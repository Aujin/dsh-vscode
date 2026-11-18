import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { readBrowserSessionSecret, mintBrowserCookie } = await import('../dist/credentials.js')
const authority = '127.0.0.1:3080'
const cookie = mintBrowserCookie(authority, readBrowserSessionSecret())
const ws = new WebSocket(`ws://${authority}/api/remote.mux`, { headers: { cookie } })
ws.addEventListener('open', () => {
  ws.send(JSON.stringify({ type: 'open', streamId: 'f1', endpoint: 'workspace/follow', payload: { args: {} } }))
})
ws.addEventListener('message', (e) => {
  const frame = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data))
  if (frame.type === 'item' && frame.value?.type === 'baseline') {
    for (const w of frame.value.value.items) {
      console.log(JSON.stringify({ id: w.workspaceId, path: w.path, title: w.title, sessions: w.sessionIds.length, createdAt: w.createdAt }))
    }
    console.log('archived:', JSON.stringify(frame.value.value.archivedSessionIds), 'pinned:', JSON.stringify(frame.value.value.pinnedSessionIds))
  }
})
setTimeout(() => process.exit(0), 4000)
