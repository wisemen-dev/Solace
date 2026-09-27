import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const JS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/renderer/js')
const tick = () => new Promise(resolve => setImmediate(resolve))
const newSettings = {
  pdfReaderPath: 'new-reader.exe', notesEditorPath: 'new-editor.exe',
  externalToolPath: 'new-tool.exe', watchFolder: 'new-watch', watchEnabled: false
}
const library = (sessionId, settings = {}) => ({ sessionId, documents: [], categories: [], settings })
const browsers = [
  { button: 'btnBrowsePdfReader', input: 'setPdfReader', key: 'pdfReaderPath', picker: 'pickFile' },
  { button: 'btnBrowseNotesEditor', input: 'setNotesEditor', key: 'notesEditorPath', picker: 'pickFile' },
  { button: 'btnBrowseTool', input: 'setTool', key: 'externalToolPath', picker: 'pickFile' },
  { button: 'btnBrowseWatch', input: 'setWatchFolder', key: 'watchFolder', picker: 'pickDirectory' }
]

function deferred () {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function element (id) {
  const listeners = new Map()
  return {
    id, value: '', textContent: '', innerHTML: '', checked: false, disabled: false,
    dataset: {}, classList: { toggle () {} },
    addEventListener (name, fn) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
    },
    emit (name, event = {}) {
      return Promise.all((listeners.get(name) || []).map(fn => fn({ target: this, ...event })))
    },
    showModal () { this.open = true },
    close () { this.open = false }
  }
}

