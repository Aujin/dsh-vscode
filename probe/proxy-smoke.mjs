/**
 * Smoke test for the extension's loopback proxy:
 *  - proxy an index request (cookie injected, bridge injected)
 *  - proxy an API call (session/list)
 *  - proxy the WebSocket mux handshake and read the first frame
 */
import { createRequire } from 'node:module'
import { readBrowserSessionSecret, mintBrowserCookie } from '../dist/credentials.js'

const require = createRequire(import.meta.url)
const { DshProxy } = require('../dist/proxy.js')

const HOST = process.argv[2] ?? 'http://127.0.0.1:3080'
const url = new URL(/^[a-z]+:\/\//i.test(HOST) ? HOST : `http://${HOST}`)
const authority = url.host
const origin = `${url.protocol}//${url.host}`

const secret = readBrowserSessionSecret()
if (!secret) {
  console.error('no browser-session secret found')
  process.exit(1)
}
const cookie = mintBrowserCookie(authority, secret)

const info = {
  baseUrl: origin,
  hostname: url.hostname,
  port: Number(url.port || 80),
  authority,
  origin,
  cookie,
  mode: 'attached',
}

const logger = {
  info: (message) => console.log('[info]', message),
  warn: (message) => console.log('[warn]', message),
  error: (message, error) => console.log('[error]', message, error?.message ?? ''),
}

const proxy = await DshProxy.start(() => info, logger)
const proxyUrl = proxy.url
console.log('proxy url:', proxyUrl)

// 1. index
const index = await fetch(`${proxyUrl}/`, { headers: { accept: 'text/html' } })
const html = await index.text()
console.log('INDEX status:', index.status, 'len:', html.length)
console.log('has __DSH_BOOT__:', html.includes('__DSH_BOOT__'))
console.log('bridge injected:', html.includes('/__dsh_vscode_bridge.js'))

// 2. api call
const api = await fetch(`${proxyUrl}/api/session/list`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'client-request', rpcId: 'smoke-1', method: 'session/list', payload: { args: { _request: {} } } }),
})
const apiBody = await api.text()
console.log('API status:', api.status, 'len:', apiBody.length)
console.log('API has sessions:', apiBody.includes('sessionId'))

// 3. websocket mux
const ws = new WebSocket(`${proxyUrl.replace('http://', 'ws://')}/api/remote.mux`)
const frames = []
await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(), 6000)
  ws.addEventListener('open', () => console.log('WS open'))
  ws.addEventListener('message', (event) => {
    frames.push(String(event.data).slice(0, 120))
    if (frames.length >= 1) {
      clearTimeout(timer)
      ws.close()
      resolve()
    }
  })
  ws.addEventListener('error', (event) => {
    console.log('WS error', event.message ?? '')
    clearTimeout(timer)
    resolve()
  })
})
console.log('WS frames:', frames.length, frames[0] ?? '(none)')

await proxy.dispose()
