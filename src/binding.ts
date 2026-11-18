import type { DshRpc } from './rpc'
import type { Logger } from './logger'
import type { WorkspaceEntry } from './workspaces'

export type WorkspaceView = WorkspaceEntry

export interface SessionSummary {
  sessionId: string
  updatedAt: number
  running: boolean
  blank: boolean
  cwd?: string
  parentSessionId?: string
  origin?: string
  projections?: {
    kind?: string
    asOfSeq?: number
    values?: {
      title?: string
      workingDirectory?: string | null
      agentPreset?: string
      [key: string]: unknown
    }
  }
}

/** Keeps a VS Code folder bound to a dsh workspace and its session. */
export class WorkspaceBinding {
  constructor(
    private readonly rpc: DshRpc,
    private readonly logger: Logger,
  ) {}

  /** Create (or reuse) the dsh workspace that owns `path`. */
  async ensureWorkspace(path: string): Promise<{ workspace: WorkspaceView; created: boolean }> {
    const value = await this.rpc.call<{ workspace: WorkspaceView; created: boolean }>('workspace/create', {
      request: { path },
    })
    this.logger.info(`workspace ${value.workspace.workspaceId} ${value.created ? 'created' : 'reused'} for ${path}`)
    return value
  }

  /** Every session the host knows about, including sessions from `dsh web`. */
  async listSessions(): Promise<SessionSummary[]> {
    const value = await this.rpc.call<{ items: SessionSummary[] }>('session/list', { _request: {} })
    return Array.isArray(value.items) ? value.items : []
  }

  /**
   * The session that belongs to `path`, newest first.
   *
   * When the workspace is known, a session that the workspace owns is
   * preferred: such a session is grouped under the workspace in the browser
   * GUI as well, while a session created for a bare `cwd` stays detached.
   */
  async findSessionForPath(path: string, workspace?: WorkspaceView): Promise<SessionSummary | undefined> {
    const sessions = await this.listSessions()
    const normalized = path.toLowerCase()
    const matches = sessions
      .filter((session) => (session.cwd ?? '').toLowerCase() === normalized)
      .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
    if (!workspace) return matches[0]
    const attached = matches.find((session) => workspace.sessionIds.includes(session.sessionId))
    return attached ?? matches[0]
  }

  /** Create a fresh blank session inside `workspaceId`. */
  async createSession(workspaceId: string): Promise<{ sessionId: string; agentPreset?: string }> {
    return this.rpc.call<{ sessionId: string; agentPreset?: string }>('session/create', {
      request: { workspaceId },
    })
  }

  /**
   * Remove a workspace registration.
   *
   * The host keeps the directory and every session log; only the registration
   * disappears, which also stops the host from re-creating its default
   * workspace later on.
   */
  async deleteWorkspace(workspaceId: string): Promise<void> {
    await this.rpc.call<unknown>('workspace/delete', { request: { workspaceId } })
    this.logger.info(`deleted workspace registration ${workspaceId}`)
  }

  /** Human readable title for a session row. */
  static titleOf(session: SessionSummary): string {
    const title = session.projections?.values?.title
    if (typeof title === 'string' && title.trim().length > 0) return title.trim()
    return session.sessionId
  }
}
