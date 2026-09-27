const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const { spawn } = require('child_process')
const { shell } = require('electron')
const { assertDocumentId, containedPath } = require('./library-paths')

// 笔记数据层：每本书的笔记是 notes/<docId>/ 下的独立 .md 文件（阅读日志模式）。
// 目录扫描是唯一事实来源——用户在文件管理器/Typora 里的增删改名，应用重新
// 打开面板即如实显示，library.json 不登记笔记，与文本索引一样独立于元数据。

let libraryRoot = null
let getSettings = null // () => settings，由 main.js 注入（避免与 library.js 循环依赖）

function init (rootDir, settingsGetter) {
  containedPath(rootDir, 'notes')
  libraryRoot = path.resolve(rootDir)
  getSettings = settingsGetter || (() => ({}))
}

// docId 是入库时生成的 UUID。渲染进程传来的 id 一律先过白名单再拼路径，
// 防止路径穿越；删除文档时 library.js 按同一约定清理 notes/<docId>/
function docDir (docId) {
  return containedPath(libraryRoot, 'notes', assertDocumentId(docId))
}

// file 必须是纯文件名（basename），禁止任何路径成分
function notePath (docId, file) {
  const name = String(file || '')
  if (!name || name !== name.trim() || /[\\/:*?"<>|]/.test(name) || name.startsWith('.')) {
    throw new Error('非法笔记文件名')
  }
  return containedPath(libraryRoot, 'notes', assertDocumentId(docId), name)
}

async function list (docId) {
  const dir = docDir(docId)
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return { notes: [] } // 这本书还没有笔记目录
  }
  const notes = []
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.md')) continue
    let st
    try {
      st = await fsp.stat(path.join(dir, ent.name))
    } catch {
      continue // readdir 与 stat 的间隙里被删的文件：跳过，不让整个列表加载失败
    }
    notes.push({ file: ent.name, mtime: st.mtime.toISOString(), birth: st.birthtime.toISOString(), size: st.size })
  }
  notes.sort((a, b) => new Date(b.mtime) - new Date(a.mtime)) // 最近修改在上
  return { notes }
}

// 一键新建：文件名用「日期 时间（含秒）」——Windows 文件名不能有冒号，
// 时段用点号；展示名即文件名去 .md，用户改名后面板如实跟随。
// 模板写入书名 / 创建时间 / 建笔记时的阅读页码（仅作记录，不做跳转）。
// 同一秒内连建两条会撞名：加「 (2)」序号后缀；检查与写入都用同步 IO，
// 中间没有 await，主进程内天然原子，不会互相覆盖
async function create (docId, payload = {}) {
  const dir = docDir(docId)
  fs.mkdirSync(dir, { recursive: true })
  const now = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const date = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
  const hm = `${p(now.getHours())}:${p(now.getMinutes())}`
  const stamp = `${date} ${p(now.getHours())}.${p(now.getMinutes())}.${p(now.getSeconds())}`
  let file = `${stamp}.md`
  let n = 2
  while (fs.existsSync(path.join(dir, file))) file = `${stamp} (${n++}).md`
  const lines = [
    `# 《${String(payload.title || '未命名')}》笔记`,
    '',
    `- 创建：${date} ${hm}`
  ]
  const page = Math.floor(Number(payload.page))
  const total = Math.floor(Number(payload.total))
  if (page >= 1 && total >= 1) lines.push(`- 位置：第 ${Math.min(page, total)} / ${total} 页`)
  lines.push('', '')
  fs.writeFileSync(path.join(dir, file), lines.join('\n'), 'utf8')
  return { file }
}

// Typora 探测：常见安装位置（Typora 默认装在 Program Files 或用户目录）
function probeTypora () {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Typora', 'Typora.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Typora', 'Typora.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Typora', 'Typora.exe')
  ]
  return candidates.find(p => p && fs.existsSync(p)) || null
}

// 编辑器解析顺序：设置里手动指定的路径 → 探测到的 Typora → null
// （null 交由渲染层询问路径或回退系统默认关联）
function resolveEditor () {
  const custom = getSettings() && getSettings().notesEditorPath
  if (custom && fs.existsSync(custom)) return custom
  return probeTypora()
}

async function open (docId, file, opts = {}) {
  const md = notePath(docId, file)
  if (!fs.existsSync(md)) throw new Error('笔记文件不存在')
  if (opts.forceDefault) {
    const err = await shell.openPath(md)
    if (err) throw new Error(err)
    return { opened: true, editor: 'default' }
  }
  const exe = resolveEditor()
  if (!exe) return { needEditor: true }
  await new Promise((resolve, reject) => {
    const child = spawn(exe, [md], { detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.unref()
    setTimeout(resolve, 250) // 未在启动瞬间报错即认为已拉起
  })
  return { opened: true, editor: exe }
}

async function trash (docId, file) {
  const md = notePath(docId, file)
  if (fs.existsSync(md)) await shell.trashItem(md)
  return true
}

function reveal (docId, file) {
  shell.showItemInFolder(notePath(docId, file))
  return true
}

module.exports = { init, list, create, open, trash, reveal }