async function harness (overrides = {}) {
  assert.equal(typeof vm.SourceTextModule, 'function', 'Run with --experimental-vm-modules')
  const elements = new Map()
  const el = id => {
    if (!elements.has(id)) elements.set(id, element(id))
    return elements.get(id)
  }
  let current = library('old-library')
  const order = []
  const events = []
  const calls = { toast: [] }
  const handlers = {
    getLibrary: async () => current,
    getLibraryInfo: async () => ({ rootDir: current.sessionId, canRelocate: true }),
    updateSettings: async patch => patch,
    pickFile: async () => 'picked.exe',
    pickDirectory: async () => 'new-root',
    openLibraryRoot: async () => true,
    inspectTarget: async () => ({ targetRoot: 'new-root', hasLibrary: false }),
    relocateLibrary: async () => {
      current = library('new-library', newSettings)
      return { mode: 'moved', rootDir: 'new-root' }
    },
    askChoice: async () => 'move',
    prepareLibraryChange: async () => {},
    ...overrides
  }
  function call (name, args) {
    if (!calls[name]) calls[name] = []
    calls[name].push(structuredClone(args))
    order.push(name)
    return handlers[name](...args)
  }
  const solace = {}
  for (const name of Object.keys(handlers)) {
    if (name !== 'askChoice' && name !== 'prepareLibraryChange') solace[name] = (...args) => call(name, args)
  }
  const window = {
    solace,
    prepareLibraryChange: (...args) => call('prepareLibraryChange', args),
    toast: (...args) => calls.toast.push(args),
    dispatchEvent (event) {
      events.push({ type: event.type, detail: structuredClone(event.detail) })
      order.push(event.type)
    }
  }
  class CustomEvent {
    constructor (type, { detail } = {}) { this.type = type; this.detail = detail }
  }
  const context = vm.createContext({
    window, CustomEvent,
    document: {
      getElementById: el,
      querySelector: selector => el(selector.replace(/^#/, '')),
      querySelectorAll: () => []
    },
    console
  })
  const dialog = new vm.SyntheticModule(['askChoice'], function () {
    this.setExport('askChoice', (...args) => call('askChoice', args))
  }, { context, identifier: 'dialog.js' })
  const modules = new Map([['dialog.js', dialog]])
  for (const name of ['util.js', 'settings.js']) {
    modules.set(name, new vm.SourceTextModule(fs.readFileSync(path.join(JS_DIR, name), 'utf8'), {
      context, identifier: name
    }))
  }
  await modules.get('settings.js').link(spec => modules.get(path.basename(spec)))
  await modules.get('settings.js').evaluate()
  return {
    el, calls, order, events, handlers,
    setLibrary (data) { current = data },
    open: () => el('btnSettings').emit('click'),
    move: () => el('btnRelocate').emit('click')
  }
}

test('relocation waits for preparation and the progress flush before sending IPC', async () => {
  const progress = deferred()
  const h = await harness({ prepareLibraryChange: async () => {
    await progress.promise
    h.order.push('progress-flushed')
  } })
  await h.open()
  const moving = h.move()
  await tick()
  assert.equal(h.calls.prepareLibraryChange.length, 1)
  assert.equal(h.calls.relocateLibrary, undefined)
  assert.equal(h.el('btnRelocate').disabled, true)
  progress.resolve()
  await moving
  assert.deepEqual(h.calls.relocateLibrary, [['new-root', { move: true, sessionId: 'old-library' }]])
  assert.ok(h.order.indexOf('progress-flushed') < h.order.indexOf('relocateLibrary'))
  assert.deepEqual(h.events, [{ type: 'solace-library-moved', detail: { mode: 'moved', rootDir: 'new-root' } }])
  assert.equal(h.el('setRootPath').textContent, 'new-library')
  assert.equal(h.el('btnRelocate').disabled, false)
})

test('a failed progress flush cancels preparation and allows another attempt', async () => {
  const h = await harness({ prepareLibraryChange: async () => { throw new Error('disk full') } })
  await h.open()
  await h.move()
  assert.equal(h.calls.relocateLibrary, undefined)
  assert.deepEqual(h.events.map(event => event.type), ['solace-library-change-cancelled'])
  assert.match(h.calls.toast[0][0], /disk full/)
  assert.equal(h.el('btnRelocate').disabled, false)
  h.handlers.prepareLibraryChange = async () => {}
  await h.move()
  assert.equal(h.calls.relocateLibrary.length, 1)
  assert.equal(h.events[1].type, 'solace-library-moved')
})

test('a relocation IPC failure restores the current library workflow', async () => {
  const h = await harness({ relocateLibrary: async () => { throw new Error('target is locked') } })
  await h.open()
  await h.move()
  assert.deepEqual(h.events.map(event => event.type), ['solace-library-change-cancelled'])
  assert.match(h.calls.toast[0][0], /target is locked/)
  assert.equal(h.el('setRootPath').textContent, 'old-library')
  assert.equal(h.el('btnRelocate').disabled, false)
})

test('directory picker failure is caught without starting library preparation', async () => {
  const h = await harness({ pickDirectory: async () => { throw new Error('picker unavailable') } })
  await h.open()
  await assert.doesNotReject(h.move())
  assert.equal(h.calls.prepareLibraryChange, undefined)
  assert.equal(h.calls.relocateLibrary, undefined)
  assert.deepEqual(h.events, [])
  assert.match(h.calls.toast[0][0], /picker unavailable/)
  assert.equal(h.el('btnRelocate').disabled, false)
})

test('duplicate clicks cannot start another relocation during any async stage', async () => {
  const picking = deferred()
  const preparing = deferred()
  const relocating = deferred()
  const refreshing = deferred()
  const h = await harness({
    pickDirectory: () => picking.promise,
    prepareLibraryChange: () => preparing.promise,
    relocateLibrary: () => relocating.promise
  })
  await h.open()
  h.handlers.getLibrary = () => refreshing.promise
  const moving = h.move()
  await h.move()
  assert.equal(h.calls.pickDirectory.length, 1)
  picking.resolve('new-root')
  await tick()
  await h.move()
  assert.equal(h.calls.prepareLibraryChange.length, 1)
  preparing.resolve()
  await tick()
  await h.move()
  assert.equal(h.calls.relocateLibrary.length, 1)
  relocating.resolve({ mode: 'moved' })
  await tick()
  await h.move()
  assert.equal(h.calls.pickDirectory.length, 1, 'The guard remains active while the panel reloads')
  assert.equal(h.el('btnRelocate').disabled, true)
  refreshing.resolve(library('new-library'))
  await moving
  assert.equal(h.el('btnRelocate').disabled, false)
})

test('refresh after a cancelled choice preserves the relocation permission', async () => {
  const h = await harness({ askChoice: async () => null })
  await h.open()
  h.handlers.getLibraryInfo = async () => ({ rootDir: 'old-library', canRelocate: false })
  await h.move()
  assert.equal(h.calls.prepareLibraryChange, undefined)
  assert.deepEqual(h.events, [])
  assert.equal(h.el('btnRelocate').disabled, true)
})

for (const browser of browsers) {
  test(`${browser.key} browsing saves a current result with its captured session`, async () => {
    const h = await harness({ [browser.picker]: async () => 'chosen-path' })
    await h.open()
    await h.el(browser.button).emit('click')
    const patch = { [browser.key]: 'chosen-path' }
    if (browser.key === 'watchFolder') patch.watchEnabled = true
    assert.deepEqual(h.calls.updateSettings, [[patch, 'old-library']])
    assert.equal(h.el(browser.input).value, 'chosen-path')
    if (browser.key === 'watchFolder') assert.equal(h.el('setWatchEnabled').checked, true)
  })

  test(`${browser.key} browsing cannot write its old result after switching libraries`, async () => {
    const picked = deferred()
    const h = await harness()
    const defaultPicker = h.handlers[browser.picker]
    let first = true
    h.handlers[browser.picker] = (...args) => {
      if (first) { first = false; return picked.promise }
      return defaultPicker(...args)
    }
    await h.open()
    const browsing = h.el(browser.button).emit('click')
    await h.move()
    picked.resolve('old-path')
    await browsing
    assert.equal(h.calls.updateSettings, undefined)
    assert.equal(h.el(browser.input).value, newSettings[browser.key])
    assert.equal(h.el('setWatchEnabled').checked, false)
  })
}

test('a picker result received during library preparation is ignored', async () => {
  const picked = deferred()
  const preparing = deferred()
  const h = await harness({ pickFile: () => picked.promise, prepareLibraryChange: () => preparing.promise })
  await h.open()
  const browsing = h.el('btnBrowsePdfReader').emit('click')
  const moving = h.move()
  await tick()
  picked.resolve('old-path')
  await browsing
  assert.equal(h.calls.updateSettings, undefined)
  assert.equal(h.el('setPdfReader').value, '')
  preparing.resolve()
  await moving
})

test('path picker failures do not escape as unhandled event errors', async () => {
  for (const browser of browsers) {
    const h = await harness({ [browser.picker]: async () => { throw new Error('picker unavailable') } })
    await h.open()
    await assert.doesNotReject(h.el(browser.button).emit('click'))
    assert.equal(h.calls.updateSettings, undefined)
    assert.match(h.calls.toast[0][0], /picker unavailable/)
  }
})

test('a relocation choice from an old panel session cannot prepare the new library', async () => {
  const choosing = deferred()
  const h = await harness({ askChoice: () => choosing.promise })
  await h.open()
  const moving = h.move()
  await tick()
  h.setLibrary(library('new-library'))
  await h.open()
  choosing.resolve('move')
  await moving
  assert.equal(h.calls.prepareLibraryChange, undefined)
  assert.equal(h.calls.relocateLibrary, undefined)
  assert.deepEqual(h.events, [])
})

test('changing panel sessions during preparation cancels relocation', async () => {
  const preparing = deferred()
  const h = await harness({ prepareLibraryChange: () => preparing.promise })
  await h.open()
  const moving = h.move()
  await tick()
  h.setLibrary(library('new-library'))
  await h.open()
  preparing.resolve()
  await moving
  assert.equal(h.calls.relocateLibrary, undefined)
  assert.deepEqual(h.events.map(event => event.type), ['solace-library-change-cancelled'])
})
