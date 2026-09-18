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
let textIndexDir = null       // textindex/<id>.json 一本一分片
let textIndexMetaFile = null  // textindex/index.json：id -> { ver, failed, at }
let legacyTextIndexFile = null // 0.15.x 的单文件索引，仅用于一次性搬迁
let pointerFile = null
let startupNotice = null // 指针目标不可用回退默认时的一句话说明（main 弹给用户）
let data = null
let textIndexMeta = { version: 1, entries: {} }
let legacyMigrationDone = false // 搬迁失败过就不再重试，避免每次搜索都读一遍坏文件
// 「移入系统回收站」的实现由 main.js 注入（shell.trashItem）。library.js 不
// require('electron')，保持纯 Node、可独立单测；未注入时回退永久删除
let trashItem = null

function setTrashHandler (fn) {
  trashItem = typeof fn === 'function' ? fn : null
}

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
    // textindex.json / textindex/ 一律原地不动：docId 没变，用户从
    // library.json.corrupt 里抢救回条目后索引还能直接复用，没有理由先毁掉它
    startupNotice = `资料库数据文件损坏，已新建空资料库：\n${defaultRoot}\n原文件保留为 library.json.corrupt，库内 PDF 副本与全文索引未删除，可手动取回或重新导入。`
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
  textIndexDir = path.join(rootDir, 'textindex')
  textIndexMetaFile = path.join(textIndexDir, 'index.json')
  legacyTextIndexFile = path.join(rootDir, 'textindex.json')
  fs.mkdirSync(path.join(rootDir, 'files'), { recursive: true })
  fs.mkdirSync(path.join(rootDir, 'covers'), { recursive: true })
  fs.mkdirSync(textIndexDir, { recursive: true })
  if (fs.existsSync(dataFile)) {
    data = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
    assertLibraryShape()
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
  // 后面几项是逐版本新增的字段，缺了补默认值即可（旧库能平滑升级）
  if (!Array.isArray(data.history)) data.history = []
  if (!Array.isArray(data.smartShelves)) data.smartShelves = []
  if (!data.settings) data.settings = { theme: 'auto', viewMode: 'grid' }
  normalizeDocuments()
  normalizeOpenDays()
  // 索引是一份可重建的缓存：分片里的正文按需读取，启动只加载 KB 级的 meta，
  // 再也不做「整个索引 JSON.parse 一遍」的同步阻塞。
  // opts.sweep=false（损坏重建）时连 meta 也不清：docId 未变，抢救回条目后
  // 索引还能直接用，与 files/ 的保留策略一致
  shardCache.clear()
  shardCacheChars = 0
  legacyMigrationDone = false
  textIndexMeta = readTextIndexMeta()
  if (opts.sweep !== false) pruneTextIndexMeta()
  // 删除书籍时被占用没删掉的文件，启动时的孤儿清理补删
  if (opts.sweep !== false) sweepOrphans()
}

function getData () {
  return data
}

// 临时文件 + 原子重命名：写入中断也不会留下半个坏文件
function atomicWriteFile (file, text) {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

function save () {
  atomicWriteFile(dataFile, JSON.stringify(data, null, 2))
}

// 文件名去扩展名 = 默认书名（入库与「标题留空」回退共用同一取法，
// 免得回退出来的是带 .pdf 的原始文件名）
function stemOf (name) {
  return String(name || '').replace(/\.[^.\\/]+$/, '')
}

// 结构校验：library.json 是人工可编辑的，合法 JSON 不代表是本应用的库。
// 缺核心集合时必须**抛错**走「损坏恢复」路径（改名留档 + 本次跳过孤儿清扫），
// 绝不能顺着当成空库继续跑——库一旦被认成空的，紧接着的启动清扫就会把
// files/ 下的 PDF 副本全判为孤儿永久删掉，那是不可逆的数据丢失。
// （0.15.x 是靠后续代码偶然访问 data.documents 抛错兜住的；索引分片化之后
// 那条路径不再触发，必须显式校验）
function assertLibraryShape (obj = data) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('不是对象')
  for (const key of ['documents', 'categories', 'tags']) {
    if (!Array.isArray(obj[key])) throw new Error(`缺少 ${key} 集合`)
  }
}

