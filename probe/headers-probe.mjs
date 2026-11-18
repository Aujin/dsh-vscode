// Probe 2: response headers + injected boot payload (absolute URLs would bypass the proxy)
import { readFileSync } from 'node:fs'
import { createHash, createHmac } from 'node:crypto'

const home = process.env.DSH_HOME ?? `${process.env.USERPROFILE}\\.dsh`
const yaml = readFileSync(`${home}\\.credentials.yaml`, 'utf8')
const secret = Buffer.from(yaml.match(/client-connection\/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]{20,})/)[1], 'base64url')
const authority = '127.0.0.1:3080'
const cookieName = 'dsh-auth-' + createHash('sha256').update(authority).digest('base64url')
const now = Date.now()
const body = Buffer.from(JSON.stringify({ version: 1, authority, issuedAt: now, expiresAt: now + 2.592e9 })).toString('base64url')
const cookie = `${cookieName}=v1.${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`

const res = await fetch(`http://${authority}/`, { headers: { cookie } })
console.log('=== INDEX HEADERS ===')
for (const [k, v] of res.headers) console.log(`${k}: ${v}`)
const html = await res.text()

console.log('\n=== ABSOLUTE URLS IN INDEX ===')
for (const m of html.matchAll(/https?:\/\/[^\s"'`<>)]+/g)) console.log(m[0])
console.log('\n=== ws:// IN INDEX ===')
for (const m of html.matchAll(/wss?:\/\/[^\s"'`<>)]+/g)) console.log(m[0])

console.log('\n=== BOOT SCRIPT ===')
const boot = html.match(/<script>globalThis\["__DSH_BOOT__"\][\s\S]*?<\/script>/)
console.log(boot ? boot[0].slice(0, 3000) : 'no __DSH_BOOT__ script tag found')
console.log('\n=== ALL script tags (first 400 chars each) ===')
for (const m of html.matchAll(/<script[^>]*>/g)) console.log(m[0])

const asset = html.match(/src="\.\/assets\/[^"]+"/)
if (asset) {
  const a = await fetch(`http://${authority}/${asset[0].slice(5, -1).replace('./', '')}`, { headers: { cookie } })
  console.log('\n=== ASSET HEADERS', asset[0], '===')
  for (const [k, v] of a.headers) console.log(`${k}: ${v}`)
}
