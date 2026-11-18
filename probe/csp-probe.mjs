// Probe 14: does VS Code prepend its own CSP (with frame-src 'none') into extension webviews?
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

console.log("occurrences of 'default-src':", (code.match(/default-src/g) || []).length)
let i = -1
let n = 0
while ((i = code.indexOf('default-src', i + 1)) !== -1 && n < 8) {
  const w = code.slice(Math.max(0, i - 420), i + 420).replace(/\s+/g, ' ')
  console.log(`\n--- default-src hit ${++n} ---\n${w}`)
}
console.log('\n\n=== _prependToHead occurrences:', (code.match(/_prependToHead/g) || []).length)
let j = code.indexOf('_prependToHead')
console.log(code.slice(Math.max(0, j - 900), j + 500).replace(/\s+/g, ' '))
