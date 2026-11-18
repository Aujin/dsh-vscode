/**
 * Compare a plain WebSocket client against the host directly and through the
 * extension proxy, printing close/error details.
 */
import { createRequire } from 'node:module'
import { readBrowserSessionSecret, mintBrowserCookie } from '../dist/credentials.js'

const require = createRequire(import.meta.url)
const { DshProxy } = require('../dist/proxy.js')

const authority = '127.0.0.1:3080'
const secret = readBrowserSessionSecret()
const cookie = mintBrowserCookie(authority, secret)
const info = {
  baseUrl: 'http://127.0.0.1:3080',
  hostname: '127.0.0.1',
  port: 3080,
  authority,
  origin: 'http://127.0.0.1:3080',
  cookie,
  mode: 'attached',
}

function connect(label, url) {
  return new Promise((resolve) => {
    const socket = new WebSocket(url)
    const seen = []
    socket.addEventListener('open', () => console.log(`[${label}] open`))
    socket.addEventListener('message', (event) => {
      seen.push(String(event.data))
      console.log(`[${label}] message`, String(event.data).slice(0, 160))
    })
    socket.addEventListener('error', (event) => {
      console.log(`[${label}] error`, event.message ?? '', event.error?.message ?? '', event.error?.code ?? '')
    })
    socket.addEventListener('close', (event) => {
      console.log(`[${label}] close code=${event.code} reason=${event.reason}`)
      resolve(seen)
    })
    setTimeout(() => {
      console.log(`[${label}] timeout, closing`)
      socket.close()
    }, 5000)
  })
}

console.log('--- direct ---')
await connect('direct', 'ws://127.0.0.1:3080/api/remote.mux')

console.log('--- proxied ---')
const proxy = await DshProxy.start(() => info, { info: () => {}, warn: () => {}, error: (m, e) => console.log('[proxy-error]', m, e?.message ?? '') })
const port = new URL(proxy.url).port
await connect('proxy', `ws://127.0.0.1:${port}/api/remote.mux`)

await proxy.dispose()
process.exit(0)
