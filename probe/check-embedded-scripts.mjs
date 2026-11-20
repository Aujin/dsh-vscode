// Syntax-checks the JavaScript that the extension embeds into web pages.
//
// The webview script and the SPA bridge script are written as string literals
// in TypeScript, so a stray backslash can silently turn them into invalid
// JavaScript: the webview would then do nothing at all without reporting an
// error. This probe parses both scripts and fails when either one is broken.
import { createRequire } from 'node:module'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const Module = require('node:module')

// The compiled modules import `vscode`, which only exists inside VS Code.
const originalResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return 'vscode-stub'
  return originalResolve.call(this, request, ...rest)
}
require.cache['vscode-stub'] = {
  id: 'vscode-stub',
  filename: 'vscode-stub',
  loaded: true,
  exports: {
    window: {},
    workspace: { getConfiguration: () => ({ get: () => undefined }) },
    Uri: { joinPath: (...parts) => parts.join('/') },
  },
}

const { renderDshHtml } = require('../dist/webviewHtml.js')
const { BRIDGE_SCRIPT } = require('../dist/bridge.js')

const html = renderDshHtml(
  { cspSource: 'vscode-webview://01234567-89ab-cdef-0123-456789abcdef' },
  { proxyUrl: 'http://127.0.0.1:12345' },
)

const match = html.match(/<script nonce="([^"]+)">([\s\S]*?)<\/script>/)
if (!match) {
  console.error('FAIL: the webview html contains no inline script')
  process.exit(1)
}

const [, nonce, script] = match
const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/)
if (!csp) {
  console.error('FAIL: the webview html contains no content security policy')
  process.exit(1)
}
if (!csp[1].includes(`'nonce-${nonce}'`)) {
  console.error(`FAIL: the content security policy does not carry the nonce of the script`)
  process.exit(1)
}
if (script.includes('__PROXY_URL__')) {
  console.error('FAIL: the proxy url placeholder was not replaced')
  process.exit(1)
}

let failures = 0
for (const [name, code] of [
  ['webview script', script],
  ['SPA bridge script', BRIDGE_SCRIPT],
]) {
  try {
    new vm.Script(code, { filename: `${name}.js` })
    console.log(`ok  ${name} (${code.length} bytes)`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${name}: ${error.message}`)
  }
}

if (failures > 0) process.exit(1)
console.log('EMBEDDED SCRIPTS OK')
