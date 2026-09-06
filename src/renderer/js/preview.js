import pdfjsLib from './pdfjs.js'
import { burst } from './confetti.js'

let pdf = null
let pageNum = 0
let rendering = false
let rerenderPending = false
let currentDoc = null     // 阅读进度归属的文档
let lastPct = 0           // 本会话内上次记录的进度百分比，用于判定「读毕」瞬间
let pendingProgress = null
let progressTimer = null

const overlay = document.getElementById('previewOverlay')
const canvas = document.getElementById('previewCanvas')
const body = document.getElementById('previewBody')
const tocBtn = document.getElementById('btnToc')
const tocPanel = document.getElementById('tocPanel')
const tocList = document.getElementById('tocList')

// jumpPage：全文搜索命中时跳转的起始页（null 则从第 1 页开始）
export function openPreview (doc, jumpPage = null) {
  if (!doc) return
  currentDoc = doc
  window.currentPreviewId = doc.id
  document.getElementById('previewTitle').textContent = doc.title
  overlay.hidden = false
  loadDoc(doc.id, jumpPage)
}

export function closePreview () {
  // 关闭前把还没落库的进度立刻写掉，避免丢掉最后翻到的那一页。
  // 返回落库的 Promise：调用方（app.js）须等它完成再刷新列表，
  // 否则 getLibrary 与 setProgress 并发竞争，会读回旧进度。
  clearTimeout(progressTimer)
  const flushed = flushProgress()
  overlay.hidden = true
  window.currentPreviewId = null
  currentDoc = null
  if (pdf) { pdf.destroy(); pdf = null }
  pageNum = 0
  tocPanel.hidden = true
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  return flushed
}

export function isPreviewOpen () {
  return !overlay.hidden
}

async function loadDoc (id, jumpPage) {
  try {
    const buffer = await window.solace.readPreview(id)
    const pdfDoc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise
    pdf = pdfDoc
    pageNum = jumpPage >= 1 && jumpPage <= pdfDoc.numPages ? jumpPage : 1
    lastPct = pctOf(currentDoc)
    updatePageIndicator()
    renderPage()
    scheduleProgress()
    loadOutline(pdfDoc, id)
  } catch (err) {
    closePreview()
    alert(`预览加载失败：${err.message || err}`)
  }
}

function updatePageIndicator () {
  document.getElementById('previewPage').textContent = `${pageNum} / ${pdf.numPages}`
}

async function renderPage () {
  if (!pdf || rendering) { rerenderPending = true; return }
  rendering = true
  try {
    const page = await pdf.getPage(pageNum)
    const fitWidth = Math.min(1100, body.clientWidth - 36)
    const base = page.getViewport({ scale: 1 })
    const scale = Math.max(0.2, fitWidth / base.width)

    // 按设备像素比渲染，保证文字清晰
    const dpr = window.devicePixelRatio || 1
    const viewport = page.getViewport({ scale: scale * dpr })
    canvas.width = Math.floor(viewport.width)
    canvas.height = Math.floor(viewport.height)
    canvas.style.width = Math.floor(base.width * scale) + 'px'
    canvas.style.height = Math.floor(base.height * scale) + 'px'

    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
  } finally {
    rendering = false
    if (rerenderPending) { rerenderPending = false; renderPage() }
  }
}

/* ================= 阅读进度 ================= */

function pctOf (doc) {
  const p = doc && doc.progress
  return p && p.totalPages >= 1 ? Math.min(100, Math.round(p.page / p.totalPages * 100)) : 0
}

// 翻页后不立刻写库：600ms 内连续翻页只记最后一次，减少 library.json 写入次数
function scheduleProgress () {
  if (!currentDoc || !pdf) return
  pendingProgress = { page: pageNum, total: pdf.numPages }
  clearTimeout(progressTimer)
  progressTimer = setTimeout(flushProgress, 600)
}

