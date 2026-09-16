import pdfjsLib, { docParams } from './pdfjs.js'
import { normText } from './util.js'

// 全文索引：启动后（以及每次导入后）把还没有索引的书排进队列，串行提取
// 每页文本（按 norm.js 的共享规则归一化，与标题搜索同一实现），经 IPC
// 存进资料库的 textindex.json。搜索时标题/文件名未命中再查这里，返回首个
// 命中页码，供卡片「全文命中」标记与预览跳页使用。

let index = {}            // docId -> { pages: string[], failed: bool, ver: number }
const pending = new Set() // 待提取的 docId
const inflight = new Set()
let draining = false

// 索引版本：v1（无版本号）是未配置 CMap 资源时提取的，中文 PDF 文本严重缺失；
// v2 起补全 cMapUrl/standardFontDataUrl。旧版本索引在启动时自动重建，
// 打不开的书（failed）除外——维持原「不反复重试」行为
const INDEX_VERSION = 2

// 提取页数上限（设置面板可调）：只影响之后新建/重建的索引，
// 已建好的索引不因调整而失效或重建
let pageLimit = 1500

export function setIndexPageLimit (n) {
  const v = Math.floor(Number(n))
  if (v >= 1) pageLimit = v
}

export async function initIndex (docs) {
  try {
    index = await window.solace.getTextIndex()
  } catch {
    index = {}
  }
  for (const doc of docs) {
    const e = index[doc.id]
    const stale = !e || (e.ver !== INDEX_VERSION && !e.failed)
    if (stale && !pending.has(doc.id) && !inflight.has(doc.id)) pending.add(doc.id)
  }
  drain()
}

// 新导入的书也排进队列
export function ensureQueued (docId) {
  if (index[docId] || pending.has(docId) || inflight.has(docId)) return
  pending.add(docId)
  drain()
}

// 返回首个命中的页码（1 起），未命中返回 0。kw 须先经 norm 归一化
export function textHit (docId, kw) {
  if (!kw) return 0
  const e = index[docId]
  if (!e || e.failed || !Array.isArray(e.pages)) return 0
  for (let i = 0; i < e.pages.length; i++) {
    if (e.pages[i].includes(kw)) return i + 1
  }
  return 0
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
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer), ...docParams }).promise
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
      index[docId] = { pages, failed: false, ver: INDEX_VERSION }
    } finally {
      pdf.destroy()
    }
  } catch {
    // 打不开/加密的 PDF 标记失败，避免每次启动反复重试
    index[docId] = { pages: [], failed: true }
    try {
      await window.solace.setTextIndex(docId, { failed: true })
    } catch { /* 落库失败下轮启动会再试一次 */ }
  }
  // 单本完成即广播，让搜索结果与索引提示即时更新
  window.dispatchEvent(new CustomEvent('solace-index-doc', { detail: { docId } }))
}
