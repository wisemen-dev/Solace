import pdfjsLib, { docParams } from './pdfjs.js'
import { normText } from './util.js'

// 全文索引：启动后（以及每次导入后）把还没有索引的书排进队列，串行提取
// 每页文本（按 util.js 的 normText 归一化，与标题搜索同一规则），经 IPC 存进
// 资料库的 textindex/<id>.json 分片。搜索由主进程按需读取分片完成，渲染层
// 只拿到「命中的书 → 首个命中页码」这张小表——不再持有全部正文，也不再
// 每次 refresh 都把整份索引拉一遍（大库上那是几十 MB 的结构化克隆）。

// 索引版本：v1（无版本号）是未配置 CMap 资源时提取的，中文 PDF 文本严重缺失；
// v2 起补全 cMapUrl/standardFontDataUrl。旧版本索引在启动时自动重建，
// 打不开的书（failed）除外——维持原「不反复重试」行为
const INDEX_VERSION = 2

// 提取页数上限（设置面板可调）：只影响之后新建/重建的索引，
// 已建好的索引不因调整而失效或重建
const DEFAULT_PAGE_LIMIT = 1500
let pageLimit = DEFAULT_PAGE_LIMIT

// docId -> { ver, failed }：主进程返回的索引清单（KB 级），用于判断谁需要重建
let status = {}
const pending = new Map() // docId -> task
const inflight = new Map()
const activePdfs = new Set()
let draining = null
let generation = 0
let initSeq = 0
let librarySession

// 当前关键词的全文命中表。kw 与 hitsKw 不一致时一律按未命中处理，
// 免得把上一个关键词的结果当成本次的结果用（搜索是异步的）
let hits = new Map()
let hitsKw = ''
let searchSeq = 0

export function setIndexPageLimit (n) {
  const v = Math.floor(Number(n))
  if (v >= 1) pageLimit = v
}

export function resetIndex () {
  generation++
  initSeq++
  searchSeq++
  librarySession = undefined
  pageLimit = DEFAULT_PAGE_LIMIT
  status = {}
  pending.clear()
  inflight.clear()
  draining = null
  hits = new Map()
  hitsKw = ''
  for (const task of activePdfs) destroyPdf(task)
  activePdfs.clear()
  emit()
}

export async function initIndex (docs, sessionId = librarySession) {
  const epoch = generation
  const seq = ++initSeq
  librarySession = sessionId
  let nextStatus
  try {
    nextStatus = await window.solace.getTextIndexStatus(sessionId)
  } catch {
    nextStatus = {}
  }
  if (epoch !== generation || seq !== initSeq) return
  status = nextStatus || {}
  for (const doc of docs) {
    const e = status[doc.id]
    const stale = !e || (e.ver !== INDEX_VERSION && !e.failed)
    if (stale && !pending.has(doc.id) && !inflight.has(doc.id)) {
      pending.set(doc.id, { docId: doc.id, sessionId, generation })
    }
  }
  drain()
}

// 新导入的书也排进队列
export function ensureQueued (docId, sessionId = librarySession) {
  if (librarySession !== undefined && sessionId !== librarySession) return
  if (status[docId] || pending.has(docId) || inflight.has(docId)) return
  pending.set(docId, { docId, sessionId, generation })
  drain()
}

// 返回首个命中的页码（1 起），未命中返回 0。kw 须先经 normText 归一化
export function textHit (docId, kw) {
  if (!kw || kw !== hitsKw) return 0
  return hits.get(docId) || 0
}

// 查询全文命中（主进程侧读分片）。调用方 await 之后再渲染，
// 结果过期（期间又发起了新查询）时直接丢弃
export async function searchTextIndex (kw, sessionId = librarySession) {
  const nkw = normText(kw)
  const seq = ++searchSeq
  const epoch = generation
  if (!nkw) {
    hits = new Map()
    hitsKw = ''
    return
  }
  let res
  try {
    res = await window.solace.searchTextIndex(nkw, sessionId)
  } catch {
    if (epoch !== generation || seq !== searchSeq) return
    // 查询失败降级为「只按标题/文件名匹配」，不拿错结果糊弄界面
    hits = new Map()
    hitsKw = ''
    return
  }
  if (epoch !== generation || seq !== searchSeq) return
  hits = new Map(Object.entries(res || {}))
  hitsKw = nkw
}

function emit () {
  window.dispatchEvent(new CustomEvent('solace-index', { detail: { pending: pending.size } }))
}

async function drain () {
  const epoch = generation
  if (draining === epoch) return
  draining = epoch
  emit()
  try {
    while (pending.size && epoch === generation) {
      const task = pending.values().next().value
      pending.delete(task.docId)
      inflight.set(task.docId, task)
      try {
        await extractOne(task)
      } finally {
        if (inflight.get(task.docId) === task) inflight.delete(task.docId)
      }
      if (epoch !== generation) return
      emit()
    }
  } finally {
    if (draining === epoch) {
      draining = null
      emit()
    }
  }
}

async function extractOne (task) {
  const { docId, sessionId } = task
  try {
    const buffer = await window.solace.readPreview(docId, sessionId)
    if (task.generation !== generation) return
    // IPC 送来的就是 Uint8Array，直接用（再包一层 new Uint8Array 会白复制
    // 一整份文件）；万一拿到别的形态才走包装兜底
    const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
    task.loadingTask = pdfjsLib.getDocument({ data, ...docParams })
    activePdfs.add(task)
    task.pdf = await task.loadingTask.promise
    if (task.generation !== generation) return
    const pages = []
    const max = Math.min(task.pdf.numPages, pageLimit)
    for (let n = 1; n <= max; n++) {
      const page = await task.pdf.getPage(n)
      if (task.generation !== generation) return
      try {
        const tc = await page.getTextContent()
        if (task.generation !== generation) return
        pages.push(normText(tc.items.map(i => i.str).join(' ')))
      } finally {
        page.cleanup()
      }
    }
    await window.solace.setTextIndex(docId, { pages, ver: INDEX_VERSION }, sessionId)
    if (task.generation !== generation) return
    status[docId] = { ver: INDEX_VERSION, failed: false }
  } catch {
    if (task.generation !== generation) return
    // 打不开/加密的 PDF 标记失败，避免每次启动反复重试
    status[docId] = { failed: true }
    try {
      await window.solace.setTextIndex(docId, { failed: true }, sessionId)
    } catch { /* 落库失败下轮启动会再试一次 */ }
    if (task.generation !== generation) return
  } finally {
    destroyPdf(task)
    activePdfs.delete(task)
  }
  if (task.generation !== generation) return
  // 单本完成即广播，让搜索结果与索引提示即时更新
  window.dispatchEvent(new CustomEvent('solace-index-doc', { detail: { docId } }))
}

function destroyPdf (task) {
  const resource = task.pdf || task.loadingTask
  if (!resource || task.destroyed === resource) return
  task.destroyed = resource
  try {
    Promise.resolve(resource.destroy?.()).catch(() => {})
  } catch {
    // Disposal must never delay a new library's queue.
  }
}