async function flushProgress () {
  const doc = currentDoc
  if (!doc || !pendingProgress) return
  const { page, total } = pendingProgress
  pendingProgress = null
  const pct = total >= 1 ? Math.min(100, Math.round(page / total * 100)) : 0
  const finished = pct >= 100 && lastPct < 100
  lastPct = pct
  try {
    await window.solace.setProgress(doc.id, page, total)
  } catch {
    return
  }
  if (finished) {
    const r = body.getBoundingClientRect()
    burst(r.left + r.width / 2, r.top + r.height / 3)
    window.toast?.(`🎉 《${doc.title}》读完了`)
  }
}

/* ================= 目录（PDF 书签大纲） ================= */

// 大纲解析是异步的，期间用户可能关闭预览或切换文档：所有调用都绑定 pdfDoc，
// 完成后核对它仍是当前文档才渲染。
async function loadOutline (pdfDoc, docId) {
  tocBtn.hidden = true
  tocPanel.hidden = true
  tocList.innerHTML = ''
  let flat
  try {
    const outline = await pdfDoc.getOutline()
    if (pdfDoc !== pdf || !currentDoc || currentDoc.id !== docId) return
    if (!outline || !outline.length) return
    flat = []
    await flattenOutline(pdfDoc, outline, 0, flat)
    if (pdfDoc !== pdf) return
  } catch {
    return
  }
  if (!flat.length) return
  tocBtn.hidden = false
  tocList.innerHTML = flat.map(it => `
    <li style="--d:${it.depth}">
      ${it.page
        ? `<button data-page="${it.page}" title="第 ${it.page} 页">${escToc(it.title)}</button>`
        : `<span class="toc-dead">${escToc(it.title)}</span>`}
    </li>`).join('')
}

async function flattenOutline (pdfDoc, items, depth, out) {
  for (const it of items) {
    out.push({ title: it.title || '（无标题）', depth, page: await destToPage(pdfDoc, it.dest) })
    if (Array.isArray(it.items) && it.items.length) await flattenOutline(pdfDoc, it.items, depth + 1, out)
  }
}

async function destToPage (pdfDoc, dest) {
  try {
    const d = typeof dest === 'string' ? await pdfDoc.getDestination(dest) : dest
    if (Array.isArray(d) && d[0]) return (await pdfDoc.getPageIndex(d[0])) + 1
  } catch { /* 定位失败的条目置灰显示 */ }
  return null
}

const escToc = (s) => String(s).replace(/[&<>"]/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
}[c]))

tocBtn.addEventListener('click', () => { tocPanel.hidden = !tocPanel.hidden })

tocList.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-page]')
  if (!btn || !pdf) return
  const p = Number(btn.dataset.page)
  if (!(p >= 1 && p <= pdf.numPages)) return
  pageNum = p
  updatePageIndicator()
  renderPage()
  body.scrollTop = 0
  scheduleProgress()
})

/* ================= 翻页 ================= */

document.getElementById('btnPrevPage').addEventListener('click', () => stepPage(-1))
document.getElementById('btnNextPage').addEventListener('click', () => stepPage(1))

function stepPage (delta) {
  if (!pdf) return
  const next = pageNum + delta
  if (next < 1 || next > pdf.numPages) return
  pageNum = next
  updatePageIndicator()
  renderPage()
  body.scrollTop = 0
  scheduleProgress()
}

// 预览内键盘翻页（有对话框开着时让位给对话框，比如命令面板里的输入）
window.addEventListener('keydown', (e) => {
  if (!isPreviewOpen()) return
  if (document.querySelector('dialog[open]')) return
  if (e.key === 'ArrowLeft') stepPage(-1)
  if (e.key === 'ArrowRight') stepPage(1)
})

// 窗口尺寸变化时重渲染当前页
window.addEventListener('resize', () => {
  if (isPreviewOpen() && pdf) renderPage()
})

// 供 app.js 挂到 window 上的关闭函数
window.closePreview = closePreview
