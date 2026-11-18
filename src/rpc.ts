import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { DshHostInfo } from './host'
import type { Logger } from './logger'

/** Error raised when the host answers a request with `result.ok === false`. */
export class DshRpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'DshRpcError'
  }
}

/** Unary RPC client for the dsh host (`POST /api/<namespace>/<method>`). */
export class DshRpc {
  constructor(
    private readonly getInfo: () => DshHostInfo | undefined,
    private readonly logger: Logger,
  ) {}

  async call<T = unknown>(method: string, args: unknown = {}): Promise<T> {
    const info = this.getInfo()
    if (!info) {
      throw new DshRpcError('not-connected', '尚未连接到 dsh web。')
    }
    const payload = JSON.stringify({
      type: 'client-request',
      rpcId: randomUUID(),
      method,
      payload: { args },
    })

    const response = await this.send(info, method, payload).catch((error: unknown) => {
      this.logger.warn(`rpc ${method} failed: ${(error as Error).message}`)
      throw error
    })
    if (response.status < 200 || response.status >= 300) {
      throw new DshRpcError(`http/${response.status}`, `${method} failed with HTTP ${response.status}: ${response.body.slice(0, 300)}`)
    }
    let json: any
    try {
      json = JSON.parse(response.body)
    } catch {
      throw new DshRpcError('bad-response', `${method} returned a non-JSON body: ${response.body.slice(0, 200)}`)
    }
    const result = json?.result
    if (!result) {
      throw new DshRpcError('bad-response', `${method} returned no result: ${response.body.slice(0, 200)}`)
    }
    if (result.ok === false) {
      const error = result.error ?? {}
      throw new DshRpcError(String(error.code ?? 'unknown'), String(error.message ?? 'unknown error'), error.details)
    }
    return result.value as T
  }

  private send(info: DshHostInfo, method: string, payload: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const url = new URL(`${info.baseUrl}/api/${method}`)
      const send = url.protocol === 'https:' ? httpsRequest : httpRequest
      const req = send(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + url.search,
          method: 'POST',
          headers: {
            host: url.host,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
            cookie: info.cookie,
            accept: 'application/json',
            'accept-encoding': 'identity',
            'user-agent': 'dsh-vscode/0.1.0',
          },
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
          })
        },
      )
      req.setTimeout(15_000, () => req.destroy(new Error('RPC timeout')))
      req.on('error', reject)
      req.write(payload)
      req.end()
    })
  }
}
