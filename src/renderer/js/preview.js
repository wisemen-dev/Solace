import pdfjsLib, { docParams } from './pdfjs.js'
import { burst } from './confetti.js'
import { openNotes, closeNotes, isNotesOpen } from './notespanel.js'
import { esc } from './util.js'

let pdf = null
let pageNum = 0
let rendering = false
let rerenderPending = false
let currentDoc = null     // 阅读进度归属的文档
let readMarked = false    // 本次会话是否已记过阅读足迹（只在第一次真实翻页时记）
let pendingProgress = null // 待落库的进度 { doc, page, total }，绑定所属文档防切书串写
let progressTimer = null
let resumeEnabled = true  // 设置面板「恢复上次阅读位置」开关（app.js 注入）
const lastPctByDoc = new Map() // docId -> 本会话上次记录的进度百分比，判定「读毕」瞬间

export function setResumeEnabled (v) {
  resumeEnabled = !!v
}

const overlay = document.getElementById('previewOverlay')
const canvas = document.getElementById('previewCanvas')
const body = document.getElementById('previewBody')
const tocBtn = document.getElementById('btnToc')
const tocPanel = document.getElementById('tocPanel')
const tocList = document.getElementById('tocList')
const notesBtn = document.getElementById('btnNotes')
const pageJump = document.getElementById('pageJump')
const pageTotal = document.getElementById('pageTotal')
const errBox = document.getElementById('previewError')
const errText = document.getElementById('previewErrorText')

// jumpPage：全文搜索命中时跳转的起始页（null 则从第 1 页开始）
export function openPreview (doc, jumpPage = null) {
  if (!doc) return
  // 切书前先把上一本的待写进度立刻落库：进度绑定在 pendingProgress.doc 上，
  // 即使 600ms 防抖窗口内经命令面板换书，也只会写到原来的书上
  if (pendingProgress) flushProgress()
  currentDoc = doc
  readMarked = false
  window.currentPreviewId = doc.id
  document.getElementById('previewTitle').textContent = doc.title
  closeNotes() // 换书/重开时重置笔记面板
  overlay.hidden = false
  loadDoc(doc.id, jumpPage)
}

export function closePreview () {
  // 关闭前把还没落库的进度立刻写掉，避免丢掉最后翻到的那一页。
  // 返回落库的 Promise：调用方（app.js）须等它完成再刷新列表，
  // 否则 getLibrary 与 setProgress 并发竞争，会读回旧进度。
  clearTimeout(progressTimer)
  const flushed = flushProgress()
  closeNotes()
  errBox.hidden = true
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
  // 过期判定：加载是异步的，期间用户可能已关闭浮层或切到别的书（currentDoc 变化）
  const stale = () => overlay.hidden || !currentDoc || currentDoc.id !== id
  try {
    const buffer = await window.solace.readPreview(id)
    const pdfDoc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer), ...docParams }).promise
    // 过期结果必须销毁丢弃：否则会把已关闭的预览「复活」——pdf 挂着永不
    // destroy（内存泄漏）、往隐藏的 canvas 渲染
    if (stale()) {
      pdfDoc.destroy()
      return
    }
    pdf = pdfDoc
    // 起始页优先级：搜索命中的直达页 > 上次读到的页（设置开启时）> 第 1 页。
    // 显式跳页是当下意图，覆盖恢复逻辑，两者不冲突
    let start = 1
    if (jumpPage >= 1 && jumpPage <= pdfDoc.numPages) start = jumpPage
    else if (resumeEnabled && currentDoc && currentDoc.progress) {
      const p = currentDoc.progress
      if (p.page >= 1 && p.page <= pdfDoc.numPages) start = p.page
    }
    pageNum = start
    lastPctByDoc.set(id, currentDoc && currentDoc.id === id ? pctOf(currentDoc) : 0)
    updatePageIndicator()
    renderPage()
    scheduleProgress()
    loadOutline(pdfDoc, id)
  } catch (err) {
    // 失败时浮层可能已被用户关闭或已切书：这是过期加载，静默放弃，
    // 既不关闭当前预览也不弹错误打扰
    if (stale()) return
    closePreview()
    const msg = err && err.name === 'PasswordException'
      ? '此 PDF 已加密，内置预览无法打开。请用卡片上的「打开」按钮在外部阅读器中阅读。'
      : `预览加载失败：${err.message || err}`
    alert(msg)
  }
}

function updatePageIndicator () {
  pageJump.value = pageNum
  pageTotal.textContent = pdf.numPages
}

// Canvas 有单边像素上限（Chromium 约 32767，超限得到空白画布），大幅面
// PDF（图纸/海报）在高 DPI 屏上按 dpr 放大后很容易越界——表现为「整页
// 空白」，这里按上限回退缩放，宁可整页缩小显示也不空白
const MAX_CANVAS_SIDE = 8192

