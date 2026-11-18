import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Logger } from './logger'
import { browserCookieName, mintBrowserCookie, readBrowserSessionSecret } from './credentials'

export interface DshHostInfo {
  /** Base URL of the dsh web host, without query string. */
  baseUrl: string
  hostname: string
  port: number
  /** `host:port` as the host sees it. */
  authority: string
  /** `http://host:port`, the origin every forwarded request must present. */
  origin: string
  /** Cookie header the host accepts for this authority. */
  cookie: string
  /** How the connection was established. */
  mode: 'attached' | 'spawned'
}

export interface DshHostOptions {
  webUrl: string
  autoStart: boolean
  autoStartPort: number
  executablePath?: string
}

/** A dsh installation that the extension can launch. */
interface DshInstall {
  /** Absolute path of `@deepseek-ai/dsh/lib/bin.js`. */
  entry?: string
  /** Absolute path of a `dsh` launcher shim. */
  shim?: string
  /** Node binary able to run the entry point. */
  node?: string
  /** Human readable description, used in the log and in error messages. */
  description: string
}

/**
 * Expand a path pattern that contains a single `*` wildcard.
 *
 * Used for version directories such as
 * `%APPDATA%\fnm\node-versions\*\installation`.
 */
function expandWildcard(pattern: string): string[] {
  const sep = pattern.includes('\\') ? '\\' : '/'
  const isAbsolute = pattern.startsWith('/')
  const parts = pattern.split(/[\\/]+/).filter((part) => part.length > 0)
  const starIndex = parts.findIndex((part) => part.includes('*'))
  if (starIndex < 0) {
    return existsSync(pattern) ? [pattern] : []
  }
  const parent = (isAbsolute ? sep : '') + parts.slice(0, starIndex).join(sep)
  const prefix = parts[starIndex].slice(0, parts[starIndex].indexOf('*'))
  let entries: string[]
  try {
    entries = readdirSync(parent)
  } catch {
    return []
  }
  const tail = parts.slice(starIndex + 1)
  const matches: string[] = []
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue
    matches.push([parent, entry, ...tail].join(sep))
  }
  return matches
}

/** Result of a plain GET against the host. */
interface ProbeResult {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

function parseBaseUrl(raw: string): { baseUrl: string; token?: string } {
  const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`
  const url = new URL(withScheme)
  const token = url.searchParams.get('token') ?? undefined
  url.search = ''
  url.hash = ''
  return { baseUrl: url.toString().replace(/\/$/, ''), token }
}

/** One HTTP GET with an optional cookie header. */
function httpGet(url: string, cookie: string | undefined, timeoutMs = 4000): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest
    const req = send(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: {
          host: target.host,
          ...(cookie ? { cookie } : {}),
          'accept-encoding': 'identity',
          'user-agent': 'dsh-vscode/0.1.0',
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        })
      },
    )
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms`))
    })
    req.on('error', reject)
    req.end()
  })
}

/**
 * Run a command and capture its standard output.
 *
 * Used to enumerate the TCP ports that listen on this machine.
 */
function runCommand(command: string, args: string[], timeoutMs = 6000): Promise<string> {
  return new Promise((resolve) => {
    let out = ''
    let child: ChildProcess
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    } catch {
      resolve('')
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // ignore
      }
      resolve(out)
    }, timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      out += chunk
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve('')
    })
    child.on('exit', () => {
      clearTimeout(timer)
      resolve(out)
    })
  })
}

/**
 * Extract the local TCP ports that are in LISTEN state.
 *
 * Understands the output of `netstat -ano -p TCP` (Windows), `ss -ltn`
 * (Linux) and `lsof -nP -iTCP -sTCP:LISTEN` (macOS): every line of those
 * listings that mentions LISTEN carries the bound local address.
 */
export function parseListeningPorts(output: string): number[] {
  const ports = new Set<number>()
  for (const line of output.split(/\r?\n/)) {
    if (!/listen/i.test(line)) continue
    for (const match of line.matchAll(/(?:\[::1\]|127\.0\.0\.1|0\.0\.0\.0|\*):(\d{1,5})\b/g)) {
      const port = Number(match[1])
      if (port > 0 && port <= 65535) ports.add(port)
    }
  }
  return [...ports].sort((a, b) => a - b)
}

/**
 * Ask every candidate port whether it serves a dsh web host.
 *
 * A dsh host answers the index request with the SPA document, which carries
 * the injected boot payload; that marker identifies the host far more
 * reliably than the port number. The first port that answers wins.
 */
