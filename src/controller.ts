import { mkdir } from 'node:fs/promises'
import { isAbsolute, extname, join, resolve } from 'node:path'
import * as vscode from 'vscode'
import type { DshHost, DshHostInfo } from './host'
import { WorkspaceBinding, type SessionSummary } from './binding'
import type { WorkspaceDirectory, WorkspaceEntry } from './workspaces'
import type { Logger } from './logger'

export type DshStatus =
  | { kind: 'connecting' }
  | { kind: 'ready'; mode: 'attached' | 'spawned'; baseUrl: string }
  | { kind: 'error'; message: string }

export interface DshState {
  status: DshStatus
  /** Folder the agent is bound to. */
  boundPath?: string
  /** dsh workspace that owns the folder. */
  workspaceId?: string
  /** Session currently shown in the sidebar. */
  sessionId?: string
  /** Sessions known to the host, newest first. */
  sessions: SessionSummary[]
  /** Workspaces known to the host. */
  workspaces: WorkspaceEntry[]
  /** URL of the proxied dsh SPA. */
  proxyUrl?: string
  /** URL of the dsh web host. */
  hostUrl?: string
}

/**
 * A workspace registration is the host's "default workspace" when it carries
 * the host's own default directory name. The host always creates that
 * workspace below the user's documents folder, so it can never be the folder
 * that is open in VS Code.
 */
