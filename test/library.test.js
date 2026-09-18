// library.js 单元测试（纯 Node，不依赖 Electron）：
// 跑法 `npm test`。这些用例把 2026-09 全量审查里修掉的问题固化成回归：
// 孤儿清理误删、删除笔记的回收站语义、并发导入重复入库、全文索引的存储与
// 迁移、字段归一化、收藏夹引用完整性、设置白名单、足迹窗口统计等。
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const library = require('../src/main/library.js')

let base = null
let root = null

function freshLibrary () {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'solace-lib-'))
  library.init(base, { pointerFile: null })
  root = library.getRootDir()
  return root
}

// 造一个内容确定的「PDF」：seed 相同则字节相同（用于内容去重）
function pdfFile (name, seed = 0, size = 4096) {
  const p = path.join(base, name)
  const body = Buffer.alloc(size, seed % 251)
  fs.writeFileSync(p, Buffer.concat([Buffer.from('%PDF-1.4\n'), body]))
  return p
}

const normText = (s) => String(s || '').toLowerCase().replace(/\s+/g, '')
const dayKey = (d) => {
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/* ---------------- 入库与去重 ---------------- */

test('入库：复制副本到 files/ 并写全字段', async () => {
  freshLibrary()
  const src = pdfFile('a.pdf', 1)
  const doc = await library.importPdf(src)
  assert.ok(fs.existsSync(path.join(root, 'files', `${doc.id}.pdf`)), '副本应落在 files/<id>.pdf')
  assert.equal(doc.title, 'a')
  assert.equal(doc.openCount, 0)
  assert.equal(doc.categoryId, null)
  assert.deepEqual(doc.tagIds, [])
  assert.match(doc.hash, /^[0-9a-f]{64}$/)
  assert.ok(fs.existsSync(src), '原文件不该被动')
})

test('入库：内容相同的文件被拒绝并指出重了哪一本', async () => {
  freshLibrary()
  const a = await library.importPdf(pdfFile('a.pdf', 7))
  const err = await library.importPdf(pdfFile('b.pdf', 7)).then(() => null, e => e)
  assert.ok(err, '同内容文件应当被拒绝')
  assert.equal(err.duplicate.title, a.title)
  assert.equal(library.getData().documents.length, 1)
})

test('入库：并发导入同一文件只落一条（串行化）', async () => {
  freshLibrary()
  const big = pdfFile('big.pdf', 3, 8 * 1024 * 1024)
  const settled = await Promise.allSettled([library.importPdf(big), library.importPdf(big)])
  assert.equal(library.getData().documents.length, 1, '并发导入不该产生重复条目')
  const rejected = settled.filter(r => r.status === 'rejected')
  assert.equal(rejected.length, 1, '其中一个调用应当收到「重复」错误')
  assert.ok(rejected[0].reason.duplicate)
})

test('入库：非 PDF 与非常规文件被拒绝', async () => {
  freshLibrary()
  const txt = path.join(base, 'a.txt')
  fs.writeFileSync(txt, 'x')
  await assert.rejects(() => library.importPdf(txt), /仅支持 PDF/)
  await assert.rejects(() => library.importPdf(base), /不是常规文件/)
})

/* ---------------- 孤儿清理 ---------------- */

test('孤儿清理：只删 UUID 命名的无主文件，用户自放的文件一律不动', async () => {
  freshLibrary()
  const doc = await library.importPdf(pdfFile('a.pdf', 1))
  const orphan = `${crypto.randomUUID()}.pdf`
  const userFiles = ['rust-book.pdf', 'my-notes-2024.pdf', 'Book 2024.pdf']
  fs.writeFileSync(path.join(root, 'files', orphan), 'orphan')
  for (const n of userFiles) fs.writeFileSync(path.join(root, 'files', n), 'user')
  fs.writeFileSync(path.join(root, 'covers', 'cover-backup.jpg'), 'user')

  library.init(base, { pointerFile: null }) // 重启触发清扫

  const files = fs.readdirSync(path.join(root, 'files'))
  assert.ok(!files.includes(orphan), 'UUID 命名的无主文件应当被清掉')
  assert.ok(files.includes(`${doc.id}.pdf`), '在册文档的副本必须保留')
  for (const n of userFiles) assert.ok(files.includes(n), `用户文件 ${n} 不该被删`)
  assert.deepEqual(fs.readdirSync(path.join(root, 'covers')), ['cover-backup.jpg'])
})

test('孤儿清理：原子写入残留的 .tmp 被清掉', async () => {
  freshLibrary()
  const shard = crypto.randomUUID()
  fs.mkdirSync(path.join(root, 'textindex'), { recursive: true })
  fs.writeFileSync(path.join(root, 'library.json.tmp'), '{}')
  fs.writeFileSync(path.join(root, 'textindex', 'index.json.tmp'), '{}')
  fs.writeFileSync(path.join(root, 'textindex', `${shard}.json.tmp`), '{}')
  fs.writeFileSync(path.join(root, 'textindex', 'user-file.json'), '{}')

  library.init(base, { pointerFile: null })

  assert.ok(!fs.existsSync(path.join(root, 'library.json.tmp')))
  assert.ok(!fs.existsSync(path.join(root, 'textindex', 'index.json.tmp')))
  assert.ok(!fs.existsSync(path.join(root, 'textindex', `${shard}.json.tmp`)))
  assert.ok(fs.existsSync(path.join(root, 'textindex', 'user-file.json')), '非本应用命名的文件不动')
})

/* ---------------- 删除 ---------------- */

test('删除文档：默认把笔记移入回收站，而不是永久删除', async () => {
  freshLibrary()
  const doc = await library.importPdf(pdfFile('a.pdf', 1))
  const notesDir = path.join(root, 'notes', doc.id)
  fs.mkdirSync(notesDir, { recursive: true })
  fs.writeFileSync(path.join(notesDir, 'n.md'), '# note')

  const trashed = []
  library.setTrashHandler(async (p) => { trashed.push(p); fs.rmSync(p, { recursive: true, force: true }) })
  const res = await library.removeDoc(doc.id, { keepNotes: false })

  assert.deepEqual(trashed, [notesDir], '应当交给注入的回收站处理器')
  assert.equal(res.notesPurged, false, '走了回收站就不该标成永久删除')
  assert.equal(res.leftovers.length, 0)
  assert.equal(library.getData().documents.length, 0)
  assert.ok(!fs.existsSync(path.join(root, 'files', `${doc.id}.pdf`)))
})

test('删除文档：回收站不可用时回退永久删除并如实上报', async () => {
  freshLibrary()
  const doc = await library.importPdf(pdfFile('a.pdf', 1))
  const notesDir = path.join(root, 'notes', doc.id)
  fs.mkdirSync(notesDir, { recursive: true })

  library.setTrashHandler(async () => { throw new Error('回收站不可用') })
  const res = await library.removeDoc(doc.id, { keepNotes: false })

  assert.equal(res.notesPurged, true, '回退永久删除时必须如实标注，界面要提示用户')
  assert.ok(!fs.existsSync(notesDir))
  library.setTrashHandler(null)
})

test('删除文档：keepNotes 时笔记目录改名保留', async () => {
  freshLibrary()
  const doc = await library.importPdf(pdfFile('一本书.pdf', 1))
  fs.mkdirSync(path.join(root, 'notes', doc.id), { recursive: true })
  library.setTrashHandler(async (p) => { fs.rmSync(p, { recursive: true, force: true }) })

  const res = await library.removeDoc(doc.id, { keepNotes: true })

  assert.ok(res.notesKeptTo, '应当回报保留到的目录名')
  assert.match(res.notesKeptTo, /^已删书-/)
  assert.ok(fs.existsSync(path.join(root, 'notes', res.notesKeptTo)))
  library.setTrashHandler(null)
})

/* ---------------- 全文索引 ---------------- */

test('全文索引：一本一分片，落库不重写整份索引', async () => {
  freshLibrary()
  const a = await library.importPdf(pdfFile('a.pdf', 1))
  const b = await library.importPdf(pdfFile('b.pdf', 2))
  library.setTextIndex(a.id, { pages: [normText('hello alpha')], ver: 2 })
  library.setTextIndex(b.id, { pages: [normText('hello beta')], ver: 2 })

  const dir = path.join(root, 'textindex')
  assert.deepEqual(fs.readdirSync(dir).sort(), ['index.json', `${a.id}.json`, `${b.id}.json`].sort())
  assert.ok(!fs.existsSync(path.join(root, 'textindex.json')), '不该再有单文件索引')
})

test('全文索引：搜索命中页码正确，清单里不含正文', async () => {
  freshLibrary()
  const a = await library.importPdf(pdfFile('a.pdf', 1))
  const b = await library.importPdf(pdfFile('b.pdf', 2))
  library.setTextIndex(a.id, { pages: [normText('one'), normText('two quick fox'), normText('three')], ver: 2 })
  library.setTextIndex(b.id, { pages: [normText('nothing here')], ver: 2 })
  library.setTextIndex(a.id, { pages: [normText('one'), normText('two quick fox'), normText('three')], ver: 2 })

  const hits = await library.searchTextIndex('FOX')
  assert.deepEqual(hits, { [a.id]: 2 }, '应返回首个命中页，且大小写不敏感')
  assert.deepEqual(await library.searchTextIndex(''), {}, '空关键词返回空表')

  const status = library.getTextIndexStatus()
  assert.equal(status[a.id].ver, 2)
  assert.equal(status[a.id].failed, false)
  assert.ok(!JSON.stringify(status).includes('fox'), '清单里不该带正文')
})

test('全文索引：failed 条目不参与搜索也不被重建', async () => {
  freshLibrary()
  const a = await library.importPdf(pdfFile('a.pdf', 1))
  library.setTextIndex(a.id, { pages: [normText('secret')], ver: 2 })
  library.setTextIndex(a.id, { failed: true })
  assert.deepEqual(await library.searchTextIndex('secret'), {})
  const status = library.getTextIndexStatus()
  assert.equal(status[a.id].failed, true)
  assert.equal(status[a.id].ver, undefined, '失败条目不该带版本号')
})

test('全文索引：删除文档时清掉分片', async () => {
  freshLibrary()
  const a = await library.importPdf(pdfFile('a.pdf', 1))
  library.setTextIndex(a.id, { pages: [normText('gone')], ver: 2 })
  await library.removeDoc(a.id, {})
  assert.ok(!fs.existsSync(path.join(root, 'textindex', `${a.id}.json`)))
  assert.equal(library.getTextIndexStatus()[a.id], undefined)
})

test('全文索引：旧版单文件索引自动迁移为分片', async () => {
  freshLibrary()
  const a = await library.importPdf(pdfFile('a.pdf', 1))
  const b = await library.importPdf(pdfFile('b.pdf', 2))
  fs.writeFileSync(path.join(root, 'textindex.json'), JSON.stringify({
    [a.id]: { pages: [normText('legacy alpha')], failed: false, ver: 2, at: '2026-01-01T00:00:00.000Z' },
    [b.id]: { pages: [normText('legacy beta 中文')], failed: false, at: '2026-01-01T00:00:00.000Z' }
  }))
  library.init(base, { pointerFile: null })

  const status = library.getTextIndexStatus()
  assert.equal(status[a.id].ver, 2)
  assert.equal(status[b.id].ver, undefined, '无版本号的 v1 旧索引要保持原样以便触发重建')
  assert.ok(fs.existsSync(path.join(root, 'textindex.json.migrated')), '旧文件改名留档')
  assert.deepEqual(await library.searchTextIndex('legacy'), { [a.id]: 1, [b.id]: 1 })
})

test('全文索引：旧文件损坏时改名留档并按无索引继续', async () => {
  freshLibrary()
  fs.writeFileSync(path.join(root, 'textindex.json'), '{ not json')
  library.init(base, { pointerFile: null })
  assert.deepEqual(library.getTextIndexStatus(), {}, '坏索引不该挡门')
  assert.ok(fs.existsSync(path.join(root, 'textindex.json.corrupt')))
})

/* ---------------- 读文件 ---------------- */

test('读副本：返回 Promise，副本丢失时给出可读错误', async () => {
  freshLibrary()
  const doc = await library.importPdf(pdfFile('a.pdf', 1))
  const pending = library.readFileBuffer(doc.id)
  assert.ok(pending instanceof Promise, '必须异步读，不能阻塞主进程')
  assert.ok(Buffer.isBuffer(await pending))

  fs.rmSync(path.join(root, 'files', `${doc.id}.pdf`))
  await assert.rejects(() => library.readFileBuffer(doc.id), /副本已丢失/)
})

/* ---------------- 数据归一化 ---------------- */

test('归一化：缺 tagIds/openCount/categoryId 的历史条目被补齐', async () => {
  freshLibrary()
  await library.importPdf(pdfFile('a.pdf', 1))
  const libFile = path.join(root, 'library.json')
  const raw = JSON.parse(fs.readFileSync(libFile, 'utf8'))
  raw.documents.push({ id: 'legacy', title: '旧条目', fileName: 'l.pdf', size: 1, addedAt: new Date().toISOString() })
  fs.writeFileSync(libFile, JSON.stringify(raw, null, 2))

  library.init(base, { pointerFile: null })
  const d = library.getData().documents.find(x => x.id === 'legacy')
  assert.deepEqual(d.tagIds, [])
  assert.equal(d.categoryId, null)
  assert.equal(d.openCount, 0)

  const tag = library.addTag('t')
  assert.doesNotThrow(() => library.removeTag(tag.id), '缺 tagIds 不该让删标签失败')
  library.markOpened('legacy')
  assert.ok(Number.isFinite(library.getData().documents.find(x => x.id === 'legacy').openCount))
})

test('归一化：updateDoc 拒绝非数组 tagIds，undefined 分类收敛为 null', async () => {
  freshLibrary()
  const doc = await library.importPdf(pdfFile('a.pdf', 1))
  library.updateDoc(doc.id, { tagIds: 'oops', categoryId: undefined })
  const d = library.getData().documents[0]
  assert.deepEqual(d.tagIds, [])
  assert.equal(d.categoryId, null)
  assert.equal(library.updateDoc(doc.id, { title: '   ' }).title, 'a', '空标题回退到文件名')
})

/* ---------------- 分类 / 标签 / 收藏夹 ---------------- */

test('分类树：删除分类时子分类与文档上移，收藏夹跟着走', async () => {
  freshLibrary()
  const top = library.addCategory('顶层')
  const mid = library.addCategory('中层', top.id)
  const leaf = library.addCategory('叶层', mid.id)
  const shelf = library.addSmartShelf('叶层书架', { categoryId: leaf.id })

  library.removeCategory(leaf.id)
  assert.equal(library.getData().smartShelves.find(s => s.id === shelf.id).filters.categoryId, mid.id)

  library.removeCategory(mid.id)
  assert.equal(library.getData().categories.find(c => c.id === top.id).parentId, null)
  assert.equal(library.getData().smartShelves.find(s => s.id === shelf.id).filters.categoryId, top.id,
    '连续删除时收藏夹要一路跟着上移，不能留死 id')
})

test('分类树：禁止移到自身子孙下成环；同名分类被拒', () => {
  freshLibrary()
  const a = library.addCategory('A')
  const b = library.addCategory('B', a.id)
  const c = library.addCategory('C', b.id)
  assert.throws(() => library.moveCategory(a.id, c.id), /不能移动到自己的子分类下/)
  assert.throws(() => library.moveCategory(a.id, a.id), /不能移动到自身/)
  assert.throws(() => library.addCategory('A', c.id), /分类已存在/)
})

test('分类树：手改成环的 parentId 不该把 moveCategory 卡死', () => {
  freshLibrary()
  const a = library.addCategory('A')
  const b = library.addCategory('B')
  const outside = library.addCategory('圈外')
  // 模拟人工编辑损坏：B 与圈外互为父子（经应用的操作造不出这种数据，
  // moveCategory 会拦；这里直接改内存数据绕过校验）
  const { categories } = library.getData()
  categories.find(x => x.id === b.id).parentId = outside.id
  categories.find(x => x.id === outside.id).parentId = b.id
  // 把无关的顶级分类 A 移到 B 下：父链上行会撞进环，必须明确报错
  // 而不是沿环无限循环把这条 IPC 卡死
  assert.throws(() => library.moveCategory(a.id, b.id), /成环/)
})

test('删标签：文档上的标签与收藏夹里的死条件一并清掉', async () => {
  freshLibrary()
  const doc = await library.importPdf(pdfFile('a.pdf', 1))
  const tag = library.addTag('要删的')
  library.updateDoc(doc.id, { tagIds: [tag.id] })
  const shelf = library.addSmartShelf('标签书架', { tagId: tag.id })

  library.removeTag(tag.id)
  assert.deepEqual(library.getData().documents[0].tagIds, [])
  assert.ok(!('tagId' in library.getData().smartShelves.find(s => s.id === shelf.id).filters))
})

/* ---------------- 设置 ---------------- */

test('设置：枚举与数值下界卡住非法值', () => {
  freshLibrary()
  const s = library.updateSettings({
    theme: 'nonsense', viewMode: 'carousel', coverSize: 'huge',
    dormantDays: '', indexPageLimit: -5, watchEnabled: 'yes'
  })
  assert.equal(s.theme, 'auto')
  assert.equal(s.viewMode, 'grid')
  assert.equal(s.coverSize, undefined)
  assert.equal(s.dormantDays, undefined)
  assert.equal(s.indexPageLimit, undefined)
  assert.equal(s.watchEnabled, false)

  const ok = library.updateSettings({ theme: 'dusk', viewMode: 'shelf', dormantDays: 60, coverSize: 'large' })
  assert.deepEqual(
    { theme: ok.theme, viewMode: ok.viewMode, dormantDays: ok.dormantDays, coverSize: ok.coverSize },
    { theme: 'dusk', viewMode: 'shelf', dormantDays: 60, coverSize: 'large' }
  )
})

/* ---------------- 足迹 ---------------- */

test('足迹：时间窗口统计按天立账，不受 history 上限影响', async () => {
  freshLibrary()
  const doc = await library.importPdf(pdfFile('a.pdf', 1))
  for (let i = 0; i < 260; i++) library.markOpened(doc.id, 'read')

  const s = library.getOpenStats()
  assert.equal(s.opens7d, 260, 'history 被截到 200 条，窗口统计不能跟着被截')
  assert.equal(s.opens30d, 260)
  assert.equal(library.getData().history.length, 200)
  assert.equal(library.getData().documents[0].openCount, 260)
  assert.equal(library.getData().openDays[dayKey(new Date())], 260)
})

test('足迹：旧库（只有 history）自动回填按天账', async () => {
  freshLibrary()
  const doc = await library.importPdf(pdfFile('a.pdf', 1))
  const libFile = path.join(root, 'library.json')
  const raw = JSON.parse(fs.readFileSync(libFile, 'utf8'))
  delete raw.openDays
  const back = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString() }
  raw.history = [
    { docId: doc.id, at: back(1), type: 'open' },
    { docId: doc.id, at: back(1), type: 'read' },
    { docId: doc.id, at: back(2), type: 'open' },
    { docId: doc.id, at: back(45), type: 'open' }
  ]
  fs.writeFileSync(libFile, JSON.stringify(raw, null, 2))

  library.init(base, { pointerFile: null })
  assert.equal(library.getOpenStats().opens30d, 3)
})

