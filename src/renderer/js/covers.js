import pdfjsLib, { docParams } from './pdfjs.js'
import { fitPageViewport } from './pdfcanvas.js'

// 封面服务：
// - 已有封面（doc.hasCover）→ 从资料库读回，内存缓存
// - 无封面 → 入队后台生成（渲染首页 → JPEG → 存库），完成后就地刷新对应 <img>
// 生成按队列串行执行，避免同时加载多份 PDF 挤占资源

const covers = new Map()   // docId -> dataUrl（渲染进程内存缓存）
const inflight = new Map() // docId -> task
const queue = []           // 待生成队列
const activePdfs = new Set()
let generation = 0
let draining = null

export function coverCache () {
  return covers
}

// 切换资料库后调用：旧库的封面 dataURL 缓存全部作废
export function clearCoverCache () {
  generation++
  queue.length = 0
  inflight.clear()
  draining = null
  covers.clear()
  for (const task of activePdfs) destroyPdf(task)
  activePdfs.clear()
}

// 供列表渲染时调用：把 doc 的封面填进 img（有则立即填，无则安排生成）
export function ensureCover (doc, img, sessionId) {
  const cached = covers.get(doc.id)
  if (cached) {
    img.src = cached
    return
  }
  if (doc.hasCover) {
    if (inflight.has(doc.id)) return
    const task = { doc, sessionId, generation }
    inflight.set(doc.id, task)
    loadCover(task)
    return
  }
  enqueueGenerate(doc, sessionId)
}

async function loadCover (task) {
  try {
    const dataUrl = await window.solace.getCover(task.doc.id, task.sessionId)
    if (task.generation !== generation) return
    release(task)
    if (dataUrl) {
      covers.set(task.doc.id, dataUrl)
      fillImgs(task.doc.id, dataUrl)
    } else {
      enqueueGenerate(task.doc, task.sessionId)
    }
  } catch {
    // A later visibility update retries a failed read.
  } finally {
    release(task)
  }
}

function release (task) {
  if (inflight.get(task.doc.id) === task) inflight.delete(task.doc.id)
}

function enqueueGenerate (doc, sessionId) {
  if (inflight.has(doc.id) || queue.some(task => task.doc.id === doc.id)) return
  queue.push({ doc, sessionId, generation })
  drain()
}

async function drain () {
  const epoch = generation
  if (draining === epoch) return
  draining = epoch
  try {
    while (queue.length && epoch === generation) {
      const task = queue.shift()
      inflight.set(task.doc.id, task)
      try {
        const dataUrl = await generateCover(task)
        if (task.generation !== generation) return
        if (dataUrl) {
          covers.set(task.doc.id, dataUrl)
          fillImgs(task.doc.id, dataUrl)
        }
      } catch {
        // A later visibility update retries a failed generation.
      } finally {
        release(task)
      }
    }
  } finally {
    if (draining === epoch) draining = null
  }
}

async function generateCover (task) {
  try {
    const buffer = await window.solace.readPreview(task.doc.id, task.sessionId)
    if (task.generation !== generation) return null
    const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
    task.loadingTask = pdfjsLib.getDocument({ data, ...docParams })
    activePdfs.add(task)
    task.pdf = await task.loadingTask.promise
    if (task.generation !== generation) return null
    const page = await task.pdf.getPage(1)
    if (task.generation !== generation) return null
    const base = page.getViewport({ scale: 1 })
    const scale = Math.min(2, 320 / base.width)
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const { viewport, width, height } = fitPageViewport(page, scale * dpr)
    const canvas = document.createElement('canvas')
    task.canvas = canvas
    canvas.width = width
    canvas.height = height
    task.renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport })
    await task.renderTask.promise
    task.renderTask = null
    if (task.generation !== generation) return null
    const dataUrl = canvas.toDataURL('image/jpeg', 0.82)
    await window.solace.setCover(task.doc.id, dataUrl, task.sessionId)
    if (task.generation !== generation) return null
    return dataUrl
  } finally {
    destroyPdf(task)
    activePdfs.delete(task)
    if (task.canvas) task.canvas.width = task.canvas.height = 0
  }
}

function destroyPdf (task) {
  try { task.renderTask?.cancel() } catch {}
  const resource = task.pdf || task.loadingTask
  if (!resource || task.destroyed === resource) return
  task.destroyed = resource
  try {
    Promise.resolve(resource.destroy?.()).catch(() => {})
  } catch {
    // Disposal must never delay a new library's queue.
  }
}

function fillImgs (docId, dataUrl) {
  document
    .querySelectorAll(`.doc-cover-img[data-doc-id="${docId}"]`)
    .forEach(img => { img.src = dataUrl })
}
