import * as pdfjsLib from '../../../node_modules/pdfjs-dist/build/pdf.min.mjs'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  '../../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).href

let pdf = null
let pageNum = 0
let rendering = false
let rerenderPending = false

const overlay = document.getElementById('previewOverlay')
const canvas = document.getElementById('previewCanvas')
const body = document.getElementById('previewBody')

export function openPreview (doc) {
  if (!doc) return
  window.currentPreviewId = doc.id
  document.getElementById('previewTitle').textContent = doc.title
  overlay.hidden = false
  loadDoc(doc.id)
}

export function closePreview () {
  overlay.hidden = true
  window.currentPreviewId = null
  if (pdf) { pdf.destroy(); pdf = null }
  pageNum = 0
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, canvas.width, canvas.height)
}

export function isPreviewOpen () {
  return !overlay.hidden
}

async function loadDoc (id) {
  try {
    const buffer = await window.solace.readPreview(id)
    pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise
    pageNum = 1
    updatePageIndicator()
    renderPage()
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
}

// 预览内键盘翻页
window.addEventListener('keydown', (e) => {
  if (!isPreviewOpen()) return
  if (e.key === 'ArrowLeft') stepPage(-1)
  if (e.key === 'ArrowRight') stepPage(1)
})

// 窗口尺寸变化时重渲染当前页
window.addEventListener('resize', () => {
  if (isPreviewOpen() && pdf) renderPage()
})

// 供 app.js 挂到 window 上的关闭函数
window.closePreview = closePreview
