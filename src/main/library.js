const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const crypto = require('crypto')

// 资料库数据层：全部元数据存于 library.json，PDF 副本存于 files/<id>.pdf。
// 写入统一走 save() 的「临时文件 + 原子重命名」，避免中断损坏数据。
// 资料库位置可由用户更改：真实位置记录在 userData 下的指针文件
// solace-library-pointer.json（位置配置不能存进 library.json——得先知道
// 资料库在哪才能读到它）。启动解析优先级：SOLACE_DATA_DIR > 指针 > 默认。

let rootDir = null
let dataFile = null
let textIndexFile = null
let pointerFile = null
let startupNotice = null // 指针目标不可用回退默认时的一句话说明（main 弹给用户）
let data = null
let textIndex = null

function init (baseDir, opts = {}) {
  pointerFile = opts.pointerFile || null
  startupNotice = null
  const defaultRoot = path.join(baseDir, 'SolaceLibrary')
  if (pointerFile) {
    const pointed = readPointer()
    if (pointed) {
      try {
        loadRoot(pointed)
        return
      } catch (err) {
        // 指针目标不可用（移动硬盘拔了/路径被删）：回退默认位置并告知，
        // 绝不让坏指针把应用挡在门外
        startupNotice = `已配置的资料库位置 ${pointed} 无法使用（${err.message}）。\n已临时回退到默认位置 ${defaultRoot}。`
      }
    }
  }
  try {
    loadRoot(defaultRoot)
  } catch (err) {
    // 默认库本身损坏（library.json 解析失败/结构缺失）：同样不能把应用挡在
    // 门外。坏文件改名保留为 .corrupt 供抢救，原地重建空库；本次跳过孤儿
    // 清扫——库已空，清扫会把 files/ 下的 PDF 副本全删掉，而它们可能是
    // 用户唯一的副本，应留给用户手动恢复或重新导入
    const bad = path.join(defaultRoot, 'library.json')
    try { fs.renameSync(bad, bad + '.corrupt') } catch { /* 改不了名则本次启动仍会失败 */ }
    try { fs.renameSync(path.join(defaultRoot, 'textindex.json'), path.join(defaultRoot, 'textindex.json.corrupt')) } catch { /* 可能本就不存在 */ }
    startupNotice = `资料库数据文件损坏，已新建空资料库：\n${defaultRoot}\n原文件保留为 library.json.corrupt，库内 PDF 副本未删除，可手动取回或重新导入。`
    loadRoot(defaultRoot, { sweep: false })
  }
}

function readPointer () {
  try {
    const obj = JSON.parse(fs.readFileSync(pointerFile, 'utf8'))
    return typeof obj.rootDir === 'string' && obj.rootDir.trim() ? obj.rootDir.trim() : null
  } catch {
    return null
  }
}

function writePointer (p) {
  if (!pointerFile) return
  fs.mkdirSync(path.dirname(pointerFile), { recursive: true })
  const tmp = pointerFile + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify({ rootDir: p }, null, 2), 'utf8')
  fs.renameSync(tmp, pointerFile)
}

// 指向某目录并（重新）加载它：init 启动加载与 relocate 切换共用。
// opts.sweep=false 跳过孤儿清扫（损坏重建时用，保留无主 PDF 副本供恢复）
function loadRoot (root, opts = {}) {
  rootDir = root
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
      smartShelves: [], // 智能收藏夹 { id, name, filters: { categoryId?, tagId?, keyword? } }
      settings: { theme: 'auto', viewMode: 'grid' } // 主题与视图偏好
    }
    save()
  }
  // 0.2.0 及之前建的库没有 history 字段，补齐
  if (!Array.isArray(data.history)) data.history = []
  // 0.5.0 及之前建的库没有智能收藏夹，补齐
  if (!Array.isArray(data.smartShelves)) data.smartShelves = []
  // 0.6.0 及之前建的库没有设置项，补齐默认值
  if (!data.settings) data.settings = { theme: 'auto', viewMode: 'grid' }
  // 全文索引存独立文件，避免撑大 library.json；顺带清掉指向已删除文档的残留。
  // 索引损坏不值得挡门（可由渲染层全量重建）：改名保留现场后按无索引继续
  if (fs.existsSync(textIndexFile)) {
    try {
      textIndex = JSON.parse(fs.readFileSync(textIndexFile, 'utf8'))
    } catch {
      try { fs.renameSync(textIndexFile, textIndexFile + '.corrupt') } catch { /* 改不了名也继续 */ }
      textIndex = null
    }
    if (textIndex) {
      const ids = new Set(data.documents.map(d => d.id))
      for (const id of Object.keys(textIndex)) {
        if (!ids.has(id)) delete textIndex[id]
      }
      saveTextIndex()
    }
  } else {
    textIndex = null
  }
  // 删除书籍时被占用没删掉的文件，启动时的孤儿清理补删
  if (opts.sweep !== false) sweepOrphans()
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

