import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { readBrowserSessionSecret, dshHome, mintBrowserCookie, browserCookieName } = await import('../dist/credentials.js')

const secret = readBrowserSessionSecret()
console.log('dsh home:', dshHome())
console.log('secret found:', Boolean(secret))
console.log('secret bytes:', secret ? secret.byteLength : 0)
if (secret) {
  const authority = '127.0.0.1:3080'
  const cookie = mintBrowserCookie(authority, secret)
  console.log('cookie name:', browserCookieName(authority))
  console.log('cookie prefix ok:', cookie.startsWith(browserCookieName(authority) + '=v1.'))
  console.log('cookie parts:', cookie.split('.').length)
}
