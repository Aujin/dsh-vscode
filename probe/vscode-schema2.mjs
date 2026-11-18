// Probe 9: extract the `viewsContainers` JSON schema (Res) and check for a secondarySidebar property
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const base = `${process.env.LOCALAPPDATA}\\Programs\\Microsoft VS Code`
const candidates = [join(base, 'resources', 'app')]
for (const name of readdirSync(base)) {
  const p = join(base, name)
  try { if (statSync(p).isDirectory()) candidates.push(join(p, 'resources', 'app')) } catch {}
}
const appDir = candidates.find((p) => existsSync(join(p, 'out', 'vs', 'workbench')))
const code = readFileSync(join(appDir, 'out', 'vs', 'workbench', 'workbench.desktop.main.js'), 'utf8')

const i = code.indexOf('registerExtensionPoint({extensionPoint:"viewsContainers"')
// walk backwards to find `Res=` definition
const before = code.slice(Math.max(0, i - 6000), i)
const j = before.lastIndexOf('Res=')
console.log('--- schema Res (viewsContainers) ---')
console.log(before.slice(j).replace(/\s+/g, ' '))

const k = code.indexOf('isValidViewsContainer(')
console.log('\n--- isValidViewsContainer ---')
console.log(code.slice(k, k + 700).replace(/\s+/g, ' '))

console.log('\n--- count of "secondarySidebar" occurrences:', (code.match(/secondarySidebar/g) || []).length)
console.log('--- contexts ---')
let m, n = 0
const re = /secondarySidebar/g
while ((m = re.exec(code)) && n < 12) {
  console.log('  ...' + code.slice(Math.max(0, m.index - 120), m.index + 140).replace(/\s+/g, ' ') + '...')
  n++
}
