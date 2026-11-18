// Probe 6: does the SPA understand URL params (deep links) for session/workspace selection?
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

const html = await (await fetch(`http://${authority}/`, { headers: { cookie } })).text()
const i = html.indexOf('__DSH_BOOT__')
const start = html.indexOf('{', i)
let depth = 0
let boot = null
for (let k = start; k < html.length; k++) {
  if (html[k] === '{') depth++
  else if (html[k] === '}') { depth--; if (depth === 0) { boot = JSON.parse(html.slice(start, k + 1)); break } }
}

// main SPA bundle(s)
const assets = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]).filter((s) => s.includes('assets/'))
const urls = [...assets, ...boot.entries.filter((e) => /client-ui|client-modules/.test(e.id)).map((e) => e.url)]

const seen = new Set()
for (const u of urls) {
  if (seen.has(u)) continue
  seen.add(u)
  const res = await fetch(`http://${authority}/${u}`, { headers: { cookie } })
  if (!res.ok) { console.log('skip', u, res.status); continue }
  const code = await res.text()
  const hits = new Set()
  for (const m of code.matchAll(/searchParams\.get\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) hits.add(m[1])
  for (const m of code.matchAll(/get\(\s*["'`]([a-zA-Z-]{3,24})["'`]\s*\)/g)) { if (/session|workspace|tab|panel|view/i.test(m[1])) hits.add(m[1]) }
  if (hits.size) console.log(u.split('&')[0], '->', [...hits].join(', '))
}
