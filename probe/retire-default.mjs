// Retires the host's own default workspace registration (the folder below the
// documents directory that dsh creates automatically). The directory and every
// session log are kept by the host; only the registration disappears.
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'

const require = createRequire(import.meta.url)
const { DshHost } = require('../dist/host.js')
const { DshRpc } = require('../dist/rpc.js')
const { WorkspaceBinding } = require('../dist/binding.js')
const { WorkspaceDirectory } = require('../dist/workspaces.js')

const logger = {
  info: (message) => console.log(`  [info] ${message}`),
  warn: (message) => console.log(`  [warn] ${message}`),
  error: (message) => console.log(`  [error] ${message}`),
  show: () => {},
}

const host = new DshHost(logger, () => ({ webUrl: '', autoStart: true, autoStartPort: 3080 }))
await host.connect()

const rpc = new DshRpc(() => host.current, logger)
const binding = new WorkspaceBinding(rpc, logger)
const directory = new WorkspaceDirectory(() => host.current, logger)
await directory.ensureConnected()
await new Promise((resolve) => setTimeout(resolve, 1200))

const before = directory.list()
console.log('workspaces before:')
for (const entry of before) console.log('  -', entry.title, '->', entry.path)

const targets = before.filter(
  (entry) =>
    entry.title.trim().toLowerCase() === 'default-workspace' ||
    entry.path.replace(/\//g, '\\').toLowerCase().endsWith('\\deepseek-harness\\default-workspace'),
)

if (targets.length === 0) {
  console.log('nothing to retire')
} else {
  for (const target of targets) {
    await binding.deleteWorkspace(target.workspaceId)
    console.log('retired', target.workspaceId, target.path)
    console.log('  directory still there:', existsSync(target.path))
  }
}

await new Promise((resolve) => setTimeout(resolve, 1200))
console.log('workspaces after:')
for (const entry of directory.list()) console.log('  -', entry.title, '->', entry.path)

const sessions = await binding.listSessions()
const kept = sessions.filter((session) =>
  targets.some((target) => (session.cwd ?? '').toLowerCase() === target.path.toLowerCase()),
)
console.log('sessions of the retired workspace are still listed:', kept.length)

directory.dispose()
await host.dispose()
process.exit(0)