export async function detectDshHost(
  ports: number[],
  cookieFor: (authority: string) => string,
  timeoutMs = 1500,
): Promise<number | undefined> {
  const seen = new Set<number>()
  for (const port of ports) {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue
    if (seen.has(port)) continue
    seen.add(port)
    const authority = `127.0.0.1:${port}`
    let cookie: string
    try {
      cookie = cookieFor(authority)
    } catch {
      continue
    }
    try {
      const probe = await httpGet(`http://127.0.0.1:${port}/`, cookie, timeoutMs)
      if (probe.status === 200 && probe.body.includes('__DSH_BOOT__')) return port
    } catch {
      // Not a dsh host (refused, timed out, or something else entirely).
    }
  }
  return undefined
}

/**
 * Owns the connection to a `dsh web` host.
 *
 * The primary path attaches to an already running host by minting the browser
 * cookie from the host's own credential store, so the sidebar and the browser
 * GUI share one host process and therefore one set of sessions. Only when no
 * host answers does the extension start one itself.
 */
export class DshHost {
  private info?: DshHostInfo
  private child?: ChildProcess
  private readonly disposables: Array<() => void> = []

  constructor(
    private readonly logger: Logger,
    private readonly options: () => DshHostOptions,
  ) {}

  get current(): DshHostInfo | undefined {
    return this.info
  }

  /** True when the extension started the host and therefore owns its lifetime. */
  get ownsProcess(): boolean {
    return this.child !== undefined
  }

  async connect(): Promise<DshHostInfo> {
    const options = this.options()
    const candidates = this.candidateUrls(options)
    const triedPorts: number[] = []

    for (const [index, candidate] of candidates.entries()) {
      const attached = await this.tryAttach(candidate.baseUrl, candidate.token, index > 0)
      if (attached) {
        this.info = attached
        this.logger.info(`attached to running dsh web at ${attached.baseUrl} (${candidate.source})`)
        return attached
      }
      const url = new URL(candidate.baseUrl)
      triedPorts.push(Number(url.port || (url.protocol === 'https:' ? 443 : 80)))
    }

    const scanned = await this.scanForHosts(triedPorts)
    if (scanned) {
      this.info = scanned
      this.logger.info(`attached to running dsh web at ${scanned.baseUrl} (port scan)`)
      return scanned
    }

    if (!options.autoStart) {
      throw new Error(
        `未找到正在运行的 dsh web（已尝试 ${candidates.length} 个地址与本机监听端口），且已禁用自动启动（dsh.autoStart）。`,
      )
    }

    const spawned = await this.spawnHost(options)
    this.info = spawned
    this.logger.info(`started dsh web at ${spawned.baseUrl} (pid ${this.child?.pid})`)
    return spawned
  }

  /**
   * Addresses that may host a running `dsh web`, in the order they are tried.
   *
   * The configured URL comes first, then the `DSH_WEB_URL` environment
   * variable (set when VS Code was started from a terminal), then the port the
   * extension would start a host on, then the ports dsh web uses by default.
   */
  private candidateUrls(
    options: DshHostOptions,
  ): Array<{ baseUrl: string; token?: string; source: string }> {
    const candidates: Array<{ baseUrl: string; token?: string; source: string }> = []
    const push = (raw: string | undefined, source: string) => {
      if (!raw || !raw.trim()) return
      const { baseUrl, token } = parseBaseUrl(raw.trim())
      if (candidates.some((candidate) => candidate.baseUrl === baseUrl)) return
      candidates.push({ baseUrl, token, source })
    }

    push(options.webUrl, 'dsh.webUrl')
    push(process.env.DSH_WEB_URL, 'DSH_WEB_URL')
    if (options.autoStartPort > 0) {
      push(`http://127.0.0.1:${options.autoStartPort}`, 'dsh.autoStartPort')
    }
    for (const port of [3080, 8080, 3000]) {
      push(`http://127.0.0.1:${port}`, `default port ${port}`)
    }
    return candidates
  }

  /** Ask the operating system which TCP ports listen on this machine. */
  private async listeningPorts(): Promise<number[]> {
    const attempts =
      process.platform === 'win32'
        ? [{ command: 'netstat', args: ['-ano', '-p', 'TCP'] }]
        : [
            { command: 'ss', args: ['-ltn'] },
            { command: 'lsof', args: ['-nP', '-iTCP', '-sTCP:LISTEN'] },
          ]

    for (const attempt of attempts) {
      const output = await runCommand(attempt.command, attempt.args)
      const ports = parseListeningPorts(output)
      if (ports.length) return ports
    }
    return []
  }

