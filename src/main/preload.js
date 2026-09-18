const { contextBridge, ipcRenderer, webUtils } = require('electron')

// 渲染进程唯一可用的接口：window.solace.*
contextBridge.exposeInMainWorld('solace', {
  // 资料库
  getLibrary: () => ipcRenderer.invoke('library:get'),
  getOpenStats: () => ipcRenderer.invoke('library:stats'),
  importDialog: () => ipcRenderer.invoke('library:importDialog'),
  importPaths: (paths) => ipcRenderer.invoke('library:importPaths', paths),
  getLibraryInfo: () => ipcRenderer.invoke('library:info'),
  openLibraryRoot: () => ipcRenderer.invoke('library:openRoot'),
  inspectTarget: (dir) => ipcRenderer.invoke('library:inspectTarget', dir),
  relocateLibrary: (dir, opts) => ipcRenderer.invoke('library:relocate', dir, opts),
  pickFile: (opts) => ipcRenderer.invoke('dialog:pickFile', opts),
  pickDirectory: (opts) => ipcRenderer.invoke('dialog:pickDirectory', opts),
  // 文档
  updateDoc: (id, patch) => ipcRenderer.invoke('doc:update', id, patch),
  removeDoc: (id, opts) => ipcRenderer.invoke('doc:remove', id, opts),
  openDoc: (id) => ipcRenderer.invoke('doc:open', id),
  markRead: (id) => ipcRenderer.invoke('doc:markRead', id),
  readPreview: (id) => ipcRenderer.invoke('preview:read', id),
  setProgress: (id, page, totalPages) => ipcRenderer.invoke('doc:setProgress', id, page, totalPages),
  // 全文索引（清单 + 主进程侧搜索，不把整份索引拉到渲染进程）
  getTextIndexStatus: () => ipcRenderer.invoke('textindex:status'),
  searchTextIndex: (kw) => ipcRenderer.invoke('textindex:search', kw),
  setTextIndex: (id, payload) => ipcRenderer.invoke('textindex:set', id, payload),
  // 封面
  setCover: (id, dataUrl) => ipcRenderer.invoke('cover:set', id, dataUrl),
  getCover: (id) => ipcRenderer.invoke('cover:get', id),
  // 分类（parentId 构成分类树）
  addCategory: (name, parentId) => ipcRenderer.invoke('cat:add', name, parentId),
  renameCategory: (id, name) => ipcRenderer.invoke('cat:rename', id, name),
  moveCategory: (id, parentId) => ipcRenderer.invoke('cat:move', id, parentId),
  removeCategory: (id) => ipcRenderer.invoke('cat:remove', id),
  // 标签
  addTag: (name) => ipcRenderer.invoke('tag:add', name),
  removeTag: (id) => ipcRenderer.invoke('tag:remove', id),
  // 智能收藏夹（保存的筛选组合）
  saveShelf: (name, filters) => ipcRenderer.invoke('shelf:add', name, filters),
  renameShelf: (id, name) => ipcRenderer.invoke('shelf:rename', id, name),
  removeShelf: (id) => ipcRenderer.invoke('shelf:remove', id),
  // 设置（主题 / 视图模式 / 阅读器路径等）
  updateSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  // 外部工具与自动入库（主进程 → 渲染层事件）
  launchTool: () => ipcRenderer.invoke('tool:launch'),
  onWatchEvent: (cb) => {
    ipcRenderer.on('watch:imported', (_e, payload) => cb({ type: 'imported', ...payload }))
    ipcRenderer.on('watch:error', (_e, payload) => cb({ type: 'error', ...payload }))
  },
  // 笔记（.md 文件存于资料库 notes/<id>/，目录扫描为准）
  listNotes: (id) => ipcRenderer.invoke('notes:list', id),
  createNote: (id, payload) => ipcRenderer.invoke('notes:create', id, payload),
  openNote: (id, file, opts) => ipcRenderer.invoke('notes:open', id, file, opts),
  trashNote: (id, file) => ipcRenderer.invoke('notes:trash', id, file),
  revealNote: (id, file) => ipcRenderer.invoke('notes:reveal', id, file),
  // 拖拽文件落盘路径（Electron 渲染进程 File 对象不带 path，需经 webUtils 转换）
  pathForFile: (file) => webUtils.getPathForFile(file)
})
