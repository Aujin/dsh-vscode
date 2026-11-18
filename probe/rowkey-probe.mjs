// Probe 12: context of data-row-key / session list rows in the SPA workspace bundle
import { readFileSync } from 'node:fs'

for (const name of ['workspace', 'conversation', 'sidebar']) {
  const code = readFileSync(`probe/bundle-${name}.js`, 'utf8')
  console.log(`\n########## ${name} ##########`)
  let i = -1
  let n = 0
  while ((i = code.indexOf('data-row-key', i + 1)) !== -1 && n < 6) {
    console.log(`--- hit ${++n} ---`)
    console.log(code.slice(Math.max(0, i - 700), i + 300).replace(/\s+/g, ' '))
  }
  // class names that look like rows
  const classes = new Set()
  for (const m of code.matchAll(/css_default\.([A-Za-z]*(?:Row|Item|List)[A-Za-z]*)/g)) classes.add(m[1])
  console.log('row-ish css classes:', [...classes].slice(0, 40).join(', '))
}
