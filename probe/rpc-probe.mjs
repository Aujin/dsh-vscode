// Probe 4: workspace binding flow (workspace/create -> session/list -> session/create)
import { readFileSync } from 'node:fs'
import { createHash, createHmac, randomUUID } from 'node:crypto'

const home = process.env.DSH_HOME ?? `${process.env.USERPROFILE}\\.dsh`
const yaml = readFileSync(`${home}\\.credentials.yaml`, 'utf8')
const secret = Buffer.from(yaml.match(/client-connection\/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]{20,})/)[1], 'base64url')
const authority = '127.0.0.1:3080'
const cookieName = 'dsh-auth-' + createHash('sha256').update(authority).digest('base64url')
const now = Date.now()
const body = Buffer.from(JSON.stringify({ version: 1, authority, issuedAt: now, expiresAt: now + 2.592e9 })).toString('base64url')
const cookie = `${cookieName}=v1.${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`

async function call(method, args) {
  const res = await fetch(`http://${authority}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }),
  })
  const json = await res.json().catch(() => null)
  const result = json?.result
  const label = `[${method}]`
  if (result?.ok) {
    const value = JSON.stringify(result.value)
    console.log(`${label} ok value:`, value.length > 900 ? value.slice(0, 900) + '…' : value)
    return result.value
  }
  console.log(`${label} FAILED:`, JSON.stringify(result?.error)?.slice(0, 500))
  return undefined
}

await call('workspace/create', { request: { path: 'D:\\Workspace\\VSCplugin' } })
await call('session/list', { _request: {} })
await call('session/create', { request: { cwd: 'D:\\Workspace\\VSCplugin' } })
await call('session/list', { _request: {} })
