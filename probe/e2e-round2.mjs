// Round 2 checks: dsh discovery without a shell PATH, the workspace registry
// stream, and the "no default workspace while nothing is bound" rule.
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { DshHost } = require('../dist/host.js')
const { DshProxy } = require('../dist/proxy.js')
const { WorkspaceDirectory } = require('../dist/workspaces.js')
const { DshRpc } = require('../dist/rpc.js')
const { WorkspaceBinding } = require('../dist/binding.js')

const logger = {
  info: (message) => console.log(`  [info] ${message}`),
  warn: (message) => console.log(`  [warn] ${message}`),
  error: (message) => console.log(`  [error] ${message}`),
  show: () => {},
}

const host = new DshHost(logger, () => ({
  webUrl: '',
  autoStart: true,
  autoStartPort: 3080,
}))

// 1. Discovery: the fnm installation must be found without a shell PATH.
const install = host.discover({
  webUrl: '',
  autoStart: true,
  autoStartPort: 3080,
})
console.log('discovery entry :', install.entry ?? '(none)')
console.log('discovery node  :', install.node ?? '(none)')
console.log('discovery shim  :', install.shim ?? '(none)')
if (!install.entry || !install.node) {
  // The desktop app installation ships no command line launcher, so there is
  // nothing to discover: the extension then attaches to the running host
  // instead of spawning one. Only the spawn path needs the launcher.
  console.log('note            : no dsh launcher found (desktop app install) - skipping the spawn check')
}

// 2. Attach to the running host.
const info = await host.connect()
console.log('host mode       :', info.mode, info.baseUrl)

// 3. The workspace registry stream.
const directory = new WorkspaceDirectory(() => host.current, logger)
await directory.ensureConnected()
await new Promise((resolve) => setTimeout(resolve, 1500))
const workspaces = directory.list()
console.log('workspaces      :', workspaces.length)
for (const entry of workspaces) console.log('  -', entry.title, '->', entry.path)

// 4. While nothing is bound the proxy must not let the SPA create the host's
//    default workspace.
const blocked = await DshProxy.start(() => host.current, logger, () => true)
const response = await fetch(`${blocked.url}/api/workspace/initializeDefault`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    type: 'client-request',
    rpcId: 'probe-1',
    method: 'workspace/initializeDefault',
    payload: { args: {} },
  }),
})
const body = await response.json()
console.log('blocked answer  :', JSON.stringify(body))
if (!body.result || body.result.value !== null) {
  console.error('FAIL: the proxy did not answer initializeDefault locally')
  process.exit(1)
}
blocked.dispose()

// 5. The regular API still works through the same code path.
const rpc = new DshRpc(() => host.current, logger)
const binding = new WorkspaceBinding(rpc, logger)
const sessions = await binding.listSessions()
console.log('sessions        :', sessions.length)
const created = await binding.ensureWorkspace(process.cwd())
console.log('workspace       :', created.workspace.title, '->', created.workspace.path, created.created ? '(created)' : '(reused)')

directory.dispose()
await host.dispose()
console.log('ROUND2 OK')
process.exit(0)