  /**
   * Look for a dsh web host on any locally listening port.
   *
   * This is what keeps the sidebar in sync with the browser GUI when the host
   * runs on a non default port: attaching to the running host is preferred
   * over starting a second one, which would fork the session list.
   */
  private async scanForHosts(skipPorts: number[], knownPorts?: number[]): Promise<DshHostInfo | undefined> {
    const secret = readBrowserSessionSecret()
    if (!secret) return undefined

    const ports = (knownPorts ?? (await this.listeningPorts())).filter(
      (port) => !skipPorts.includes(port),
    )
    if (!ports.length) return undefined

    const rank = (port: number) => (port === 3080 ? 0 : port === 8080 ? 1 : 2)
    const ordered = [...ports].sort((a, b) => rank(a) - rank(b) || a - b)
    this.logger.info(`scanning ${ordered.length} local listening port(s) for a dsh web host`)

    const port = await detectDshHost(ordered, (authority) => mintBrowserCookie(authority, secret))
    if (port === undefined) return undefined

    const baseUrl = `http://127.0.0.1:${port}`
    const url = new URL(baseUrl)
    return {
      baseUrl,
      hostname: url.hostname,
      port,
      authority: url.host,
      origin: `http://${url.host}`,
      cookie: mintBrowserCookie(url.host, secret),
      mode: 'attached',
    }
  }

  /** Mint a cookie for `authority` and check that the host accepts it. */
  private async tryAttach(
    baseUrl: string,
    token?: string,
    quiet = false,
  ): Promise<DshHostInfo | undefined> {
    const url = new URL(baseUrl)
    const authority = url.host
    const origin = `${url.protocol}//${url.host}`

    const secret = readBrowserSessionSecret()
    if (secret) {
      const cookie = mintBrowserCookie(authority, secret)
      try {
        const probe = await httpGet(`${baseUrl}/`, cookie)
        if (probe.status === 200) {
          return { baseUrl, hostname: url.hostname, port: Number(url.port || 80), authority, origin, cookie, mode: 'attached' }
        }
        if (!quiet) {
          this.logger.warn(`dsh web at ${baseUrl} rejected the minted cookie (status ${probe.status})`)
        }
      } catch (error) {
        if (!quiet) {
          this.logger.info(`no dsh web reachable at ${baseUrl}: ${(error as Error).message}`)
        }
      }
    } else if (!quiet) {
      this.logger.info('browser-session credential record not found in $DSH_HOME/.credentials.yaml')
    }

    if (token) {
      try {
        const probe = await httpGet(`${baseUrl}/?token=${encodeURIComponent(token)}`, undefined)
        const setCookie = probe.headers['set-cookie']
        const value = Array.isArray(setCookie) ? setCookie[0] : setCookie
        const cookie = value?.split(';')[0]
        if (cookie) {
          return { baseUrl, hostname: url.hostname, port: Number(url.port || 80), authority, origin, cookie, mode: 'attached' }
        }
      } catch (error) {
        this.logger.warn(`launch token exchange failed: ${(error as Error).message}`)
      }
    }

    return undefined
  }

  /** Start `dsh web --no-open` and wait for the printed, authenticated URL. */
  private async spawnHost(options: DshHostOptions): Promise<DshHostInfo> {
    try {
      return await this.runHost(options, options.autoStartPort)
    } catch (error) {
      const message = String((error as Error).message ?? error)
      if (options.autoStartPort !== 0 && /EADDRINUSE|address already in use/i.test(message)) {
        this.logger.warn(`port ${options.autoStartPort} is already in use; letting the system pick a free port`)
        return this.runHost(options, 0)
      }
      throw error
    }
  }

