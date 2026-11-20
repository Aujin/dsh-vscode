import { createRequire } from 'node:module'
import http from 'node:http'

const require = createRequire(import.meta.url)
const { readBrowserSessionSecret, mintBrowserCookie } = require('../dist/credentials.js')

const authority = process.argv[2] ?? '127.0.0.1:1249'
const port = Number(authority.split(':')[1])

function get(path, headers = {}) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, headers: { host: authority, 'accept-encoding': 'identity', ...headers } },
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

const secret = readBrowserSessionSecret()
console.log('secret bytes:', secret?.length)
const cookie = mintBrowserCookie(authority, secret)

console.log('\n--- GET / without cookie ---')
let r = await get('/')
console.log('status:', r.status, 'len:', r.body.length, 'has boot:', r.body.toString('utf8').includes('__DSH_BOOT__'))
console.log('body head:', JSON.stringify(r.body.toString('utf8').slice(0, 200)))

console.log('\n--- GET / with minted cookie ---')
r = await get('/', { cookie })
console.log('status:', r.status, 'len:', r.body.length, 'has boot:', r.body.toString('utf8').includes('__DSH_BOOT__'))
console.log('set-cookie:', r.headers['set-cookie'])
console.log('body head:', JSON.stringify(r.body.toString('utf8').slice(0, 300)))

console.log('\n--- POST /api/session/list ---')
const rpc = await get('/api/session/list', {
  cookie,
  'content-type': 'application/json',
  'content-length': '0',
})
console.log('status:', rpc.status, 'body head:', JSON.stringify(rpc.body.toString('utf8').slice(0, 300)))
