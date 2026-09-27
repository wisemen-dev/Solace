const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const vm = require('vm')
const { EventEmitter } = require('events')

const MAIN_FILE = path.join(__dirname, '..', 'src', 'main', 'main.js')
const MAIN_SOURCE = fs.readFileSync(MAIN_FILE, 'utf8')
const DOC_ID = '11111111-1111-4111-8111-111111111111'

function deferred () {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const flushAsync = () => new Promise(resolve => setImmediate(resolve))

// Run the real main process wiring while keeping windows, files and external
// programs behind stubs. Each harness has its own library and startup promise.
function harness (hooks = {}) {
  const ready = deferred()
  const events = []
  const handlers = new Map()
  const windows = []
  const calls = { init: [], imports: [], mutations: [], queued: [], notes: [], watcher: [], messages: [], errors: [], quit: 0 }
  const state = {
    sessionId: 41,
    root: path.join(os.tmpdir(), 'solace-main-ipc-fixture', 'SolaceLibrary'),
    data: {
      documents: [{ id: DOC_ID, title: 'Book', tagIds: [], categoryId: null }],
      categories: [],
      tags: [],
      settings: { watchFolder: 'old-inbox', theme: 'ink' }
    },
    covers: {},
    textindex: {},
    notes: {}
  }
  const mutate = (method, args) => calls.mutations.push({ method, args })
  const library = {
    init (base, opts) {
      calls.init.push({ base, opts: { ...opts } })
      events.push('library:init')
      if (hooks.init) return hooks.init(base, opts, state)
    },
    getSessionId: () => state.sessionId,
    getData: () => state.data,
    getRootDir: () => state.root,
    getStartupNotice: () => null,
    canRelocate: () => true,
    setTrashHandler () {},
    assertSession (expected = state.sessionId) {
      if (expected === state.sessionId) return
      const err = new Error('Library session changed')
      err.name = 'AbortError'
      throw err
    },
    runMutation (expected, action) {
      library.assertSession(expected)
      calls.queued.push(expected)
      if (hooks.runMutation) return hooks.runMutation(expected, action, state)
      return Promise.resolve().then(action)
    },
    getDocPath (id) {
      assert.ok(state.data.documents.some(d => d.id === id), 'Document must exist')
      return path.join(state.root, 'files', `${id}.pdf`)
    },
    setCover (id, dataUrl) {
      mutate('setCover', [id, dataUrl])
      state.covers[id] = dataUrl
      return true
    },
    setTextIndex (id, payload) {
      mutate('setTextIndex', [id, payload])
      state.textindex[id] = payload
      return true
    },
    setProgress (id, page, totalPages) {
      mutate('setProgress', [id, page, totalPages])
      state.data.documents.find(d => d.id === id).progress = { page, totalPages }
      return true
    },
    updateDoc (id, patch) { mutate('updateDoc', [id, patch]); return true },
    removeDoc (id, opts) { mutate('removeDoc', [id, opts]); return true },
    markOpened (id, type) { mutate('markOpened', [id, type]) },
    updateSettings (patch) {
      mutate('updateSettings', [patch])
      Object.assign(state.data.settings, patch)
      return state.data.settings
    },
    relocate (dir, opts) {
      events.push('library:relocate')
      if (hooks.relocate) return hooks.relocate(dir, opts, state)
      throw new Error('Unexpected relocation')
    },
    importPdf (file, opts) {
      calls.imports.push({ file, opts: { ...opts } })
      library.assertSession(opts.sessionId)
      if (hooks.importPdf) return hooks.importPdf(file, opts, state)
      return Promise.resolve({ id: DOC_ID, title: path.basename(file) })
    }
  }
  const notes = {
    init (root, settingsGetter) {
      events.push('notes:init')
      calls.notes.push({ method: 'init', root, settingsGetter })
    },
    list (id) { calls.notes.push({ method: 'list', id }); return { notes: state.notes[id] || [] } },
    create (id, payload) {
      calls.notes.push({ method: 'create', id, payload })
      state.notes[id] = [...state.notes[id] || [], { file: 'note.md' }]
      return { file: 'note.md' }
    },
    trash (id, file) {
      calls.notes.push({ method: 'trash', id, file })
      if (hooks.trashNote) return hooks.trashNote(id, file, state)
      state.notes[id] = []
      return true
    },
    open (id, file, opts) { calls.notes.push({ method: 'open', id, file, opts }); return { opened: true } },
    reveal (id, file) { calls.notes.push({ method: 'reveal', id, file }); return true }
  }
  const watcher = {
    init (callbacks) { calls.watcher.push({ method: 'init', callbacks }) },
    stop () { events.push('watcher:stop'); calls.watcher.push({ method: 'stop' }) },
    configure (settings) {
      events.push('watcher:configure')
      calls.watcher.push({ method: 'configure', settings: { ...settings } })
    }
  }
  let startup
  const app = new EventEmitter()
  app.commandLine = { appendSwitch () {} }
  app.requestSingleInstanceLock = () => true
  app.getPath = () => path.dirname(state.root)
  app.quit = () => { calls.quit++; events.push('app:quit') }
  app.whenReady = () => ({
    then (callback) {
      startup = ready.promise.then(callback)
      return startup
    }
  })
  class BrowserWindow extends EventEmitter {
    constructor (opts) {
      super()
      this.options = opts
      this.webContents = { send () {} }
      windows.push(this)
      events.push('window:create')
    }

    loadFile () {}
    show () {}
    isDestroyed () { return false }
    static getAllWindows () { return windows }
  }
  const dialog = {
    showMessageBox (opts) {
      events.push('dialog:message')
      calls.messages.push(opts)
      return hooks.showMessageBox ? hooks.showMessageBox(opts) : Promise.resolve({ response: 2 })
    },
    showErrorBox (title, message) { calls.errors.push({ title, message }) },
    showOpenDialog (...args) {
      return hooks.showOpenDialog ? hooks.showOpenDialog(...args) : Promise.resolve({ canceled: true, filePaths: [] })
    }
  }
  const electron = {
    app,
    BrowserWindow,
    dialog,
    shell: { trashItem: async () => {}, openPath: async () => '' },
    ipcMain: {
      handle (channel, callback) {
        assert.equal(handlers.has(channel), false, `Duplicate IPC handler: ${channel}`)
        handlers.set(channel, callback)
      }
    }
  }
  const dependencies = {
    electron,
    fs,
    path,
    child_process: { spawn () { throw new Error('External processes are not allowed in this test') } },
    './library': library,
    './notes': notes,
    './watcher': watcher
  }
  const sandbox = {
    module: { exports: {} },
    __dirname: path.dirname(MAIN_FILE),
    process: { env: {}, platform: 'win32' },
    setTimeout,
    clearTimeout,
    console,
    require (name) {
      assert.ok(name in dependencies, `Unexpected module: ${name}`)
      return dependencies[name]
    }
  }
  vm.runInNewContext(`${MAIN_SOURCE}\nmodule.exports = { registerIpc, importPaths }\n`, sandbox, { filename: MAIN_FILE })
  return {
    state,
    calls,
    events,
    handlers,
    windows,
    registerIpc: sandbox.module.exports.registerIpc,
    start () { ready.resolve(); return startup },
    async invoke (channel, ...args) {
      assert.ok(handlers.has(channel), `Missing IPC handler: ${channel}`)
      return structuredClone(await handlers.get(channel)({}, ...args))
    }
  }
}

test('library:get returns the library and each document with the current session', async () => {
  const h = harness()
  h.registerIpc()
  const original = structuredClone(h.state.data)
  const snapshot = await h.invoke('library:get')

  assert.equal(snapshot.sessionId, h.state.sessionId)
  assert.equal(snapshot.documents[0].sessionId, h.state.sessionId)
  assert.deepEqual(h.state.data, original, 'Adding response metadata must not mutate stored data')
  snapshot.documents[0].title = 'Changed in renderer'
  assert.equal(h.state.data.documents[0].title, 'Book')
})

test('stale session writes are rejected before changing library, notes or watcher settings', async () => {
  const h = harness()
  h.registerIpc()
  const oldSession = h.state.sessionId
  h.state.sessionId++
  const original = structuredClone(h.state)
  const requests = [
    ['cover:set', DOC_ID, 'data:image/jpeg;base64,YQ=='],
    ['textindex:set', DOC_ID, { pages: ['old text'], ver: 2 }],
    ['doc:setProgress', DOC_ID, 8, 20],
    ['doc:update', DOC_ID, { title: 'Old title' }],
    ['doc:remove', DOC_ID, { keepNotes: false }],
    ['doc:markRead', DOC_ID],
    ['notes:create', DOC_ID, { title: 'Old note' }],
    ['notes:trash', DOC_ID, 'note.md'],
    ['notes:open', DOC_ID, 'note.md', {}],
    ['notes:reveal', DOC_ID, 'note.md'],
    ['settings:set', { theme: 'dusk', watchFolder: 'wrong-inbox' }]
  ]
  for (const [channel, ...args] of requests) {
    await assert.rejects(h.invoke(channel, ...args, oldSession), { name: 'AbortError' }, channel)
  }

  assert.deepEqual(h.state, original)
  assert.deepEqual(h.calls.mutations, [])
  assert.deepEqual(h.calls.notes, [])
  assert.deepEqual(h.calls.watcher, [])
})

test('current session writes still reach library and notes handlers', async () => {
  const h = harness()
  h.registerIpc()
  const session = h.state.sessionId
  await h.invoke('cover:set', DOC_ID, 'data:image/jpeg;base64,YQ==', session)
  await h.invoke('textindex:set', DOC_ID, { pages: ['current text'], ver: 2 }, session)
  await h.invoke('doc:setProgress', DOC_ID, 3, 20, session)
  await h.invoke('notes:create', DOC_ID, { title: 'Current note' }, session)
  await h.invoke('notes:trash', DOC_ID, 'note.md', session)
  await h.invoke('settings:set', { theme: 'paper' }, session)

  assert.equal(h.state.covers[DOC_ID], 'data:image/jpeg;base64,YQ==')
  assert.deepEqual(h.state.textindex[DOC_ID], { pages: ['current text'], ver: 2 })
  assert.deepEqual(h.state.data.documents[0].progress, { page: 3, totalPages: 20 })
  assert.deepEqual(h.calls.notes.map(c => c.method), ['create', 'trash'])
  assert.equal(h.state.data.settings.theme, 'paper')
  assert.equal(h.calls.watcher.at(-1).settings.theme, 'paper')
})

test('note deletion enters the shared mutation queue and waits for the deletion to finish', async () => {
  const deleted = deferred()
  const h = harness({ trashNote: () => deleted.promise })
  h.registerIpc()
  let finished = false
  const pending = h.invoke('notes:trash', DOC_ID, 'note.md').then(result => {
    finished = true
    return result
  })

  assert.deepEqual(h.calls.queued, [h.state.sessionId])
  assert.deepEqual(h.calls.notes, [], 'Deletion cannot run before the queue executes it')
  await flushAsync()
  assert.deepEqual(h.calls.notes, [{ method: 'trash', id: DOC_ID, file: 'note.md' }])
  assert.equal(finished, false)
  deleted.resolve(true)
  assert.equal(await pending, true)
})

test('queued note deletion keeps its original session and rechecks it at execution', async () => {
  const ready = deferred()
  const h = harness({ runMutation: (_session, action) => ready.promise.then(action) })
  h.registerIpc()
  const originalSession = h.state.sessionId
  const pending = h.invoke('notes:trash', DOC_ID, 'note.md')
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  assert.deepEqual(h.calls.queued, [originalSession])

  h.state.sessionId++
  ready.resolve()
  await rejected
  assert.deepEqual(h.calls.notes, [])
})

test('queued note deletion rechecks that its document still exists at execution', async () => {
  const ready = deferred()
  const h = harness({ runMutation: (_session, action) => ready.promise.then(action) })
  h.registerIpc()
  const pending = h.invoke('notes:trash', DOC_ID, 'note.md', h.state.sessionId)
  const rejected = assert.rejects(pending, /Document must exist/)

  h.state.data.documents = []
  ready.resolve()
  await rejected
  assert.deepEqual(h.calls.notes, [])
})

test('relocation waits for the library before reinitializing notes and monitoring', async () => {
  const moved = deferred()
  const h = harness({
    async relocate (dir, _opts, state) {
      await moved.promise
      state.root = dir
      state.sessionId++
      state.data.settings = { watchFolder: 'new-inbox' }
      return { rootDir: dir, mode: 'moved' }
    }
  })
  h.registerIpc()
  const nextRoot = path.join(os.tmpdir(), 'next-solace-ipc-fixture', 'SolaceLibrary')
  const pending = h.invoke('library:relocate', nextRoot, { move: true })

  assert.deepEqual(h.events, ['watcher:stop', 'library:relocate'])
  assert.deepEqual(h.calls.notes, [])
  moved.resolve()
  const result = await pending

  assert.equal(result.sessionId, h.state.sessionId)
  assert.equal(result.rootDir, nextRoot)
  assert.deepEqual(h.events, ['watcher:stop', 'library:relocate', 'notes:init', 'watcher:configure'])
  assert.equal(h.calls.notes[0].root, nextRoot)
  assert.deepEqual(h.calls.notes[0].settingsGetter(), { watchFolder: 'new-inbox' })
  assert.deepEqual(h.calls.watcher.at(-1).settings, { watchFolder: 'new-inbox' })
})

test('failed relocation restarts the old monitor in finally without switching notes', async () => {
  const moved = deferred()
  const h = harness({ relocate: () => moved.promise })
  h.registerIpc()
  const original = structuredClone(h.state)
  const pending = h.invoke('library:relocate', 'unavailable-location', { move: true })
  assert.deepEqual(h.events, ['watcher:stop', 'library:relocate'])

  moved.reject(new Error('copy failed'))
  await assert.rejects(pending, /copy failed/)

  assert.deepEqual(h.state, original)
  assert.deepEqual(h.calls.notes, [])
  assert.deepEqual(h.events, ['watcher:stop', 'library:relocate', 'watcher:configure'])
  assert.deepEqual(h.calls.watcher.at(-1).settings, original.data.settings)
})

function unavailableError () {
  return Object.assign(new Error('Configured library is unavailable'), {
    code: 'LIBRARY_UNAVAILABLE',
    defaultRoot: path.join(os.tmpdir(), 'default-solace-ipc-fixture', 'SolaceLibrary')
  })
}

test('unavailable library blocks IPC and windows until the default location is accepted', async () => {
  const choice = deferred()
  const h = harness({
    init (_base, opts) { if (!opts.acceptDefault) throw unavailableError() },
    showMessageBox: () => choice.promise
  })
  const pending = h.start()
  await flushAsync()

  assert.equal(h.calls.messages.length, 1)
  assert.equal(h.handlers.size, 0)
  assert.equal(h.windows.length, 0)
  assert.deepEqual(h.calls.notes, [])
  assert.deepEqual(h.calls.watcher, [])
  assert.equal(h.calls.init.length, 1)
  assert.equal(h.calls.init[0].opts.acceptDefault, undefined)

  choice.resolve({ response: 1 })
  await pending

  assert.equal(h.calls.init.length, 2)
  assert.equal(h.calls.init[1].opts.acceptDefault, true)
  assert.ok(h.handlers.has('library:get'))
  assert.equal(h.windows.length, 1)
  assert.equal(h.calls.quit, 0)
  assert.deepEqual(h.calls.errors, [])
})

test('exiting the unavailable-library prompt does not register IPC or create a window', async () => {
  const h = harness({
    init () { throw unavailableError() },
    showMessageBox: async () => ({ response: 2 })
  })
  await h.start()

  assert.equal(h.calls.init.length, 1)
  assert.equal(h.calls.quit, 1)
  assert.equal(h.handlers.size, 0)
  assert.equal(h.windows.length, 0)
  assert.deepEqual(h.calls.notes, [])
  assert.deepEqual(h.calls.watcher, [])
})

test('retrying the unavailable library does not implicitly accept the default location', async () => {
  let attempts = 0
  const h = harness({
    init () { if (++attempts === 1) throw unavailableError() },
    showMessageBox: async () => ({ response: 0 })
  })
  await h.start()

  assert.equal(h.calls.init.length, 2)
  assert.equal(h.calls.init[1].opts.acceptDefault, false)
  assert.equal(h.calls.quit, 0)
  assert.equal(h.windows.length, 1)
})

test('a batch import keeps the session captured before the first asynchronous file', async () => {
  const firstImport = deferred()
  const h = harness({ importPdf: () => firstImport.promise })
  h.registerIpc()
  const originalSession = h.state.sessionId
  const pending = h.invoke('library:importPaths', ['first.pdf', 'second.pdf'])
  assert.equal(h.calls.imports.length, 1)

  h.state.sessionId++
  firstImport.resolve({ id: DOC_ID, title: 'First' })
  await assert.rejects(pending, { name: 'AbortError' })

  assert.deepEqual(h.calls.imports.map(c => c.opts.sessionId), [originalSession, originalSession])
  assert.deepEqual(h.calls.mutations, [])
})

test('an import dialog completed after a library switch cannot import into the new library', async () => {
  const selection = deferred()
  const h = harness({ showOpenDialog: () => selection.promise })
  h.registerIpc()
  const pending = h.invoke('library:importDialog')
  h.state.sessionId++
  selection.resolve({ canceled: false, filePaths: ['selected.pdf'] })

  await assert.rejects(pending, { name: 'AbortError' })
  assert.deepEqual(h.calls.imports, [])
  assert.deepEqual(h.calls.mutations, [])
})
