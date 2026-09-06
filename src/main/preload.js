const { contextBridge, ipcRenderer, webUtils } = require('electron')

// 渲染进程唯一可用的接口：window.solace.*
contextBridge.exposeInMainWorld('solace', {
  // 资料库
  getLibrary: () => ipcRenderer.invoke('library:get'),
  importDialog: () => ipcRenderer.invoke('library:importDialog'),
  importPaths: (paths) => ipcRenderer.invoke('library:importPaths', paths),
  // 文档
  updateDoc: (id, patch) => ipcRenderer.invoke('doc:update', id, patch),
  removeDoc: (id) => ipcRenderer.invoke('doc:remove', id),
  openDoc: (id) => ipcRenderer.invoke('doc:open', id),
  readPreview: (id) => ipcRenderer.invoke('preview:read', id),
  setProgress: (id, page, totalPages) => ipcRenderer.invoke('doc:setProgress', id, page, totalPages),
  // 全文索引
  getTextIndex: () => ipcRenderer.invoke('textindex:get'),
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
  // 设置（主题 / 视图模式）
  updateSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  // 拖拽文件落盘路径（Electron 渲染进程 File 对象不带 path，需经 webUtils 转换）
  pathForFile: (file) => webUtils.getPathForFile(file)
})
