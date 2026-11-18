/**
 * Minimal raw WebSocket client for the DSH remote mux.
 *
 * The host speaks a logical-stream protocol over the socket:
 *   client -> host : {type:'open', streamId, endpoint, payload}
 *   host -> client : JSON text frames ({type:'ready',...} for $events)
 * The host also sends PING control frames as heartbeat; we must answer with PONG.
 *
 * Usage: node probe\ws-mux-raw.mjs [host:port] [--proxy]
 */
import net from 'node:net'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { readBrowserSessionSecret, mintBrowserCookie } = await import('../dist/credentials.js')

const target = process.argv[2] ?? '127.0.0.1:3080'
const useProxy = process.argv.includes('--proxy')
const [host, portText] = target.split(':')
const port = Number(portText)

function buildKey() {
  return crypto.randomBytes(16).toString('base64')
}

function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8')
  const mask = crypto.randomBytes(4)
  let header
  if (data.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | data.length])
  } else if (data.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(data.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(data.length), 2)
  }
  const masked = Buffer.alloc(data.length)
  for (let i = 0; i < data.length; i += 1) masked[i] = data[i] ^ mask[i % 4]
  return Buffer.concat([header, mask, masked])
}

async function run() {
  let connectHost = host
  let connectPort = port
  const secret = readBrowserSessionSecret()
  const cookie = mintBrowserCookie(target, secret)
  let origin = `http://${target}`

  if (useProxy) {
    const { DshProxy } = require('../dist/proxy.js')
    const info = {
      baseUrl: `http://${target}`,
      hostname: host,
      port,
      authority: target,
      origin: `http://${target}`,
      cookie,
      mode: 'attached',
    }
    const proxy = await DshProxy.start(() => info, { info: () => {}, warn: () => {}, error: (m) => console.log('[proxy-error]', m) })
    connectHost = '127.0.0.1'
    connectPort = Number(new URL(proxy.url).port)
    console.log('proxy at', proxy.url)
  }

  const key = buildKey()
  const socket = net.connect(connectPort, connectHost)
  const cookieHeader = useProxy ? '' : cookie
  let handshake = [
    `GET /api/remote.mux HTTP/1.1`,
    `Host: ${target}`,
    `Upgrade: websocket`,
    `Connection: Upgrade`,
    `Sec-WebSocket-Key: ${key}`,
    `Sec-WebSocket-Version: 13`,
    'Origin: http://127.0.0.1:3080',
    'Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits',
  ]
  if (cookieHeader) handshake.push(`Cookie: ${cookieHeader}`)
  socket.write(`${handshake.join('\r\n')}\r\n\r\n`)

  let buffer = Buffer.alloc(0)
  let handshaked = false
  let opened = false

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    if (!handshaked) {
      const end = buffer.indexOf('\r\n\r\n')
      if (end < 0) return
      const head = buffer.subarray(0, end).toString('utf8')
      console.log('--- handshake ---')
      console.log(head)
      buffer = buffer.subarray(end + 4)
      handshaked = true
      const open = JSON.stringify({
        type: 'open',
        streamId: crypto.randomUUID(),
        endpoint: '$events',
        payload: { args: {} },
      })
      console.log('--- sending open frame ---')
      console.log(open)
      socket.write(encodeFrame(0x1, open))
      opened = true
    }
    for (;;) {
      if (buffer.length < 2) return
      const fin = (buffer[0] & 0x80) !== 0
      const opcode = buffer[0] & 0x0f
      const masked = (buffer[1] & 0x80) !== 0
      let length = buffer[1] & 0x7f
      let offset = 2
      if (length === 126) {
        if (buffer.length < 4) return
        length = buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buffer.length < 10) return
        length = Number(buffer.readBigUInt64BE(2))
        offset = 10
      }
      let maskKey
      if (masked) {
        if (buffer.length < offset + 4) return
        maskKey = buffer.subarray(offset, offset + 4)
        offset += 4
      }
      if (buffer.length < offset + length) return
      let payload = buffer.subarray(offset, offset + length)
      if (maskKey) {
        const copy = Buffer.from(payload)
        for (let i = 0; i < copy.length; i += 1) copy[i] ^= maskKey[i % 4]
        payload = copy
      }
      buffer = buffer.subarray(offset + length)
      if (opcode === 0x9) {
        console.log('--- PING -> PONG ---')
        socket.write(encodeFrame(0xa, payload))
      } else if (opcode === 0xa) {
        console.log('--- PONG ---')
      } else if (opcode === 0x8) {
        console.log('--- CLOSE ---', payload.length ? payload.toString('utf8') : '')
        socket.end()
        return
      } else {
        console.log(`--- frame op=${opcode} fin=${fin} len=${payload.length} ---`)
        console.log(payload.toString('utf8').slice(0, 1200))
      }
    }
  })

  socket.on('close', () => {
    console.log('--- socket closed ---', { opened })
    process.exit(0)
  })
  socket.on('error', (error) => {
    console.log('socket error', error.message)
    process.exit(1)
  })

  setTimeout(() => {
    console.log('--- timeout ---')
    socket.destroy()
    process.exit(0)
  }, 8000)
}

run()
