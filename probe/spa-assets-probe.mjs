/**
 * Verify that every asset the SPA needs is reachable through the extension proxy.
 *
 * Fetches the index, parses the injected `__DSH_BOOT__` payload, then requests
 * every plugin bundle the boot manifest references plus the main SPA bundle.
 */
import { createRequire } from 'node:module'
import { readBrowserSessionSecret, mintBrowserCookie } from '../dist/credentials.js'

const require = createRequire(import.meta.url)
const { DshProxy } = require('../dist/proxy.js')

const target = process.argv[2] ?? '127.0.0.1:3080'
const [hostname, portText] = target.split(':')
const port = Number(portText)
const secret = readBrowserSessionSecret()
const cookie = mintBrowserCookie(target, secret)
const info = {
  baseUrl: `http://${target}`,
  hostname,
  port,
  authority: target,
  origin: `http://${target}`,
  cookie,
  mode: 'attached',
}
const logger = { info: () => {}, warn: () => {}, error: (m) => console.log('[error]', m) }
const proxy = await DshProxy.start(() => info, logger)
const base = proxy.url
console.log('proxy', base)

const index = await fetch(`${base}/`)
const html = await index.text()
console.log('index status', index.status, 'len', html.length)

const match = html.match(/globalThis\["__DSH_BOOT__"\]\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/)
if (!match) throw new Error('boot payload not found in proxied index')
const boot = JSON.parse(match[1])
console.log('boot entries', boot.entries.length, 'batches', boot.batches?.length ?? 0)

const urls = []
for (const entry of boot.entries ?? []) if (entry.url) urls.push(entry.url)
for (const batch of boot.batches ?? []) if (batch.url) urls.push(batch.url)
const assetMatch = html.match(/src="(assets\/[^"]+\.js)"/)
if (assetMatch) urls.unshift(assetMatch[1])

let failures = 0
let total = 0
for (const url of urls) {
  total += 1
  const response = await fetch(`${base}/${url}`)
  const body = await response.text()
  const ok = response.status === 200 && body.length > 0
  if (!ok) {
    failures += 1
    console.log('FAIL', response.status, url, body.slice(0, 120))
  }
}
console.log(`assets ok: ${total - failures}/${total}`)

// The bridge script must be served by the proxy itself.
const bridge = await fetch(`${base}/__dsh_vscode_bridge.js`)
console.log('bridge status', bridge.status, 'len', (await bridge.text()).length)

await proxy.dispose()
process.exit(failures === 0 ? 0 : 1)
