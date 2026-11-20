import { createRequire } from 'node:module'
import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'

const require = createRequire(import.meta.url)
const { readBrowserSessionSecret, mintBrowserCookie } = require('../dist/credentials.js')

const authority = process.argv[2] ?? '127.0.0.1:1249'
const port = Number(authority.split(':')[1])
const cookie = mintBrowserCookie(authority, readBrowserSessionSecret())

// 1) unary RPC with a proper body
function post(path, body, headers = {}) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(body))
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { host: authority, cookie, 'content-type': 'application/json', 'content-length': payload.length, 'accept-encoding': 'identity', ...headers },
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', (e) => resolve({ status: 0, body: String(e.message) }))
    req.end(payload)
  })
}

console.log('--- POST /api/session/list (proper body) ---')
let r = await post('/api/session/list', { type: 'client-request', rpcId: 'p1', method: 'session/list', payload: { args: { _request: {} } } })
console.log('status:', r.status, 'body:', r.body.slice(0, 200))

console.log('\n--- POST /api/workspace/create ---')
r = await post('/api/workspace/create', { type: 'client-request', rpcId: 'p2', method: 'workspace/create', payload: { args: { request: { path: 'D:\\Workspace\\VSCplugin' } } } })
console.log('status:', r.status, 'body:', r.body.slice(0, 300))

// 2) mux upgrade handshake
console.log('\n--- WS upgrade /api/remote.mux ---')
const key = crypto.randomBytes(16).toString('base64')
const socket = net.connect(port, '127.0.0.1', () => {
  socket.write(
    `GET /api/remote.mux HTTP/1.1\r\nHost: ${authority}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: http://${authority}\r\nCookie: ${cookie}\r\n\r\n`,
  )
})
let buf = Buffer.alloc(0)
let upgraded = false
socket.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk])
  if (!upgraded) {
    const text = buf.toString('latin1')
    const idx = text.indexOf('\r\n\r\n')
    if (idx >= 0) {
      console.log(text.split('\r\n')[0])
      upgraded = true
      const rest = buf.subarray(idx + 4)
      if (rest.length) console.log('after handshake bytes:', rest.toString('hex'))
    }
  }
})
socket.on('error', (e) => console.log('socket error:', e.message))
setTimeout(() => {
  console.log('done waiting for handshake')
  socket.destroy()
  process.exit(0)
}, 4000)
