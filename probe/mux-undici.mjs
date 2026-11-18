import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { readBrowserSessionSecret, mintBrowserCookie } = await import('../dist/credentials.js')

const authority = '127.0.0.1:3080'
const secret = readBrowserSessionSecret()
const cookie = mintBrowserSessionCookieSafe(authority, secret)

function mintBrowserSessionCookieSafe(authority, secret) {
  return mintBrowserCookie(authority, secret)
}

console.log('node', process.version, 'WebSocket global:', typeof WebSocket)

const ws = new WebSocket(`ws://${authority}/api/remote.mux`, {
  headers: { cookie },
})

const opened = new Set()
ws.addEventListener('open', () => {
  console.log('ws open')
  const streamId = 'events-' + Date.now()
  opened.add(streamId)
  ws.send(JSON.stringify({ type: 'open', streamId, endpoint: '$events', payload: { args: {} } }))
  const followId = 'follow-' + Date.now()
  opened.add(followId)
  ws.send(JSON.stringify({ type: 'open', streamId: followId, endpoint: 'workspace/follow', payload: { args: {} } }))
})
ws.addEventListener('message', (event) => {
  const text = typeof event.data === 'string' ? event.data : String(event.data)
  console.log('frame:', text.slice(0, 600))
})
ws.addEventListener('error', (event) => {
  console.log('ws error:', event.message ?? '(no message)', event.error?.message ?? '')
})
ws.addEventListener('close', (event) => {
  console.log('ws close code=', event.code, 'reason=', event.reason)
})
setTimeout(() => {
  console.log('done, exiting')
  process.exit(0)
}, 8000)
