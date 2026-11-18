import type * as vscode from 'vscode'
import type { DshHostInfo } from './host'
import { DshMux, type MuxStreamHandle } from './mux'
import type { Logger } from './logger'

export interface WorkspaceEntry {
  workspaceId: string
  path: string
  title: string
  sessionIds: string[]
  createdAt: string
  updatedAt: string
}

/**
 * Live view of the workspaces a dsh host knows about.
 *
 * The host only exposes that list as a stream (`workspace/follow`), which is
 * served over the remote mux. The directory therefore keeps one mux connection
 * open, mirrors the host's workspace registry and notifies listeners whenever it
 * changes.
 */
export class WorkspaceDirectory implements vscode.Disposable {
  private mux?: DshMux
  private stream?: MuxStreamHandle
  private readonly entries = new Map<string, WorkspaceEntry>()
  private order: string[] = []
  private readonly listeners = new Set<(workspaces: WorkspaceEntry[]) => void>()
  private stopped = false
  private retryTimer?: NodeJS.Timeout
  /** Resolves once the host sent its first baseline frame. */
  private baselineReady?: Promise<void>
  private baselineResolve?: () => void

  constructor(
    private readonly getInfo: () => DshHostInfo | undefined,
    private readonly logger: Logger,
  ) {}

  /** Workspaces in the order the host reports them. */
  list(): WorkspaceEntry[] {
    return this.order
      .map((id) => this.entries.get(id))
      .filter((entry): entry is WorkspaceEntry => entry !== undefined)
  }

  onDidChange(listener: (workspaces: WorkspaceEntry[]) => void): vscode.Disposable {
    this.listeners.add(listener)
    return { dispose: () => this.listeners.delete(listener) }
  }

  /** Connect (once) and start mirroring the host's workspace registry. */
  async ensureConnected(): Promise<void> {
    if (this.stopped) return
    if (this.stream && this.mux?.connected) return
    const info = this.getInfo()
    if (!info) return
    try {
      this.mux?.dispose()
      this.baselineReady = new Promise<void>((resolve) => {
        this.baselineResolve = resolve
      })
      this.mux = await DshMux.connect(info, this.logger)
      this.logger.info('mux connected, following the workspace registry')
      this.stream = this.mux.openStream('workspace/follow', {})
      void this.pump(this.stream)
      // Wait for the first baseline so that callers can rely on the list being
      // complete right after the call.
      await Promise.race([this.baselineReady, delay(3000)])
    } catch (error) {
      this.logger.warn(`mux connection failed: ${(error as Error).message}`)
      this.scheduleRetry()
    }
  }

  private async pump(stream: MuxStreamHandle): Promise<void> {
    try {
      for (;;) {
        const value = (await stream.next()) as
          | { type?: string; workspace?: WorkspaceEntry; workspaceId?: string; workspaceIds?: string[]; value?: { items?: WorkspaceEntry[] } }
          | undefined
        if (!value) continue
        this.apply(value)
      }
    } catch (error) {
      if (this.stopped) return
      this.logger.warn(`workspace stream ended: ${(error as Error).message}`)
      this.scheduleRetry()
    }
  }

  private apply(frame: {
    type?: string
    workspace?: WorkspaceEntry
    workspaceId?: string
    workspaceIds?: string[]
    value?: { items?: WorkspaceEntry[] }
  }): void {
    if (frame.type === 'baseline') {
      const items = frame.value?.items ?? []
      this.entries.clear()
      for (const item of items) this.entries.set(item.workspaceId, item)
      this.order = items.map((item) => item.workspaceId)
      this.baselineResolve?.()
      this.baselineResolve = undefined
      this.notify()
      return
    }
    if (frame.type === 'upsert' && frame.workspace) {
      const workspace = frame.workspace
      const existed = this.entries.has(workspace.workspaceId)
      this.entries.set(workspace.workspaceId, workspace)
      if (!existed) this.order = [workspace.workspaceId, ...this.order]
      this.notify()
      return
    }
    if (frame.type === 'remove' && frame.workspaceId) {
      if (this.entries.delete(frame.workspaceId)) {
        this.order = this.order.filter((id) => id !== frame.workspaceId)
        this.notify()
      }
      return
    }
    if (frame.type === 'order' && frame.workspaceIds) {
      const known = frame.workspaceIds.filter((id) => this.entries.has(id))
      const rest = this.order.filter((id) => !known.includes(id))
      this.order = [...known, ...rest]
      this.notify()
    }
  }

  private notify(): void {
    const snapshot = this.list()
    for (const listener of this.listeners) listener(snapshot)
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      void this.ensureConnected()
    }, 3000)
  }

  dispose(): void {
    this.stopped = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.baselineResolve?.()
    this.baselineResolve = undefined
    this.stream?.close()
    this.mux?.dispose()
    this.listeners.clear()
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
