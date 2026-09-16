import pdfjsLib, { docParams } from './pdfjs.js'

// 封面服务：
// - 已有封面（doc.hasCover）→ 从资料库读回，内存缓存
// - 无封面 → 入队后台生成（渲染首页 → JPEG → 存库），完成后就地刷新对应 <img>
// 生成按队列串行执行，避免同时加载多份 PDF 挤占资源

const covers = new Map()   // docId -> dataUrl（渲染进程内存缓存）
const inflight = new Set() // 正在读取/生成的文档
const queue = []           // 待生成队列
let draining = false

export function coverCache () {
  return covers
}

// 切换资料库后调用：旧库的封面 dataURL 缓存全部作废
export function clearCoverCache () {
  covers.clear()
}

// 供列表渲染时调用：把 doc 的封面填进 img（有则立即填，无则安排生成）
export function ensureCover (doc, img) {
  const cached = covers.get(doc.id)
  if (cached) {
    img.src = cached
    return
  }
  if (doc.hasCover) {
    if (inflight.has(doc.id)) return
    inflight.add(doc.id)
    window.solace.getCover(doc.id)
      .then(dataUrl => {
        // 先释放占位再处理结果：文件丢失要回退生成队列，去重检查依赖 inflight 已清
        inflight.delete(doc.id)
        if (dataUrl) {
          covers.set(doc.id, dataUrl)
          fillImgs(doc.id, dataUrl)
        } else {
          // 登记了 hasCover 但 covers/<id>.jpg 已不在（被手动清理/损坏）：重新生成
          enqueueGenerate(doc)
        }
      })
      .catch(() => {})
      .finally(() => inflight.delete(doc.id))
    return
  }
  enqueueGenerate(doc)
}

function enqueueGenerate (doc) {
  if (inflight.has(doc.id) || queue.some(d => d.id === doc.id)) return
  queue.push(doc)
  drain()
}

async function drain () {
  if (draining) return
  draining = true
  while (queue.length) {
    const doc = queue.shift()
    inflight.add(doc.id)
    try {
      const dataUrl = await generateCover(doc.id)
      if (dataUrl) {
        covers.set(doc.id, dataUrl)
        fillImgs(doc.id, dataUrl)
      }
    } catch {
      // 生成失败静默跳过；该卡片下次进入视野时会重试
    } finally {
      inflight.delete(doc.id)
    }
  }
  draining = false
}

async function generateCover (docId) {
  const buffer = await window.solace.readPreview(docId)
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer), ...docParams }).promise
  try {
    const page = await pdf.getPage(1)
    const base = page.getViewport({ scale: 1 })
    const scale = Math.min(2, 320 / base.width)
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const viewport = page.getViewport({ scale: scale * dpr })
    const canvas = document.createElement('canvas')
    canvas.width = Math.floor(viewport.width)
    canvas.height = Math.floor(viewport.height)
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
    const dataUrl = canvas.toDataURL('image/jpeg', 0.82)
    await window.solace.setCover(docId, dataUrl)
    return dataUrl
  } finally {
    pdf.destroy()
  }
}

function fillImgs (docId, dataUrl) {
  document
    .querySelectorAll(`.doc-cover-img[data-doc-id="${docId}"]`)
    .forEach(img => { img.src = dataUrl })
}