async function renderPage () {
  if (!pdf || rendering) { rerenderPending = true; return }
  rendering = true
  errBox.hidden = true
  try {
    const page = await pdf.getPage(pageNum)
    const fitWidth = Math.min(1100, body.clientWidth - 36)
    const base = page.getViewport({ scale: 1 })

    // 按设备像素比渲染，保证文字清晰
    const dpr = window.devicePixelRatio || 1
    let scale = Math.max(0.2, fitWidth / base.width)
    const capped = Math.min(MAX_CANVAS_SIDE / (base.width * dpr), MAX_CANVAS_SIDE / (base.height * dpr))
    if (scale > capped) scale = Math.max(0.05, capped)
    const viewport = page.getViewport({ scale: scale * dpr })
    canvas.width = Math.floor(viewport.width)
    canvas.height = Math.floor(viewport.height)
    canvas.style.width = Math.floor(base.width * scale) + 'px'
    canvas.style.height = Math.floor(base.height * scale) + 'px'

    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
  } catch (err) {
    // 渲染失败不再静默白屏：明确告知页码与原因，并给出出路
    errText.textContent = `第 ${pageNum} 页渲染失败（${String(err.message || err)}）。` +
      '可能是内置预览引擎（pdf.js）对此文件的兼容性限制，可点顶栏「外部打开」阅读本书。'
    errBox.hidden = false
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
  // 绑定 doc：防抖窗口内切书（如 Ctrl+K 换书）也不会把这本的页码写到别的书上
  pendingProgress = { doc: currentDoc, page: pageNum, total: pdf.numPages }
  clearTimeout(progressTimer)
  progressTimer = setTimeout(flushProgress, 600)
}

// 足迹：用户真实翻页（按钮/键盘/目录跳转）才算读过一次——打开即关、
// 搜索命中的直达跳页都不算，避免误触灌水「翻开 N 次」。每次会话只记一次。
function markReadOnce () {
  if (readMarked || !currentDoc) return
  readMarked = true
  window.solace.markRead(currentDoc.id).catch(() => { /* 足迹失败不影响阅读 */ })
}

async function flushProgress () {
  if (!pendingProgress) return
  // 落库对象取自 pendingProgress.doc（捕获时的文档），而非调用时刻的 currentDoc：
  // 定时器触发时用户可能已切到别的书，按 currentDoc 写会把进度记错
  const { doc, page, total } = pendingProgress
  pendingProgress = null
  const pct = total >= 1 ? Math.min(100, Math.round(page / total * 100)) : 0
  const finished = pct >= 100 && (lastPctByDoc.get(doc.id) || 0) < 100
  lastPctByDoc.set(doc.id, pct)
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
        ? `<button data-page="${it.page}" title="第 ${it.page} 页">${esc(it.title)}</button>`
        : `<span class="toc-dead">${esc(it.title)}</span>`}
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

// 目录与笔记两个面板互斥：同在预览左侧锚定，不能叠着开
tocBtn.addEventListener('click', () => {
  if (!tocPanel.hidden) { tocPanel.hidden = true; return }
  closeNotes()
  tocPanel.hidden = false
})

notesBtn.addEventListener('click', () => {
  if (isNotesOpen()) { closeNotes(); return }
  tocPanel.hidden = true
  openNotes(currentDoc, () => ({ page: pageNum, total: pdf ? pdf.numPages : 0 }))
})

// 点击正文区域（阅读页获得焦点）自动收起目录/笔记侧栏：开始阅读即让出
// 版面。两个面板是 previewBody 的兄弟节点，面板内部的点击不会冒泡到这里
body.addEventListener('click', () => {
  if (!tocPanel.hidden) tocPanel.hidden = true
  if (isNotesOpen()) closeNotes()
})

tocList.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-page]')
  if (!btn || !pdf) return
  const p = Number(btn.dataset.page)
  if (!(p >= 1 && p <= pdf.numPages)) return
  jumpTo(p)
})

/* ================= 翻页与页码跳转 ================= */

document.getElementById('btnPrevPage').addEventListener('click', () => stepPage(-1))
document.getElementById('btnNextPage').addEventListener('click', () => stepPage(1))

// 统一跳转入口：翻页按钮、底栏页码输入、目录点击都走这里。
// clamp 到合法页码；目标与当前页相同只复位指示器，不重渲染不记足迹
async function jumpTo (p) {
  if (!pdf) return
  p = Math.floor(Number(p))
  if (!(p >= 1)) p = 1
  if (p > pdf.numPages) p = pdf.numPages
  if (p === pageNum) { pageJump.value = pageNum; return }
  pageNum = p
  updatePageIndicator()
  renderPage()
  body.scrollTop = 0
  scheduleProgress()
  markReadOnce()
}

function stepPage (delta) {
  jumpTo(pageNum + delta)
}

// 页码输入框：回车跳转——想给第 20 页记笔记，直接输入 20 回车再「＋ 新建」，
// 模板即记录该页，不用逐页翻
pageJump.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    jumpTo(pageJump.value)
    pageJump.blur()
  } else if (e.key === 'Escape') {
    // 只还原页码并退出输入；拦住冒泡，否则 app.js 的全局 Esc 会把整个预览关掉
    e.stopPropagation()
    pageJump.value = pageNum
    pageJump.blur()
  }
})
pageJump.addEventListener('focus', () => pageJump.select())
pageJump.addEventListener('blur', () => { if (pdf) pageJump.value = pageNum })

document.getElementById('btnRetryRender').addEventListener('click', () => renderPage())

// 预览内键盘翻页（有对话框开着时让位给对话框，比如命令面板里的输入；
// 焦点在输入框时让位给光标移动——页码框里按 ←/→ 应移光标而非翻页）
window.addEventListener('keydown', (e) => {
  if (!isPreviewOpen()) return
  if (document.querySelector('dialog[open]')) return
  const tag = e.target && e.target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA') return
  if (e.key === 'ArrowLeft') stepPage(-1)
  if (e.key === 'ArrowRight') stepPage(1)
})

// 窗口尺寸变化时重渲染当前页
window.addEventListener('resize', () => {
  if (isPreviewOpen() && pdf) renderPage()
})

// 供 app.js 挂到 window 上的关闭函数
window.closePreview = closePreview
