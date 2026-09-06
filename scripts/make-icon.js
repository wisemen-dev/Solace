// 生成应用图标 build/icon.ico —— 纯 Node 实现，无第三方依赖。
// 设计：深夜蓝渐变圆角底 + 六芒星芒（呼应 Solace 界面的 ❉ 元素）。
// 产物：内嵌 256/48/32/16 四档 PNG 的 ICO（Vista+ 支持 PNG-in-ICO）。
// 用法：node scripts/make-icon.js

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32 (buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function pngChunk (type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function pngEncode (size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  // 每行前置 filter 字节 0
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

// ---------- 绘制 ----------
function drawIcon (size) {
  const px = Buffer.alloc(size * size * 4)
  const S = size / 256 // 以 256 为设计基准的缩放系数
  const c = size / 2
  const R = 106 * S // 星芒外半径
  const HUB = 15 * S // 中心圆
  const CORNER = 52 * S // 圆角半径
  const spokes = []
  for (let k = 0; k < 6; k++) spokes.push(Math.PI / 2 + (k * Math.PI) / 3)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      // 圆角矩形外 → 透明
      const dx = Math.max(Math.abs(x - c) - (c - CORNER), 0)
      const dy = Math.max(Math.abs(y - c) - (c - CORNER), 0)
      if (Math.hypot(dx, dy) > CORNER) continue

      // 背景：对角渐变 #1b2740 → #0f141b
      const t = (x + y) / (size * 2)
      px[i] = Math.round(0x1b + (0x0f - 0x1b) * t)
      px[i + 1] = Math.round(0x27 + (0x14 - 0x27) * t)
      px[i + 2] = Math.round(0x40 + (0x1b - 0x40) * t)
      px[i + 3] = 255

      // 星芒：到 6 条辐条轴线的加权距离
      const vx = x - c
      const vy = y - c
      let d = Infinity
      for (const a of spokes) {
        const ux = Math.cos(a)
        const uy = -Math.sin(a) // 屏幕 y 向下
        const proj = vx * ux + vy * uy
        const perp = Math.abs(-vx * uy + vy * ux)
        if (proj >= HUB * 0.4 && proj <= R) {
          const w = 12 * S * (1 - (proj / R) * 0.35) // 由内向外收窄
          d = Math.min(d, perp - w)
        }
      }
      d = Math.min(d, Math.hypot(vx, vy) - HUB) // 中心圆
      if (d < 0) {
        const edge = Math.min(1, -d / (1.6 * S)) // 简单抗锯齿
        px[i] = Math.round(0x6e * edge + px[i] * (1 - edge))
        px[i + 1] = Math.round(0xa8 * edge + px[i + 1] * (1 - edge))
        px[i + 2] = Math.round(0xfe * edge + px[i + 2] * (1 - edge))
      }
    }
  }
  return px
}

// 最近邻缩放（源图固定按 256 设计，直接重绘各尺寸保证细节）
function icoEncode (images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  const entries = []
  let offset = 6 + images.length * 16
  for (const { size, data } of images) {
    const e = Buffer.alloc(16)
    e[0] = size >= 256 ? 0 : size
    e[1] = size >= 256 ? 0 : size
    e[2] = 0 // 调色板色数
    e[3] = 0 // 保留
    e.writeUInt16LE(1, 4) // planes
    e.writeUInt16LE(32, 6) // bpp
    e.writeUInt32LE(data.length, 8)
    e.writeUInt32LE(offset, 12)
    entries.push(e)
    offset += data.length
  }
  return Buffer.concat([header, ...entries, ...images.map(m => m.data)])
}

const outDir = path.join(__dirname, '..', 'build')
fs.mkdirSync(outDir, { recursive: true })
const images = [256, 48, 32, 16].map(size => ({ size, data: pngEncode(size, drawIcon(size)) }))
fs.writeFileSync(path.join(outDir, 'icon.ico'), icoEncode(images))
console.log('已生成 build/icon.ico（256/48/32/16）')
