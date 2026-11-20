import * as vscode from 'vscode'
import { type DshController, type DshState } from './controller'
import { renderDshHtml } from './webviewHtml'
import type { Logger } from './logger'

/** Messages the webview sends to the extension host. */
type WebviewToHost =
  | { type: 'ready' }
  | {
      type: 'action'
      action:
        | 'new-session'
        | 'pick-session'
        | 'bind'
        | 'bind-new'
        | 'reconnect'
        | 'open-browser'
        | 'unbind'
        | 'retire-default'
    }
  | { type: 'bridge'; message: unknown }
  | { type: 'frame'; event: string; url?: string }

/** Messages the extension host sends into the webview. */
type HostToWebview =
  | { type: 'state'; state: DshState }
  | { type: 'open-session'; sessionId: string }
  | { type: 'reload' }

/**
 * Renders the DeepSeek Harness SPA inside the secondary side bar. The SPA is
 * loaded from the extension's loopback proxy, which forwards it to the dsh
 * web host with a valid authentication cookie.
 */
export class DshViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'dsh.chat'

  private view?: vscode.WebviewView

  /** Session that should be opened as soon as the view exists. */
  private pendingSessionId?: string

  /** Last bound path written to the log, to avoid repeating it on every poll. */
  private lastLoggedBoundPath?: string

  constructor(
    private readonly controller: DshController,
    private readonly logger: Logger,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = { enableScripts: true, localResourceRoots: [] }
    view.webview.html = this.render(view.webview)
    this.logger.info(
      `sidebar view resolved (proxy ${this.controller.current.proxyUrl ?? 'none'}, status ${this.controller.current.status.kind})`,
    )
    view.webview.onDidReceiveMessage((message: WebviewToHost) => void this.handleMessage(message))
    view.onDidChangeVisibility(() => {
      if (view.visible) this.postState()
    })
    this.controller.onDidChange(() => this.postState())
    if (this.pendingSessionId) {
      const sessionId = this.pendingSessionId
      this.pendingSessionId = undefined
      this.post({ type: 'open-session', sessionId })
    }
  }

  /** Ask the sidebar to open a session in the embedded SPA. */
  openSession(sessionId: string): void {
    if (!this.view) {
      this.pendingSessionId = sessionId
      return
    }
    this.post({ type: 'open-session', sessionId })
  }

  /** Reload the embedded SPA, e.g. after the host was reconnected. */
  reload(): void {
    this.post({ type: 'reload' })
  }

  private post(message: HostToWebview): void {
    void this.view?.webview.postMessage({ ...message, source: 'dsh-vscode-host' })
  }

  private postState(): void {
    const state = this.controller.current
    if (state.boundPath !== this.lastLoggedBoundPath) {
      this.lastLoggedBoundPath = state.boundPath
      this.logger.info(
        `sidebar workspace: ${state.boundPath ?? 'none'} · ${state.sessions.length} sessions · ${state.status.kind}`,
      )
    }
    this.post({ type: 'state', state })
  }

  private async handleMessage(message: WebviewToHost): Promise<void> {
    if (!message || typeof message !== 'object') return
    switch (message.type) {
      case 'ready':
        this.postState()
        return
      case 'action':
        await vscode.commands.executeCommand(`dsh.${message.action}`)
        return
      case 'bridge': {
        const payload = message.message as
          | { type?: string; sessionId?: string; state?: unknown; message?: string }
          | undefined
        if (payload?.type === 'session-changed' && payload.sessionId) {
          this.logger.info(`sidebar session changed to ${payload.sessionId}`)
        } else if (payload?.type === 'diagnostic') {
          this.logger.info(`sidebar diagnostic: ${JSON.stringify(payload.state)}`)
        } else if (payload?.type === 'page-error') {
          this.logger.warn(`sidebar page error: ${payload.message ?? 'unknown'}`)
        } else if (payload?.type === 'open-failed') {
          this.logger.warn(`sidebar could not open session ${payload.sessionId ?? '?'}`)
        }
        return
      }
      case 'frame': {
        const payload = message as { event?: string; url?: string }
        this.logger.info(`sidebar frame ${payload.event ?? '?'} ${payload.url ?? ''}`)
        return
      }
      default:
        return
    }
  }

  private render(webview: vscode.Webview): string {
    return renderDshHtml(webview, { proxyUrl: this.controller.current.proxyUrl ?? '' })
  }
}