// Probe 15b: confirm VS Code command ids + viewsContainers.secondarySidebar description
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const base = `${process.env.LOCALAPPDATA}\\Programs\\Microsoft VS Code`
const appDir = (() => {
  for (const name of readdirSync(base)) {
    const p = join(base, name, 'resources', 'app')
    if (existsSync(join(p, 'out', 'vs', 'workbench'))) return p
  }
  return join(base, 'resources', 'app')
})()

const code = readFileSync(join(appDir, 'out', 'vs', 'workbench', 'workbench.desktop.main.js'), 'utf8')

// nls files: search a few likely spots for a file (not dir) containing "Secondary Side Bar"
const spots = [
  join(appDir, 'out', 'nls.messages.json'),
  join(appDir, 'out', 'nls.metadata.json'),
  join(appDir, 'out', 'vs', 'workbench', 'workbench.desktop.main.nls.js'),
]
for (const p of spots) {
  if (!existsSync(p) || statSync(p).isDirectory()) continue
  const nls = readFileSync(p, 'utf8')
  for (const id of [8273, 8300]) {
    const m = nls.match(new RegExp(`"?${id}"?\\s*:\\s*"([^"]*)"`))
    console.log(`nls ${id} (${p.split('\\').pop()}):`, m ? m[1] : '(not found)')
  }
  const idx = nls.indexOf('Secondary Side Bar')
  if (idx !== -1) console.log('  ...context:', nls.slice(Math.max(0, idx - 200), idx + 120).replace(/\s+/g, ' '))
}

const commands = [
  'workbench.action.toggleAuxiliaryBar',
  'workbench.action.moveViewToSecondarySideBar',
  'workbench.action.openView',
  'auxiliarybar.focus',
  'workbench.action.toggleAuxiliaryBarPosition',
  'workbench.action.closeSidebar',
]
for (const c of commands) console.log(`${code.includes(`"${c}"`) ? 'FOUND  ' : 'absent '} ${c}`)
