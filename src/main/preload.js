const { contextBridge, ipcRenderer, webUtils } = require('electron')
let activeSession

// 渲染进程唯一可用的接口：window.solace.*
contextBridge.exposeInMainWorld('solace', {
  // 资料库
  getLibrary: async () => {
    const data = await ipcRenderer.invoke('library:get')
    if (activeSession === undefined || data.sessionId > activeSession) activeSession = data.sessionId
    return data
  },
  getOpenStats: (sessionId = activeSession) => ipcRenderer.invoke('library:stats', sessionId),
  importDialog: (sessionId = activeSession) => ipcRenderer.invoke('library:importDialog', sessionId),
  importPaths: (paths, sessionId = activeSession) => ipcRenderer.invoke('library:importPaths', paths, sessionId),
  getLibraryInfo: () => ipcRenderer.invoke('library:info'),
  openLibraryRoot: () => ipcRenderer.invoke('library:openRoot'),
  inspectTarget: (dir) => ipcRenderer.invoke('library:inspectTarget', dir),
  relocateLibrary: (dir, opts) => ipcRenderer.invoke('library:relocate', dir, { ...opts, sessionId: opts?.sessionId ?? activeSession }),
  pickFile: (opts) => ipcRenderer.invoke('dialog:pickFile', opts),
  pickDirectory: (opts) => ipcRenderer.invoke('dialog:pickDirectory', opts),
  // 文档
  updateDoc: (id, patch, sessionId = activeSession) => ipcRenderer.invoke('doc:update', id, patch, sessionId),
  removeDoc: (id, opts, sessionId = activeSession) => ipcRenderer.invoke('doc:remove', id, opts, sessionId),
  openDoc: (id, sessionId = activeSession) => ipcRenderer.invoke('doc:open', id, sessionId),
  markRead: (id, sessionId = activeSession) => ipcRenderer.invoke('doc:markRead', id, sessionId),
  readPreview: (id, sessionId = activeSession) => ipcRenderer.invoke('preview:read', id, sessionId),
  setProgress: (id, page, totalPages, sessionId = activeSession) => ipcRenderer.invoke('doc:setProgress', id, page, totalPages, sessionId),
  // 全文索引（清单 + 主进程侧搜索，不把整份索引拉到渲染进程）
  getTextIndexStatus: (sessionId = activeSession) => ipcRenderer.invoke('textindex:status', sessionId),
  searchTextIndex: (kw, sessionId = activeSession) => ipcRenderer.invoke('textindex:search', kw, sessionId),
  setTextIndex: (id, payload, sessionId = activeSession) => ipcRenderer.invoke('textindex:set', id, payload, sessionId),
  // 封面
  setCover: (id, dataUrl, sessionId = activeSession) => ipcRenderer.invoke('cover:set', id, dataUrl, sessionId),
  getCover: (id, sessionId = activeSession) => ipcRenderer.invoke('cover:get', id, sessionId),
  // 分类（parentId 构成分类树）
  addCategory: (name, parentId, sessionId = activeSession) => ipcRenderer.invoke('cat:add', name, parentId, sessionId),
  renameCategory: (id, name, sessionId = activeSession) => ipcRenderer.invoke('cat:rename', id, name, sessionId),
  moveCategory: (id, parentId, sessionId = activeSession) => ipcRenderer.invoke('cat:move', id, parentId, sessionId),
  removeCategory: (id, sessionId = activeSession) => ipcRenderer.invoke('cat:remove', id, sessionId),
  // 标签
  addTag: (name, sessionId = activeSession) => ipcRenderer.invoke('tag:add', name, sessionId),
  removeTag: (id, sessionId = activeSession) => ipcRenderer.invoke('tag:remove', id, sessionId),
  // 智能收藏夹（保存的筛选组合）
  saveShelf: (name, filters, sessionId = activeSession) => ipcRenderer.invoke('shelf:add', name, filters, sessionId),
  renameShelf: (id, name, sessionId = activeSession) => ipcRenderer.invoke('shelf:rename', id, name, sessionId),
  removeShelf: (id, sessionId = activeSession) => ipcRenderer.invoke('shelf:remove', id, sessionId),
  // 设置（主题 / 视图模式 / 阅读器路径等）
  updateSettings: (patch, sessionId = activeSession) => ipcRenderer.invoke('settings:set', patch, sessionId),
  // 外部工具与自动入库（主进程 → 渲染层事件）
  launchTool: () => ipcRenderer.invoke('tool:launch'),
  onWatchEvent: (cb) => {
    ipcRenderer.on('watch:imported', (_e, payload) => cb({ type: 'imported', ...payload }))
    ipcRenderer.on('watch:error', (_e, payload) => cb({ type: 'error', ...payload }))
  },
  // 笔记（.md 文件存于资料库 notes/<id>/，目录扫描为准）
  listNotes: (id, sessionId = activeSession) => ipcRenderer.invoke('notes:list', id, sessionId),
  createNote: (id, payload, sessionId = activeSession) => ipcRenderer.invoke('notes:create', id, payload, sessionId),
  openNote: (id, file, opts, sessionId = activeSession) => ipcRenderer.invoke('notes:open', id, file, opts, sessionId),
  trashNote: (id, file, sessionId = activeSession) => ipcRenderer.invoke('notes:trash', id, file, sessionId),
  revealNote: (id, file, sessionId = activeSession) => ipcRenderer.invoke('notes:reveal', id, file, sessionId),
  // 拖拽文件落盘路径（Electron 渲染进程 File 对象不带 path，需经 webUtils 转换）
  pathForFile: (file) => webUtils.getPathForFile(file)
})
