import { createRequire } from 'node:module'
import { request } from 'node:http'
const require = createRequire(import.meta.url)
const { readBrowserSessionSecret, mintBrowserCookie } = require('../dist/credentials.js')
const authority = '127.0.0.1:8080'
const cookie = mintBrowserCookie(authority, readBrowserSessionSecret())
const html = await new Promise((resolve) => {
  const req = request({ host: '127.0.0.1', port: 8080, path: '/', method: 'GET', headers: { host: authority, cookie, 'accept-encoding': 'identity' } }, (r) => {
    const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => resolve(Buffer.concat(c).toString('utf8')))
  }); req.end()
})
let boot
const i = html.indexOf('__DSH_BOOT__')
const start = html.indexOf('{', i)
let depth = 0
for (let k = start; k < html.length; k++) {
  if (html[k] === '{') depth++
  else if (html[k] === '}') { depth--; if (depth === 0) { boot = JSON.parse(html.slice(start, k + 1)); break } }
}
console.log('entries', boot.entries.length, 'batches', boot.batches.length)
for (const b of boot.batches) {
  console.log('batch', b.phase, 'entries', b.entries.length, 'url len', b.url.length)
  for (const e of b.entries) {
    if (/primitives|brand/i.test(e.id ?? '')) console.log('   ', JSON.stringify(e).slice(0, 300))
  }
  const prim = b.entries.filter((e) => e.id?.includes('primitives'))
  console.log('   primitives in batch:', prim.length)
}
