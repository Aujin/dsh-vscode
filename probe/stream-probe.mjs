import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { readBrowserSessionSecret, mintBrowserCookie } = await import('../dist/credentials.js')

const authority = '127.0.0.1:3080'
const secret = readBrowserSessionSecret()
const cookie = mintBrowserCookie(authority, secret)

async function tryMethod(method) {
  const res = await fetch(`http://${authority}/api/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie,
      accept: 'application/json',
    },
    body: JSON.stringify({ type: 'client-request', rpcId: 'probe-' + method, method, payload: { args: {} } }),
  })
  console.log(`--- ${method}: status=${res.status} content-type=${res.headers.get('content-type')} transfer-encoding=${res.headers.get('transfer-encoding')}`)
  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  const timer = setTimeout(() => reader.cancel().catch(() => {}), 3000)
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      chunks.push(value)
      if (total > 4000) break
    }
  } catch (error) {
    console.log('  read error:', String(error))
  }
  clearTimeout(timer)
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)))
  console.log('  bytes:', buf.length)
  console.log('  head:', buf.subarray(0, 900).toString('utf8'))
}

await tryMethod('workspace/follow')
await tryMethod('session/control')
