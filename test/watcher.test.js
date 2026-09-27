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
const { EventEmitter } = require('events')

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
  watcher.stop() // 停掉监视，避免句柄泄漏到下一个用例
}

function deferred () {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function stubWatch (t) {
  const handles = []
  t.mock.method(fs, 'watch', (_dir, _opts, onEvent) => {
    const handle = new EventEmitter()
    handle.closed = false
    handle.close = () => { handle.closed = true }
    handle.change = (file) => onEvent('rename', file)
    handles.push(handle)
    return handle
  })
  return handles
}

const flushAsync = () => new Promise(resolve => setImmediate(resolve))

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

test('重复 configure 同一目录不会重复导入或重启监视', async (t) => {
  setup()
  const watchCalls = []
  const realWatch = fs.watch
  t.mock.method(fs, 'watch', (...args) => {
    watchCalls.push(args[0])
    return realWatch(...args)
  })
  try {
    watcher.configure({ watchFolder: watchDir, watchEnabled: true })
    writePdf(watchDir, 'once.pdf', 8)
    const doc = await waitFor(() => library.getData().documents[0])
    assert.ok(doc)

    // 设置面板每改一项都会 configure 一次：同目录必须提前返回，不重扫
    watcher.configure({ watchFolder: watchDir, watchEnabled: true, confetti: true })
    await new Promise(r => setTimeout(r, 1200))
    assert.equal(library.getData().documents.length, 1, '重复 configure 不该产生第二条目')
    assert.equal(watchCalls.length, 1, '同目录同库只应创建一个监视句柄')
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

test('停用时取消已经排队的启动补扫，不写入资料库', async (t) => {
  setup()
  stubWatch(t)
  const requests = []
  const realImport = library.importPdf
  t.mock.method(library, 'importPdf', (file, opts) => {
    const promise = realImport(file, opts)
    requests.push({ promise, opts })
    return promise
  })
  try {
    writePdf(watchDir, 'cancelled.pdf', 30)
    watcher.configure({ watchFolder: watchDir, watchEnabled: true })
    assert.equal(requests.length, 1)
    assert.equal(requests[0].opts.sessionId, library.getSessionId())

    watcher.stop()
    const [result] = await Promise.allSettled(requests.map(r => r.promise))
    await flushAsync()

    assert.equal(requests[0].opts.signal.aborted, true)
    assert.equal(result.status, 'rejected')
    assert.equal(result.reason.name, 'AbortError')
    assert.deepEqual(library.getData().documents, [])
    assert.deepEqual(fs.readdirSync(path.join(root, 'files')), [])
    assert.deepEqual(imported, [])
    assert.deepEqual(errors, [])
  } finally { teardown() }
})

test('切库后监视同一目录也重新补扫，旧库通知不会混入新库', async (t) => {
  setup()
  const handles = stubWatch(t)
  try {
    writePdf(watchDir, 'shared-inbox.pdf', 31)
    const settings = { watchFolder: watchDir, watchEnabled: true }
    watcher.configure(settings)
    const oldDoc = await waitFor(() => library.getData().documents[0])
    assert.ok(oldDoc)
    const oldSessionId = library.getSessionId()

    library.init(path.join(base, 'other-library'), { pointerFile: null })
    assert.notEqual(library.getSessionId(), oldSessionId)
    watcher.configure(settings)
    const newDoc = await waitFor(() => library.getData().documents[0])
    assert.ok(newDoc, '相同监视目录的存量文件也必须导入新库')
    assert.notEqual(newDoc.id, oldDoc.id)
    assert.equal(handles.length, 2)
    assert.equal(handles[0].closed, true)
    assert.ok(fs.existsSync(path.join(root, 'files', `${oldDoc.id}.pdf`)))
    assert.ok(fs.existsSync(path.join(library.getRootDir(), 'files', `${newDoc.id}.pdf`)))
    assert.ok(await waitFor(() => imported.some(d => d.id === newDoc.id)))
    assert.deepEqual(imported.map(d => d.id), [newDoc.id])
    assert.deepEqual(errors, [])
  } finally { teardown() }
})

test('旧监视器的事件和 error 不会停止或污染新监视器', async (t) => {
  setup()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const handles = stubWatch(t)
  const requests = []
  t.mock.method(library, 'importPdf', async (file) => {
    requests.push(file)
    return { id: 'live-doc', title: 'live' }
  })
  try {
    watcher.configure({ watchFolder: watchDir, watchEnabled: true })
    const nextDir = path.join(base, 'next-inbox')
    fs.mkdirSync(nextDir)
    watcher.configure({ watchFolder: nextDir, watchEnabled: true })
    writePdf(nextDir, 'stale.pdf', 32)
    writePdf(nextDir, 'live.pdf', 33)

    handles[0].change('stale.pdf')
    handles[0].emit('error', new Error('late error from closed watcher'))
    assert.equal(handles[1].closed, false)
    handles[1].change('live.pdf')
    t.mock.timers.tick(1200)
    t.mock.timers.tick(900)
    await flushAsync()
    t.mock.timers.tick(800)

    assert.deepEqual(requests, [path.join(nextDir, 'live.pdf')])
    assert.deepEqual(imported, [{ id: 'live-doc', title: 'live' }])
    assert.deepEqual(errors, [])
  } finally { teardown() }
})

test('稳定判定期间停用再启用同一目录，旧计时任务不能恢复', async (t) => {
  setup()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const handles = stubWatch(t)
  const requests = []
  t.mock.method(library, 'importPdf', async (file) => {
    requests.push(file)
    return { id: 'current-doc', title: 'current' }
  })
  try {
    const settings = { watchFolder: watchDir, watchEnabled: true }
    watcher.configure(settings)
    const file = writePdf(watchDir, 'current.pdf', 34)
    handles[0].change('current.pdf')
    t.mock.timers.tick(1200)

    watcher.stop()
    watcher.configure(settings)
    await flushAsync()
    t.mock.timers.tick(1700)
    await flushAsync()

    assert.deepEqual(requests, [file], '只允许新一轮启动补扫导入一次')
    assert.deepEqual(imported, [{ id: 'current-doc', title: 'current' }])
    assert.deepEqual(errors, [])
  } finally { teardown() }
})

for (const rejectOld of [false, true]) {
  test(`换目录后旧导入${rejectOld ? '失败' : '成功'}，不再归类或通知`, async (t) => {
    setup()
    t.mock.timers.enable({ apis: ['setTimeout'] })
    stubWatch(t)
    const oldImport = deferred()
    const requests = []
    const updates = []
    t.mock.method(library, 'importPdf', (file, opts) => {
      requests.push({ file, opts })
      return oldImport.promise
    })
    t.mock.method(library, 'updateDoc', (...args) => updates.push(args))
    try {
      const cat = library.addCategory('下载')
      writePdf(watchDir, 'old.pdf', 35)
      watcher.configure({ watchFolder: watchDir, watchEnabled: true, watchCategory: cat.id })
      assert.equal(requests.length, 1)

      const nextDir = path.join(base, 'next-inbox')
      fs.mkdirSync(nextDir)
      watcher.configure({ watchFolder: nextDir, watchEnabled: true, watchCategory: cat.id })
      assert.equal(requests[0].opts.signal.aborted, true)
      if (rejectOld) oldImport.reject(new Error('late import failure'))
      else oldImport.resolve({ id: 'old-doc', title: 'old' })
      await flushAsync()
      t.mock.timers.tick(1000)

      assert.deepEqual(updates, [])
      assert.deepEqual(imported, [])
      assert.deepEqual(errors, [])
    } finally { teardown() }
  })
}
