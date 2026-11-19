// Fetch the running dsh web SPA bundle and extract the FishLogo (whale) vector artwork.
import { createRequire } from 'node:module'
import http from 'node:http'
import { writeFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const { readBrowserSessionSecret, mintBrowserCookie } = require('../dist/credentials.js')

const authority = process.argv[2] ?? '127.0.0.1:6918'
const cookie = mintBrowserCookie(authority, readBrowserSessionSecret())

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: Number(authority.split(':')[1]), path, headers: { host: authority, cookie, 'accept-encoding': 'identity' } },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

const html = await get('/')
const src = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)]
  .map((m) => m[1].replace(/&amp;/g, '&'))
  .find((s) => s.includes('assets/'))
const bundle = await get('/' + src.replace(/^\.\//, ''))

const pathName = bundle.match(/FISH_LOGO_PATH:\s*([A-Za-z_$][\w$]*)/)?.[1]
const boxName = bundle.match(/FISH_LOGO_VIEWBOX:\s*([A-Za-z_$][\w$]*)/)?.[1]
const pathData = bundle.match(new RegExp(`\\b${pathName}\\s*=\\s*"([^"]+)"`))?.[1]
const box = bundle.match(new RegExp(`\\b${boxName}\\s*=\\s*\\{\\s*width:\\s*([\\d.]+)\\s*,\\s*height:\\s*([\\d.]+)\\s*\\}`))
if (!pathData || !box) throw new Error('fish logo artwork not found in bundle')

const viewBox = `0 0 ${box[1]} ${box[2]}`
console.log('path length:', pathData.length, 'viewBox:', viewBox)

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${box[1]}" height="${box[2]}" fill="currentColor" role="img" aria-label="DeepSeek Harness"><path d="${pathData}"/></svg>\n`
writeFileSync('media/dsh-whale.svg', svg, 'utf8')
writeFileSync('media/dsh.svg', svg, 'utf8')
console.log('wrote media/dsh-whale.svg and media/dsh.svg')
