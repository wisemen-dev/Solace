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
let pageLimit = 1500

// docId -> { ver, failed }：主进程返回的索引清单（KB 级），用于判断谁需要重建
let status = {}
const pending = new Set() // 待提取的 docId
const inflight = new Set()
let draining = false

// 当前关键词的全文命中表。kw 与 hitsKw 不一致时一律按未命中处理，
// 免得把上一个关键词的结果当成本次的结果用（搜索是异步的）
let hits = new Map()
let hitsKw = ''
let searchSeq = 0

export function setIndexPageLimit (n) {
  const v = Math.floor(Number(n))
  if (v >= 1) pageLimit = v
}

export async function initIndex (docs) {
  try {
    status = (await window.solace.getTextIndexStatus()) || {}
  } catch {
    status = {}
  }
  for (const doc of docs) {
    const e = status[doc.id]
    const stale = !e || (e.ver !== INDEX_VERSION && !e.failed)
    if (stale && !pending.has(doc.id) && !inflight.has(doc.id)) pending.add(doc.id)
  }
  drain()
}

// 新导入的书也排进队列
export function ensureQueued (docId) {
  if (status[docId] || pending.has(docId) || inflight.has(docId)) return
  pending.add(docId)
  drain()
}

// 返回首个命中的页码（1 起），未命中返回 0。kw 须先经 normText 归一化
export function textHit (docId, kw) {
  if (!kw || kw !== hitsKw) return 0
  return hits.get(docId) || 0
}

// 查询全文命中（主进程侧读分片）。调用方 await 之后再渲染，
// 结果过期（期间又发起了新查询）时直接丢弃
export async function searchTextIndex (kw) {
  const nkw = normText(kw)
  const seq = ++searchSeq
  if (!nkw) {
    hits = new Map()
    hitsKw = ''
    return
  }
  let res
  try {
    res = await window.solace.searchTextIndex(nkw)
  } catch {
    if (seq !== searchSeq) return
    // 查询失败降级为「只按标题/文件名匹配」，不拿错结果糊弄界面
    hits = new Map()
    hitsKw = ''
    return
  }
  if (seq !== searchSeq) return
  hits = new Map(Object.entries(res || {}))
  hitsKw = nkw
}

function emit () {
  window.dispatchEvent(new CustomEvent('solace-index', { detail: { pending: pending.size } }))
}

async function drain () {
  if (draining) return
  draining = true
  emit()
  try {
    while (pending.size) {
      const docId = pending.values().next().value
      pending.delete(docId)
      inflight.add(docId)
      try {
        await extractOne(docId)
      } finally {
        inflight.delete(docId)
      }
      emit()
    }
  } finally {
    draining = false
    emit()
  }
}

async function extractOne (docId) {
  try {
    const buffer = await window.solace.readPreview(docId)
    // IPC 送来的就是 Uint8Array，直接用（再包一层 new Uint8Array 会白复制
    // 一整份文件）；万一拿到别的形态才走包装兜底
    const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
    const pdf = await pdfjsLib.getDocument({ data, ...docParams }).promise
    try {
      const pages = []
      const max = Math.min(pdf.numPages, pageLimit)
      for (let n = 1; n <= max; n++) {
        const page = await pdf.getPage(n)
        const tc = await page.getTextContent()
        pages.push(normText(tc.items.map(i => i.str).join(' ')))
        page.cleanup()
      }
      await window.solace.setTextIndex(docId, { pages, ver: INDEX_VERSION })
      status[docId] = { ver: INDEX_VERSION, failed: false }
    } finally {
      pdf.destroy()
    }
  } catch {
    // 打不开/加密的 PDF 标记失败，避免每次启动反复重试
    status[docId] = { failed: true }
    try {
      await window.solace.setTextIndex(docId, { failed: true })
    } catch { /* 落库失败下轮启动会再试一次 */ }
  }
  // 单本完成即广播，让搜索结果与索引提示即时更新
  window.dispatchEvent(new CustomEvent('solace-index-doc', { detail: { docId } }))
}
