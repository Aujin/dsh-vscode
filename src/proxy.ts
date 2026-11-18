import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { gunzipSync } from 'node:zlib'
import { connect as netConnect, type Socket as NetSocket } from 'node:net'
import { URL } from 'node:url'
import type { DshHostInfo } from './host'
import type { Logger } from './logger'
import { BRIDGE_SCRIPT } from './bridge'

const BRIDGE_PATH = '/__dsh_vscode_bridge.js'

/**
 * Loopback reverse proxy in front of the dsh web host.
 *
 * The host authenticates browsers with a signed cookie and refuses
 * cross-site markers and foreign origins, neither of which a VS Code webview
 * can provide. The proxy therefore terminates the browser side: it injects the
 * host cookie, presents the host's own origin, and forwards everything -
 * including the WebSocket mux at `/api/remote.mux` - byte for byte.
 */
export class DshProxy {
  private readonly server = createServer((request, response) => {
    void this.handleRequest(request, response)
  })

  private constructor(
    private readonly getInfo: () => DshHostInfo | undefined,
    private readonly logger: Logger,
    private readonly port: number,
    /**
     * True while no folder is bound in VS Code. The host would then create its
     * own default workspace below the documents folder, which is exactly what
     * must not happen while the user has not picked a workspace.
     */
    private readonly shouldBlockDefaultWorkspace: () => boolean,
  ) {
    this.server.on('upgrade', (request, socket, head) => this.handleUpgrade(request, socket, head))
  }

  /** Start the proxy on an ephemeral loopback port. */
  static async start(
    getInfo: () => DshHostInfo | undefined,
    logger: Logger,
    shouldBlockDefaultWorkspace: () => boolean = () => false,
  ): Promise<DshProxy> {
    const proxy = new DshProxy(getInfo, logger, 0, shouldBlockDefaultWorkspace)
    await new Promise<void>((resolve, reject) => {
      proxy.server.once('error', reject)
      proxy.server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = proxy.server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('proxy failed to bind a port')
    }
    const port = address.port
    logger.info(`proxy listening on http://127.0.0.1:${port}`)
    return new DshProxy(getInfo, logger, port, shouldBlockDefaultWorkspace)
  }

  /** URL the webview iframe loads. */
  get url(): string {
    return `http://127.0.0.1:${this.port}`
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = request.url ?? '/'
    if (url.startsWith(BRIDGE_PATH)) {
      response.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
      })
      response.end(BRIDGE_SCRIPT)
      return
    }

    // Private Network Access preflight: the webview runs on a secure origin
    // and loads this loopback proxy in an iframe, so Chromium may ask for a
    // CORS preflight before allowing the navigation.
    if (request.method === 'OPTIONS') {
      const origin = String(request.headers['origin'] ?? '*')
      response.writeHead(204, {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'access-control-allow-headers': String(request.headers['access-control-request-headers'] ?? '*'),
        'access-control-allow-private-network': 'true',
        'access-control-max-age': '600',
        vary: 'Origin',
      })
      response.end()
      return
    }

    const info = this.getInfo()
    if (!info) {
      response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('dsh web 尚未连接。')
      return
    }

    // The SPA creates the host's default workspace on its own when the host
    // is completely empty. While no VS Code folder is bound that must not
    // happen, so the call is answered locally instead of being forwarded.
    if (
      request.method === 'POST' &&
      url.split('?')[0] === '/api/workspace/initializeDefault' &&
      this.shouldBlockDefaultWorkspace()
    ) {
      await this.answerInitializeDefault(request, response)
      return
    }

