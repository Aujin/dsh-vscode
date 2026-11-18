// Probe 8: exact `viewsContainers` / `views` extension-point schemas in the local VS Code bundle
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const base = `${process.env.LOCALAPPDATA}\\Programs\\Microsoft VS Code`
const candidates = [join(base, 'resources', 'app')]
for (const name of readdirSync(base)) {
  const p = join(base, name)
  try { if (statSync(p).isDirectory()) candidates.push(join(p, 'resources', 'app')) } catch {}
}
const appDir = candidates.find((p) => existsSync(join(p, 'out', 'vs', 'workbench')))
const file = join(appDir, 'out', 'vs', 'workbench', 'workbench.desktop.main.js')
const code = readFileSync(file, 'utf8')

function show(label, re, span = 1400) {
  const m = re.exec(code)
  console.log(`\n########## ${label} ##########`)
  if (!m) { console.log('  NOT FOUND'); return }
  console.log(code.slice(Math.max(0, m.index - span), m.index + span).replace(/\s+/g, ' '))
}
show('viewsContainers extension point registration', /registerExtensionPoint\(\{extensionPoint:"viewsContainers"/)
show('views extension point registration', /registerExtensionPoint\(\{extensionPoint:"views",deps/)
show('auxiliarybar string literal in schema-ish context', /"auxiliarybar"/)
show('ViewContainerLocation enum', /ViewContainerLocation[^;]{0,300}/)
show('secondarySideBar defaultVisibility config', /workbench\.secondarySideBar\.defaultVisibility/)
