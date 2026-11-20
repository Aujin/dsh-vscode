// Checks the remote instance support and the install hint.
//
//   node probe\remote-probe.mjs <host:port>
//
// The host argument is an already running dsh web; the probe connects to it
// through the `dsh.remoteUrl` setting and checks that the extension neither
// scans the local ports nor starts a second host.
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Module = require('node:module')

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

const { DshHost, INSTALL_HINT } = require('../dist/host.js')

const target = process.argv[2] ?? '127.0.0.1:1249'
const baseUrl = target.includes('://') ? target : `http://${target}`

let failures = 0
function check(label, ok, detail = '') {
  if (ok) {
    console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    failures += 1
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const logger = {
  info: (message) => console.log(`  [info] ${message}`),
  warn: (message) => console.log(`  [warn] ${message}`),
  error: (message) => console.log(`  [error] ${message}`),
}

// 1. A configured remote instance is the only candidate.
const options = {
  webUrl: '',
  autoStart: false,
  autoStartPort: 3080,
  remoteUrl: baseUrl,
}
const host = new DshHost(logger, () => options)
const candidates = host.candidateUrls(options)
check('the remote instance is the only candidate', candidates.length === 1, JSON.stringify(candidates))
check(
  'the candidate carries the remote source',
  candidates[0]?.source === 'dsh.remoteUrl',
  candidates[0]?.source,
)

// 2. Attaching to the remote instance works and starts nothing locally.
const attached = await host.connect()
check('the remote instance is attached', attached?.mode === 'attached', attached?.baseUrl)
check('the attached host is the remote one', attached?.baseUrl === baseUrl, attached?.baseUrl)
check('no second host was started', host.ownsProcess === false)

// 3. An unreachable remote instance reports a helpful error.
const broken = new DshHost(logger, () => ({ ...options, remoteUrl: 'http://127.0.0.1:1' }))
let failure = ''
try {
  await broken.connect()
} catch (error) {
  failure = String(error?.message ?? error)
}
check('an unreachable remote instance fails', failure.length > 0, failure.split('\n')[0])
check('the error mentions the remote instance', failure.includes('远程'), failure.split('\n')[0])

// 4. The install hint names the npm package and the app website.
check('the hint mentions the npm package', INSTALL_HINT.includes('npm install -g @deepseek-ai/dsh'))
check('the hint mentions the app website', INSTALL_HINT.includes('https://harness.deepseek.com'))

if (failures > 0) {
  console.error(`REMOTE FAILED (${failures})`)
  process.exit(1)
}
console.log('REMOTE OK')
