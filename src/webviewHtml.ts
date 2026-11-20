import * as vscode from 'vscode'

export interface DshHtmlOptions {
  /** Base URL of the extension's loopback proxy, e.g. `http://127.0.0.1:53124`. */
  proxyUrl: string
  /** Document title of the embedded webview. */
  title?: string
}

/**
 * Inline script of the embedded webview.
 *
 * The script is written with `String.raw` so that the JavaScript that reaches
 * the browser is byte for byte the JavaScript below - a template literal would
 * eat the backslashes of the regular expressions below and produce a script
 * that fails to parse (and then silently does nothing).
 */
const WEBVIEW_SCRIPT = String.raw`
(function () {
  // The webview is sandboxed: report liveness and failures through the proxy
  // so a broken script shows up in the extension log instead of leaving the
  // header in its static state.
  try { new Image().src = '__PROXY_URL__/__webview-ping'; } catch (error) { void error; }
  try {
    (function () {
      var vscode = acquireVsCodeApi();
      var frame = document.getElementById('dsh-frame');
      var dot = document.getElementById('dot');
      var pathLabel = document.getElementById('path');
      var status = document.getElementById('status');
      var ready = false;
      var pendingSession = null;
      var hostReady = false;

      function send(message) { vscode.postMessage(message); }

      function action(name) { send({ type: 'action', action: name }); }

      frame.addEventListener('load', function () { send({ type: 'frame', event: 'loaded', url: frame.src }); });
      frame.addEventListener('error', function () { send({ type: 'frame', event: 'error', url: frame.src }); });

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

      function isDefaultWorkspace(entry) {
        if (!entry) return false;
        if (String(entry.title || '').trim().toLowerCase() === 'default-workspace') return true;
        var normalized = String(entry.path || '').split('/').join('\\').toLowerCase();
        return normalized.indexOf('\\deepseek-harness\\default-workspace') >= 0;
      }

      function applyState(state) {
        var current = (state && state.status) || { kind: 'connecting' };
        var bound = state && state.boundPath;
        pathLabel.textContent = bound || '未绑定目录';
        pathLabel.title = bound || '';
        if (current.kind === 'ready') {
          var sessions = (state && state.sessions) || [];
          var workspaces = (state && state.workspaces) || [];
          var hostDefault = workspaces.some(function (entry) { return isDefaultWorkspace(entry); });
          var boundWorkspace = workspaces.find(function (entry) {
            return bound && entry.path && bound.toLowerCase() === entry.path.toLowerCase();
          });
          var parts = [];
          parts.push(boundWorkspace ? '工作区 ' + boundWorkspace.title : (bound ? '工作区' : '未绑定目录'));
          if (bound) parts.push(sessions.length + ' 个会话');
          if (!bound) parts.push('不会创建 dsh 工作区');
          if (hostDefault) parts.push('主机默认工作区仍存在');
          setStatus(parts.join(' · '), 'ready');
          pathLabel.title = (bound || '') + ' · ' + sessions.length + ' 个会话';
          var proxyUrl = state && state.proxyUrl;
          if (proxyUrl && frame.src.indexOf(proxyUrl) !== 0) {
            // The frame was rendered before the proxy URL was known (the
            // sidebar can resolve before the host was found) or the proxy was
            // restarted: point the frame at the current proxy.
            frame.src = proxyUrl + '/';
          } else if (!hostReady) {
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

      window.addEventListener('message', function (event) {
        var data = event.data;
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
  } catch (error) {
    try {
      new Image().src = '__PROXY_URL__/__webview-error?msg=' + encodeURIComponent(String((error && error.message) || error));
    } catch (inner) { void inner; }
  }
})();
`

/**
 * Renders the DeepSeek Harness SPA inside a webview. The SPA is loaded from
 * the extension's loopback proxy, which forwards it to the dsh web host with a
 * valid authentication cookie.
 *
 * The same markup is used by the secondary side bar view and by the editor
 * tab opened from the editor title bar badge.
 */
export function renderDshHtml(webview: vscode.Webview, options: DshHtmlOptions): string {
  const nonce = createNonce()
  const proxyUrl = options.proxyUrl
  const title = options.title ?? 'DeepSeek Harness'
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} https: data: http://127.0.0.1:*`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
    'frame-src http://127.0.0.1:*',
    'connect-src http://127.0.0.1:*',
  ].join('; ')
  const script = WEBVIEW_SCRIPT.replace(/__PROXY_URL__/g, proxyUrl)

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
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
  <script nonce="${nonce}">${script}</script>
</body>
</html>`
}

export function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let nonce = ''
  for (let index = 0; index < 32; index += 1) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length))
  }
  return nonce
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