async function sha256OfFile (filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    fs.createReadStream(filePath)
      .on('data', chunk => h.update(chunk))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })
}

// 内容级去重：字节相同的 PDF 不重复入库（重复条目会让分类、足迹、笔记全部分裂）。
// 新条目都带 hash 直接比对；旧库条目没有 hash，只对同大小的文件现算一次并回填
// （大小不同的直接排除），之后就走 hash 快路径。副本已丢失的旧条目无法比对，放行导入。
async function findDuplicate (hash, size) {
  let backfilled = false
  let dup = null
  for (const d of data.documents) {
    if (d.hash) {
      if (d.hash === hash) { dup = d; break }
      continue
    }
    if (d.size !== size) continue
    try {
      d.hash = await sha256OfFile(getDocPath(d.id))
      backfilled = true
      if (d.hash === hash) dup = d
    } catch { /* 副本丢失的旧条目跳过 */ }
    if (dup) break
  }
  if (backfilled) save()
  return dup
}

async function importPdf (filePath) {
  const stat = await fsp.stat(filePath)
  if (!stat.isFile()) throw new Error('不是常规文件')
  if (path.extname(filePath).toLowerCase() !== '.pdf') throw new Error('仅支持 PDF 文件')
  const hash = await sha256OfFile(filePath)
  const dup = await findDuplicate(hash, stat.size)
  if (dup) {
    const err = new Error(`与已入库的《${dup.title}》内容相同`)
    err.duplicate = { title: dup.title, docId: dup.id }
    throw err
  }
  const id = crypto.randomUUID()
  await fsp.copyFile(filePath, path.join(rootDir, 'files', `${id}.pdf`))
  const doc = {
    id,
    title: path.basename(filePath, path.extname(filePath)),
    fileName: path.basename(filePath),
    originalPath: filePath,
    size: stat.size,
    hash,
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

// 删除文档：先做「逻辑删除」（改数据 + 落库，必然成功），库内文件尽力而为。
// 副本可能正被外部阅读器（Adobe/Edge 关闭后仍驻留的后台进程）、同步盘或杀软
// 占用，Windows 上 rmSync 会抛 EBUSY/EPERM——不能让占用否决整个删除，否则
// 书删不掉、再导入还被判重复。删不掉的文件列入 leftovers 回报界面提示，
// 启动时的孤儿清理（sweepOrphans）会补删。
// opts.keepNotes：不删笔记，把 notes/<id>/ 改名为「已删书-书名-时间」保留——
// UUID 目录名对人不可见，改名后既可在文件管理器里找到，也不会被孤儿清理触碰
function removeDoc (id, opts = {}) {
  const doc = findDoc(id)
  data.documents = data.documents.filter(d => d.id !== id)
  if (textIndex && textIndex[id]) {
    delete textIndex[id]
    saveTextIndex()
  }
  save()
  const leftovers = []
  const tryRm = (target, o) => {
    try { fs.rmSync(target, o) } catch { leftovers.push(path.basename(target)) }
  }
  tryRm(path.join(rootDir, 'files', `${doc.id}.pdf`), { force: true })
  tryRm(path.join(rootDir, 'covers', `${doc.id}.jpg`), { force: true })
  let notesKeptTo = null
  const notesDir = path.join(rootDir, 'notes', doc.id)
  if (opts.keepNotes && fs.existsSync(notesDir)) {
    // Windows 目录名不能含 \/:*?"<>| 也不能以点号/空格结尾，逐一清洗
    const safe = String(doc.title || '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .trim().slice(0, 40)
      .replace(/[\s.]+$/, '').trim() || '未命名'
    const p = n => String(n).padStart(2, '0')
    const t = new Date()
    const stamp = `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}`
    let dest = path.join(rootDir, 'notes', `已删书-${safe}-${stamp}`)
    let n = 2
    while (fs.existsSync(dest)) dest = path.join(rootDir, 'notes', `已删书-${safe}-${stamp} (${n++})`)
    try {
      fs.renameSync(notesDir, dest)
      notesKeptTo = path.basename(dest)
    } catch {
      // 改名失败（目录被占用）就原样保留，宁可留在 UUID 目录里也不丢笔记
    }
  } else {
    tryRm(notesDir, { recursive: true, force: true })
  }
  return { title: doc.title, leftovers, notesKeptTo }
}

// 启动时清理 files/、covers/ 下不属于任何文档的残留——删除时被占用没删掉
// 的文件在这里补删。只匹配本应用生成的 id 命名，用户手动放进去的其它文件
// 不动；仍被占用的留到下次启动再试。
// 注意 notes/ 不在清扫范围：保留笔记的目录也在其中，宁可冗余不可误删
function sweepOrphans () {
  const ids = new Set(data.documents.map(d => d.id))
  const tryRm = (p) => { try { fs.rmSync(p, { force: true }) } catch { /* 占用中，下次再试 */ } }
  for (const sub of ['files', 'covers']) {
    let entries
    try { entries = fs.readdirSync(path.join(rootDir, sub)) } catch { continue }
    for (const name of entries) {
      const m = /^([A-Za-z0-9-]+)\.(pdf|jpg)$/i.exec(name)
      if (!m || ids.has(m[1])) continue
      tryRm(path.join(rootDir, sub, name))
    }
  }
}

/* ---- 资料库位置（relocate） ---- */

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

// 用户选的文件夹 → 资料库根目录：通常在其下建 SolaceLibrary 子目录（与默认
// 位置同构，不污染所选文件夹）；若所选文件夹本身就叫 SolaceLibrary 则直接用
function targetRootOf (dir) {
  const picked = path.resolve(String(dir || ''))
  if (!picked || !path.isAbsolute(picked)) throw new Error('无效的文件夹路径')
  return path.basename(picked).toLowerCase() === 'solacelibrary'
    ? picked
    : path.join(picked, 'SolaceLibrary')
}

// 渲染层选完文件夹后先探测目标状态，按状态呈现对应的确认选项
function inspectTarget (dir) {
  const target = targetRootOf(dir)
  const libFile = path.join(target, 'library.json')
  let docCount = null
  try {
    docCount = (JSON.parse(fs.readFileSync(libFile, 'utf8')).documents || []).length
  } catch { /* 无库或坏库都按「没有」处理 */ }
  const rel = path.relative(rootDir, target)
  return {
    targetRoot: target,
    sameAsCurrent: samePath(target, rootDir),
    // 目标落在当前资料库内部：复制会递归套娃，必须拒绝
    insideCurrent: rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel),
    hasLibrary: docCount != null,
    docCount: docCount == null ? 0 : docCount
  }
}

// 切换资料库位置。mode 由渲染层按 inspectTarget 的状态选定：
// - move：整库复制到新位置 → 指针切换 → 删旧目录。事务性保证：任何一步
//   失败指针都不动，当前资料库原样完好
// - 非 move：目标已有资料库则「采用」（当前库原样保留）；否则建空库
function relocate (dir, opts = {}) {
  if (!pointerFile) throw new Error('资料库位置已由 SOLACE_DATA_DIR 环境变量固定，无法更改')
  const target = targetRootOf(dir)
  if (samePath(target, rootDir)) throw new Error('目标位置就是当前资料库位置')
  // 目标与当前资料库互不允许嵌套：目标在库内 → 复制进自身递归爆炸；
  // 库在目标内 → 复制后删旧目录会把新库一并删掉
  const rel = path.relative(rootDir, target)
  if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    throw new Error('目标位置在当前资料库内部，请选择资料库以外的文件夹')
  }
  const relBack = path.relative(target, rootDir)
  if (relBack !== '' && !relBack.startsWith('..') && !path.isAbsolute(relBack)) {
    throw new Error('目标位置包含当前资料库，请选择其它文件夹')
  }

  if (opts.move) {
    if (fs.existsSync(target) && fs.readdirSync(target).length) {
      throw new Error('目标位置已有文件，为避免覆盖请选择空文件夹')
    }
    const oldRoot = rootDir
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.cpSync(oldRoot, target, { recursive: true }) // 失败即抛出，指针不动
    writePointer(target)
    let oldRemoved = true
    try { fs.rmSync(oldRoot, { recursive: true, force: true }) } catch { /* 旧目录文件被占用 */ }
    if (fs.existsSync(oldRoot)) oldRemoved = false
    loadRoot(target)
    return { rootDir: target, mode: 'moved', oldLocation: oldRoot, oldRemoved, docCount: data.documents.length }
  }

  const libFile = path.join(target, 'library.json')
  if (fs.existsSync(libFile)) {
    // 预校验目标库可解析：坏库直接报错，指针不动
    JSON.parse(fs.readFileSync(libFile, 'utf8'))
    writePointer(target)
    loadRoot(target)
    return { rootDir: target, mode: 'adopted', docCount: data.documents.length }
  }
  // 新建空库：先建目录并探写，确认可写后才切指针
  fs.mkdirSync(path.join(target, 'files'), { recursive: true })
  fs.mkdirSync(path.join(target, 'covers'), { recursive: true })
  const probe = path.join(target, '.solace-probe')
  fs.writeFileSync(probe, '')
  fs.rmSync(probe)
  writePointer(target)
  loadRoot(target)
  return { rootDir: target, mode: 'created', docCount: data.documents.length }
}

function getDocPath (id) {
  return path.join(rootDir, 'files', `${findDoc(id).id}.pdf`)
}

function readFileBuffer (id) {
  const p = getDocPath(id)
  // 副本可能已被手动清理：给出可读错误，而不是让调用方拿到 ENOENT 猜原因
  if (!fs.existsSync(p)) throw new Error('库内 PDF 副本已丢失，请删除这本书后重新导入（原文件不受影响）')
  // 直接返回 Buffer，由 Electron IPC 结构化克隆为渲染进程的 Uint8Array。
  // 不能返回 buffer.buffer（ArrayBuffer），Node 缓冲池会使其大于实际文件长度。
  return fs.readFileSync(p)
}

// 阅读足迹：外部打开（type='open'）与预览真实翻页（type='read'）都算「翻开过」，
// 统一刷新 openedAt / openCount——沉睡判定与近 7/30 天统计才不会被纯预览阅读骗过；
// history.type 供足迹时间线区分来源（旧数据无 type，按外部打开处理）
function markOpened (id, type = 'open') {
  const doc = findDoc(id)
  doc.openedAt = new Date().toISOString()
  doc.openCount += 1
  data.history.push({ docId: id, at: doc.openedAt, type })
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
    // 索引版本（textindex.js 的 INDEX_VERSION），低于当前版本的旧索引会被重建
    ver: Number(payload && payload.ver) || undefined,
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

// ---- 设置 ----
// 界面与行为偏好。只放行白名单字段并按类型收敛，避免渲染进程写入任意键；
// 布尔项严格 === true，未设置时 UI 侧按默认值解读（undefined = 开启类默认开）
function updateSettings (patch) {
  if (!data.settings) data.settings = {}
  const strings = ['theme', 'viewMode', 'notesEditorPath', 'pdfReaderPath',
    'externalToolPath', 'watchFolder', 'watchCategory']
  const booleans = ['resumeReading', 'confetti', 'openingAnimation', 'watchEnabled']
  const numbers = ['dormantDays', 'indexPageLimit']
  const enums = { coverSize: ['small', 'medium', 'large'] }
  for (const key of strings) if (key in patch) data.settings[key] = String(patch[key])
  for (const key of booleans) if (key in patch) data.settings[key] = patch[key] === true
  for (const key of numbers) if (key in patch) {
    const n = Math.floor(Number(patch[key]))
    if (Number.isFinite(n)) data.settings[key] = n
  }
  for (const key of Object.keys(enums)) {
    if (key in patch && enums[key].includes(patch[key])) data.settings[key] = patch[key]
  }
  save()
  return data.settings
}

function getRootDir () {
  return rootDir
}

function canRelocate () {
  return !!pointerFile
}

function getStartupNotice () {
  return startupNotice
}

module.exports = {
  init,
  getData,
  getRootDir,
  canRelocate,
  getStartupNotice,
  inspectTarget,
  relocate,
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
  removeSmartShelf,
  updateSettings
}
