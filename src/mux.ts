import { connect, type Socket } from 'node:net'
import { randomBytes, randomUUID } from 'node:crypto'
import type { DshHostInfo } from './host'
import type { Logger } from './logger'

const OPCODE_CONTINUATION = 0x0
const OPCODE_TEXT = 0x1
const OPCODE_BINARY = 0x2
const OPCODE_CLOSE = 0x8
const OPCODE_PING = 0x9
const OPCODE_PONG = 0xa

/** A logical stream opened on the mux. */
export interface MuxStreamHandle {
  readonly streamId: string
  /** Resolves with the next value the host sends for this stream. */
  next(): Promise<unknown>
  /** Rejects with the reason the host gave for the stream. */
  fail(error: Error): void
  close(): void
}

interface StreamState {
  endpoint: string
  queue: unknown[]
  waiters: Array<(value: unknown) => void>
  failure?: Error
  closed: boolean
}

/**
 * Minimal client for the dsh remote mux.
 *
 * The host exposes its streaming methods (`workspace/follow`, `session/follow`,
 * `session/control`) over the `/api/remote.mux` WebSocket using a logical
 * stream protocol: the client opens a stream with `{type:'open', streamId,
 * endpoint, payload}` and the host answers with `{type:'item', streamId,
 * value}` frames. Node's global WebSocket cannot send the authentication
 * cookie, so the socket is implemented directly on top of `node:net`.
 */
export class DshMux {
  private socket?: Socket
  private buffer = Buffer.alloc(0)
  private handshaken = false
  private closed = false
  private readonly streams = new Map<string, StreamState>()

  private constructor(
    private readonly info: DshHostInfo,
    private readonly logger: Logger,
  ) {}

  /** Open the mux socket and wait for the host's 101 response. */
  static async connect(info: DshHostInfo, logger: Logger): Promise<DshMux> {
    const mux = new DshMux(info, logger)
    await mux.handshake()
    return mux
  }

  get connected(): boolean {
    return this.socket !== undefined && !this.closed
  }

  /** Open a logical stream on the mux. */
  openStream(endpoint: string, args: unknown = {}): MuxStreamHandle {
    const streamId = randomUUID()
    const state: StreamState = { endpoint, queue: [], waiters: [], closed: false }
    this.streams.set(streamId, state)
    this.send({ type: 'open', streamId, endpoint, payload: { args } })
    const handle: MuxStreamHandle = {
      streamId,
      next: () => this.nextValue(state),
      fail: (error: Error) => {
        state.failure = error
        this.flushWaiters(state)
      },
      close: () => {
        if (state.closed) return
        state.closed = true
        this.streams.delete(streamId)
        this.send({ type: 'cancel', streamId })
      },
    }
    return handle
  }

  private nextValue(state: StreamState): Promise<unknown> {
    if (state.queue.length > 0) return Promise.resolve(state.queue.shift())
    if (state.failure) return Promise.reject(state.failure)
    if (state.closed) return Promise.reject(new Error('stream closed'))
    return new Promise((resolve, reject) => {
      state.waiters.push((value) => {
        if (state.failure) reject(state.failure)
        else resolve(value)
      })
    })
  }

  private flushWaiters(state: StreamState): void {
    const waiters = state.waiters.splice(0)
    for (const waiter of waiters) {
      if (state.failure) waiter(undefined as unknown as never)
    }
  }

  private send(message: unknown): void {
    if (!this.socket || this.closed) return
    this.socket.write(encodeFrame(OPCODE_TEXT, Buffer.from(JSON.stringify(message), 'utf8')))
  }

