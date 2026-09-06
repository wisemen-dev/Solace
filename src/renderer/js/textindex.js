import pdfjsLib from './pdfjs.js'

// 全文索引：启动后（以及每次导入后）把还没有索引的书排进队列，串行提取
// 每页文本（小写化 + 剔除全部空白，与 app.js 的 normText 同一规则），经 IPC
// 存进资料库的 textindex.json。搜索时标题/文件名未命中再查这里，返回首个
// 命中页码，供卡片「全文命中」标记与预览跳页使用。

let index = {}            // docId -> { pages: string[], failed: bool }
const pending = new Set() // 待提取的 docId
const inflight = new Set()
let draining = false

// 与 app.js 的 normText 保持一致：小写化 + 剔除全部空白（含全角空格）
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '')

export async function initIndex (docs) {
  try {
    index = await window.solace.getTextIndex()
  } catch {
    index = {}
  }
  for (const doc of docs) {
    if (!index[doc.id] && !pending.has(doc.id) && !inflight.has(doc.id)) pending.add(doc.id)
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
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise
    try {
      const pages = []
      const max = Math.min(pdf.numPages, 1500)
      for (let n = 1; n <= max; n++) {
        const page = await pdf.getPage(n)
        const tc = await page.getTextContent()
        pages.push(norm(tc.items.map(i => i.str).join(' ')))
        page.cleanup()
      }
      await window.solace.setTextIndex(docId, { pages })
      index[docId] = { pages, failed: false }
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
