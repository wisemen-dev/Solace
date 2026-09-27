const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const library = require('./library')
const notes = require('./notes')
const watcher = require('./watcher')

// Windows 上 Chromium 的原生窗口遮挡计算存在已知问题：
// 窗口最小化恢复后可能不重绘（看起来一片空白）。禁用该特性规避。
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
// pdf.js 加载 CMap/标准字体资源走 fetch，而页面是 file:// 协议：
// Chromium 默认禁止 file:// 页面访问其它 file:// 资源，需放开此开关。
// 本应用不加载任何远程内容且 CSP 限定 'self'，放开的攻击面极小
app.commandLine.appendSwitch('allow-file-access-from-files')

let mainWindow = null

// 主进程 → 渲染层推送（自动入库等）；窗口未就绪/已销毁时静默丢弃
function send (channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

function createWindow () {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 620,
    title: 'Solace',
    backgroundColor: '#101418',
    autoHideMenuBar: true,
    show: false, // 首帧就绪后再显示，避免白屏/黑屏闪现
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
    // 监视文件夹在窗口就绪后再启动：启动期报错（目录不存在/不可读）才有
    // 窗口可以 toast 告知，不会静默丢失
    watcher.configure(library.getData().settings || {})
  })
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
}

// 单实例锁：安装版与开发版默认共用同一资料库目录，两份实例同时运行会各自
// 拿着内存里的旧数据互相覆盖 library.json——刚删的书会被另一个实例的下次
// 保存「复活」（界面已消失、重新导入却被判重复）。拒绝第二实例并唤起已有窗口
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    // SOLACE_DATA_DIR 供开发/测试隔离资料库，不污染真实数据；设置时位置被
    // 固定（不走指针也不允许迁移），否则资料库位置可经设置面板更改，
    // 真实位置记录在 userData 下的指针文件里
    const envPinned = !!process.env.SOLACE_DATA_DIR
    try {
      const base = process.env.SOLACE_DATA_DIR || app.getPath('userData')
      const opts = { pointerFile: envPinned ? null : path.join(base, 'solace-library-pointer.json') }
      while (true) {
        try {
          library.init(base, opts)
          break
        } catch (err) {
          if (err.code !== 'LIBRARY_UNAVAILABLE') throw err
          const { response } = await dialog.showMessageBox({
            type: 'warning',
            title: '资料库位置不可用',
            message: err.message,
            detail: `可重新连接原资料库后重试，或改用默认位置：\n${err.defaultRoot}\n选择默认位置后，下次启动也会继续使用它。`,
            buttons: ['重试原资料库', '使用默认资料库', '退出'],
            defaultId: 0,
            cancelId: 2,
            noLink: true
          })
          if (response === 2) { app.quit(); return }
          opts.acceptDefault = response === 1
        }
      }
    } catch (err) {
      // 连默认位置都建不起库（目录只读/磁盘满/路径被占）：明确告诉用户再退出，
      // 不要让 whenReady 静默 reject 成一个「双击了没反应」的进程
      dialog.showErrorBox('无法初始化资料库',
        `${(err && err.message) || err}\n\n请检查该目录的读写权限，或用 SOLACE_DATA_DIR 指定另一个位置。`)
      app.quit()
      return
    }
    // 删除文档时的笔记默认移入系统回收站（与确认框文案一致）；library.js
    // 本身不依赖 electron，能力由这里注入
    library.setTrashHandler((p) => shell.trashItem(p))
    const notice = library.getStartupNotice()
    if (notice) dialog.showErrorBox('资料库位置不可用', notice)
    notes.init(library.getRootDir(), () => library.getData().settings || {})
    watcher.init({
      onImported: (docs) => send('watch:imported', { docs, sessionId: library.getSessionId() }),
      onError: (message) => send('watch:error', { message })
    })
    registerIpc()
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

// 常见 PDF 阅读器探测（与 notes.js 的 Typora 探测同一思路）：SumatraPDF、Foxit
function probePdfReader () {
  const env = process.env
  const candidates = [
    [env.LOCALAPPDATA, 'Programs', 'SumatraPDF', 'SumatraPDF.exe'],
    [env.ProgramFiles, 'SumatraPDF', 'SumatraPDF.exe'],
    [env.ProgramFiles, 'Foxit Software', 'Foxit PDF Reader', 'FoxitPDFReader.exe'],
    [env['ProgramFiles(x86)'], 'Foxit Software', 'Foxit PDF Reader', 'FoxitPDFReader.exe']
  ]
  for (const c of candidates) {
    const p = path.join(...c.filter(Boolean))
    if (c.every(Boolean) && fs.existsSync(p)) return p
  }
  return null
}