test('阅读进度：非法页数被忽略，页码被 clamp 到总页数内', async () => {
  freshLibrary()
  const doc = await library.importPdf(pdfFile('a.pdf', 1))
  assert.equal(library.setProgress(doc.id, 0, 10).progress, undefined)
  assert.equal(library.setProgress(doc.id, 5, 0).progress, undefined)
  assert.deepEqual(
    { page: library.setProgress(doc.id, 99, 10).progress.page, total: library.getData().documents[0].progress.totalPages },
    { page: 10, total: 10 }
  )
})

/* ---------------- 损坏恢复 ---------------- */

test('损坏恢复：library.json 结构损坏时改名留档、保留 PDF 副本', async () => {
  freshLibrary()
  const doc = await library.importPdf(pdfFile('a.pdf', 1))
  fs.writeFileSync(path.join(root, 'library.json'), JSON.stringify({ hello: 'world' }))
  fs.writeFileSync(path.join(root, 'textindex.json'), JSON.stringify({}))

  library.init(base, { pointerFile: null })

  assert.equal(library.getData().documents.length, 0)
  assert.ok(fs.existsSync(path.join(root, 'library.json.corrupt')), '坏文件要留档')
  assert.ok(fs.existsSync(path.join(root, 'files', `${doc.id}.pdf`)), '库内副本不能被牵连删除')
  assert.ok(library.getStartupNotice())
})

