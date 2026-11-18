/**
 * Verify the host discovery of the extension.
 *
 *   node probe\discovery-probe.mjs <host:port> [netstat-sample.txt]
 *
 * Checks
 *   1. the candidate address list (dsh.webUrl → DSH_WEB_URL → autoStartPort → default ports),
 *   2. the netstat parser against a real `netstat -ano -p TCP` sample,
 *   3. the port detector against the running dsh web (identified by the
 *      injected __DSH_BOOT__ marker in the index document),
 *   4. the whole DshHost.connect() path attaching to the running host instead
 *      of starting a second one.
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const { DshHost, parseListeningPorts, detectDshHost } = require('../dist/host.js')
const { readBrowserSessionSecret, mintBrowserCookie } = require('../dist/credentials.js')

const target = process.argv[2] ?? '127.0.0.1:8080'
const sampleFile = process.argv[3]
const [hostname, portText] = target.split(':')
const port = Number(portText)
const authority = target
const baseUrl = `http://${target}`

const logger = {
  info: (message) => console.log('[info]', message),
  warn: (message) => console.log('[warn]', message),
  error: (message, error) => console.log('[error]', message, error?.stack ?? error ?? ''),
}

let failures = 0
function check(label, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`)
  if (!ok) failures += 1
}

// 1. candidate list
const options = { webUrl: '', autoStart: false, autoStartPort: 3080, executablePath: undefined }
const host = new DshHost(logger, () => options)
const candidates = host.candidateUrls(options).map((c) => `${c.baseUrl} (${c.source})`)
console.log('candidates:', candidates.join(', '))
check('DSH_WEB_URL is used when dsh.webUrl is empty', candidates.some((c) => c.includes('DSH_WEB_URL')))
check('default ports are probed', candidates.some((c) => c.includes(':3080')) && candidates.some((c) => c.includes(':8080')))

// 2. netstat parser
let parsedPorts = []
if (sampleFile) {
  parsedPorts = parseListeningPorts(readFileSync(sampleFile, 'utf8'))
  console.log('parsed listening ports:', parsedPorts.join(', '))
  check('the running dsh web port is in the parsed list', parsedPorts.includes(port), `port ${port}`)
} else {
  console.log('skip  netstat parser (no sample file given)')
}

// 3. port detector
const secret = readBrowserSessionSecret()
if (!secret) {
  console.log('FAIL  no browser session secret found')
  failures += 1
} else {
  const detected = await detectDshHost([port], (auth) => mintBrowserCookie(auth, secret))
  check('detectDshHost finds the running dsh web', detected === port, `detected ${detected}`)
  const wrong = await detectDshHost([1], (auth) => mintBrowserCookie(auth, secret))
  check('detectDshHost ignores a port that is not a dsh host', wrong === undefined)
}

// 4. full connect path
const attached = await host.connect()
check('DshHost.connect() attaches to the running host', attached?.mode === 'attached', attached?.baseUrl)
check('the attached host is the running one', attached?.baseUrl === baseUrl, attached?.baseUrl)
check('no second host was started', host.ownsProcess === false)

// 5. the start menu case: no DSH_WEB_URL, no configured url — the host has to
//    be found by scanning the locally listening ports
if (parsedPorts.length) {
  const scanned = await host.scanForHosts([], parsedPorts)
  check('the port scan finds the running dsh web', scanned?.baseUrl === baseUrl, scanned?.baseUrl)
}

console.log(failures === 0 ? 'DISCOVERY OK' : `DISCOVERY FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
