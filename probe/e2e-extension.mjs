/**
 * End-to-end check of the extension's own modules against a running dsh web.
 *
 * It exercises exactly the chain the extension uses at runtime:
 *   DshHost (attach) -> DshRpc (session/list) -> WorkspaceBinding
 *   (workspace/create + session/create) -> DshProxy (index, PNA preflight,
 *   WebSocket mux handshake and the `$events` stream).
 *
 * Usage: node probe\e2e-extension.mjs [host:port] [workspacePath]
 */
import net from 'node:net'
import crypto from 'node:crypto'
import http from 'node:http'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { DshHost } = await import('../dist/host.js')
const { DshRpc } = await import('../dist/rpc.js')
const { WorkspaceBinding } = await import('../dist/binding.js')
const { DshProxy } = await import('../dist/proxy.js')

const target = process.argv[2] ?? '127.0.0.1:3080'
const workspacePath = process.argv[3] ?? process.cwd()

const logs = []
const logger = {
  info: (message) => logs.push(`[info] ${message}`),
  warn: (message) => logs.push(`[warn] ${message}`),
  error: (message, error) => logs.push(`[error] ${message} ${error ? String(error) : ''}`),
  show: () => {},
}

function step(label, value) {
  console.log(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
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

/** Open the mux through the proxy and wait for the `ready` frame. */
function muxReady(host, port) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64')
    const socket = net.connect(port, host)
    let buffer = Buffer.alloc(0)
    let handshaked = false
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('mux timeout'))
    }, 8000)

    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })

    // A browser sends exactly this handshake for the nested frame's origin.
    socket.write(
      [
        'GET /api/remote.mux HTTP/1.1',
        `Host: ${host}:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        `Origin: http://${host}:${port}`,
      ].join('\r\n') + '\r\n\r\n',
    )

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (!handshaked) {
        const end = buffer.indexOf('\r\n\r\n')
        if (end < 0) return
        const head = buffer.subarray(0, end).toString('latin1')
        if (!head.startsWith('HTTP/1.1 101')) {
          clearTimeout(timer)
          socket.destroy()
          reject(new Error(`upgrade failed: ${head.split('\r\n')[0]}`))
          return
        }
        buffer = buffer.subarray(end + 4)
        handshaked = true
        socket.write(
          encodeFrame(
            0x1,
            JSON.stringify({
              type: 'open',
              streamId: crypto.randomUUID(),
              endpoint: '$events',
              payload: { args: {} },
            }),
          ),
        )
      }      for (;;) {
        if (buffer.length < 2) return
        const opcode = buffer[0] & 0x0f
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
        if (buffer.length < offset + length) return
        const payload = buffer.subarray(offset, offset + length)
        buffer = buffer.subarray(offset + length)
        if (opcode === 0x9) {
          socket.write(encodeFrame(0xa, payload))
          continue
        }
        if (opcode === 0x1) {
          const text = payload.toString('utf8')
          if (text.includes('"ready"')) {
            clearTimeout(timer)
            socket.destroy()
            resolve(text.slice(0, 200))
            return
          }
        }
      }
    })
  })
}

async function main() {
  const host = new DshHost(logger, () => ({
    webUrl: `http://${target}`,
    autoStart: false,
    autoStartPort: Number(target.split(':')[1] ?? 3080),
  }))
  const info = await host.connect()
  step('host mode', info.mode)
  step('host base', info.baseUrl)

  const rpc = new DshRpc(() => host.current, logger)
  const binding = new WorkspaceBinding(rpc, logger)

  const listed = await binding.listSessions()
  step('sessions visible', listed.length)
  step('first session', listed[0] ? `${listed[0].sessionId} cwd=${listed[0].cwd ?? '-'}` : '-')

  const { workspace, created } = await binding.ensureWorkspace(workspacePath)
  step('workspace', `${workspace.workspaceId} path=${workspace.path} created=${created}`)

  const existing = await binding.findSessionForPath(workspace.path)
  step('session for path', existing ? existing.sessionId : 'none')

  let sessionId = existing?.sessionId
  if (!sessionId) {
    const createdSession = await binding.createSession(workspace.workspaceId)
    sessionId = createdSession.sessionId
    step('created session', sessionId)
  }

  const after = await binding.listSessions()
  const bound = after.find((item) => item.sessionId === sessionId)
  step('session cwd', bound?.cwd ?? 'missing')
  step('session blank', String(bound?.blank))

  const proxy = await DshProxy.start(() => host.current, logger)
  step('proxy', proxy.url)

  const index = await new Promise((resolve, reject) => {
    http
      .get(`${proxy.url}/`, (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }),
        )
      })
      .on('error', reject)
  })
  step('index status', String(index.status))
  step('index has boot', String(index.body.includes('__DSH_BOOT__')))
  step('index has bridge', String(index.body.includes('/__dsh_vscode_bridge.js')))
  step('index pna header', String(index.headers['access-control-allow-private-network']))

  const preflight = await new Promise((resolve, reject) => {
    const req = http.request(
      `${proxy.url}/api/session/list`,
      { method: 'OPTIONS', headers: { origin: 'https://example.test', 'access-control-request-private-network': 'true' } },
      (res) => {
        res.resume()
        resolve({ status: res.statusCode, headers: res.headers })
      },
    )
    req.on('error', reject)
    req.end()
  })
  step('preflight status', String(preflight.status))
  step('preflight pna', String(preflight.headers['access-control-allow-private-network']))
  step('preflight origin', String(preflight.headers['access-control-allow-origin']))

  const proxyPort = Number(new URL(proxy.url).port)
  const ready = await muxReady('127.0.0.1', proxyPort)
  step('mux ready frame', ready)

  await proxy.dispose()
  await host.dispose()
  console.log('--- extension log ---')
  for (const line of logs) console.log(line)
  console.log('E2E OK')
  process.exit(0)
}

main().catch((error) => {
  console.error('E2E FAILED', error)
  for (const line of logs) console.error(line)
  process.exit(1)
})