test('损坏恢复：合法 JSON 但缺少核心集合时，绝不当作空库继续跑', async () => {
  freshLibrary()
  const doc = await library.importPdf(pdfFile('a.pdf', 1))
  // 合法 JSON、却没有 documents/categories：早期实现会「归一化」成空库，
  // 紧接着的启动清扫就把 files/ 下的副本当孤儿永久删光
  fs.writeFileSync(path.join(root, 'library.json'), JSON.stringify({ hello: 'world' }))

  library.init(base, { pointerFile: null })

  assert.ok(fs.existsSync(path.join(root, 'files', `${doc.id}.pdf`)), '副本必须保住')
  assert.ok(fs.existsSync(path.join(root, 'library.json.corrupt')))
})

test('损坏恢复：重建后的空库不清扫，用户重启一次也不会丢副本', async () => {
  freshLibrary()
  const doc = await library.importPdf(pdfFile('a.pdf', 1))
  fs.writeFileSync(path.join(root, 'library.json'), '{ 坏文件')
  library.init(base, { pointerFile: null }) // 第一次：损坏恢复
  library.init(base, { pointerFile: null }) // 第二次：正常启动，空库仍不清扫
  library.init(base, { pointerFile: null }) // 第三次

  assert.ok(fs.existsSync(path.join(root, 'files', `${doc.id}.pdf`)),
    '空库不清扫是刻意的：副本是用户唯一凭据时可手动取回')
})

test('孤儿清理：库非空时仍然清理无主的 UUID 副本', async () => {
  freshLibrary()
  await library.importPdf(pdfFile('a.pdf', 1))
  const orphan = `${crypto.randomUUID()}.pdf`
  fs.writeFileSync(path.join(root, 'files', orphan), 'orphan')
  library.init(base, { pointerFile: null })
  assert.ok(!fs.existsSync(path.join(root, 'files', orphan)), '库里有书时残留照常清理')
})
