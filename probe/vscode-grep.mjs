// Probe 7: what does the local VS Code support for SECONDARY (auxiliary) side bar views?
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const base = `${process.env.LOCALAPPDATA}\\Programs\\Microsoft VS Code`
const candidates = [join(base, 'resources', 'app')]
for (const name of readdirSync(base)) {
  const p = join(base, name)
  try { if (statSync(p).isDirectory()) candidates.push(join(p, 'resources', 'app')) } catch {}
}
const appDir = candidates.find((p) => existsSync(join(p, 'out', 'vs', 'workbench'))) ?? candidates[0]
console.log('appDir:', appDir, 'exists:', existsSync(appDir))
const wb = join(appDir, 'out', 'vs', 'workbench')
console.log('\n-- out/vs/workbench top level --')
console.log(readdirSync(wb).join('  '))
const apiCommon = join(wb, 'api', 'common')
if (existsSync(apiCommon)) console.log('\n-- api/common --\n' + readdirSync(apiCommon).join('  '))

function walk(dir, out = [], depth = 0) {
  if (depth > 4) return out
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    try {
      const s = statSync(p)
      if (s.isDirectory()) walk(p, out, depth + 1)
      else if (/\.js$/.test(name)) out.push(p)
    } catch {}
  }
  return out
}
const files = walk(wb)
console.log('\njs files under workbench:', files.length)

const patterns = [
  'viewsContainers',
  'workbench.auxiliaryBar',
  'auxiliarybar',
  'secondarySideBar',
  'moveViewToSecondarySideBar',
  'toggleAuxiliaryBar',
  'AuxiliaryBar',
]
const hits = new Map(patterns.map((p) => [p, []]))
for (const f of files) {
  const code = readFileSync(f, 'utf8')
  for (const p of patterns) {
    if (hits.get(p).length >= 4) continue
    let i = code.indexOf(p)
    while (i !== -1 && hits.get(p).length < 4) {
      hits.get(p).push({ f, ctx: code.slice(Math.max(0, i - 260), i + 260) })
      i = code.indexOf(p, i + p.length)
    }
  }
}
for (const p of patterns) {
  const list = hits.get(p)
  console.log(`\n===== ${p}: ${list.length} hits =====`)
  for (const h of list.slice(0, 4)) console.log(`  [${h.f.replace(appDir, '')}]\n   ...${h.ctx.replace(/\s+/g, ' ')}...\n`)
}
