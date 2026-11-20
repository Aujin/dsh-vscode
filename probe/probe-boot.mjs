import { createRequire } from 'node:module'
import http from 'node:http'

const require = createRequire(import.meta.url)
const { readBrowserSessionSecret, mintBrowserCookie } = require('../dist/credentials.js')

const authority = process.argv[2] ?? '127.0.0.1:1249'
const port = Number(authority.split(':')[1])
const cookie = mintBrowserCookie(authority, readBrowserSessionSecret())

function get(path) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, headers: { host: authority, cookie, 'accept-encoding': 'identity' } },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      },
    )
    req.on('error', (e) => resolve(String(e.message)))
    req.end()
  })
}

const html = await get('/')
console.log('index length:', html.length)
for (const marker of [
  '__DSH_BOOT__',
  '__DSH_BOOT_READY__',
  '__DSH_TRANSPORT__',
  '__ModuleLoader__',
  '__DSH_CONTACT_CONFIG__',
  'streamBaseUrl',
  'ownsHost',
]) {
  const index = html.indexOf(marker)
  console.log(`${marker}: ${index === -1 ? 'ABSENT' : 'present @' + index}`)
}

// print every inline script block (trimmed) so the carrier contract is visible
const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
console.log('\n--- inline script blocks:', scripts.length, '---')
for (const [i, match] of scripts.entries()) {
  const attrs = match[1].trim()
  const body = match[2].trim()
  console.log(`\n[${i}] attrs=${attrs || '(none)'} length=${body.length}`)
  console.log(body.slice(0, 600))
}
