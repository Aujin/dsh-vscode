import { createRequire } from 'node:module'
import http from 'node:http'

const require = createRequire(import.meta.url)
const { readBrowserSessionSecret, mintBrowserCookie } = require('../dist/credentials.js')

const authority = process.argv[2] ?? '127.0.0.1:1249'
const port = Number(authority.split(':')[1])
const cookie = mintBrowserCookie(authority, readBrowserSessionSecret())

const html = await new Promise((resolve) => {
  http.get(
    { host: '127.0.0.1', port, path: '/', headers: { host: authority, cookie, 'accept-encoding': 'identity' } },
    (res) => {
      const chunks = []
      res.on('data', (d) => chunks.push(d))
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    },
  )
})

const match = html.match(/globalThis\["__DSH_BOOT__"\]\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/)
const boot = JSON.parse(match[1])
console.log('release:', JSON.stringify(boot.release), 'rev:', boot.rev)
console.log('entries:', boot.entries.length, 'batches:', boot.batches.length)
console.log('entries with external:', boot.entries.filter((e) => e.external).map((e) => e.id))
console.log('batches:', JSON.stringify(boot.batches.map((b) => ({ phase: b.phase, url: b.url, n: b.entries?.length }))))
console.log('sample entry:', JSON.stringify(boot.entries[0]))
const ids = boot.entries.map((e) => e.id)
console.log('has api-gateway:', ids.includes('@deepseek-ai/dsh-api-gateway'), 'has client-connection:', ids.includes('@deepseek-ai/dsh-client-connection'))
console.log('all ids:', ids.join(', '))
