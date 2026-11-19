import { createRequire } from 'node:module'
import http from 'node:http'

const require = createRequire(import.meta.url)
const { readBrowserSessionSecret, mintBrowserCookie } = require('../dist/credentials.js')
const authority = '127.0.0.1:6918'
const cookie = mintBrowserCookie(authority, readBrowserSessionSecret())

const get = (path) =>
  new Promise((res, rej) => {
    const r = http.request(
      { host: '127.0.0.1', port: 6918, path, headers: { host: authority, cookie, 'accept-encoding': 'identity' } },
      (x) => {
        const c = []
        x.on('data', (d) => c.push(d))
        x.on('end', () => res(Buffer.concat(c).toString('utf8')))
      },
    )
    r.on('error', rej)
    r.end()
  })

const html = await get('/')
const src = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)]
  .map((m) => m[1].replace(/&amp;/g, '&'))
  .find((s) => s.includes('assets/'))
const bundle = await get('/' + src.replace(/^\.\//, ''))

console.log('--- literal "0 0 24 24" occurrences ---')
for (const m of bundle.matchAll(/"0 0 24 24"/g)) console.log('@', m.index, bundle.slice(Math.max(0, m.index - 120), m.index + 60))

console.log('\n--- all "Ca=" occurrences (first 5) ---')
let n = 0
for (const m of bundle.matchAll(/\bCa\s*=/g)) {
  console.log('@', m.index, JSON.stringify(bundle.slice(m.index, m.index + 80)))
  n += 1
  if (n >= 5) break
}

console.log('\n--- FishLogo usage sites ---')
let k = 0
for (const m of bundle.matchAll(/FishLogo/g)) {
  console.log('@', m.index, JSON.stringify(bundle.slice(Math.max(0, m.index - 200), m.index + 120)))
  k += 1
  if (k >= 4) break
}
