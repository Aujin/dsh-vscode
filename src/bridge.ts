/**
 * Script injected into the dsh SPA page served through the extension proxy.
 *
 * The SPA keeps its current session in client-side state, so the extension
 * cannot address a session over the wire. The bridge therefore does two
 * things: it opens a requested session by clicking the matching row, and it
 * reports the session that is currently open back to the extension.
 */
export const BRIDGE_SCRIPT = `(() => {
  const BRIDGE = 'dsh-vscode-bridge';
  const escapeValue = (value) => {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(String(value));
    return String(value).replace(/["\\\\]/g, '\\\\$&');
  };
  const post = (message) => {
    try { window.parent.postMessage(Object.assign({ source: BRIDGE }, message), '*'); } catch (error) { /* ignore */ }
  };
  const sessionRow = (sessionId) => document.querySelector('[data-row-key="session:' + escapeValue(sessionId) + '"]');
  const currentSessionId = () => {
    const node = document.querySelector('[data-conversation-session]');
    return node ? node.getAttribute('data-conversation-session') : null;
  };

  // The workspace tree renders a session row only inside an expanded
  // workspace, so collapsed workspaces are opened once before giving up.
  const expandWorkspaces = () => {
    const rows = document.querySelectorAll('[data-row-key^="workspace:"]');
    rows.forEach((row) => {
      if (row.getAttribute('aria-expanded') === 'false') {
        try { row.click(); } catch (error) { /* ignore */ }
      }
    });
  };

  const openSession = (sessionId) => {
    let attempts = 0;
    let expanded = false;
    const attempt = () => {
      if (currentSessionId() === sessionId) {
        post({ type: 'opened', sessionId });
        return;
      }
      const row = sessionRow(sessionId);
      if (row) {
        try { row.click(); } catch (error) { /* ignore */ }
        window.setTimeout(() => {
          if (currentSessionId() === sessionId) {
            post({ type: 'opened', sessionId });
          } else {
            attempt();
          }
        }, 300);
        return;
      }
      if (!expanded && attempts > 8) {
        expanded = true;
        expandWorkspaces();
      }
      if (attempts++ < 120) {
        window.setTimeout(attempt, 250);
        return;
      }
      post({ type: 'open-failed', sessionId });
    };
    attempt();
  };

  let last = null;
  const report = () => {
    const id = currentSessionId();
    if (id !== last) {
      last = id;
      post({ type: 'session-changed', sessionId: id });
    }
  };

  // Diagnostics: report what the SPA actually rendered, so a blank sidebar
  // can be told apart from a failed boot without opening dev tools.
  const errors = [];
  window.addEventListener('error', (event) => {
    errors.push(String(event.message || event.error || 'error'));
    post({ type: 'page-error', message: String(event.message || event.error || 'error') });
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event && event.reason ? String(event.reason) : 'rejection';
    errors.push(reason);
    post({ type: 'page-error', message: reason });
  });

  let lastDiagnostic = '';
  const diagnose = () => {
    const boot = document.querySelector('[data-dsh-boot]');
    let text = '';
    try {
      text = (document.body && document.body.innerText ? document.body.innerText : '').replace(/\\s+/g, ' ').trim().slice(0, 240);
    } catch (error) {
      text = '';
    }
    const state = JSON.stringify({
      title: document.title,
      url: window.location.href,
      boot: boot ? (boot.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160) : null,
      text,
      errors: errors.slice(-3),
    });
    if (state !== lastDiagnostic) {
      lastDiagnostic = state;
      post({ type: 'diagnostic', state: JSON.parse(state) });
    }
  };

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.source !== 'dsh-vscode') return;
    if (data.type === 'open-session' && data.sessionId) openSession(data.sessionId);
    if (data.type === 'reload') window.location.reload();
  });
  window.setInterval(report, 500);
  window.setInterval(diagnose, 1500);
  post({ type: 'ready', url: window.location.href });
})();
`