export function isHostDefaultWorkspace(entry: WorkspaceEntry): boolean {
  const title = entry.title.trim().toLowerCase()
  if (title === 'default-workspace') return true
  const path = entry.path.replace(/\//g, '\\').toLowerCase()
  return path.endsWith('\\deepseek-harness\\default-workspace')
}

/**
 * Connects the VS Code window to a dsh host, binds a folder to a dsh
 * workspace and keeps the sidebar in sync with the sessions the host knows -
 * including sessions created in the `dsh web` browser GUI, because both
 * clients talk to the same host process.
 */
export class DshController implements vscode.Disposable {
  private state: DshState = { status: { kind: 'connecting' }, sessions: [], workspaces: [] }
  private readonly listeners = new Set<(state: DshState) => void>()
  private pollTimer?: NodeJS.Timeout

  constructor(
    private readonly host: DshHost,
    private readonly binding: WorkspaceBinding,
    private readonly directory: WorkspaceDirectory,
    readonly logger: Logger,
    private readonly proxyUrl: () => string,
  ) {
    // The proxy is already listening when the controller is created, so the
    // sidebar can render the embedded SPA right away - even before the host
    // itself was found.
    this.state = { ...this.state, proxyUrl: this.proxyUrl() }
    directory.onDidChange((workspaces) => this.update({ workspaces }))
  }

  get current(): DshState {
    return this.state
  }

  onDidChange(listener: (state: DshState) => void): vscode.Disposable {
    this.listeners.add(listener)
    return { dispose: () => this.listeners.delete(listener) }
  }

  private update(patch: Partial<DshState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener(this.state)
  }

  /** Connect to the host and start polling for session changes. */
  async connect(): Promise<void> {
    this.update({ status: { kind: 'connecting' } })
    try {
      const info = await this.host.connect()
      this.update({
        status: { kind: 'ready', mode: info.mode, baseUrl: info.baseUrl },
        hostUrl: info.baseUrl,
        proxyUrl: this.proxyUrl(),
      })
      await this.directory.ensureConnected()
      await this.refreshSessions()
      this.startPolling()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.error('failed to connect to dsh web', error)
      this.update({ status: { kind: 'error', message } })
    }
  }

  /** Reconnect, e.g. after the host was restarted. */
  async reconnect(): Promise<void> {
    this.update({ status: { kind: 'connecting' } })
    await this.connect()
  }

  private startPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    const interval = this.pollInterval()
    if (interval <= 0) return
    this.pollTimer = setInterval(() => {
      void this.refreshSessions()
    }, interval)
  }

  private pollInterval(): number {
    const configured = vscode.workspace.getConfiguration('dsh').get<number>('pollIntervalMs', 3000)
    return Number.isFinite(configured) && configured >= 0 ? configured : 3000
  }

  /** Reload the session list from the host. */
  async refreshSessions(): Promise<SessionSummary[]> {
    try {
      const sessions = await this.binding.listSessions()
      sessions.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
      this.update({ sessions })
      return sessions
    } catch (error) {
      this.logger.warn(`session list failed: ${(error as Error).message}`)
      return this.state.sessions
    }
  }

  /**
   * Bind a folder: create (or reuse) the dsh workspace for the path and make
   * sure a session exists inside it. The workspace is shared with the browser
   * GUI, so the folder shows up there as well, and opening one of its sessions
   * in the sidebar makes it the GUI's active workspace - which is what new
   * sessions are created in.
   */
  async bindFolder(path: string): Promise<{ workspaceId: string; sessionId?: string }> {
    const folder = resolve(path)
    const { workspace, created } = await this.binding.ensureWorkspace(folder)
    this.logger.info(`${created ? 'created' : 'reused'} workspace ${workspace.workspaceId} for ${folder}`)
    this.update({ boundPath: workspace.path, workspaceId: workspace.workspaceId })

    await this.retireHostDefaultWorkspace(workspace)

    const reuse = vscode.workspace.getConfiguration('dsh').get<boolean>('reuseExistingSession', true)
    let sessionId: string | undefined
    if (reuse) {
      const existing = await this.binding.findSessionForPath(workspace.path, workspace)
      sessionId = existing?.sessionId
    }
    if (!sessionId) {
      const created2 = await this.binding.createSession(workspace.workspaceId)
      sessionId = created2.sessionId
      this.logger.info(`created session ${sessionId} in workspace ${workspace.workspaceId}`)
    }
    this.update({ sessionId })
    await this.refreshSessions()
    return { workspaceId: workspace.workspaceId, sessionId }
  }

  /**
   * Remove the host's own default workspace registration.
   *
   * The host always creates that workspace below the user's documents folder,
   * so it can never become the folder that is open in VS Code. Deleting the
   * registration keeps the directory and every session log, and permanently
   * stops the host from recreating it.
   */
  async retireHostDefaultWorkspace(bound?: WorkspaceEntry): Promise<boolean> {
    const enabled = vscode.workspace.getConfiguration('dsh').get<boolean>('retireDefaultWorkspace', true)
    if (!enabled) return false
    const candidates = this.directory.list().filter((entry) => isHostDefaultWorkspace(entry))
    let retired = false
    for (const candidate of candidates) {
      if (bound && candidate.workspaceId === bound.workspaceId) continue
      try {
        await this.binding.deleteWorkspace(candidate.workspaceId)
        retired = true
        this.logger.info(
          `retired the host's default workspace ${candidate.workspaceId} (${candidate.path}); ` +
            'its folder and session logs are kept',
        )
      } catch (error) {
        this.logger.warn(`could not retire the host's default workspace: ${(error as Error).message}`)
      }
    }
    return retired
  }

  /** Forget the bound folder without touching anything on the host. */
  unbind(): void {
    this.update({ boundPath: undefined, workspaceId: undefined, sessionId: undefined })
  }

  /** Create a fresh blank session in the bound workspace. */
  async newSession(): Promise<string | undefined> {
    const workspaceId = this.state.workspaceId
    if (!workspaceId) {
      void vscode.window.showWarningMessage('请先绑定一个工作目录。')
      return undefined
    }
    const created = await this.binding.createSession(workspaceId)
    this.update({ sessionId: created.sessionId })
    await this.refreshSessions()
    return created.sessionId
  }

  /** Sessions of the bound folder, newest first. */
  sessionsForBoundPath(): SessionSummary[] {
    const bound = this.state.boundPath?.toLowerCase()
    if (!bound) return this.state.sessions
    return this.state.sessions.filter((session) => (session.cwd ?? '').toLowerCase() === bound)
  }

  /**
   * Pick a session folder and create it on disk.
   *
   * With `unique` the name is made unique (`name`, `name-2`, `name-3`, …) so a
   * manual request never reuses an existing folder by accident.
   */
  async createWorkspaceFolder(parent: string, name: string, unique = false): Promise<string> {
    const folderName = name.trim() || 'dsh-workspace'
    const base = isAbsolute(folderName) ? folderName : join(resolve(parent), folderName)
    if (!unique) {
      await mkdir(base, { recursive: true })
      return base
    }
    const extension = extname(base)
    const stem = base.slice(0, base.length - extension.length)
    let target = base
    for (let attempt = 2; attempt < 100; attempt += 1) {
      try {
        await mkdir(target)
        return target
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        target = `${stem}-${attempt}${extension}`
      }
    }
    throw new Error(`无法创建唯一的目录 ${base}`)
  }

  dispose(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = undefined
    this.listeners.clear()
  }
}

export type { DshHostInfo }
