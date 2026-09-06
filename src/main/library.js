const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const crypto = require('crypto')

// 资料库数据层：全部元数据存于 library.json，PDF 副本存于 files/<id>.pdf。
// 写入统一走 save() 的「临时文件 + 原子重命名」，避免中断损坏数据。

let rootDir = null
let dataFile = null
let textIndexFile = null
let data = null
let textIndex = null

function init (userDataDir) {
  rootDir = path.join(userDataDir, 'SolaceLibrary')
  dataFile = path.join(rootDir, 'library.json')
  textIndexFile = path.join(rootDir, 'textindex.json')
  fs.mkdirSync(path.join(rootDir, 'files'), { recursive: true })
  fs.mkdirSync(path.join(rootDir, 'covers'), { recursive: true })
  if (fs.existsSync(dataFile)) {
    data = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
  } else {
    data = {
      version: 1,
      createdAt: new Date().toISOString(),
      categories: [], // { id, name, parentId: null }，parentId 构成分类树
      tags: [],       // { id, name }
      documents: [],  // 见 importPdf()
      history: [],    // 打开事件 { docId, at }，足迹面板用
      smartShelves: [] // 智能收藏夹 { id, name, filters: { categoryId?, tagId?, keyword? } }
    }
    save()
  }
  // 0.2.0 及之前建的库没有 history 字段，补齐
  if (!Array.isArray(data.history)) data.history = []
  // 0.5.0 及之前建的库没有智能收藏夹，补齐
  if (!Array.isArray(data.smartShelves)) data.smartShelves = []
  // 全文索引存独立文件，避免撑大 library.json；顺带清掉指向已删除文档的残留
  if (fs.existsSync(textIndexFile)) {
    textIndex = JSON.parse(fs.readFileSync(textIndexFile, 'utf8'))
    const ids = new Set(data.documents.map(d => d.id))
    for (const id of Object.keys(textIndex)) {
      if (!ids.has(id)) delete textIndex[id]
    }
    saveTextIndex()
  }
}

function getData () {
  return data
}

function save () {
  const tmp = dataFile + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(tmp, dataFile)
}

function findDoc (id) {
  const doc = data.documents.find(d => d.id === id)
  if (!doc) throw new Error(`文档不存在: ${id}`)
  return doc
}

async function importPdf (filePath) {
  const stat = await fsp.stat(filePath)
  if (!stat.isFile()) throw new Error('不是常规文件')
  if (path.extname(filePath).toLowerCase() !== '.pdf') throw new Error('仅支持 PDF 文件')
  const id = crypto.randomUUID()
  await fsp.copyFile(filePath, path.join(rootDir, 'files', `${id}.pdf`))
  const doc = {
    id,
    title: path.basename(filePath, path.extname(filePath)),
    fileName: path.basename(filePath),
    originalPath: filePath,
    size: stat.size,
    addedAt: new Date().toISOString(),
    openedAt: null,
    openCount: 0,
    categoryId: null,
    tagIds: []
  }
  data.documents.push(doc)
  save()
  return doc
}

// patch 只允许改这三个字段，其余字段由系统维护
function updateDoc (id, patch) {
  const doc = findDoc(id)
  for (const key of ['title', 'categoryId', 'tagIds']) {
    if (key in patch) doc[key] = patch[key]
  }
  save()
  return doc
}

function removeDoc (id) {
  const doc = findDoc(id)
  fs.rmSync(path.join(rootDir, 'files', `${doc.id}.pdf`), { force: true })
  fs.rmSync(path.join(rootDir, 'covers', `${doc.id}.jpg`), { force: true })
  data.documents = data.documents.filter(d => d.id !== id)
  if (textIndex && textIndex[id]) {
    delete textIndex[id]
    saveTextIndex()
  }
  save()
  return true
}

function getDocPath (id) {
  return path.join(rootDir, 'files', `${findDoc(id).id}.pdf`)
}

function readFileBuffer (id) {
  // 直接返回 Buffer，由 Electron IPC 结构化克隆为渲染进程的 Uint8Array。
  // 不能返回 buffer.buffer（ArrayBuffer），Node 缓冲池会使其大于实际文件长度。
  return fs.readFileSync(getDocPath(id))
}

function markOpened (id) {
  const doc = findDoc(id)
  doc.openedAt = new Date().toISOString()
  doc.openCount += 1
  data.history.push({ docId: id, at: doc.openedAt })
  if (data.history.length > 200) data.history = data.history.slice(-200)
  save()
}

// 阅读进度：由预览翻页时调用，记录「读到第几页 / 共几页」
function setProgress (id, page, totalPages) {
  const doc = findDoc(id)
  page = Math.floor(Number(page))
  totalPages = Math.floor(Number(totalPages))
  if (!(page >= 1) || !(totalPages >= 1)) return doc
  doc.progress = { page: Math.min(page, totalPages), totalPages, at: new Date().toISOString() }
  save()
  return doc
}

// ---- 全文索引 ----
// 渲染进程闲时用 pdf.js 提取每页文本（归一化后的字符串数组）传回，
// 存独立的 textindex.json，与 library.json 一样走「临时文件+原子重命名」。

function getTextIndex () {
  return textIndex || {}
}

function saveTextIndex () {
  const tmp = textIndexFile + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(textIndex, null, 2), 'utf8')
  fs.renameSync(tmp, textIndexFile)
}

function setTextIndex (id, payload) {
  findDoc(id)
  if (!textIndex) textIndex = {}
  textIndex[id] = {
    pages: Array.isArray(payload && payload.pages) ? payload.pages.map(String) : [],
    failed: !!(payload && payload.failed),
    at: new Date().toISOString()
  }
  saveTextIndex()
  return true
}

