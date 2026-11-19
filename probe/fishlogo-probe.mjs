// Locate and fetch the client-ui-primitives bundle (FishLogo) from the running dsh host.
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { request } from 'node:http'

const require = createRequire(import.meta.url)
const { readBrowserSessionSecret, mintBrowserCookie } = require('../dist/credentials.js')

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const req = request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: { host: target.host, 'accept-encoding': 'identity', ...headers },
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

const authority = process.argv[2] ?? '127.0.0.1:8080'
const cookie = mintBrowserCookie(authority, readBrowserSessionSecret())
const base = `http://${authority}`

const index = await httpGet(`${base}/`, { cookie })
console.log('index', index.status, index.body.length)

// 1) how does the html reference the primitives module?
for (const m of index.body.matchAll(/[^\s"'<>]*primitives[^\s"'<>]*/g)) console.log('html ref:', m[0])

// 2) try the module path with and without rev
for (const path of [
  '/plugins/??@deepseek-ai/dsh-client-ui-primitives/client.js',
  '/plugins/??@deepseek-ai/dsh-client-ui-primitives/client.js&rev=',
]) {
  const res = await httpGet(base + path, { cookie })
  console.log(path, '->', res.status, res.body.length)
  if (res.status === 200 && res.body.includes('FishLogo')) {
    writeFileSync(new URL('./bundle-primitives.js', import.meta.url), res.body)
    const i = res.body.indexOf('FishLogo')
    console.log(res.body.slice(Math.max(0, i - 5000), i + 5000))
    break
  }
}
