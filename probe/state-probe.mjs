// Probe 5: how does the SPA persist client-side state (session/workspace selection)?
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
const marker = html.indexOf('__DSH_BOOT__')
console.log('marker at', marker)
console.log(html.slice(Math.max(0, marker - 120), marker + 400))
let boot
for (const pat of [/globalThis\["__DSH_BOOT__"\]\s*=\s*(\{[\s\S]*?\})\s*[;<]/, /__DSH_BOOT__\s*=\s*(\{[\s\S]*?\})\s*[;<]/]) {
  const m = html.match(pat)
  if (m) { boot = JSON.parse(m[1]); break }
}
if (!boot) {
  const i = html.indexOf('__DSH_BOOT__')
  const start = html.indexOf('{', i)
  let depth = 0
  for (let k = start; k < html.length; k++) {
    if (html[k] === '{') depth++
    else if (html[k] === '}') { depth--; if (depth === 0) { boot = JSON.parse(html.slice(start, k + 1)); break } }
  }
}
if (!boot) throw new Error('no boot payload')
console.log('boot keys:', Object.keys(boot))
console.log('entry count:', boot.entries.length)

const interesting = boot.entries.filter((e) => /ui-session|ui-workspace|ui-conversation|ui-sidebar/i.test(e.id))
for (const entry of interesting) {
  const res = await fetch(`http://${authority}/${entry.url}`, { headers: { cookie } })
  const code = await res.text()
  console.log(`\n===== ${entry.id} (${code.length} bytes) =====`)
  for (const m of code.matchAll(/localStorage[^;\n]{0,160}/g)) console.log('  LS:', m[0].slice(0, 200))
  for (const m of code.matchAll(/["'`]([a-zA-Z0-9:_-]*(?:session|workspace)[a-zA-Z0-9:_-]*)["'`]/gi)) {
    const s = m[1]
    if (s.length < 60 && !s.includes('/')) console.log('  ID:', s)
  }
}
