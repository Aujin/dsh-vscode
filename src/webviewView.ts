import * as vscode from 'vscode'
import { type DshController, type DshState } from './controller'
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

  constructor(
    private readonly controller: DshController,
    private readonly logger: Logger,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = { enableScripts: true, localResourceRoots: [] }
    view.webview.html = this.render(view.webview)
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
          this.logger.info(`sidebar session changed to ${payload.sessionId}`)
        }
        return
      }
      default:
        return
    }
  }

  private render(webview: vscode.Webview): string {
    const nonce = createNonce()
    const proxyUrl = this.controller.current.proxyUrl ?? ''
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      'frame-src http://127.0.0.1:*',
      'connect-src http://127.0.0.1:*',
    ].join('; ')

    return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DeepSeek Harness</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; padding: 0; }
  body {
    display: flex; flex-direction: column; height: 100vh; overflow: hidden;
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
    color: var(--vscode-foreground); background: var(--vscode-sideBar-background);
  }
  header {
    display: flex; align-items: center; gap: 6px; padding: 6px 8px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-charts-yellow); flex: none; }
  .dot.ready { background: var(--vscode-charts-green); }
  .dot.error { background: var(--vscode-charts-red); }
  #path {
    flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--vscode-descriptionForeground);
  }
  .actions { display: flex; gap: 2px; flex: none; }
  button {
    background: transparent; border: none; color: var(--vscode-foreground); cursor: pointer;
    padding: 2px 5px; border-radius: 3px; font-size: 13px; line-height: 18px;
  }
  button:hover { background: var(--vscode-toolbar-hoverBackground); }
  button:disabled { opacity: .45; cursor: default; }
  #status {
    padding: 4px 10px; font-size: 11px; color: var(--vscode-descriptionForeground);
    border-bottom: 1px solid var(--vscode-panel-border); white-space: nowrap; overflow: hidden;
    text-overflow: ellipsis;
  }
  #status.hidden { display: none; }
  iframe { flex: 1 1 auto; width: 100%; border: none; background: var(--vscode-editor-background); }
</style>
</head>
<body>
  <header>
    <span id="dot" class="dot"></span>
    <span id="path" title="">未绑定目录</span>
    <span class="actions">
      <button id="new-session" title="新建会话">＋</button>
      <button id="pick-session" title="选择会话">会话</button>
      <button id="bind" title="绑定当前目录">目录</button>
      <button id="bind-new" title="新建工作目录">＋目录</button>
      <button id="unbind" title="解除目录绑定">✕</button>
      <button id="reconnect" title="重新连接">⟳</button>
      <button id="open-browser" title="在浏览器中打开">↗</button>
    </span>
  </header>
  <div id="status" class="hidden"></div>
  <iframe id="dsh-frame" src="${proxyUrl}/" allow="local-network-access; autoplay; clipboard-read; clipboard-write"></iframe>
  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();
      const frame = document.getElementById('dsh-frame');
      const dot = document.getElementById('dot');
      const pathLabel = document.getElementById('path');
      const status = document.getElementById('status');
      let ready = false;
      let pendingSession = null;
      let hostReady = false;

      function send(message) { vscode.postMessage(message); }

      function action(name) { send({ type: 'action', action: name }); }

      document.getElementById('new-session').addEventListener('click', function () { action('new-session'); });
      document.getElementById('pick-session').addEventListener('click', function () { action('pick-session'); });
      document.getElementById('bind').addEventListener('click', function () { action('bind'); });
      document.getElementById('bind-new').addEventListener('click', function () { action('bind-new'); });
      document.getElementById('unbind').addEventListener('click', function () { action('unbind'); });
      document.getElementById('reconnect').addEventListener('click', function () { action('reconnect'); });
      document.getElementById('open-browser').addEventListener('click', function () { action('open-browser'); });

      function setStatus(text, kind) {
        if (!text) { status.classList.add('hidden'); status.textContent = ''; return; }
        status.classList.remove('hidden');
        status.textContent = text;
        status.title = text;
        if (kind) dot.className = 'dot ' + kind;
      }

      function applyState(state) {
        const current = (state && state.status) || { kind: 'connecting' };
        const bound = state && state.boundPath;
        pathLabel.textContent = bound || '未绑定目录';
        pathLabel.title = bound || '';
        if (current.kind === 'ready') {
          const sessions = (state && state.sessions) || [];
          const workspaces = (state && state.workspaces) || [];
          const hostDefault = workspaces.some(function (entry) { return isDefaultWorkspace(entry); });
          const boundWorkspace = workspaces.find(function (entry) {
            return bound && entry.path && bound.toLowerCase() === entry.path.toLowerCase();
          });
          const parts = [];
          parts.push(boundWorkspace ? '工作区 ' + boundWorkspace.title : (bound ? '工作区' : '未绑定目录'));
          if (bound) parts.push(sessions.length + ' 个会话');
          if (!bound) parts.push('不会创建 dsh 工作区');
          if (hostDefault) parts.push('主机默认工作区仍存在');
          setStatus(parts.join(' · '), 'ready');
          pathLabel.title = (bound || '') + ' · ' + sessions.length + ' 个会话';
          if (!hostReady) {
            // The frame was rendered while dsh web was not reachable yet: reload
            // it so the SPA boots against a live host.
            hostReady = true;
            frame.src = frame.src;
          }
        } else if (current.kind === 'error') {
          hostReady = false;
          setStatus(current.message, 'error');
        } else {
          hostReady = false;
          setStatus('正在连接 dsh web …', '');
        }
      }

      function isDefaultWorkspace(entry) {
        if (!entry) return false;
        if (String(entry.title || '').trim().toLowerCase() === 'default-workspace') return true;
        return String(entry.path || '').replace(/\//g, '\\').toLowerCase().indexOf('\\deepseek-harness\\default-workspace') >= 0;
      }

      window.addEventListener('message', function (event) {
        const data = event.data;
        if (!data || typeof data !== 'object') return;
        if (data.source === 'dsh-vscode-bridge') {
          if (data.type === 'ready') {
            ready = true;
            send({ type: 'ready' });
            if (pendingSession) {
              frame.contentWindow.postMessage({ source: 'dsh-vscode', type: 'open-session', sessionId: pendingSession }, '*');
              pendingSession = null;
            }
          } else { send({ type: 'bridge', message: data }); }
          return;
        }
        if (data.source === 'dsh-vscode-host') {
          if (data.type === 'state') applyState(data.state);
          else if (data.type === 'open-session') {
            if (ready) frame.contentWindow.postMessage({ source: 'dsh-vscode', type: 'open-session', sessionId: data.sessionId }, '*');
            else pendingSession = data.sessionId;
          } else if (data.type === 'reload') {
            frame.src = frame.src;
          }
        }
      });

      send({ type: 'ready' });
    })();
  </script>
</body>
</html>`
  }
}

function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let nonce = ''
  for (let index = 0; index < 32; index += 1) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length))
  }
  return nonce
}
