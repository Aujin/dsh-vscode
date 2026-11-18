// Probe: can we attach to an already-running `dsh web` as an authenticated browser peer
// without the per-process launch token? We mint the browser-session cookie ourselves
// using the signing secret the host keeps in $DSH_HOME/.credentials.yaml.
import { readFileSync } from 'node:fs'
import { createHash, createHmac } from 'node:crypto'
import { request } from 'node:http'

const home = process.env.DSH_HOME ?? `${process.env.USERPROFILE}\\.dsh`
const yaml = readFileSync(`${home}\\.credentials.yaml`, 'utf8')
const match = yaml.match(/client-connection\/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]{20,})/)
if (!match) throw new Error('browser-session credential record not found')
const secret = Buffer.from(match[1], 'base64url')
console.log('secret bytes:', secret.byteLength)

const authority = process.argv[2] ?? '127.0.0.1:3080'
const cookieName = 'dsh-auth-' + createHash('sha256').update(authority).digest('base64url')
const issuedAt = Date.now()
const payload = { version: 1, authority, issuedAt, expiresAt: issuedAt + 30 * 24 * 3600 * 1000 }
const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
const signature = createHmac('sha256', secret).update(body).digest('base64url')
const cookie = `${cookieName}=v1.${body}.${signature}`
console.log('cookie name:', cookieName)

// 1. index request with our minted cookie
const res = await fetch(`http://${authority}/`, { headers: { cookie } })
const text = await res.text()
console.log('INDEX status:', res.status, 'len:', text.length)
console.log('index head:', JSON.stringify(text.slice(0, 400)))
console.log('has __DSH_BOOT__:', text.includes('__DSH_BOOT__'))
console.log('set-cookie:', res.headers.getSetCookie?.() ?? res.headers.get('set-cookie'))

// 2. websocket upgrade at /api/remote.mux with the same cookie
await new Promise((resolve) => {
  const req = request({
    host: '127.0.0.1',
    port: Number(authority.split(':')[1]),
    path: '/api/remote.mux',
    headers: {
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-key': Buffer.from('0123456789abcdef').toString('base64'),
      'sec-websocket-version': '13',
      cookie,
    },
  })
  req.on('upgrade', (res, socket) => {
    console.log('WS upgrade status:', res.statusCode)
    socket.destroy()
    resolve()
  })
  req.on('response', (res) => {
    console.log('WS refused, status:', res.statusCode)
    res.resume()
    resolve()
  })
  req.on('error', (error) => {
    console.log('WS error:', error.message)
    resolve()
  })
  req.end()
})