// 文档字段归一化：数据层的读写两侧都假定这些字段存在（renderTags 直接
// for...of d.tagIds、removeTag 直接 d.tagIds.filter、markOpened 直接
// doc.openCount += 1），缺一个字段就会抛错——标签删不掉、整块界面渲染中断、
// 「累计翻开」变 NaN。手工编辑过 library.json、或未来某次写入漏了字段时，
// 这里兜底补回，只补不覆盖。前置条件是 assertLibraryShape 已确认 documents 是数组
function normalizeDocuments () {
  for (const d of data.documents) {
    if (!Array.isArray(d.tagIds)) d.tagIds = []
    // categoryId 用 null 表示未分类（undefined 会让「未分类」筛选漏掉它）
    if (d.categoryId === undefined) d.categoryId = null
    if (!Number.isFinite(d.openCount)) d.openCount = 0
    if (typeof d.title !== 'string' || !d.title) d.title = stemOf(d.fileName) || '未命名文档'
  }
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

// 导入串行化：入库流程是「算哈希 → 查重 → 复制副本 → 写数据」，中间有多个
// await，本身不是原子的。同一文件被两条链路同时导入（快速拖入两次、
// 自动入库与手动导入撞车、启动补扫与稳定判定定时器撞车）时会双双通过查重，
// 落成两条内容相同的条目——正是内容去重要防的分裂（分类/足迹/笔记各记一份，
// 且此后该文件永远被判重复）。用一条 promise 链把导入排成队，队列内不并发；
// 单次失败不打断队列，错误仍原样抛给本次调用方
let importChain = Promise.resolve()

function importPdf (filePath) {
  const run = importChain.then(() => importPdfLocked(filePath))
  importChain = run.then(() => {}, () => {})
  return run
}

async function importPdfLocked (filePath) {
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
    title: stemOf(path.basename(filePath)),
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

// patch 只允许改这三个字段，其余字段由系统维护。
// 写入侧也做一次形状收敛：tagIds 不是数组会让 removeTag 的 filter、
// 侧栏的 for...of 直接抛错，categoryId 传 undefined 会让「未分类」筛选漏掉它
function updateDoc (id, patch) {
  const doc = findDoc(id)
  if ('title' in patch) {
    const t = String(patch.title == null ? '' : patch.title).trim()
    doc.title = t || stemOf(doc.fileName) || '未命名文档'
  }
  if ('categoryId' in patch) {
    doc.categoryId = patch.categoryId == null ? null : String(patch.categoryId)
  }
  if ('tagIds' in patch) {
    doc.tagIds = Array.isArray(patch.tagIds) ? patch.tagIds.map(String) : doc.tagIds
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
// 默认删除笔记时走系统回收站（与确认框文案「移入系统回收站」一致，也与笔记
// 面板里的单条删除同语义）；回收站不可用时才回退永久删除，并在返回值里以
// notesPurged 如实标注，由界面提示用户
async function removeDoc (id, opts = {}) {
  const doc = findDoc(id)
  data.documents = data.documents.filter(d => d.id !== id)
  if (textIndexMeta.entries[id]) {
    delete textIndexMeta.entries[id]
    saveTextIndexMeta()
    dropShardCache(id)
  }
  save()
  const leftovers = []
  const tryRm = (target, o) => {
    try { fs.rmSync(target, o) } catch { leftovers.push(path.basename(target)) }
  }
  tryRm(path.join(rootDir, 'files', `${doc.id}.pdf`), { force: true })
  tryRm(path.join(rootDir, 'covers', `${doc.id}.jpg`), { force: true })
  tryRm(shardFile(doc.id), { force: true })
  let notesKeptTo = null
  let notesPurged = false
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
  } else if (fs.existsSync(notesDir)) {
    let trashed = false
    if (trashItem) {
      try { await trashItem(notesDir); trashed = true } catch { /* 回收站不可用，走永久删除 */ }
    }
    if (!trashed && fs.existsSync(notesDir)) {
      try {
        fs.rmSync(notesDir, { recursive: true, force: true })
        notesPurged = true
      } catch {
        leftovers.push(path.basename(notesDir))
      }
    }
  }
  return { title: doc.title, leftovers, notesKeptTo, notesPurged }
}

// 库内文件一律以「crypto.randomUUID() + 固定扩展名」命名（v0.1.0 起未变）。
// 清扫只认这个形状：早期版本用的是「字母数字加连字符」的宽松正则，会把用户
// 自己放进 files/ 的 rust-book.pdf 之类当成孤儿永久删除（从旧备份恢复
// library.json 时尤其致命——备份之后导入的书全会被判成孤儿）。
// 只匹配严格 UUID，其它文件一律不动；仍被占用的留到下次启动再试。
// 注意 notes/ 不在清扫范围：保留笔记的目录也在其中，宁可冗余不可误删
const APP_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(pdf|jpg)$/i
// 同上，分片写入中断留下的 <uuid>.json.tmp
const APP_TMP_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json\.tmp$/i

// 启动时的清理分成两类，风险完全不同：
//  - 写入残留（*.tmp）：原子写入在 writeFileSync 与 renameSync 之间断电才会
//    留下，删掉没有任何数据风险，永远可清
//  - 无主副本（UUID 命名的 pdf/jpg/jpg）：只清不在册的。**库为空时一律不清**
//    ——库为空既可能是「用户真把书删光了」，也可能是「library.json 刚损坏
//    重建」，后者下 files/ 里的 PDF 常常是用户唯一凭据，删了不可逆；而用户
//    往往只是点掉报错框就重启了。等库里重新有书再清残留，代价只是多留一阵
function sweepOrphans () {
  const tryRm = (p) => { try { fs.rmSync(p, { force: true }) } catch { /* 占用中，下次再试 */ } }

  tryRm(dataFile + '.tmp')
  tryRm(textIndexMetaFile + '.tmp')
  let shards = []
  try { shards = fs.readdirSync(textIndexDir) } catch { /* 目录尚未建立 */ }
  for (const name of shards) {
    if (APP_TMP_RE.test(name)) tryRm(path.join(textIndexDir, name))
  }

  if (!data.documents.length) return
  const ids = new Set(data.documents.map(d => d.id))
  for (const sub of ['files', 'covers']) {
    let entries
    try { entries = fs.readdirSync(path.join(rootDir, sub)) } catch { continue }
    for (const name of entries) {
      const m = APP_FILE_RE.exec(name)
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
    // 预校验目标库可解析且结构完整：坏库直接报错，指针不动
    // （否则坏库会让指针先切过去，下次启动才发现并回退默认位置）
    assertLibraryShape(JSON.parse(fs.readFileSync(libFile, 'utf8')))
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

// 异步读：readFileSync 会把主进程连同全部 IPC 一起卡住（预览 / 封面 / 全文
// 索引三条路径都走这里，大 PDF 上就是整个窗口失去响应）
async function readFileBuffer (id) {
  const p = getDocPath(id)
  // 副本可能已被手动清理：给出可读错误，而不是让调用方拿到 ENOENT 猜原因
  try {
    // 直接返回 Buffer，由 Electron IPC 结构化克隆为渲染进程的 Uint8Array。
    // 不能返回 buffer.buffer（ArrayBuffer），Node 缓冲池会使其大于实际文件长度
    return await fsp.readFile(p)
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new Error('库内 PDF 副本已丢失，请删除这本书后重新导入（原文件不受影响）')
    }
    throw err
  }
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
  countOpenDay(doc.openedAt)
  save()
}

// 按天累计的翻开次数：history 有 200 条上限（只服务「最近翻开」时间线与命令
// 面板的最近书目），若拿它去算时间窗口，翻得多的时候会得出「累计翻开 260 次
// 但近 30 天只有 3 次」这种自相矛盾的数字。窗口统计因此单独立账，按自然日
// 累计、只保留最近 400 天
const OPEN_DAYS_KEEP = 400
const dayKey = (d) => {
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function countOpenDay (at) {
  if (!data.openDays || typeof data.openDays !== 'object') data.openDays = {}
  const k = dayKey(new Date(at))
  data.openDays[k] = (data.openDays[k] || 0) + 1
  const keys = Object.keys(data.openDays)
  if (keys.length > OPEN_DAYS_KEEP) {
    keys.sort()
    for (const old of keys.slice(0, keys.length - OPEN_DAYS_KEEP)) delete data.openDays[old]
  }
}

// 近 N 个自然日（含今天）的翻开次数。与 countOpenDay 共用 dayKey，
// 口径不会两边对不上
function getOpenStats () {
  const days = data.openDays || {}
  const d = new Date()
  let opens7d = 0
  let opens30d = 0
  for (let i = 0; i < 30; i++) {
    const n = days[dayKey(d)] || 0
    if (i < 7) opens7d += n
    opens30d += n
    d.setDate(d.getDate() - 1)
  }
  return { opens7d, opens30d }
}

// 0.9.x 及之前建的库只有 history：用它回填一份按天账（受 200 条上限所限，
// 只是一次性的近似起点，此后的计数都是准的）
function normalizeOpenDays () {
  if (data.openDays && typeof data.openDays === 'object') return
  data.openDays = {}
  for (const h of data.history) {
    if (!h || !h.at) continue
    const d = new Date(h.at)
    if (Number.isNaN(d.getTime())) continue
    const k = dayKey(d)
    data.openDays[k] = (data.openDays[k] || 0) + 1
  }
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
// 渲染进程闲时用 pdf.js 提取每页文本（归一化后的字符串数组）传回。存放方式：
//   textindex/index.json      id -> { ver, failed, at }，KB 级，随每本更新
//   textindex/<id>.json       { pages, failed, ver, at }，一本一分片
// 0.15.x 及更早是「全部正文挤在一个 textindex.json，每提取一本整体重写一遍」：
// 实测 120 本 × 500 页时单次落库同步阻塞 221ms、建索引累计写入数 GB、每次
// refresh 还要把几十 MB 索引结构化克隆给渲染进程。分片后单本落库只写自己那份，
// 启动只读 meta，搜索改由主进程按需读取分片并只回传命中页码。
// 索引始终是「可重建的缓存」：任何损坏都按无索引处理，由渲染层重新提取。

// 搜索关键词归一化：必须与渲染层 util.js 的 normText 保持一致（主进程无法
// import ESM 模块，规则在这里复制一份，改一处要同步改另一处）。渲染层传来的
// 已经是归一化后的关键词，这里只是兜底
const normalizeKeyword = (s) => String(s || '').toLowerCase().replace(/\s+/g, '')

// 分片正文缓存：搜索时首次从磁盘读取并解析，之后走内存，避免逐键重扫磁盘。
// 按字符数封顶并淘汰最早的条目，防止超大库把主进程内存撑爆
const shardCache = new Map()
let shardCacheChars = 0
const SHARD_CACHE_MAX_CHARS = 64 * 1024 * 1024

function cacheShard (id, pages) {
  let chars = 0
  for (const p of pages) chars += p.length
  if (chars > SHARD_CACHE_MAX_CHARS) return // 单本即超预算：不入缓存
  const old = shardCache.get(id)
  if (old) {
    shardCache.delete(id)
    shardCacheChars -= old.chars
  }
  shardCache.set(id, { pages, chars })
  shardCacheChars += chars
  for (const [key, val] of shardCache) {
    if (shardCacheChars <= SHARD_CACHE_MAX_CHARS) break
    if (key === id) continue
    shardCache.delete(key)
    shardCacheChars -= val.chars
  }
}

function dropShardCache (id) {
  const old = shardCache.get(id)
  if (!old) return
  shardCache.delete(id)
  shardCacheChars -= old.chars
}

function shardFile (id) {
  return path.join(textIndexDir, `${id}.json`)
}

// 分片正文体积大，用紧凑 JSON（library.json 保持两空格缩进供人工查看）
function writeShard (id, entry) {
  atomicWriteFile(shardFile(id), JSON.stringify({
    pages: Array.isArray(entry.pages) ? entry.pages.map(String) : [],
    failed: !!entry.failed,
    ver: Number(entry.ver) || undefined, // 无版本号（v1 旧索引）时该键不会落盘
    at: entry.at || new Date().toISOString()
  }))
}

function readTextIndexMeta () {
  let raw
  try {
    raw = fs.readFileSync(textIndexMetaFile, 'utf8')
  } catch {
    return { version: 1, entries: {} } // 首次运行：还没有 meta
  }
  try {
    const obj = JSON.parse(raw)
    if (obj && obj.entries && typeof obj.entries === 'object' && !Array.isArray(obj.entries)) {
      return { version: 1, entries: obj.entries }
    }
  } catch { /* 落到下面按损坏处理 */ }
  // meta 损坏不值得挡门：改名留档，索引退回「无」，渲染层会按需重建
  try { fs.renameSync(textIndexMetaFile, textIndexMetaFile + '.corrupt') } catch { /* 改不了名也继续 */ }
  return { version: 1, entries: {} }
}

function saveTextIndexMeta () {
  atomicWriteFile(textIndexMetaFile, JSON.stringify(textIndexMeta))
}

// 清掉指向已删除文档的 meta 残留（崩溃/异常退出留下的）
function pruneTextIndexMeta () {
  const ids = new Set(data.documents.map(d => d.id))
  let changed = false
  for (const id of Object.keys(textIndexMeta.entries)) {
    if (!ids.has(id)) {
      delete textIndexMeta.entries[id]
      dropShardCache(id)
      changed = true
    }
  }
  // 分片文件本身不主动删：孤儿分片是惰性的（只有 meta 指到才会被读），
  // 而误删不可逆——与 notes/ 不进孤儿清扫同一个取舍
  if (changed) saveTextIndexMeta()
}

// 0.15.x 的单文件索引 → 分片，一次性搬迁。成功与否都不再阻塞后续操作
function migrateLegacyTextIndex () {
  if (legacyMigrationDone || !legacyTextIndexFile) return
  legacyMigrationDone = true
  if (!fs.existsSync(legacyTextIndexFile)) return
  try {
    const old = JSON.parse(fs.readFileSync(legacyTextIndexFile, 'utf8'))
    for (const [id, e] of Object.entries(old || {})) {
      if (!e || !Array.isArray(e.pages)) continue
      writeShard(id, e)
      textIndexMeta.entries[id] = { ver: Number(e.ver) || undefined, failed: !!e.failed, at: e.at }
    }
    saveTextIndexMeta()
    fs.renameSync(legacyTextIndexFile, legacyTextIndexFile + '.migrated')
  } catch {
    // 旧文件损坏 / 磁盘满：改名留档，索引按「无」继续，渲染层会重建
    try { fs.renameSync(legacyTextIndexFile, legacyTextIndexFile + '.corrupt') } catch { /* 下次启动再试 */ }
  }
}

// 渲染层开局只需要知道「哪些书已有索引、版本对不对、是不是已知打不开」，
// 这是个 KB 级的清单，不再把全部正文推给渲染进程
function getTextIndexStatus () {
  migrateLegacyTextIndex()
  const out = {}
  for (const [id, e] of Object.entries(textIndexMeta.entries)) {
    out[id] = { ver: e.ver, failed: !!e.failed }
  }
  return out
}

async function readShardPages (id) {
  const cached = shardCache.get(id)
  if (cached) return cached.pages
  let raw
  try {
    raw = await fsp.readFile(shardFile(id), 'utf8')
  } catch {
    return null
  }
  let obj
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (!obj || !Array.isArray(obj.pages)) return null
  cacheShard(id, obj.pages)
  return obj.pages
}

// 全文搜索：只回传 { docId: 首个命中页码 }。逐本 await 读取（不阻塞主进程
// 事件循环），并周期性让出，避免大库搜索时窗口消息被卡住
async function searchTextIndex (kw) {
  const needle = normalizeKeyword(kw)
  if (!needle) return {}
  migrateLegacyTextIndex()
  const live = new Set(data.documents.map(d => d.id))
  const hits = {}
  const ids = Object.keys(textIndexMeta.entries).filter(id => live.has(id) && !textIndexMeta.entries[id].failed)
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]
    const pages = await readShardPages(id)
    if (pages) {
      for (let n = 0; n < pages.length; n++) {
        if (pages[n].includes(needle)) { hits[id] = n + 1; break }
      }
    } else {
      // 分片丢失/损坏：清掉 meta 让渲染层重新提取，索引自愈
      delete textIndexMeta.entries[id]
      saveTextIndexMeta()
    }
    if ((i & 15) === 15) await new Promise(r => setImmediate(r))
  }
  return hits
}

function setTextIndex (id, payload) {
  findDoc(id)
  migrateLegacyTextIndex()
  const entry = {
    pages: Array.isArray(payload && payload.pages) ? payload.pages.map(String) : [],
    failed: !!(payload && payload.failed),
    // 索引版本（textindex.js 的 INDEX_VERSION），低于当前版本的旧索引会被重建
    ver: Number(payload && payload.ver) || undefined,
    at: new Date().toISOString()
  }
  writeShard(id, entry)
  textIndexMeta.entries[id] = { ver: entry.ver, failed: entry.failed, at: entry.at }
  saveTextIndexMeta()
  dropShardCache(id) // 重建后的正文与缓存不同，失效掉
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
    // visited 防御：library.json 是人工可编辑的，父链可能已被写成环
    // （本函数会拦住经应用产生的环，拦不住手改的）。撞环说明数据异常，
    // 明确报错而不是沿环无限循环把这条 IPC 卡死
    const seen = new Set()
    while (cursor) {
      if (cursor.id === id) throw new Error('不能移动到自己的子分类下')
      if (seen.has(cursor.id)) throw new Error('分类层级数据异常（parentId 成环），请先修复 library.json')
      seen.add(cursor.id)
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
  // 智能收藏夹存的分类 id 也要跟着走：否则收藏夹会指向一个不存在的分类——
  // 描述显示「分类：未知」、点开筛出空书架。收藏夹跟着书一起上移，
  // 与 documents 的迁移规则保持同一口径
  for (const s of data.smartShelves || []) {
    if (s.filters && s.filters.categoryId === id) s.filters.categoryId = parentId
  }
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
  data.documents.forEach(d => { if (Array.isArray(d.tagIds)) d.tagIds = d.tagIds.filter(t => t !== id) })
  data.tags = data.tags.filter(t => t.id !== id)
  // 标签没有父级可继承：收藏夹里指向它的条件直接撤掉（收藏夹随之变宽，
  // 但仍可用；留着死条件只会筛出空书架）
  for (const s of data.smartShelves || []) {
    if (s.filters && s.filters.tagId === id) delete s.filters.tagId
  }
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
// 布尔项严格 === true，未设置时 UI 侧按默认值解读（undefined = 开启类默认开）。
// 枚举项与数值下界都要卡住：theme/viewMode 曾归在「字符串」里原样落库，
// 与「非法值拒之门外」的说法不符（渲染层各有兜底才没出事）
function updateSettings (patch) {
  if (!data.settings) data.settings = {}
  const strings = ['notesEditorPath', 'pdfReaderPath', 'externalToolPath', 'watchFolder', 'watchCategory']
  const booleans = ['resumeReading', 'confetti', 'openingAnimation', 'watchEnabled']
  const numbers = { dormantDays: 1, indexPageLimit: 1 }
  const enums = {
    coverSize: ['small', 'medium', 'large'],
    theme: ['auto', 'ink', 'paper', 'dusk'],
    viewMode: ['grid', 'spine', 'shelf']
  }
  for (const key of strings) if (key in patch) data.settings[key] = String(patch[key])
  for (const key of booleans) if (key in patch) data.settings[key] = patch[key] === true
  for (const key of Object.keys(numbers)) {
    if (!(key in patch)) continue
    const n = Math.floor(Number(patch[key]))
    if (Number.isFinite(n) && n >= numbers[key]) data.settings[key] = n
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
  setTrashHandler,
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
  getOpenStats,
  setProgress,
  setCover,
  getCoverDataUrl,
  getTextIndexStatus,
  setTextIndex,
  searchTextIndex,
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