// 用指定阅读器打开文件；无可用程序时回退系统默认关联。
// 返回实际使用的程序（'default' = 系统默认）
async function openWithReader (file, customExe) {
  const exe = (customExe && fs.existsSync(customExe)) ? customExe : probePdfReader()
  if (!exe) {
    const err = await shell.openPath(file)
    if (err) throw new Error(err)
    return 'default'
  }
  await new Promise((resolve, reject) => {
    const child = spawn(exe, [file], { detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.unref()
    setTimeout(resolve, 250) // 未在启动瞬间报错即认为已拉起
  })
  return exe
}

function registerIpc () {
  ipcMain.handle('library:get', () => {
    const sessionId = library.getSessionId()
    const data = library.getData()
    return { ...data, sessionId, documents: data.documents.map(d => ({ ...d, sessionId })) }
  })
  // 足迹的时间窗口统计：按天立账在主进程侧算，口径与记账同一处
  ipcMain.handle('library:stats', (_e, sessionId) => scoped(sessionId, () => library.getOpenStats()))
  // 资料库位置：设置面板展示路径 + 打开文件夹（备份用）+ 更改位置（迁移/换库）
  ipcMain.handle('library:info', () => ({ rootDir: library.getRootDir(), canRelocate: library.canRelocate() }))
  ipcMain.handle('library:openRoot', async () => {
    const err = await shell.openPath(library.getRootDir())
    if (err) throw new Error(err)
    return true
  })
  ipcMain.handle('library:inspectTarget', (_e, dir) => library.inspectTarget(dir))
  ipcMain.handle('library:relocate', async (_e, dir, opts) => {
    watcher.stop()
    try {
      const res = await library.relocate(dir, opts || {})
      notes.init(library.getRootDir(), () => library.getData().settings || {})
      return { ...res, sessionId: library.getSessionId() }
    } finally {
      watcher.configure(library.getData().settings || {})
    }
  })
  // 通用文件/文件夹选择器（设置面板选阅读器 exe、选资料库位置用）
  ipcMain.handle('dialog:pickFile', async (_e, opts = {}) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: opts.title || '选择文件',
      properties: ['openFile'],
      filters: [
        { name: '应用程序', extensions: ['exe'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('dialog:pickDirectory', async (_e, opts = {}) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: opts.title || '选择文件夹',
      properties: ['openDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('library:importDialog', async (_e, sessionId = library.getSessionId()) => {
    library.assertSession(sessionId)
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '导入 PDF',
      filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled) return { imported: [], errors: [] }
    return importPaths(result.filePaths, sessionId)
  })

  ipcMain.handle('library:importPaths', (_e, paths, sessionId) => importPaths(paths, sessionId))

  ipcMain.handle('doc:update', (_e, id, patch, sessionId) => scoped(sessionId, () => library.updateDoc(id, patch)))
  ipcMain.handle('doc:remove', (_e, id, opts, sessionId) => scoped(sessionId, () => library.removeDoc(id, { ...opts, sessionId })))
  ipcMain.handle('doc:setProgress', (_e, id, page, totalPages, sessionId) => scoped(sessionId, () => library.setProgress(id, page, totalPages)))

  ipcMain.handle('doc:open', async (_e, id, sessionId = library.getSessionId()) => {
    library.assertSession(sessionId)
    const abs = library.getDocPath(id)
    // 配置了自定义阅读器时不检查文件会把不存在的路径传给阅读器
    // （未配置时 shell.openPath 会报错，两条路径行为对齐）
    if (!fs.existsSync(abs)) throw new Error('库内 PDF 副本已丢失，请删除这本书后重新导入（原文件不受影响）')
    const s = library.getData().settings || {}
    await openWithReader(abs, s.pdfReaderPath)
    library.assertSession(sessionId)
    library.markOpened(id)
    return true
  })

  // 预览内真实翻页也算阅读足迹（只记账，不触发外部打开）
  ipcMain.handle('doc:markRead', (_e, id, sessionId) => scoped(sessionId, () => library.markOpened(id, 'read')))

  ipcMain.handle('preview:read', (_e, id, sessionId) => library.readFileBuffer(id, sessionId))

  ipcMain.handle('cover:set', (_e, id, dataUrl, sessionId) => scoped(sessionId, () => library.setCover(id, dataUrl)))
  ipcMain.handle('cover:get', (_e, id, sessionId) => scoped(sessionId, () => library.getCoverDataUrl(id)))

  // 全文索引：渲染层只取「哪些书已索引」的清单，搜索交给主进程按需读分片，
  // 不再把整份索引（大库上可达几十 MB）结构化克隆给渲染进程
  ipcMain.handle('textindex:status', (_e, sessionId) => scoped(sessionId, () => library.getTextIndexStatus()))
  ipcMain.handle('textindex:search', (_e, kw, sessionId) => library.searchTextIndex(kw, sessionId))
  ipcMain.handle('textindex:set', (_e, id, payload, sessionId) => scoped(sessionId, () => library.setTextIndex(id, payload)))

  ipcMain.handle('cat:add', (_e, name, parentId, sessionId) => scoped(sessionId, () => library.addCategory(name, parentId)))
  ipcMain.handle('cat:rename', (_e, id, name, sessionId) => scoped(sessionId, () => library.renameCategory(id, name)))
  ipcMain.handle('cat:move', (_e, id, parentId, sessionId) => scoped(sessionId, () => library.moveCategory(id, parentId)))
  ipcMain.handle('cat:remove', (_e, id, sessionId) => scoped(sessionId, () => library.removeCategory(id)))

  ipcMain.handle('tag:add', (_e, name, sessionId) => scoped(sessionId, () => library.addTag(name)))
  ipcMain.handle('tag:remove', (_e, id, sessionId) => scoped(sessionId, () => library.removeTag(id)))

  ipcMain.handle('shelf:add', (_e, name, filters, sessionId) => scoped(sessionId, () => library.addSmartShelf(name, filters)))
  ipcMain.handle('shelf:rename', (_e, id, name, sessionId) => scoped(sessionId, () => library.renameSmartShelf(id, name)))
  ipcMain.handle('shelf:remove', (_e, id, sessionId) => scoped(sessionId, () => library.removeSmartShelf(id)))

  ipcMain.handle('settings:set', (_e, patch, sessionId) => {
    library.assertSession(sessionId)
    const s = library.updateSettings(patch)
    watcher.configure(s) // 监视文件夹相关设置即时生效
    return s
  })

  // 外部工具（如下载器）：命令面板一键拉起，spawn 模式与外部阅读器一致
  ipcMain.handle('tool:launch', () => {
    const p = (library.getData().settings || {}).externalToolPath
    if (!p || !fs.existsSync(p)) throw new Error('未配置外部工具路径，请到设置 → 阅读与索引填写')
    const child = spawn(p, [], { detached: true, stdio: 'ignore' })
    child.once('error', () => {}) // existsSync 已排除常见错误，兜底防未处理事件
    child.unref()
    return true
  })

  // 笔记：notes/<docId>/ 下的 .md 文件，目录扫描为准
  const note = (sessionId, id, fn) => scoped(sessionId, () => { library.getDocPath(id); return fn() })
  ipcMain.handle('notes:list', (_e, id, sessionId) => note(sessionId, id, () => notes.list(id)))
  ipcMain.handle('notes:create', (_e, id, payload, sessionId) => note(sessionId, id, () => notes.create(id, payload)))
  ipcMain.handle('notes:open', (_e, id, file, opts, sessionId) => note(sessionId, id, () => notes.open(id, file, opts || {})))
  ipcMain.handle('notes:trash', (_e, id, file, sessionId = library.getSessionId()) =>
    library.runMutation(sessionId, () => note(sessionId, id, () => notes.trash(id, file))))
  ipcMain.handle('notes:reveal', (_e, id, file, sessionId) => note(sessionId, id, () => notes.reveal(id, file)))
}

function scoped (sessionId, action) {
  library.assertSession(sessionId)
  return action()
}

async function importPaths (paths, sessionId = library.getSessionId()) {
  library.assertSession(sessionId)
  const imported = []
  const errors = []
  const duplicates = []
  for (const filePath of paths) {
    try {
      imported.push({ ...await library.importPdf(filePath, { sessionId }), sessionId })
    } catch (err) {
      if (err.name === 'AbortError') throw err
      if (err.duplicate) duplicates.push({ file: path.basename(filePath), title: err.duplicate.title })
      else errors.push({ file: path.basename(filePath), message: String(err.message || err) })
    }
  }
  return { imported, errors, duplicates }
}
