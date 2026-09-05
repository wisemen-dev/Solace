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
  // 分类
  addCategory: (name) => ipcRenderer.invoke('cat:add', name),
  renameCategory: (id, name) => ipcRenderer.invoke('cat:rename', id, name),
  removeCategory: (id) => ipcRenderer.invoke('cat:remove', id),
  // 标签
  addTag: (name) => ipcRenderer.invoke('tag:add', name),
  removeTag: (id) => ipcRenderer.invoke('tag:remove', id),
  // 拖拽文件落盘路径（Electron 渲染进程 File 对象不带 path，需经 webUtils 转换）
  pathForFile: (file) => webUtils.getPathForFile(file)
})