// ---- 封面 ----
// 封面由渲染进程用 pdf.js 渲染首页生成，以 JPEG dataURL 传回，存为 covers/<id>.jpg

function setCover (id, dataUrl) {
  findDoc(id)
  const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(String(dataUrl || ''))
  if (!m) throw new Error('无效的封面数据')
  fs.writeFileSync(path.join(rootDir, 'covers', `${id}.jpg`), Buffer.from(m[2], 'base64'))
  findDoc(id).hasCover = true
  save()
  return true
}

function getCoverDataUrl (id) {
  findDoc(id)
  const file = path.join(rootDir, 'covers', `${id}.jpg`)
  if (!fs.existsSync(file)) return null
  return `data:image/jpeg;base64,${fs.readFileSync(file).toString('base64')}`
}

function addCategory (name, parentId = null) {
  const trimmed = String(name || '').trim()
  if (!trimmed) throw new Error('分类名不能为空')
  if (parentId != null && !data.categories.some(c => c.id === parentId)) throw new Error('父分类不存在')
  if (data.categories.some(c => c.name === trimmed)) throw new Error(`分类已存在: ${trimmed}`)
  const cat = { id: crypto.randomUUID(), name: trimmed, parentId: parentId || null }
  data.categories.push(cat)
  save()
  return cat
}

// 拖拽换父：parentId 为 null 表示移到顶级。沿父链向上检查，禁止移到自己子孙下面成环
function moveCategory (id, parentId) {
  const cat = data.categories.find(c => c.id === id)
  if (!cat) throw new Error(`分类不存在: ${id}`)
  const target = parentId || null
  if (target === id) throw new Error('不能移动到自身')
  if (target != null) {
    let cursor = data.categories.find(c => c.id === target)
    if (!cursor) throw new Error('目标分类不存在')
    while (cursor) {
      if (cursor.id === id) throw new Error('不能移动到自己的子分类下')
      cursor = data.categories.find(c => c.id === cursor.parentId) || null
    }
  }
  if (cat.parentId === target) return cat
  cat.parentId = target
  save()
  return cat
}

function renameCategory (id, name) {
  const cat = data.categories.find(c => c.id === id)
  if (!cat) throw new Error(`分类不存在: ${id}`)
  const trimmed = String(name || '').trim()
  if (!trimmed) throw new Error('分类名不能为空')
  if (data.categories.some(c => c.id !== id && c.name === trimmed)) throw new Error(`分类已存在: ${trimmed}`)
  cat.name = trimmed
  save()
  return cat
}

function removeCategory (id) {
  const cat = data.categories.find(c => c.id === id)
  if (!cat) throw new Error(`分类不存在: ${id}`)
  // 子分类与直属文档一并上移到被删分类的父级（顶级分类则文档变未分类），组织结构不散架
  const parentId = cat.parentId || null
  data.categories.forEach(c => { if (c.parentId === id) c.parentId = parentId })
  data.documents.forEach(d => { if (d.categoryId === id) d.categoryId = parentId })
  data.categories = data.categories.filter(c => c.id !== id)
  save()
  return true
}

function addTag (name) {
  const trimmed = String(name || '').trim()
  if (!trimmed) throw new Error('标签名不能为空')
  const existed = data.tags.find(t => t.name === trimmed)
  if (existed) return existed
  const tag = { id: crypto.randomUUID(), name: trimmed }
  data.tags.push(tag)
  save()
  return tag
}

function removeTag (id) {
  data.documents.forEach(d => { d.tagIds = d.tagIds.filter(t => t !== id) })
  data.tags = data.tags.filter(t => t.id !== id)
  save()
  return true
}

// ---- 智能收藏夹 ----
// 保存「分类 + 标签 + 关键词」筛选组合为虚拟书架：只存查询条件不复制文档，
// categoryId=null 表示「未分类」，缺省键表示「全部」（undefined 无法过 JSON）。

function addSmartShelf (name, filters) {
  const trimmed = String(name || '').trim()
  if (!trimmed) throw new Error('收藏夹名称不能为空')
  if (data.smartShelves.some(s => s.name === trimmed)) throw new Error(`收藏夹已存在: ${trimmed}`)
  const clean = {}
  if (filters && filters.categoryId !== undefined) clean.categoryId = filters.categoryId
  if (filters && filters.tagId) clean.tagId = filters.tagId
  if (filters && filters.keyword) clean.keyword = filters.keyword
  if (!Object.keys(clean).length) throw new Error('当前没有可保存的筛选条件')
  const shelf = { id: crypto.randomUUID(), name: trimmed, filters: clean }
  data.smartShelves.push(shelf)
  save()
  return shelf
}

function renameSmartShelf (id, name) {
  const shelf = data.smartShelves.find(s => s.id === id)
  if (!shelf) throw new Error(`收藏夹不存在: ${id}`)
  const trimmed = String(name || '').trim()
  if (!trimmed) throw new Error('收藏夹名称不能为空')
  if (data.smartShelves.some(s => s.id !== id && s.name === trimmed)) throw new Error(`收藏夹已存在: ${trimmed}`)
  shelf.name = trimmed
  save()
  return shelf
}

function removeSmartShelf (id) {
  data.smartShelves = data.smartShelves.filter(s => s.id !== id)
  save()
  return true
}

module.exports = {
  init,
  getData,
  importPdf,
  updateDoc,
  removeDoc,
  getDocPath,
  readFileBuffer,
  markOpened,
  setProgress,
  setCover,
  getCoverDataUrl,
  getTextIndex,
  setTextIndex,
  addCategory,
  renameCategory,
  moveCategory,
  removeCategory,
  addTag,
  removeTag,
  addSmartShelf,
  renameSmartShelf,
  removeSmartShelf
}
