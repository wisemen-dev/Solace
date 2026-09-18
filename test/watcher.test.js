// watcher.js 单元测试（纯 Node，不依赖 Electron）：跑法 `npm test`。
// 覆盖启动补扫、落盘后自动入库、内容去重静默跳过、目录不可用时报错、
// 停用后不再监视、自动归入分类。
// 稳定判定是「事件后 1.2s + 间隔 0.9s 尺寸/mtime 一致」，所以实时入库类
// 用例要留足时间，这里统一用轮询而不是固定 sleep。
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const library = require('../src/main/library.js')
const watcher = require('../src/main/watcher.js')

let base = null
let root = null
let watchDir = null
let errors = []
let imported = []

function setup () {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'solace-watch-'))
  watchDir = path.join(base, 'inbox')
  fs.mkdirSync(watchDir, { recursive: true })
  library.init(base, { pointerFile: null })
  root = library.getRootDir()
  errors = []
  imported = []
  watcher.init({
    onImported: (docs) => imported.push(...docs),
    onError: (m) => errors.push(m)
  })
}

function teardown () {
  watcher.configure({}) // 停掉监视，避免句柄泄漏到下一个用例
}

async function waitFor (fn, timeout = 9000, step = 100) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > timeout) return null
    await new Promise(r => setTimeout(r, step))
  }
}

// 内容确定的「PDF」：seed 相同 → 字节相同（用于内容去重）
function writePdf (dir, name, seed = 1) {
  const p = path.join(dir, name)
  fs.writeFileSync(p, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2048, seed % 251)]))
  return p
}

test('启动补扫：应用没开着时落盘的文件在 configure 后入库', async () => {
  setup()
  try {
    writePdf(watchDir, 'before-launch.pdf', 1)
    watcher.configure({ watchFolder: watchDir, watchEnabled: true })

    const doc = await waitFor(() => library.getData().documents[0])
    assert.ok(doc, '补扫应当把已存在的 PDF 入库')
    assert.equal(doc.title, 'before-launch')
    assert.ok(fs.existsSync(path.join(root, 'files', `${doc.id}.pdf`)))
    assert.deepEqual(errors, [])
  } finally { teardown() }
})

test('实时入库：监视期间新落盘的 PDF 自动入库并通知界面', async () => {
  setup()
  try {
    watcher.configure({ watchFolder: watchDir, watchEnabled: true })
    writePdf(watchDir, 'dropped.pdf', 2)

    const doc = await waitFor(() => library.getData().documents[0])
    assert.ok(doc, '新文件应当在写入稳定后入库')
    assert.equal(doc.title, 'dropped')
    const notified = await waitFor(() => imported.find(d => d.id === doc.id))
    assert.ok(notified, '入库后应当推送一次聚合通知')
  } finally { teardown() }
})

test('内容去重：已在库中的文件被静默跳过，不报错也不重复入库', async () => {
  setup()
  try {
    // 先在监视目录外导入一份，再把同样内容放进监视目录
    const outside = path.join(base, 'outside')
    fs.mkdirSync(outside, { recursive: true })
    const src = writePdf(outside, 'same.pdf', 3)
    const first = await library.importPdf(src)
    writePdf(watchDir, 'same-copy.pdf', 3)

    watcher.configure({ watchFolder: watchDir, watchEnabled: true })

    // 补扫会尝试导入它；给它足够时间确认「什么都没发生」
    await new Promise(r => setTimeout(r, 1500))
    assert.equal(library.getData().documents.length, 1, '内容相同的文件不该产生第二条目')
    assert.equal(library.getData().documents[0].id, first.id)
    assert.deepEqual(errors, [], '重复入库是预期行为，不该报错')
  } finally { teardown() }
})

test('监视目录不可用时通过 onError 明确报出来', async () => {
  setup()
  try {
    watcher.configure({ watchFolder: path.join(base, 'not-exist'), watchEnabled: true })
    assert.equal(errors.length, 1)
    assert.match(errors[0], /监视文件夹不可用/)
    // 配置成文件而不是目录，同样要报错
    errors = []
    const f = writePdf(base, 'a-file.pdf', 4)
    watcher.configure({ watchFolder: f, watchEnabled: true })
    assert.equal(errors.length, 1)
    assert.match(errors[0], /监视文件夹不可用/)
  } finally { teardown() }
})

test('watchEnabled=false 或没配文件夹时不监视', async () => {
  setup()
  try {
    watcher.configure({ watchFolder: watchDir, watchEnabled: false })
    writePdf(watchDir, 'ignored.pdf', 5)
    await new Promise(r => setTimeout(r, 1200))
    assert.equal(library.getData().documents.length, 0, '停用时不该入库')

    errors = []
    watcher.configure({}) // 清空配置
    writePdf(watchDir, 'ignored2.pdf', 6)
    await new Promise(r => setTimeout(r, 1200))
    assert.equal(library.getData().documents.length, 0)
  } finally { teardown() }
})

test('自动入库归入指定分类', async () => {
  setup()
  try {
    const cat = library.addCategory('下载')
    writePdf(watchDir, 'categorized.pdf', 7)
    watcher.configure({ watchFolder: watchDir, watchEnabled: true, watchCategory: cat.id })

    const doc = await waitFor(() => library.getData().documents[0])
    assert.ok(doc, '应当入库')
    assert.equal(library.getData().documents[0].categoryId, cat.id)
  } finally { teardown() }
})

test('重复 configure 同一目录不会重复导入或重启监视', async () => {
  setup()
  try {
    watcher.configure({ watchFolder: watchDir, watchEnabled: true })
    writePdf(watchDir, 'once.pdf', 8)
    const doc = await waitFor(() => library.getData().documents[0])
    assert.ok(doc)

    // 设置面板每改一项都会 configure 一次：同目录必须提前返回，不重扫
    watcher.configure({ watchFolder: watchDir, watchEnabled: true, confetti: true })
    await new Promise(r => setTimeout(r, 1200))
    assert.equal(library.getData().documents.length, 1, '重复 configure 不该产生第二条目')
    assert.deepEqual(errors, [])
  } finally { teardown() }
})

test('换目录时上一轮补扫在途：新目录的存量文件仍会被补扫', async () => {
  setup()
  const dirA = path.join(base, 'inbox-a')
  const dirB = path.join(base, 'inbox-b')
  fs.mkdirSync(dirA, { recursive: true })
  fs.mkdirSync(dirB, { recursive: true })
  try {
    // A 放多个文件：补扫逐本入库、中间有 await，保证下一步 configure(B)
    // 同步执行时 A 的扫描必然还在途（旧实现用布尔防重入会在这里把 B 整体跳过）
    for (let i = 0; i < 8; i++) writePdf(dirA, `a-${i}.pdf`, 10 + i)
    writePdf(dirB, 'b-only.pdf', 20)

    watcher.configure({ watchFolder: dirA, watchEnabled: true }) // A 的补扫开始（同步置为在途）
    watcher.configure({ watchFolder: dirB, watchEnabled: true }) // 立刻换到 B

    const doc = await waitFor(() => library.getData().documents.find(d => d.title === 'b-only'))
    assert.ok(doc, '换目录后新目录的存量文件应当被补扫入库')
    assert.deepEqual(errors, [])
  } finally { teardown() }
})
