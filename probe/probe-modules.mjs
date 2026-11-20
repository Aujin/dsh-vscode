import { createRequire } from 'node:module'
import http from 'node:http'

const require = createRequire(import.meta.url)
const { readBrowserSessionSecret, mintBrowserCookie } = require('../dist/credentials.js')

const authority = process.argv[2] ?? '127.0.0.1:1249'
const port = Number(authority.split(':')[1])
const cookie = mintBrowserCookie(authority, readBrowserSessionSecret())

function get(path) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, headers: { host: authority, cookie, 'accept-encoding': 'identity' } },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, length: Buffer.concat(chunks).length, body: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', (e) => resolve({ status: 0, length: 0, body: String(e.message) }))
    req.end()
  })
}

const html = (await get('/')).body
const match = html.match(/globalThis\["__DSH_BOOT__"\]\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/)
const boot = JSON.parse(match[1])

console.log('--- every boot entry over HTTP ---')
let failures = 0
for (const entry of boot.entries) {
  const r = await get('/' + String(entry.url).replace(/^\.\//, ''))
  const flag = entry.external ? ' [external]' : ''
  if (r.status !== 200) {
    failures += 1
    console.log(`  ${r.status} ${entry.id}${flag}  ${r.body.slice(0, 120)}`)
  } else {
    console.log(`  ${r.status} ${entry.id}${flag}  ${r.length} bytes`)
  }
}
console.log('failures:', failures)

console.log('\n--- every boot batch over HTTP ---')
for (const batch of boot.batches) {
  const r = await get('/' + String(batch.url).replace(/^\.\//, ''))
  console.log(`  ${r.status} ${batch.phase} ${r.length} bytes`)
}
