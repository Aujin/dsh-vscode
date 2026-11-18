// Probe 13: VS Code webview iframe sandbox attributes
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const base = `${process.env.LOCALAPPDATA}\\Programs\\Microsoft VS Code`
const candidates = [join(base, 'resources', 'app')]
for (const name of readdirSync(base)) {
  const p = join(base, name)
  try { if (statSync(p).isDirectory()) candidates.push(join(p, 'resources', 'app')) } catch {}
}
const appDir = candidates.find((p) => existsSync(join(p, 'out', 'vs', 'workbench')))
const files = [
  join(appDir, 'out', 'vs', 'workbench', 'workbench.desktop.main.js'),
  join(appDir, 'out', 'vs', 'workbench', 'api', 'node', 'extensionHostProcess.js'),
]
for (const f of files) {
  if (!existsSync(f)) continue
  const code = readFileSync(f, 'utf8')
  console.log(`\n########## ${f.replace(appDir, '')} ##########`)
  let i = -1
  let n = 0
  while ((i = code.indexOf('allow-scripts', i + 1)) !== -1 && n < 5) {
    console.log(`--- hit ${++n} ---`)
    console.log(code.slice(Math.max(0, i - 500), i + 400).replace(/\s+/g, ' '))
  }
  for (const needle of ['webview.cspSource', 'frame-src', 'webviewOptions']) {
    const j = code.indexOf(needle)
    console.log(`\n[${needle}] ${j === -1 ? 'NOT FOUND' : code.slice(Math.max(0, j - 300), j + 300).replace(/\s+/g, ' ')}`)
  }
}
