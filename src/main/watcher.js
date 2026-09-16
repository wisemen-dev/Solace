const fs = require('fs')
const path = require('path')
const library = require('./library')

// 自动入库：监视用户指定的文件夹（通常配成下载器的保存目录），新出现的
// PDF 稳定后经 library.importPdf 复制入库（内容级去重），可选自动归入指定
// 分类。下载器是渐进写入的：事件到达时文件往往只写了一半，这里用
// 「事件防抖 + 两次 stat 尺寸一致」判定稳定再导入。
// 纯 Node 实现（回调注入 onImported/onError），不依赖 Electron，可独立测试。

let dir = null                 // 当前监视的文件夹（resolved 绝对路径）
let watcher = null             // fs.FSWatcher
let settings = {}              // 最近一次 configure 的设置快照
let callbacks = null           // { onImported(docs), onError(message) }，main.js 注入
const stableTimers = new Map() // abs -> 稳定判定定时器（多次事件只保留最后一个）
const failed = new Map()       // abs -> mtimeMs：导入失败的文件。文件被替换
                               // （mtime 变化）后允许重试，原样不动才跳过
let notifyQueue = []
let notifyTimer = null
let scanning = false

function init (cb) {
  callbacks = cb || {}
}

// 设置变化 / 资料库切换时由 main.js 调用：按当前设置启停监视。
// enabled = 配置了文件夹且未被显式关闭（watchEnabled 缺省视为开）
function configure (s) {
  settings = s || {}
  const folder = settings.watchFolder
  if (!folder || settings.watchEnabled === false) {
    stop()
    return
  }
  if (watcher && dir === path.resolve(folder)) return // 已在监视同一目录
  stop()
  try {
    if (!fs.statSync(folder).isDirectory()) throw new Error('不是文件夹')
  } catch (e) {
    reportError(`监视文件夹不可用：${folder}（${e.message}）`)
    return
  }
  dir = path.resolve(folder)
  try {
    watcher = fs.watch(dir, { recursive: true }, onEvent)
    watcher.on('error', (e) => {
      stop()
      reportError(`监视已停止（${(e && e.message) || e}），可到设置中重新指定文件夹`)
    })
  } catch (e) {
    dir = null
    reportError(`无法监视 ${folder}（${(e && e.message) || e}）`)
    return
  }
  startupScan()
}

function stop () {
  if (watcher) {
    try { watcher.close() } catch { /* 已关闭 */ }
    watcher = null
  }
  dir = null
  for (const t of stableTimers.values()) clearTimeout(t)
  stableTimers.clear()
}

function onEvent (_type, filename) {
  if (!dir || !filename) return
  const name = String(filename)
  if (!name.toLowerCase().endsWith('.pdf')) return
  queueImport(path.join(dir, name))
}

// 失败记录仍有效 = 文件自失败以来没变过（mtime 一致）。变了说明用户重新
// 下载/修复了它，应当重试
function isFailed (abs) {
  if (!failed.has(abs)) return false
  try {
    if (fs.statSync(abs).mtimeMs !== failed.get(abs)) {
      failed.delete(abs)
      return false
    }
    return true
  } catch {
    return true // 文件已不存在，保留记录无妨
  }
}

// 稳定判定：事件后等 1.2s（吸收连续写入），两次 stat 间隔 0.9s 尺寸与
// 修改时间都一致才认为写完；仍在变化就重新排队。判定期间文件被删则放弃
// （后续若有同名新文件会再来事件）
function queueImport (abs, wait = 1200) {
  if (isFailed(abs)) return
  clearTimeout(stableTimers.get(abs))
  stableTimers.set(abs, setTimeout(async () => {
    stableTimers.delete(abs)
    try {
      const s1 = fs.statSync(abs)
      if (!s1.isFile()) return
      await new Promise(r => setTimeout(r, 900))
      // 睡眠期间监视可能已被 stop（换目录/停用/切库）：过期判定直接放弃，
      // 否则停用后仍会把旧目录的文件导入
      if (!watcher || !dir || !abs.startsWith(dir + path.sep)) return
      const s2 = fs.statSync(abs)
      if (s2.size !== s1.size || s2.mtimeMs !== s1.mtimeMs) {
        queueImport(abs)
        return
      }
      await importOne(abs)
    } catch { /* 判定期间文件消失，等后续事件 */ }
  }, wait))
}

async function importOne (abs) {
  if (isFailed(abs)) return
  let doc
  try {
    doc = await library.importPdf(abs)
  } catch (err) {
    if (err && err.duplicate) return // 内容已在库中：静默跳过（重启补扫也靠它挡）
    try { failed.set(abs, fs.statSync(abs).mtimeMs) } catch { /* 文件已消失 */ }
    reportError(`${path.basename(abs)} 入库失败（${(err && err.message) || err}），本次运行内不再重试`)
    return
  }
  const catId = settings.watchCategory
  if (catId && library.getData().categories.some(c => c.id === catId)) {
    try { library.updateDoc(doc.id, { categoryId: catId }) } catch { /* 归类失败不影响入库 */ }
  }
  notifyImported(doc)
}

// 聚合批量通知：启动补扫 / 连续落盘时不刷屏
function notifyImported (doc) {
  notifyQueue.push({ id: doc.id, title: doc.title })
  clearTimeout(notifyTimer)
  notifyTimer = setTimeout(() => {
    const docs = notifyQueue
    notifyQueue = []
    if (docs.length && callbacks && callbacks.onImported) callbacks.onImported(docs)
  }, 800)
}

function reportError (message) {
  if (callbacks && callbacks.onError) callbacks.onError(message)
}

// 启动 / 重新启用时补扫：应用没开着的时候落盘的文件在这里入库。
// 已入库的会被 importPdf 的内容去重静默挡下，不产生重复条目
async function startupScan () {
  if (scanning || !dir) return
  scanning = true
  try {
    const files = []
    const walk = (p) => {
      let entries
      try { entries = fs.readdirSync(p, { withFileTypes: true }) } catch { return }
      for (const ent of entries) {
        const full = path.join(p, ent.name)
        if (ent.isDirectory()) walk(full)
        else if (ent.isFile() && ent.name.toLowerCase().endsWith('.pdf')) files.push(full)
      }
    }
    walk(dir)
    for (const f of files) {
      // 扫描中途被 stop（换目录/关监视）即中断；换了目录后旧目录的残余文件也不再导入
      if (!watcher || !dir || !f.startsWith(dir + path.sep)) break
      if (isFailed(f)) continue
      await importOne(f)
    }
  } finally {
    scanning = false
  }
}

module.exports = { init, configure }
