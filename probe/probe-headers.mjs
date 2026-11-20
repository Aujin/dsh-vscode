import { createRequire } from 'node:module'
import http from 'node:http'

const require = createRequire(import.meta.url)
const { readBrowserSessionSecret, mintBrowserCookie } = require('../dist/credentials.js')

const authority = process.argv[2] ?? '127.0.0.1:1249'
const port = Number(authority.split(':')[1])
const cookie = mintBrowserCookie(authority, readBrowserSessionSecret())

function get(path, extra = {}) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, headers: { host: authority, cookie, 'accept-encoding': 'identity', ...extra } },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
      },
    )
    req.on('error', (e) => resolve({ status: 0, headers: {}, body: Buffer.from(String(e.message)) }))
    req.end()
  })
}

for (const path of ['/', '/assets/index-Ciz7DZxv.js', '/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=8121b3531e9d']) {
  const r = await get(path)
  console.log(`\n=== ${path} -> ${r.status} (${r.body.length} bytes) ===`)
  for (const [key, value] of Object.entries(r.headers)) {
    console.log(`  ${key}: ${Array.isArray(value) ? value.join(' | ') : value}`)
  }
}
