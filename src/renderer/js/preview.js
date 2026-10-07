import pdfjsLib, { docParams } from './pdfjs.js'
import { burst } from './confetti.js'
import { openNotes, closeNotes, isNotesOpen } from './notespanel.js'
import { esc } from './util.js'
import { fitPageViewport } from './pdfcanvas.js'

let pdf = null
let pageNum = 0
let loadingTask = null
let renderState = null
let canvasTask = null
let currentDoc = null     // 阅读进度归属的文档
let readMarked = false    // 本次会话是否已记过阅读足迹（只在第一次真实翻页时记）
let pendingProgress = null // 待落库的进度 { doc, page, total }，绑定所属文档防切书串写
let progressTimer = null
let progressWrites = Promise.resolve()
const failedProgress = new Map()
let resumeEnabled = true  // 设置面板「恢复上次阅读位置」开关（app.js 注入）
const lastPctByDoc = new Map() // docId -> 本会话上次记录的进度百分比，判定「读毕」瞬间
// 会话代数：每次开/关预览递增。在途渲染、在途大纲解析都只认自己那一代的结果，
// 否则关闭预览时被 pdf.destroy() 打断的渲染会把失败信息写进错误浮层，
// 下一次打开预览可能先看到上一本的报错
let sessionToken = 0

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
const zoomOutBtn = document.getElementById('btnZoomOut')
const zoomInBtn = document.getElementById('btnZoomIn')
const zoomFitBtn = document.getElementById('btnZoomFit')

/* ================= 缩放与「适应」 =================
   两种自动模式 + 手动百分比（存 localStorage——这是纯本机界面偏好，与
   library.json 的跨设备设置分开，同 solace-opening 的策略）：
     width —— 按可用宽度铺满，纵向滚动（长文档默认，保持既有习惯）
     fit   —— 整页适应：取宽高两个比例里更严格的那个，整页一次可见
              （横屏平板这类「宽而矮」视口的正确解，桌面宽扁窗口同样受益）
     auto  —— 手动缩放态，zoomScale 记绝对比例，切换时按下表回填
   高度自适应是必须的：fix-width 在 1120×708 这类视口下每页要滚 2 屏，
   而全站此前没有任何缩放入口，读一页只能上下拖 */
const ZOOM_KEY = 'solace-zoom'
const ZOOM_MIN = 0.25
const ZOOM_MAX = 6
const ZOOM_STEP = 1.25
const ZOOM_MODES = ['auto', 'width', 'fit', 'height']

// 首次打开（本机无记录）的默认模式按窗口宽度定：
//   窄（桌面默认 1024×768、分屏、窄面板）→ width：按宽铺满，既有习惯
//   中（约 1120：平板横屏、小窗口）      → fit：整页适应
//   宽（≥1280：桌面常规窗口）            → width：按宽铺满，字够大
// 为什么不用「宽高比」判形态：桌面有 240px 侧栏长期占位，窗口几乎总是
// 宽大于高，宽高比对桌面毫无区分力（实测 1267×805 会被误判为横屏平板，
// 页宽缩到 476px 反而难读）。窗口宽度是更干净的判据。
// 用户点过状态钮后即写入记录，此后不再受本判定影响
function defaultZoomMode () {
  const w = window.innerWidth || 0
  return w >= 1000 && w <= 1200 ? 'fit' : 'width'
}

let zoomMode = readZoom().mode
let zoomScale = readZoom().scale
// 最近一次渲染的 scale=1 视口：缩放计算的基准（renderPage 里赋值，
// resetDocument 里清空）。缓存它免得每次步进都重新 getPage
let pageBase = null

function readZoom () {
  try {
    const raw = JSON.parse(localStorage.getItem(ZOOM_KEY) || 'null')
    if (raw && ZOOM_MODES.includes(raw.mode)) {
      const s = Number(raw.scale)
      return { mode: raw.mode, scale: clampZoom(Number.isFinite(s) && s > 0 ? s : 1) }
    }
  } catch { /* 解析失败回默认 */ }
  return { mode: defaultZoomMode(), scale: 1 }
}

function clampZoom (s) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s))
}

function saveZoom () {
  try { localStorage.setItem(ZOOM_KEY, JSON.stringify({ mode: zoomMode, scale: zoomScale })) } catch { /* 存不下不影响本次 */ }
}

function isAutoZoom () {
  return zoomMode !== 'auto'
}

// 每页可用尺寸：扣掉 .preview-body 的 18px 内距与画布与容器间的 18px 余量。
// clientWidth/Height 兜底 0：非浏览器环境（渲染层冒烟测试的 DOM 替身）
// 可能没定义这两个字段，兜底后本函数恒返回 ≥120，不会把 NaN 传进
// fitPageViewport 的有限性校验而抛错
function availBox () {
  return {
    w: Math.max(120, (body.clientWidth || 0) - 36),
    h: Math.max(120, (body.clientHeight || 0) - 36)
  }
}

