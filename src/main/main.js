const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('path')
const library = require('./library')

let mainWindow = null

function createWindow () {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 620,
    title: 'Solace',
    backgroundColor: '#101418',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
}

app.whenReady().then(() => {
  library.init(app.getPath('userData'))
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

function registerIpc () {
  ipcMain.handle('library:get', () => library.getData())

  ipcMain.handle('library:importDialog', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '导入 PDF',
      filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled) return { imported: [], errors: [] }
    return importPaths(result.filePaths)
  })

  ipcMain.handle('library:importPaths', (_e, paths) => importPaths(paths))

  ipcMain.handle('doc:update', (_e, id, patch) => library.updateDoc(id, patch))
  ipcMain.handle('doc:remove', (_e, id) => library.removeDoc(id))

  ipcMain.handle('doc:open', async (_e, id) => {
    const abs = library.getDocPath(id)
    const err = await shell.openPath(abs)
    if (err) throw new Error(err)
    library.markOpened(id)
    return true
  })

  ipcMain.handle('preview:read', (_e, id) => library.readFileBuffer(id))

  ipcMain.handle('cat:add', (_e, name) => library.addCategory(name))
  ipcMain.handle('cat:rename', (_e, id, name) => library.renameCategory(id, name))
  ipcMain.handle('cat:remove', (_e, id) => library.removeCategory(id))

  ipcMain.handle('tag:add', (_e, name) => library.addTag(name))
  ipcMain.handle('tag:remove', (_e, id) => library.removeTag(id))
}

async function importPaths (paths) {
  const imported = []
  const errors = []
  for (const filePath of paths) {
    try {
      imported.push(await library.importPdf(filePath))
    } catch (err) {
      errors.push({ file: path.basename(filePath), message: String(err.message || err) })
    }
  }
  return { imported, errors }
}
