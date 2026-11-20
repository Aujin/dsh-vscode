import { createRequire } from 'node:module'
import http from 'node:http'

const require = createRequire(import.meta.url)
const { readBrowserSessionSecret, mintBrowserCookie } = require('../dist/credentials.js')

const authority = process.argv[2] ?? '127.0.0.1:1249'
const port = Number(authority.split(':')[1])
const cookie = mintBrowserCookie(authority, readBrowserSessionSecret())

function get(path, headers = {}) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, headers: { host: authority, 'accept-encoding': 'identity', ...headers } },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
      },
    )
    req.on('error', (e) => resolve({ status: 0, headers: {}, body: Buffer.from(String(e.message)) }))
    req.end()
  })
}

const index = await get('/', { cookie })
const html = index.body.toString('utf8')
const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'))
console.log('index status:', index.status, 'scripts:', scripts)

for (const s of scripts) {
  const r = await get('/' + s.replace(/^\.\//, ''), { cookie })
  console.log(`  ${r.status}  ${s}  (${r.body.length} bytes)`)
}

for (const p of ['/api/remote.mux', '/api/workspace/follow', '/api/session/list', '/connect', '/assets/index-Ciz7DZxv.js']) {
  const r = await get(p, { cookie })
  console.log(`GET ${p} -> ${r.status} ${JSON.stringify(r.body.toString('utf8').slice(0, 60))}`)
}

// the boot payload: are the plugin module urls reachable?
const boot = html.match(/globalThis\["__DSH_BOOT__"\]\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/)
if (boot) {
  try {
    const data = JSON.parse(boot[1])
    console.log('boot entries:', data.entries?.length, 'batches:', data.batches?.length)
    const sample = (data.entries ?? []).slice(0, 3).map((e) => e.url)
    for (const u of sample) {
      const r = await get('/' + String(u).replace(/^\.\//, ''), { cookie })
      console.log(`  entry ${r.status} ${u}`)
    }
  } catch (error) {
    console.log('boot parse failed:', error.message)
  }
}
