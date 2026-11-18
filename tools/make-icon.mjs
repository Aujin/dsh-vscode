// Generates the Marketplace icon (media/dsh.png) from the same shape as
// media/dsh.svg. The Marketplace refuses SVG icons, so the PNG is rasterised
// here without any image dependency.
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 128
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const pixels = new Uint8Array(SIZE * SIZE * 4)

function blend(x, y, [r, g, b], alpha) {
  if (alpha <= 0) return
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return
  const index = (y * SIZE + x) * 4
  const existing = pixels[index + 3] / 255
  const out = alpha + existing * (1 - alpha)
  if (out <= 0) return
  for (let channel = 0; channel < 3; channel += 1) {
    const value = (r + 0 * channel) * alpha + pixels[index + channel] * existing * (1 - alpha)
    pixels[index + channel] = Math.round(value / out)
  }
  pixels[index + 3] = Math.round(out * 255)
}

/** Coverage of a shape at a pixel, anti aliased over one pixel. */
function coverage(distance) {
  if (distance <= -0.5) return 1
  if (distance >= 0.5) return 0
  return 0.5 - distance
}

function roundedRectDistance(x, y, halfWidth, halfHeight, radius) {
  const dx = Math.abs(x) - (halfWidth - radius)
  const dy = Math.abs(y) - (halfHeight - radius)
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
  return outside + Math.min(Math.max(dx, dy), 0) - radius
}

function segmentDistance(px_, py, ax, ay, bx, by) {
  const vx = bx - ax
  const vy = by - ay
  const wx = px_ - ax
  const wy = py - ay
  const length = vx * vx + vy * vy
  const t = length === 0 ? 0 : Math.min(Math.max((wx * vx + wy * vy) / length, 0), 1)
  return Math.hypot(wx - t * vx, wy - t * vy)
}

const BACKGROUND = [31, 36, 48]
const BORDER = [58, 67, 84]
const STROKE = [77, 208, 225]

function drawRoundedRect(cx, cy, halfWidth, halfHeight, radius, color, thickness = 0) {
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const distance = roundedRectDistance(x + 0.5 - cx, y + 0.5 - cy, halfWidth, halfHeight, radius)
      const alpha = coverage(thickness > 0 ? Math.abs(distance) - thickness / 2 : distance)
      if (alpha > 0) blend(x, y, color, alpha)
    }
  }
}

function drawSegment(ax, ay, bx, by, width, color) {
  const radius = width / 2
  const minX = Math.max(0, Math.floor(Math.min(ax, bx) - radius - 1))
  const maxX = Math.min(SIZE - 1, Math.ceil(Math.max(ax, bx) + radius + 1))
  const minY = Math.max(0, Math.floor(Math.min(ay, by) - radius - 1))
  const maxY = Math.min(SIZE - 1, Math.ceil(Math.max(ay, by) + radius + 1))
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const distance = segmentDistance(x + 0.5, y + 0.5, ax, ay, bx, by)
      const alpha = coverage(distance - radius)
      if (alpha > 0) blend(x, y, color, alpha)
    }
  }
}

function drawCircle(cx, cy, radius, color) {
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const distance = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - radius
      const alpha = coverage(distance)
      if (alpha > 0) blend(x, y, color, alpha)
    }
  }
}

// Background plate.
drawRoundedRect(SIZE / 2, SIZE / 2, SIZE / 2 - 4, SIZE / 2 - 4, 26, BACKGROUND)
drawRoundedRect(SIZE / 2, SIZE / 2, SIZE / 2 - 4, SIZE / 2 - 4, 26, BORDER, 3)

// The glyph: the 24x24 viewBox of media/dsh.svg, scaled by 4 and centred.
const scale = 4
const offset = (SIZE - 24 * scale) / 2
const point = (x, y) => [offset + x * scale, offset + y * scale]

const polyline = [
  [4, 17.5],
  [9, 12],
  [12.5, 15.5],
  [20, 7],
]
for (let index = 0; index < polyline.length - 1; index += 1) {
  const [ax, ay] = point(polyline[index][0], polyline[index][1])
  const [bx, by] = point(polyline[index + 1][0], polyline[index + 1][1])
  drawSegment(ax, ay, bx, by, 1.8 * scale, STROKE)
}
const [arrowX, arrowY] = point(15.5, 7)
const [tipX, tipY] = point(20, 7)
const [tipDownX, tipDownY] = point(20, 11.5)
drawSegment(arrowX, arrowY, tipX, tipY, 1.8 * scale, STROKE)
drawSegment(tipX, tipY, tipDownX, tipDownY, 1.8 * scale, STROKE)
const [dotX, dotY] = point(4, 17.5)
drawCircle(dotX, dotY, 1.7 * scale, STROKE)

// --- PNG encoder -------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

const header = Buffer.alloc(13)
header.writeUInt32BE(SIZE, 0)
header.writeUInt32BE(SIZE, 4)
header[8] = 8 // bit depth
header[9] = 6 // truecolour with alpha
header[10] = 0
header[11] = 0
header[12] = 0

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE)
for (let y = 0; y < SIZE; y += 1) {
  raw[y * (SIZE * 4 + 1)] = 0
  Buffer.from(pixels.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1)
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

const target = join(root, 'media', 'dsh.png')
writeFileSync(target, png)
console.log(`icon written: ${target} (${png.length} bytes)`)
