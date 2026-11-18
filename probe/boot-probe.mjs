// Probe 10: dump the full __DSH_BOOT__ payload; find absolute URLs / transport hints
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash, createHmac } from 'node:crypto'

const home = process.env.DSH_HOME ?? `${process.env.USERPROFILE}\\.dsh`
const yaml = readFileSync(`${home}\\.credentials.yaml`, 'utf8')
const secret = Buffer.from(yaml.match(/client-connection\/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]{20,})/)[1], 'base64url')
const authority = '127.0.0.1:3080'
const cookieName = 'dsh-auth-' + createHash('sha256').update(authority).digest('base64url')
const now = Date.now()
const body = Buffer.from(JSON.stringify({ version: 1, authority, issuedAt: now, expiresAt: now + 2.592e9 })).toString('base64url')
const cookie = `${cookieName}=v1.${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`

const html = await (await fetch(`http://${authority}/`, { headers: { cookie } })).text()
const i = html.indexOf('__DSH_BOOT__')
const start = html.indexOf('{', i)
let depth = 0
let boot = null
for (let k = start; k < html.length; k++) {
  if (html[k] === '{') depth++
  else if (html[k] === '}') { depth--; if (depth === 0) { boot = JSON.parse(html.slice(start, k + 1)); break } }
}
writeFileSync('probe/boot.json', JSON.stringify(boot, null, 2))

const urls = new Set()
const walk = (v) => {
  if (typeof v === 'string') { if (/^https?:\/\//.test(v)) urls.add(v) }
  else if (Array.isArray(v)) v.forEach(walk)
  else if (v && typeof v === 'object') Object.values(v).forEach(walk)
}
walk(boot)
console.log('top-level keys:', Object.keys(boot))
console.log('release:', JSON.stringify(boot.release))
console.log('batches:', JSON.stringify(boot.batches)?.slice(0, 500))
console.log('\nabsolute URLs inside boot payload:')
for (const u of urls) console.log('  ', u)
console.log('\nentry sample:', JSON.stringify(boot.entries.slice(0, 3), null, 2).slice(0, 1200))
const kinds = new Set()
for (const e of boot.entries) kinds.add(JSON.stringify(Object.keys(e).sort()))
console.log('\nentry key shapes:', [...kinds])
