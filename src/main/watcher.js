const fs = require('fs')
const path = require('path')
const timers = require('timers/promises')
const library = require('./library')

// 自动入库：监视用户指定的文件夹（通常配成下载器的保存目录），新出现的
// PDF 稳定后经 library.importPdf 复制入库（内容级去重），可选自动归入指定
// 分类。下载器是渐进写入的：事件到达时文件往往只写了一半，这里用
// 「事件防抖 + 两次 stat 尺寸一致」判定稳定再导入。
// 纯 Node 实现（回调注入 onImported/onError），不依赖 Electron，可独立测试。

let callbacks = null // { onImported(docs), onError(message) }，main.js 注入
let active = null
let generation = 0

function isCurrent (run) {
  return active === run && run.generation === generation &&
    !run.controller.signal.aborted && run.sessionId === library.getSessionId()
}

function init (cb) {
  callbacks = cb || {}
}

// 设置变化 / 资料库切换时由 main.js 调用：按当前设置启停监视。
// enabled = 配置了文件夹且未被显式关闭（watchEnabled 缺省视为开）
function configure (s) {
  const settings = s || {}
  const folder = settings.watchFolder
  if (!folder || settings.watchEnabled === false) {
    stop()
    return
  }
  const dir = path.resolve(folder)
  const sessionId = library.getSessionId()
  if (active && active.dir === dir && active.sessionId === sessionId) {
    active.settings = settings
    return // 同目录同资料库只更新设置，切库时必须重新补扫
  }
  stop()
  try {
    if (!fs.statSync(folder).isDirectory()) throw new Error('不是文件夹')
  } catch (e) {
    reportError(`监视文件夹不可用：${folder}（${e.message}）`)
    return
  }
  const run = {
    generation,
    sessionId,
    dir,
    settings,
    watcher: null,
    controller: new AbortController(),
    stableTimers: new Map(),
    failed: new Map(),
    notifyQueue: [],
    notifyTimer: null
  }
  active = run
  try {
    run.watcher = fs.watch(dir, { recursive: true }, (type, filename) => onEvent(run, type, filename))
    run.watcher.on('error', (e) => {
      if (!isCurrent(run)) return
      stop()
      reportError(`监视已停止（${(e && e.message) || e}），可到设置中重新指定文件夹`)
    })
  } catch (e) {
    stop()
    reportError(`无法监视 ${folder}（${(e && e.message) || e}）`)
    return
  }
  startupScan(run)
}

function stop () {
  generation++
  const run = active
  active = null
  if (!run) return
  // 先失效再关闭：旧 error、在途导入和定时器都不能触碰下一轮监视。
  run.controller.abort()
  if (run.watcher) {
    try { run.watcher.close() } catch { /* 已关闭 */ }
  }
  for (const t of run.stableTimers.values()) clearTimeout(t)
  run.stableTimers.clear()
  run.failed.clear()
  clearTimeout(run.notifyTimer)
  run.notifyTimer = null
  run.notifyQueue = []
}

function onEvent (run, _type, filename) {
  if (!isCurrent(run) || !filename) return
  const name = String(filename)
  if (!name.toLowerCase().endsWith('.pdf')) return
  queueImport(run, path.join(run.dir, name))
}

// 失败记录仍有效 = 文件自失败以来没变过（mtime 一致）。变了说明用户重新
// 下载/修复了它，应当重试
function isFailed (run, abs) {
  if (!run.failed.has(abs)) return false
  try {
    if (fs.statSync(abs).mtimeMs !== run.failed.get(abs)) {
      run.failed.delete(abs)
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
function queueImport (run, abs, wait = 1200) {
  if (!isCurrent(run) || isFailed(run, abs)) return
  clearTimeout(run.stableTimers.get(abs))
  run.stableTimers.set(abs, setTimeout(async () => {
    if (!isCurrent(run)) return
    run.stableTimers.delete(abs)
    try {
      const s1 = fs.statSync(abs)
      if (!s1.isFile()) return
      await timers.setTimeout(900, undefined, { signal: run.controller.signal })
      if (!isCurrent(run)) return
      const s2 = fs.statSync(abs)
      if (s2.size !== s1.size || s2.mtimeMs !== s1.mtimeMs) {
        queueImport(run, abs)
        return
      }
      await importOne(run, abs)
    } catch { /* 判定期间文件消失，等后续事件 */ }
  }, wait))
}

async function importOne (run, abs) {
  if (!isCurrent(run) || isFailed(run, abs)) return
  let doc
  try {
    doc = await library.importPdf(abs, { sessionId: run.sessionId, signal: run.controller.signal })
  } catch (err) {
    if (!isCurrent(run) || (err && err.name === 'AbortError')) return
    if (err && err.duplicate) return // 内容已在库中：静默跳过（重启补扫也靠它挡）
    try { run.failed.set(abs, fs.statSync(abs).mtimeMs) } catch { /* 文件已消失 */ }
    reportError(`${path.basename(abs)} 入库失败（${(err && err.message) || err}），本次运行内不再重试`)
    return
  }
  if (!isCurrent(run)) return
  const catId = run.settings.watchCategory
  if (catId && library.getData().categories.some(c => c.id === catId)) {
    try { library.updateDoc(doc.id, { categoryId: catId }) } catch { /* 归类失败不影响入库 */ }
  }
  notifyImported(run, doc)
}

// 聚合批量通知：启动补扫 / 连续落盘时不刷屏
function notifyImported (run, doc) {
  if (!isCurrent(run)) return
  run.notifyQueue.push({ id: doc.id, title: doc.title })
  clearTimeout(run.notifyTimer)
  run.notifyTimer = setTimeout(() => {
    if (!isCurrent(run)) return
    const docs = run.notifyQueue
    run.notifyQueue = []
    run.notifyTimer = null
    if (docs.length && callbacks && callbacks.onImported) callbacks.onImported(docs)
  }, 800)
}

function reportError (message) {
  if (callbacks && callbacks.onError) callbacks.onError(message)
}

// 启动 / 重新启用时补扫：应用没开着的时候落盘的文件在这里入库。
// 已入库的会被 importPdf 的内容去重静默挡下，不产生重复条目。
// 扫描、稳定判定与导入共享同一代数；停用或切库会取消整轮工作。
async function startupScan (run) {
  if (!isCurrent(run)) return
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
    walk(run.dir)
    for (const f of files) {
      // 扫描中途被新一轮 configure 取代（换目录/停用/关监视）即中断；
      // 旧目录的残余文件也不再导入
      if (!isCurrent(run)) return
      if (isFailed(run, f)) continue
      await importOne(run, f)
    }
  } catch {
    // 单个文件的失败已在 importOne 内消化，这里兜住意外错误：
    // 补扫是 fire-and-forget 调用的，不能把异常漏成 unhandledRejection
  }
}

module.exports = { init, configure, stop }