  private async handshake(): Promise<void> {
    const key = randomBytes(16).toString('base64')
    await new Promise<void>((resolve, reject) => {
      const socket = connect({ host: this.info.hostname, port: this.info.port })
      this.socket = socket
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error('mux handshake timed out'))
      }, 8000)
      socket.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      socket.once('close', () => {
        this.closed = true
        this.failAll(new Error('mux connection closed'))
      })
      socket.on('data', (chunk: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, chunk])
        if (!this.handshaken) {
          const end = this.buffer.indexOf('\r\n\r\n')
          if (end < 0) return
          const head = this.buffer.subarray(0, end).toString('latin1')
          this.buffer = this.buffer.subarray(end + 4)
          this.handshaken = true
          clearTimeout(timer)
          if (!/^HTTP\/1\.1 101/i.test(head)) {
            socket.destroy()
            reject(new Error(`mux handshake rejected: ${head.split('\r\n')[0]}`))
            return
          }
          resolve()
          this.drain()
          return
        }
        this.drain()
      })
      socket.setNoDelay(true)
      const lines = [
        'GET /api/remote.mux HTTP/1.1',
        `Host: ${this.info.authority}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        `Origin: ${this.info.origin}`,
        `Cookie: ${this.info.cookie}`,
      ]
      socket.write(lines.join('\r\n') + '\r\n\r\n')
    })
  }

  /** Parse as many complete frames as the buffer holds. */
  private drain(): void {
    for (;;) {
      if (this.buffer.length < 2) return
      const opcode = this.buffer[0] & 0x0f
      const fin = (this.buffer[0] & 0x80) !== 0
      const masked = (this.buffer[1] & 0x80) !== 0
      let length = this.buffer[1] & 0x7f
      let offset = 2
      if (length === 126) {
        if (this.buffer.length < 4) return
        length = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.buffer.length < 10) return
        length = Number(this.buffer.readBigUInt64BE(2))
        offset = 10
      }
      let maskKey: Buffer | undefined
      if (masked) {
        if (this.buffer.length < offset + 4) return
        maskKey = this.buffer.subarray(offset, offset + 4)
        offset += 4
      }
      if (this.buffer.length < offset + length) return
      let payload = Buffer.from(this.buffer.subarray(offset, offset + length))
      if (maskKey) {
        for (let index = 0; index < payload.length; index += 1) payload[index] ^= maskKey[index % 4]
      }
      this.buffer = this.buffer.subarray(offset + length)
      this.handleFrame(opcode, fin, payload)
      if (opcode === OPCODE_CLOSE) return
    }
  }

  private handleFrame(opcode: number, fin: boolean, payload: Buffer): void {
    if (opcode === OPCODE_PING) {
      this.socket?.write(encodeFrame(OPCODE_PONG, payload))
      return
    }
    if (opcode === OPCODE_PONG) return
    if (opcode === OPCODE_CLOSE) {
      this.closed = true
      this.socket?.end()
      this.failAll(new Error('mux connection closed by host'))
      return
    }
    if (opcode === OPCODE_BINARY || (opcode !== OPCODE_TEXT && opcode !== OPCODE_CONTINUATION)) return
    if (!fin) return
    const text = payload.toString('utf8')
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(text) as Record<string, unknown>
    } catch (error) {
      this.logger.warn(`mux frame was not JSON: ${String(error)}`)
      return
    }
    this.dispatch(parsed)
  }

  private dispatch(frame: Record<string, unknown>): void {
    const streamId = typeof frame.streamId === 'string' ? frame.streamId : undefined
    const type = typeof frame.type === 'string' ? frame.type : ''
    if (!streamId) return
    const state = this.streams.get(streamId)
    if (!state) return
    if (type === 'item') {
      const value = frame.value
      const waiter = state.waiters.shift()
      if (waiter) waiter(value)
      else state.queue.push(value)
      return
    }
    if (type === 'error') {
      const message = typeof frame.message === 'string' ? frame.message : 'mux stream error'
      state.failure = new Error(message)
      this.flushWaiters(state)
      return
    }
    if (type === 'end' || type === 'cancel') {
      state.closed = true
      this.streams.delete(streamId)
      this.flushWaiters(state)
    }
  }

  private failAll(error: Error): void {
    for (const state of this.streams.values()) {
      state.failure = error
      state.closed = true
      this.flushWaiters(state)
    }
    this.streams.clear()
  }

  dispose(): void {
    this.closed = true
    this.socket?.destroy()
    this.socket = undefined
    this.failAll(new Error('mux disposed'))
  }
}

/** Encode a masked client frame. */
function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4)
  let header: Buffer
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length])
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  const masked = Buffer.alloc(payload.length)
  for (let index = 0; index < payload.length; index += 1) masked[index] = payload[index] ^ mask[index % 4]
  return Buffer.concat([header, mask, masked])
}
