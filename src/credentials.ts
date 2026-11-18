import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash, createHmac } from 'node:crypto'

/** `$DSH_HOME`, falling back to `~/.dsh`. */
export function dshHome(): string {
  const fromEnv = process.env.DSH_HOME?.trim()
  if (fromEnv) return fromEnv
  return join(homedir(), '.dsh')
}

/** Key of the credential record that holds the browser session secret. */
const BROWSER_SESSION_KEY = 'client-connection/browser-session'

/**
 * Read the browser session secret from the credential store.
 *
 * The store also holds unrelated API keys, so instead of parsing the whole
 * document the record we need is located first and only its `secret` field is
 * read. The value is a base64url encoded random key; anything that does not
 * decode to a plausible key length is rejected.
 */
export function readBrowserSessionSecret(home: string = dshHome()): Buffer | undefined {
  const file = join(home, '.credentials.yaml')
  if (!existsSync(file)) return undefined
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  const secret = extractSecret(text)
  if (!secret) return undefined
  const bytes = Buffer.from(secret, 'base64url')
  return bytes.byteLength >= 16 ? bytes : undefined
}

/** Locate `client-connection/browser-session` and read its `secret` field. */
function extractSecret(text: string): string | undefined {
  const keyIndex = text.indexOf(BROWSER_SESSION_KEY)
  if (keyIndex < 0) return undefined
  const start = keyIndex + BROWSER_SESSION_KEY.length
  const record = text.slice(start, start + 4096)
  const match = /(?:^|[\s{,])secret\s*:\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([A-Za-z0-9_\-+/=]{16,}))/.exec(record)
  if (!match) return undefined
  const value = (match[1] ?? match[2] ?? match[3] ?? '').trim()
  return value.length > 0 ? value : undefined
}

/**
 * Mint the signed browser cookie the host expects for `authority`
 * (`host:port`). The wire format mirrors the host implementation:
 * `v1.<base64url(payload)>.<base64url(HMAC-SHA256(secret, body))>`.
 */
export function mintBrowserCookie(authority: string, secret: Buffer, lifetimeMs = 30 * 24 * 60 * 60 * 1000): string {
  const name = 'dsh-auth-' + createHash('sha256').update(authority).digest('base64url')
  const issuedAt = Date.now()
  const payload = { version: 1, authority, issuedAt, expiresAt: issuedAt + lifetimeMs }
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const signature = createHmac('sha256', secret).update(body).digest('base64url')
  return `${name}=v1.${body}.${signature}`
}

/** The cookie name the host derives from an authority. */
export function browserCookieName(authority: string): string {
  return 'dsh-auth-' + createHash('sha256').update(authority).digest('base64url')
}