  private async runHost(options: DshHostOptions, port: number): Promise<DshHostInfo> {
    const command = this.resolveLaunch(options, port)
    this.logger.info(`starting dsh web via ${command.command} ${command.args.join(' ')}`)
    const child = spawn(command.command, command.args, {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: command.shell,
    })
    this.child = child
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.logger.info(`[dsh web] ${chunk.trimEnd()}`))
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
      this.logger.warn(`[dsh web] ${chunk.trimEnd()}`)
    })
    child.on('exit', (code, signal) => {
      this.logger.warn(`dsh web exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`)
      if (this.child === child) {
        this.child = undefined
        this.info = undefined
      }
    })

    let url: string
    try {
      url = await this.waitForUrl(child, 45_000)
    } catch (error) {
      try {
        child.kill()
      } catch {
        // ignore
      }
      throw new Error(`${(error as Error).message}${stderr.trim() ? ` (${stderr.trim()})` : ''}`)
    }
    const { baseUrl } = parseBaseUrl(url)
    const target = new URL(baseUrl)
    const authority = target.host
    const origin = `${target.protocol}//${target.host}`

    // The freshly started host wrote its credential record; prefer our own
    // cookie so the browser GUI keeps working with its own session.
    const secret = readBrowserSessionSecret()
    if (secret) {
      const cookie = mintBrowserCookie(authority, secret)
      const probe = await httpGet(`${baseUrl}/`, cookie)
      if (probe.status === 200) {
        return { baseUrl, hostname: target.hostname, port: Number(target.port || 80), authority, origin, cookie, mode: 'spawned' }
      }
    }

    // Otherwise exchange the launch token for the host's own browser cookie.
    const token = new URL(url).searchParams.get('token')
    if (token) {
      const probe = await httpGet(`${baseUrl}/?token=${encodeURIComponent(token)}`, undefined)
      const setCookie = probe.headers['set-cookie']
      const value = Array.isArray(setCookie) ? setCookie[0] : setCookie
      const cookie = value?.split(';')[0]
      if (cookie) {
        return { baseUrl, hostname: target.hostname, port: Number(target.port || 80), authority, origin, cookie, mode: 'spawned' }
      }
    }

    throw new Error(`无法与新启动的 dsh web 建立认证（${baseUrl}）`)
  }

  /** Read the `dsh web: <url>` line the host prints on startup. */
  private waitForUrl(child: ChildProcess, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      let buffered = ''
      const timer = setTimeout(() => {
        reject(new Error(`dsh web 启动超时（${timeoutMs}ms）`))
      }, timeoutMs)
      const onData = (chunk: string) => {
        buffered += chunk
        const match = buffered.match(/dsh web:\s*(https?:\/\/\S+)/)
        if (match) {
          clearTimeout(timer)
          child.stdout?.off('data', onData)
          resolve(match[1])
        }
      }
      child.stdout?.on('data', onData)
      child.on('exit', () => {
        clearTimeout(timer)
        reject(new Error('dsh web 启动过程中退出'))
      })
    })
  }

  /**
   * Prefer running the dsh package entry point directly: a direct node child
   * can be terminated reliably, unlike a `dsh.cmd` shim.
   */
  private resolveLaunch(
    options: DshHostOptions,
    port: number,
  ): { command: string; args: string[]; shell: boolean } {
    const webArgs = ['web', '--no-open', '--port', String(port)]
    const install = this.discover(options)
    this.logger.info(`dsh discovery: ${install.description}`)

    if (install.entry) {
      const node = install.node ?? this.findNodeBinary()
      if (node) {
        return { command: node, args: [install.entry, ...webArgs], shell: false }
      }
      // No node binary in sight: fall back to the launcher shim.
    }

    if (install.shim) {
      return { command: install.shim, args: webArgs, shell: true }
    }

    if (install.entry) {
      // The package is there but no node binary was found; `node` from PATH is
      // the last resort.
      return { command: 'node', args: [install.entry, ...webArgs], shell: true }
    }

    return { command: 'dsh', args: webArgs, shell: true }
  }

  /**
   * Locate the dsh installation.
   *
   * VS Code started from the Windows start menu inherits the system PATH only,
   * so a dsh that was installed with fnm (or nvm, npm, volta, ...) is not on
   * it. The well known installation roots are searched explicitly; the node
   * binary that belongs to the installation is used to run it, because inside
   * the extension host `process.execPath` is the VS Code executable.
   */
  private discover(options: DshHostOptions): DshInstall {
    const configured = options.executablePath?.trim()
    if (configured) {
      if (configured.endsWith('.js')) {
        return { entry: configured, node: this.findNodeBinary(), description: `dsh.executablePath = ${configured}` }
      }
      return { shim: configured, description: `dsh.executablePath = ${configured}` }
    }

    for (const root of this.nodeModuleRoots()) {
      const entry = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      if (existsSync(entry)) {
        const node = this.nodeFor(root) ?? this.findNodeBinary()
        return { entry, node, description: `${entry}${node ? ` (node: ${node})` : ''}` }
      }
    }

    const pathEntry = this.findDshEntryPoint()
    if (pathEntry) {
      const root = dirname(dirname(dirname(dirname(dirname(pathEntry)))))
      return {
        entry: pathEntry,
        node: this.nodeFor(root) ?? this.findNodeBinary(),
        description: `${pathEntry} (PATH)`,
      }
    }

    const shim = this.findDshShim()
    if (shim) {
      return { shim, description: `${shim} (PATH)` }
    }

    return { description: 'not found' }
  }

  /**
   * Directories that may contain a global `@deepseek-ai/dsh` installation.
   *
   * Covers fnm (Windows and POSIX), nvm, the npm global prefix, the official
   * node installer and volta.
   */
  private nodeModuleRoots(): string[] {
    const roots: string[] = []
    const home = homedir()
    const appData = process.env.APPDATA
    const localAppData = process.env.LOCALAPPDATA
    const programFiles = process.env.ProgramFiles
    const fnmDir = process.env.FNM_DIR

    const patterns: string[] = []
    if (fnmDir) patterns.push(join(fnmDir, 'node-versions', '*', 'installation'))
    if (appData) patterns.push(join(appData, 'fnm', 'node-versions', '*', 'installation'))
    if (localAppData) patterns.push(join(localAppData, 'fnm', 'node-versions', '*', 'installation'))
    patterns.push(join(home, '.fnm', 'node-versions', '*', 'installation'))
    if (process.env.NVM_HOME) patterns.push(join(process.env.NVM_HOME, '*'))
    patterns.push(join(home, '.nvm', 'versions', 'node', '*'))
    if (appData) patterns.push(join(appData, 'npm'))
    if (programFiles) patterns.push(join(programFiles, 'nodejs'))
    patterns.push(join(home, '.volta', 'tools', 'image', 'node', '*'))
    if (localAppData) patterns.push(join(localAppData, 'Volta', 'tools', 'image', 'node', '*'))
    if (process.platform !== 'win32') {
      patterns.push('/usr/local/lib', '/usr/lib', '/opt/homebrew/lib')
    }

    for (const pattern of patterns) {
      for (const resolved of expandWildcard(pattern)) roots.push(resolved)
    }
    return roots
  }

  /** Node binary that belongs to an installation root, if there is one. */
  private nodeFor(root: string): string | undefined {
    const candidates =
      process.platform === 'win32'
        ? [join(root, 'node.exe')]
        : [join(root, 'bin', 'node'), join(root, 'node')]
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }
    return undefined
  }

  /** Node binary on PATH. */
  private findNodeBinary(): string | undefined {
    const seen = new Set<string>()
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      if (!dir || seen.has(dir)) continue
      seen.add(dir)
      for (const name of process.platform === 'win32' ? ['node.exe'] : ['node']) {
        const candidate = join(dir, name)
        if (existsSync(candidate)) return candidate
      }
    }
    return undefined
  }

  /** Locate `@deepseek-ai/dsh/lib/bin.js` in the node installation on PATH. */
  private findDshEntryPoint(): string | undefined {
    const seen = new Set<string>()
    const candidates: string[] = []
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      if (!dir || seen.has(dir)) continue
      seen.add(dir)
      candidates.push(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
      candidates.push(join(dir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
    }
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }
    return undefined
  }

  /** Locate the `dsh` launcher shim on PATH. */
  private findDshShim(): string | undefined {
    const seen = new Set<string>()
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      if (!dir || seen.has(dir)) continue
      seen.add(dir)
      for (const name of ['dsh.cmd', 'dsh.exe', 'dsh', 'dsh.ps1']) {
        const candidate = join(dir, name)
        if (existsSync(candidate)) return candidate
      }
    }
    return undefined
  }

  /** Terminate a host this extension started. */
  async dispose(): Promise<void> {
    for (const dispose of this.disposables.splice(0)) dispose()
    const child = this.child
    this.child = undefined
    this.info = undefined
    if (!child || child.pid === undefined) return
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve())
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).once('exit', () => resolve())
      } else {
        child.kill('SIGTERM')
        setTimeout(() => {
          child.kill('SIGKILL')
          resolve()
        }, 2000)
      }
    })
  }
}

export { browserCookieName }
