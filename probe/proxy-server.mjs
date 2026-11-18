/**
 * Hold the extension proxy open so a real browser can be pointed at it.
 *
 * Usage: node probe\proxy-server.mjs [host:port]
 * Prints the proxy URL and keeps running until the process is stopped.
 */
import { createRequire } from 'node:module'
import { readBrowserSessionSecret, mintBrowserCookie } from '../dist/credentials.js'

const require = createRequire(import.meta.url)
const { DshProxy } = require('../dist/proxy.js')

const target = process.argv[2] ?? '127.0.0.1:3080'
const [hostname, portText] = target.split(':')
const port = Number(portText)
const authority = target
const secret = readBrowserSessionSecret()
const cookie = mintBrowserCookie(authority, secret)
const info = {
  baseUrl: `http://${target}`,
  hostname,
  port,
  authority,
  origin: `http://${target}`,
  cookie,
  mode: 'attached',
}

const logger = {
  info: (message) => console.log('[info]', message),
  warn: (message) => console.log('[warn]', message),
  error: (message, error) => console.log('[error]', message, error?.stack ?? error ?? ''),
}

const proxy = await DshProxy.start(() => info, logger)
console.log(`PROXY_URL=${proxy.url}`)

process.on('SIGINT', async () => {
  await proxy.dispose()
  process.exit(0)
})
setInterval(() => {}, 1 << 30)