// 计算本次渲染比例：自动模式给出精确适应比例，手动态直接用 zoomScale
function computeScale (base) {
  if (!isAutoZoom()) return zoomScale
  const a = availBox()
  const byW = a.w / base.width
  const byH = a.h / base.height
  if (zoomMode === 'height') return byH
  if (zoomMode === 'fit') return Math.min(byW, byH)
  return byW
}

// 「适应→手动」的回填：直接用当前实际算出的适应比例（所见即所得，不会跳），
// 再 clamp 保证可用；pageBase 未就位时给一个稳妥的默认
function effectiveManualScale () {
  if (!pageBase) return 4 / 3
  return clampZoom(currentFitScale())
}

// 按钮文案显示 ×100 取整：0.6667（宽 1075 整页适应）显示 67%，
// 与用户对着 100% 的心理刻度一致
function updateZoomUI () {
  let label = '适应'
  if (!isAutoZoom()) label = Math.round(zoomScale * 100) + '%'
  else if (zoomMode === 'height') label = '适应高度'
  zoomFitBtn.textContent = label
  zoomFitBtn.classList.toggle('on', !isAutoZoom())
  zoomOutBtn.disabled = !isAutoZoom() && zoomScale <= ZOOM_MIN + 1e-6
  zoomInBtn.disabled = !isAutoZoom() && zoomScale >= ZOOM_MAX - 1e-6
}

// 改比例：重渲染当前页（渲染完再派发 solace-ink-layout，墨迹/文本层按新
// cssW/cssH 重算，坐标映射不受影响）
function setZoom (mode, scale) {
  zoomMode = mode
  if (scale !== undefined) zoomScale = clampZoom(scale)
  saveZoom()
  if (pdf) renderPage()
}

function zoomStep (dir) {
  // 从自动模式步进：以当前实际适应比例为基准（所见即所得），
  // 但受预置下限约束，避免窄面板下点「放大」反而变小
  const from = isAutoZoom() ? Math.max(currentFitScale(), effectiveManualScale()) : zoomScale
  setZoom('auto', clampZoom(dir > 0 ? from * ZOOM_STEP : from / ZOOM_STEP))
}

// 当前自动模式实际算出的比例（供步进取基准与 UI 判断）。
// pageBase 尚未就位（换书/关预览后还没渲染）时退回预置值
function currentFitScale () {
  if (!pageBase) return effectiveManualScale()
  const a = availBox()
  const byW = a.w / pageBase.width
  const byH = a.h / pageBase.height
  if (zoomMode === 'height') return byH
  if (zoomMode === 'fit') return Math.min(byW, byH)
  return byW
}

function isCurrentSession (token, pdfDoc) {
  return token === sessionToken && !overlay.hidden && !!currentDoc &&
    (pdfDoc === undefined || pdfDoc === pdf)
}

function destroyDocument (target) {
  try { Promise.resolve(target?.destroy()).catch(() => {}) } catch { /* 已销毁 */ }
}

function resetDocument () {
  sessionToken++
  renderState = null
  try { canvasTask?.cancel() } catch { /* 已结束 */ }
  const old = loadingTask || pdf
  loadingTask = null
  pdf = null
  pageBase = null
  destroyDocument(old)
  pageNum = 0
  pageJump.value = ''
  pageTotal.textContent = '0'
  tocBtn.hidden = true
  tocPanel.hidden = true
  tocList.innerHTML = ''
  errBox.hidden = true
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height)
}

// jumpPage：全文搜索命中时跳转的起始页（null 则从第 1 页开始）
export function openPreview (doc, jumpPage = null) {
  if (!doc) return
  // 切书前先把上一本的待写进度立刻落库：进度绑定在 pendingProgress.doc 上，
  // 即使 600ms 防抖窗口内经命令面板换书，也只会写到原来的书上
  flushProgress().catch(reportProgressError)
  resetDocument()
  currentDoc = doc
  readMarked = false
  window.currentPreviewId = doc.id
  document.getElementById('previewTitle').textContent = doc.title
  closeNotes() // 换书/重开时重置笔记面板
  overlay.hidden = false
  loadDoc(doc, jumpPage, sessionToken)
}

export function closePreview () {
  // 关闭前把还没落库的进度立刻写掉，避免丢掉最后翻到的那一页。
  // 返回落库的 Promise：调用方（app.js）须等它完成再刷新列表，
  // 否则 getLibrary 与 setProgress 并发竞争，会读回旧进度。
  const flushed = flushProgress()
  resetDocument()
  closeNotes()
  errBox.hidden = true
  overlay.hidden = true
  window.currentPreviewId = null
  currentDoc = null
  return flushed
}

export function isPreviewOpen () {
  return !overlay.hidden
}

