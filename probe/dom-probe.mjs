// Probe 11: how does the conversation UI list sessions? (data-conversation-session / workspace rows)
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

async function get(url) {
  const res = await fetch(`http://${authority}/${url}`, { headers: { cookie } })
  if (!res.ok) throw new Error(`${url} -> ${res.status}`)
  return res.text()
}

const boot = JSON.parse(readFileSync('probe/boot.json', 'utf8'))
const pick = (id) => boot.entries.find((e) => e.id === id)?.url
const targets = [
  ['conversation', pick('@deepseek-ai/dsh-client-ui-conversation')],
  ['workspace', pick('@deepseek-ai/dsh-client-ui-workspace')],
  ['sidebar', pick('@deepseek-ai/dsh-client-ui-sidebar')],
]
for (const [name, url] of targets) {
  let code
  try { code = await get(url) } catch (e) { console.log(name, 'ERR', e.message); continue }
  writeFileSync(`probe/bundle-${name}.js`, code)
  console.log(`\n===== ${name} (${code.length} bytes) =====`)
  for (const re of [/data-conversation-[a-z-]+/g, /conversation-[a-z-]+/g]) {
    const hits = new Set()
    let m
    while ((m = re.exec(code)) && hits.size < 12) hits.add(m[0])
    console.log(' ', re.source, '->', [...hits].join(', '))
  }
  for (const key of ['data-conversation-session', 'data-conversation-workspace']) {
    const i = code.indexOf(key)
    if (i === -1) continue
    console.log(`  --- context for ${key} ---`)
    console.log('  ...' + code.slice(Math.max(0, i - 400), i + 400).replace(/\s+/g, ' ') + '...')
  }
}
