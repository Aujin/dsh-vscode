import * as vscode from 'vscode'
import { type DshController } from './controller'
import type { Logger } from './logger'
import { renderDshHtml } from './webviewHtml'

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

/** Messages the extension host sends into the webview. */
type HostToWebview =
  | { type: 'state'; state: unknown }
  | { type: 'open-session'; sessionId: string }
  | { type: 'reload' }

/**
 * Opens the DeepSeek Harness SPA as a regular editor tab. The badge in the
 * editor title bar (like the one Codex and Claude Code show) triggers this.
 */
export class DshEditorPanel implements vscode.Disposable {
  static readonly viewType = 'dsh.editor'

  private panel: vscode.WebviewPanel | undefined

  /** Session that should be opened as soon as the panel exists. */
  private pendingSessionId: string | undefined

  private readonly stateSubscription: vscode.Disposable

  constructor(
    private readonly controller: DshController,
    private readonly logger: Logger,
    private readonly extensionUri: vscode.Uri,
  ) {
    this.stateSubscription = this.controller.onDidChange(() => this.postState())
  }

  /** Open the tab, or reveal the existing one. */
  open(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active, true)
      this.postState()
      return
    }

    const panel = vscode.window.createWebviewPanel(
      DshEditorPanel.viewType,
      'DeepSeek Harness',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] },
    )
    this.panel = panel
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'dsh.svg')
    panel.webview.html = renderDshHtml(panel.webview, {
      proxyUrl: this.controller.current.proxyUrl ?? '',
      title: 'DeepSeek Harness',
    })
    panel.webview.onDidReceiveMessage((message: WebviewToHost) => void this.handleMessage(message))
    panel.onDidDispose(() => {
      this.panel = undefined
    })

    if (this.pendingSessionId) {
      const sessionId = this.pendingSessionId
      this.pendingSessionId = undefined
      this.post({ type: 'open-session', sessionId })
    } else if (this.controller.current.sessionId) {
      // Show the session that is currently bound to the workspace.
      this.post({ type: 'open-session', sessionId: this.controller.current.sessionId })
    }
  }

  /** Open a session in the tab, opening the tab first when needed. */
  openSession(sessionId: string): void {
    if (!this.panel) {
      this.pendingSessionId = sessionId
      this.open()
      return
    }
    this.post({ type: 'open-session', sessionId })
  }

  /** Reload the embedded SPA, e.g. after the host was reconnected. */
  reload(): void {
    this.post({ type: 'reload' })
  }

  private post(message: HostToWebview): void {
    void this.panel?.webview.postMessage({ ...message, source: 'dsh-vscode-host' })
  }

  private postState(): void {
    if (!this.panel) return
    this.post({ type: 'state', state: this.controller.current })
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
        const payload = message.message as { type?: string; sessionId?: string } | undefined
        if (payload?.type === 'session-changed' && payload.sessionId) {
          this.logger.info(`editor tab session changed to ${payload.sessionId}`)
        }
        return
      }
      default:
        return
    }
  }

  dispose(): void {
    this.stateSubscription.dispose()
    this.panel?.dispose()
    this.panel = undefined
  }
}
