// 生成应用图标 build/icon.ico —— 纯 Node 实现，无第三方依赖。
// 两种来源：
//   1) node scripts/make-icon.js [源图.png]：把 PNG 源图（如书本 logo）
//      缩放并裁出圆角后封装为 ICO（默认找 build/icon-source.png）
//   2) 无源图：回退到内置绘制的旧版设计（深夜蓝渐变底 + 六芒星芒）
// 产物：内嵌 256/48/32/16 四档 PNG 的 ICO（Vista+ 支持 PNG-in-ICO），
// electron-builder 打包时要求至少含 256×256。

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const SIZES = [256, 48, 32, 16]

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

// ---------- PNG 解码（仅支持常用子集：8 位、非隔行、灰度/RGB/RGBA） ----------
function pngDecode (buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG 文件')
  let pos = 8
  let width = 0; let height = 0; let depth = 0; let colorType = 0; let interlace = 0
  const idat = []
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      depth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + len
  }
  if (interlace) throw new Error('不支持 Adam7 隔行 PNG，请重新导出')
  if (depth !== 8) throw new Error(`不支持的位深 ${depth}（仅 8 位）`)
  const ch = { 0: 1, 2: 3, 6: 4 }[colorType]
  if (!ch) throw new Error(`不支持的颜色类型 ${colorType}（仅灰度/RGB/RGBA）`)

  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * ch
  // 逐行还原过滤器（0 无 / 1 Sub / 2 Up / 3 Average / 4 Paeth）
  const out = Buffer.alloc(width * height * 4)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(stride)
    const f = raw[y * (stride + 1)]
    raw.copy(row, 0, y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? row[x - ch] : 0
      const b = prev[x]
      const c = x >= ch ? prev[x - ch] : 0
      if (f === 1) row[x] = (row[x] + a) & 0xff
      else if (f === 2) row[x] = (row[x] + b) & 0xff
      else if (f === 3) row[x] = (row[x] + ((a + b) >> 1)) & 0xff
      else if (f === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c)
        row[x] = (row[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
      }
    }
    prev = row
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      if (colorType === 6) {
        row.copy(out, o, x * 4, x * 4 + 4)
      } else if (colorType === 2) {
        out[o] = row[x * 3]; out[o + 1] = row[x * 3 + 1]; out[o + 2] = row[x * 3 + 2]; out[o + 3] = 255
      } else {
        out[o] = out[o + 1] = out[o + 2] = row[x]; out[o + 3] = 255
      }
    }
  }
  return { width, height, rgba: out }
}

// 区域平均缩放：缩小到 size×size，每目标像素取源图对应方块的平均值
// （比最近邻平滑得多，16px 小尺寸依然可辨）
function resizeBox ({ width, height, rgba }, size) {
  const out = Buffer.alloc(size * size * 4)
  for (let dy = 0; dy < size; dy++) {
    const y0 = Math.floor(dy * height / size); const y1 = Math.max(y0 + 1, Math.floor((dy + 1) * height / size))
    for (let dx = 0; dx < size; dx++) {
      const x0 = Math.floor(dx * width / size); const x1 = Math.max(x0 + 1, Math.floor((dx + 1) * width / size))
      let r = 0; let g = 0; let b = 0; let a = 0; let n = 0
      for (let y = y0; y < y1 && y < height; y++) {
        for (let x = x0; x < x1 && x < width; x++) {
          const i = (y * width + x) * 4
          r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; a += rgba[i + 3]; n++
        }
      }
      const o = (dy * size + dx) * 4
      out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n)
      out[o + 2] = Math.round(b / n); out[o + 3] = Math.round(a / n)
    }
  }
  return out
}

// 圆角裁切：圆角外透明，边缘 1px 渐变抗锯齿（与内置设计的圆角一致）
function roundCorners (px, size, radius) {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = Math.max(Math.abs(x + 0.5 - size / 2) - (size / 2 - radius), 0)
      const dy = Math.max(Math.abs(y + 0.5 - size / 2) - (size / 2 - radius), 0)
      const d = Math.hypot(dx, dy) - radius
      if (d >= 0) {
        const i = (y * size + x) * 4
        px[i + 3] = 0
      } else if (d > -1) {
        const i = (y * size + x) * 4
        px[i + 3] = Math.round(px[i + 3] * -d)
      }
    }
  }
  return px
}

// ---------- 内置绘制（无源图时的后备设计） ----------
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

// ---------- ICO 封装 ----------
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

// ---------- 主流程 ----------
const outDir = path.join(__dirname, '..', 'build')
fs.mkdirSync(outDir, { recursive: true })

const argSource = process.argv[2]
const defaultSource = path.join(outDir, 'icon-source.png')
const sourcePath = argSource || (fs.existsSync(defaultSource) ? defaultSource : null)

let images
if (sourcePath) {
  const img = pngDecode(fs.readFileSync(sourcePath))
  console.log(`源图：${sourcePath}（${img.width}×${img.height}）`)
  images = SIZES.map(size => ({
    size,
    data: pngEncode(size, roundCorners(resizeBox(img, size), size, (size / 256) * 52))
  }))
} else {
  console.log('未提供源图，使用内置绘制的六芒星设计')
  images = SIZES.map(size => ({ size, data: pngEncode(size, drawIcon(size)) }))
}
fs.writeFileSync(path.join(outDir, 'icon.ico'), icoEncode(images))
console.log(`已生成 build/icon.ico（${SIZES.join('/')}）`)