async function loadDoc (doc, jumpPage, token) {
  const { id, sessionId } = doc
  try {
    const buffer = await window.solace.readPreview(id, sessionId)
    if (!isCurrentSession(token)) return
    // IPC 送来的就是 Uint8Array，直接用（再包一层 new Uint8Array 会白复制
    // 一整份文件——大 PDF 上就是几十 MB 的无谓内存与耗时）
    const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
    const task = pdfjsLib.getDocument({ data, ...docParams })
    loadingTask = task
    const pdfDoc = await task.promise
    // 过期结果必须销毁丢弃：否则会把已关闭的预览「复活」——pdf 挂着永不
    // destroy（内存泄漏）、往隐藏的 canvas 渲染
    if (!isCurrentSession(token)) {
      destroyDocument(pdfDoc)
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
    loadOutline(pdfDoc, token)
  } catch (err) {
    // 失败时浮层可能已被用户关闭或已切书：这是过期加载，静默放弃，
    // 既不关闭当前预览也不弹错误打扰
    if (!isCurrentSession(token)) return
    closePreview().catch(reportProgressError)
    const msg = err && err.name === 'PasswordException'
      ? '此 PDF 已加密，内置预览无法打开。请用卡片上的「打开」按钮在外部阅读器中阅读。'
      : `预览加载失败：${err.message || err}`
    // 原生 alert 会阻塞渲染进程且样式脱离主题，改用时长更长的 toast
    window.toast?.(msg, 6000)
  }
}

function updatePageIndicator () {
  pageJump.value = pageNum
  pageTotal.textContent = pdf.numPages
}

// Canvas 有单边像素上限（Chromium 约 32767，超限得到空白画布），大幅面
// PDF（图纸/海报）在高 DPI 屏上按 dpr 放大后很容易越界——表现为「整页
// 空白」，这里按上限回退缩放，宁可整页缩小显示也不空白
async function renderPage () {
  if (!pdf) return
  if (renderState) { renderState.pending = true; return }
  const token = sessionToken
  const pdfDoc = pdf
  const targetPage = pageNum
  const state = { token, pending: false, task: null }
  renderState = state
  errBox.hidden = true
  try {
    const page = await pdfDoc.getPage(targetPage)
    if (!isCurrentSession(token, pdfDoc)) return
    // 取消旧会话的画布任务后等其释放 canvas；旧 getPage 则直接由 token 丢弃。
    if (canvasTask) await canvasTask.promise.catch(() => {})
    if (!isCurrentSession(token, pdfDoc)) return
    // scale=1 视口：既是下面的缩放基准，也随 solace-ink-layout 交给墨迹/
    // 文本层当存储坐标系尺寸（baseW/baseH）
    const base = page.getViewport({ scale: 1 })
    pageBase = base

    // 缩放在「存储坐标系」里算（zoom 相对 scale=1），再乘 dpr 转成设备像素：
    // 这样 zoomScale=1 就是 100%，与设备像素比无关，语义直白
    const zoom = computeScale(base)

    // 按设备像素比渲染，保证文字清晰
    const dpr = window.devicePixelRatio || 1
    const fitted = fitPageViewport(page, Math.max(0.2, zoom) * dpr)
    canvas.width = fitted.width
    canvas.height = fitted.height
    canvas.style.width = (fitted.viewport.width / dpr) + 'px'
    canvas.style.height = (fitted.viewport.height / dpr) + 'px'
    updateZoomUI()

    const task = page.render({ canvasContext: canvas.getContext('2d'), viewport: fitted.viewport })
    state.task = task
    canvasTask = task
    await task.promise
    if (!isCurrentSession(token, pdfDoc)) return
  } catch (err) {
    // 关闭预览时 pdf.destroy() 会打断在途渲染，这里报的「失败」并不是真失败：
    // 只在仍属于当前会话时才写错误浮层
    if (!isCurrentSession(token, pdfDoc)) return
    // 渲染失败不再静默白屏：明确告知页码与原因，并给出出路
    errText.textContent = `第 ${targetPage} 页渲染失败（${String(err.message || err)}）。` +
      '可能是内置预览引擎（pdf.js）对此文件的兼容性限制，可点顶栏「外部打开」阅读本书。'
    errBox.hidden = false
  } finally {
    if (canvasTask === state.task) canvasTask = null
    if (renderState === state) {
      renderState = null
      if (state.pending && isCurrentSession(token, pdfDoc)) renderPage()
    }
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
  pendingProgress = { doc: currentDoc, page: pageNum, total: pdf.numPages, token: sessionToken }
  clearTimeout(progressTimer)
  progressTimer = setTimeout(() => flushProgress().catch(reportProgressError), 600)
}

// 足迹：用户真实翻页（按钮/键盘/目录跳转）才算读过一次——打开即关、
// 搜索命中的直达跳页都不算，避免误触灌水「翻开 N 次」。每次会话只记一次。
function markReadOnce () {
  if (readMarked || !currentDoc) return
  readMarked = true
  window.solace.markRead(currentDoc.id, currentDoc.sessionId).catch(() => { /* 足迹失败不影响阅读 */ })
}

function flushProgress () {
  clearTimeout(progressTimer)
  const entries = new Map(failedProgress)
  failedProgress.clear()
  if (pendingProgress) entries.set(progressKey(pendingProgress), pendingProgress)
  pendingProgress = null
  for (const entry of entries.values()) {
    const write = () => writeProgress(entry)
    progressWrites = progressWrites.then(write, write)
  }
  return progressWrites.then(() => {
    if (failedProgress.size) throw failedProgress.values().next().value.error
  })
}

const progressKey = ({ doc }) => JSON.stringify([doc.sessionId, doc.id])

function reportProgressError (err) {
  window.toast?.(`保存阅读进度失败：${err.message || err}`, 6000)
}

async function writeProgress (entry) {
  const { doc, page, total, token } = entry
  const pct = total >= 1 ? Math.min(100, Math.round(page / total * 100)) : 0
  const finished = pct >= 100 && (lastPctByDoc.get(doc.id) || 0) < 100
  lastPctByDoc.set(doc.id, pct)
  try {
    await window.solace.setProgress(doc.id, page, total, doc.sessionId)
  } catch (error) {
    failedProgress.set(progressKey(entry), { ...entry, error })
    throw error
  }
  failedProgress.delete(progressKey(entry))
  if (!isCurrentSession(token)) return
  if (finished) {
    const r = body.getBoundingClientRect()
    burst(r.left + r.width / 2, r.top + r.height / 3)
    window.toast?.(`🎉 《${doc.title}》读完了`)
  }
}

/* ================= 目录（PDF 书签大纲） ================= */

// 大纲解析是异步的，期间用户可能关闭预览或切换文档：所有调用都绑定 pdfDoc，
// 完成后核对它仍是当前文档才渲染。
async function loadOutline (pdfDoc, token) {
  tocBtn.hidden = true
  tocPanel.hidden = true
  tocList.innerHTML = ''
  let flat
  try {
    const outline = await pdfDoc.getOutline()
    if (!isCurrentSession(token, pdfDoc)) return
    if (!outline || !outline.length) return
    flat = []
    await flattenOutline(pdfDoc, outline, 0, flat, token)
    if (!isCurrentSession(token, pdfDoc)) return
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

async function flattenOutline (pdfDoc, items, depth, out, token) {
  for (const it of items) {
    const page = await destToPage(pdfDoc, it.dest, token)
    if (!isCurrentSession(token, pdfDoc)) return
    out.push({ title: it.title || '（无标题）', depth, page })
    if (Array.isArray(it.items) && it.items.length) {
      await flattenOutline(pdfDoc, it.items, depth + 1, out, token)
      if (!isCurrentSession(token, pdfDoc)) return
    }
  }
}

async function destToPage (pdfDoc, dest, token) {
  try {
    const d = typeof dest === 'string' ? await pdfDoc.getDestination(dest) : dest
    if (!isCurrentSession(token, pdfDoc)) return null
    if (Array.isArray(d) && d[0]) {
      const index = await pdfDoc.getPageIndex(d[0])
      if (!isCurrentSession(token, pdfDoc)) return null
      return index + 1
    }
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
// clamp 到合法页码；任何显式翻页动作都算「读过一次」（单页文档只有这一条
// 翻页途径，早先按「页码是否变化」判定会让它永远记不上足迹）；
// 目标与当前页相同则只复位指示器，不重渲染
async function jumpTo (p) {
  if (!pdf) return
  p = Math.floor(Number(p))
  if (!(p >= 1)) p = 1
  if (p > pdf.numPages) p = pdf.numPages
  markReadOnce()
  if (p === pageNum) { pageJump.value = pageNum; return }
  pageNum = p
  updatePageIndicator()
  renderPage()
  body.scrollTop = 0
  scheduleProgress()
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

/* 缩放控件：−/+ 步进（自动模式先以当前适应比例为基准，避免窄面板下
   「放大」反而变小）；状态钮在「手动 ↔ 适应」之间切换。手动态下 +/− 到
   边界时置灰（updateZoomUI 负责） */
zoomOutBtn.addEventListener('click', () => zoomStep(-1))
zoomInBtn.addEventListener('click', () => zoomStep(1))
zoomFitBtn.addEventListener('click', () => {
  if (isAutoZoom()) {
    // 适应 → 手动：从当前实际比例接手，画面不跳
    setZoom('auto', effectiveManualScale())
  } else {
    // 手动 → 适应：回到长文档默认的按宽铺满
    setZoom('width')
  }
})

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
