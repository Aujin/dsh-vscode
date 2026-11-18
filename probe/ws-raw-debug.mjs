/**
 * Raw WebSocket handshake debugging: talks to the host directly and through
 * the extension proxy, printing the bytes that come back.
 */
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import { randomBytes } from 'node:crypto'
import { readBrowserSessionSecret, mintBrowserCookie } from '../dist/credentials.js'

const require = createRequire(import.meta.url)
const { DshProxy } = require('../dist/proxy.js')

const authority = '127.0.0.1:3080'
const origin = 'http://127.0.0.1:3080'
const secret = readBrowserSessionSecret()
const cookie = mintBrowserCookie(authority, secret)
const info = {
  baseUrl: origin,
  hostname: '127.0.0.1',
  port: 3080,
  authority,
  origin,
  cookie,
  mode: 'attached',
}

function handshake(target, label) {
  return new Promise((resolve) => {
    const key = randomBytes(16).toString('base64')
    const socket = connect({ host: '127.0.0.1', port: target.port }, () => {
      socket.write(
        [
          `GET ${target.path} HTTP/1.1`,
          `Host: ${target.authority}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          `Cookie: ${cookie}`,
          'Origin: http://127.0.0.1:3080',
          '',
          '',
        ].join('\r\n'),
      )
    })
    const chunks = []
    socket.on('data', (chunk) => {
      chunks.push(chunk)
      console.log(`[${label}] <<`, JSON.stringify(chunk.toString('latin1').slice(0, 200)))
    })
    socket.on('error', (error) => console.log(`[${label}] error`, error.message))
    socket.on('close', () => console.log(`[${label}] closed`))
    setTimeout(() => {
      socket.destroy()
      resolve(chunks)
    }, 3000)
  })
}

console.log('--- direct to host ---')
await handshake({ port: 3080, path: '/api/remote.mux', authority }, 'host')

console.log('--- through proxy ---')
const proxy = await DshProxy.start(() => info, { info: () => {}, warn: () => {}, error: (m, e) => console.log('[proxy-error]', m, e?.message ?? '') })
const proxyUrl = new URL(proxy.url)
await handshake({ port: Number(proxyUrl.port), path: '/api/remote.mux', authority }, 'proxy')

await proxy.dispose()
process.exit(0)
