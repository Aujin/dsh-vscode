// Compare cookie minting paths: credentials.ts helper vs the regex probe path.
import { readFileSync } from 'node:fs'
import { createHash, createHmac } from 'node:crypto'
import { readBrowserSessionSecret, mintBrowserCookie } from '../dist/credentials.js'

const authority = '127.0.0.1:3080'
const home = process.env.DSH_HOME ?? `${process.env.USERPROFILE}\\.dsh`
const yamlText = readFileSync(`${home}\\.credentials.yaml`, 'utf8')
const match = yamlText.match(/client-connection\/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]{20,})/)
const regexSecret = Buffer.from(match[1], 'base64url')
const helperSecret = readBrowserSessionSecret()
console.log('regex secret bytes:', regexSecret.byteLength, 'helper secret bytes:', helperSecret?.byteLength)
console.log('secrets equal:', regexSecret.equals(helperSecret))

const regexCookie = (() => {
  const name = 'dsh-auth-' + createHash('sha256').update(authority).digest('base64url')
  const issuedAt = Date.now()
  const payload = { version: 1, authority, issuedAt, expiresAt: issuedAt + 30 * 24 * 3600 * 1000 }
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const signature = createHmac('sha256', regexSecret).update(body).digest('base64url')
  return `${name}=v1.${body}.${signature}`
})()
const helperCookie = mintBrowserCookie(authority, helperSecret)

for (const [label, cookie] of [['regex', regexCookie], ['helper', helperCookie]]) {
  const res = await fetch(`http://${authority}/`, { headers: { cookie } })
  const text = await res.text()
  console.log(label, 'index status', res.status, 'boot:', text.includes('__DSH_BOOT__'))
}