    const upstream = httpRequest(
      {
        host: info.hostname,
        port: info.port,
        method: request.method,
        path: url,
        headers: this.upstreamHeaders(request, info),
      },
      (upstreamResponse) => {
        const headers = { ...upstreamResponse.headers }
        delete headers['transfer-encoding']
        // Keep the private-network access permission usable for the webview.
        headers['access-control-allow-private-network'] = 'true'
        const requestOrigin = request.headers.origin
        if (typeof requestOrigin === 'string' && requestOrigin.length > 0) {
          headers['access-control-allow-origin'] = requestOrigin
          headers.vary = 'Origin'
        }
        const contentType = String(headers['content-type'] ?? '')
        if (contentType.includes('text/html')) {
          const chunks: Buffer[] = []
          upstreamResponse.on('data', (chunk: Buffer) => chunks.push(chunk))
          upstreamResponse.on('end', () => {
            let raw = Buffer.concat(chunks)
            if (String(headers['content-encoding'] ?? '').includes('gzip')) {
              try {
                raw = gunzipSync(raw)
              } catch (error) {
                this.logger.warn(`proxy could not inflate the gzip index: ${String(error)}`)
              }
            }
            delete headers['content-encoding']
            const html = raw.toString('utf8')
            const body = Buffer.from(this.injectBridge(html), 'utf8')
            headers['content-length'] = String(body.byteLength)
            response.writeHead(upstreamResponse.statusCode ?? 200, headers)
            response.end(body)
          })
          return
        }
        const contentLength = upstreamResponse.headers['content-length']
        if (contentLength === undefined) delete headers['content-length']
        else headers['content-length'] = contentLength
        response.writeHead(upstreamResponse.statusCode ?? 200, headers)
        upstreamResponse.pipe(response)
      },
    )
    upstream.on('error', (error) => {
      this.logger.error(`proxy request failed for ${url}`, error)
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(`dsh host unreachable: ${error.message}`)
    })
    request.pipe(upstream)
  }

  /** Headers the host accepts: our cookie, our origin, no cross-site marker. */
  private upstreamHeaders(request: IncomingMessage, info: DshHostInfo): Record<string, string | string[] | undefined> {
    const headers: Record<string, string | string[] | undefined> = { ...request.headers }
    delete headers['host']
    delete headers['cookie']
    delete headers['sec-fetch-site']
    delete headers['connection']
    delete headers['keep-alive']
    delete headers['proxy-connection']
    delete headers['transfer-encoding']
    headers['host'] = info.authority
    headers['cookie'] = info.cookie
    headers['accept-encoding'] = 'identity'
    if (headers['origin']) headers['origin'] = info.origin
    if (headers['referer']) headers['referer'] = `${info.origin}/`
    return headers
  }

  /**
   * Answer `workspace/initializeDefault` locally.
   *
   * The host would create a workspace below the user's documents folder; the
   * sidebar only reports "there is no workspace yet" instead, so nothing is
   * created while the user has not picked a folder in VS Code.
   */
  private async answerInitializeDefault(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    await new Promise<void>((resolve) => {
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => resolve())
      request.on('error', () => resolve())
    })
    let rpcId: unknown
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { rpcId?: unknown }
      rpcId = parsed.rpcId
    } catch {
      rpcId = undefined
    }
    this.logger.info('blocked workspace/initializeDefault: no folder is bound in VS Code')
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    response.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value: null } }))
  }

  /** Add the extension bridge to the SPA document. */
  private injectBridge(html: string): string {
    const tag = `<script src="${BRIDGE_PATH}"></script>`
    if (html.includes(BRIDGE_PATH)) return html
    const index = html.toLowerCase().lastIndexOf('</body>')
    if (index === -1) return html + tag
    return html.slice(0, index) + tag + html.slice(index)
  }

  /**
   * Relay the WebSocket mux handshake and the raw frames that follow it.
   * The client's `Sec-WebSocket-Key` is forwarded unchanged, so the host's
   * `Sec-WebSocket-Accept` stays valid for the browser.
   */
  private handleUpgrade(request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void {
    const info = this.getInfo()
    if (!info) {
      socket.destroy()
      return
    }
    const upstream = netConnect({ host: info.hostname, port: info.port })
    let headerBuffer = Buffer.alloc(0)
    let headersDone = false

    const fail = (reason: string) => {
      this.logger.error(`proxy upgrade failed: ${reason}`)
      socket.destroy()
      upstream.destroy()
    }

    upstream.on('connect', () => {
      upstream.setNoDelay(true)
      if (typeof (socket as NetSocket).setNoDelay === 'function') (socket as NetSocket).setNoDelay(true)
      const headers = this.upstreamHeaders(request, info)
      headers['connection'] = 'Upgrade'
      headers['upgrade'] = 'websocket'
      const lines = [`GET ${request.url ?? '/'} HTTP/1.1`]
      for (const [key, value] of Object.entries(headers)) {
        if (value === undefined) continue
        lines.push(`${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
      }
      upstream.write(lines.join('\r\n') + '\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      // Client frames follow the handshake; relay them verbatim so the host
      // keeps receiving masked client frames and masking stays consistent.
      socket.pipe(upstream)
    })

    upstream.on('data', (chunk: Buffer) => {
      if (headersDone) {
        socket.write(chunk)
        return
      }
      headerBuffer = Buffer.concat([headerBuffer, chunk])
      const end = headerBuffer.indexOf('\r\n\r\n')
      if (end === -1) {
        if (headerBuffer.length > 64 * 1024) fail('upstream handshake too large')
        return
      }
      const rawHeaders = headerBuffer.subarray(0, end + 4).toString('latin1')
      const rest = headerBuffer.subarray(end + 4)
      headersDone = true
      socket.write(rawHeaders)
      if (rest.length > 0) socket.write(rest)
    })

    upstream.on('end', () => socket.end())
    upstream.on('error', (error) => fail(error.message))
    socket.on('error', () => upstream.destroy())
    socket.on('close', () => upstream.destroy())
    upstream.on('close', () => socket.destroy())
  }

  async dispose(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve())
      this.server.closeAllConnections?.()
    })
  }
}

export { BRIDGE_PATH }
export function proxyOrigin(url: string): string {
  return new URL(url).origin
}
