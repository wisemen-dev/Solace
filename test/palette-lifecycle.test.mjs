import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const JS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/renderer/js')
const settle = () => new Promise(resolve => setImmediate(resolve))

function deferred () {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function snapshot (sessionId = 'library-a', title = 'Current book') {
  return {
    sessionId,
    documents: [{ id: 'book', title, fileName: 'book.pdf', tagIds: [], sessionId }],
    categories: [],
    tags: [],
    history: [{ docId: 'book' }]
  }
}

function eventTarget () {
  const listeners = new Map()
  return {
    addEventListener (type, handler) {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push(handler)
    },
    dispatchEvent (event) {
      for (const handler of listeners.get(event.type) || []) handler(event)
      return true
    },
    emit (type, event = {}) {
      return Promise.all((listeners.get(type) || []).map(handler => handler({
        type, target: this, preventDefault () {}, ...event
      })))
    }
  }
}

function element () {
  let html = ''
  return {
    ...eventTarget(),
    value: '', open: false, shown: 0, writes: 0,
    get innerHTML () { return html },
    set innerHTML (value) { html = value; this.writes++ },
    querySelector: () => null,
    focus () {},
    showModal () { this.open = true; this.shown++ },
    close () {
      if (!this.open) return
      this.open = false
      this.dispatchEvent({ type: 'close', target: this })
    }
  }
}

async function harness (overrides = {}) {
  assert.equal(typeof vm.SourceTextModule, 'function', 'Run with --experimental-vm-modules')
  const elements = new Map()
  const el = id => {
    if (!elements.has(id)) elements.set(id, element())
    return elements.get(id)
  }
  const calls = { getLibrary: 0, search: [], preview: [] }
  const handlers = {
    getLibrary: async () => snapshot(),
    searchTextIndex: async kw => kw === 'main' ? { book: 7 } : { book: 2 },
    ...overrides
  }
  const timers = new Map()
  let nextTimer = 0
  const window = {
    ...eventTarget(),
    libraryChanging: false,
    solace: {
      getLibrary () { calls.getLibrary++; return handlers.getLibrary() },
      getTextIndexStatus: async () => ({}),
      searchTextIndex (...args) { calls.search.push(args); return handlers.searchTextIndex(...args) }
    }
  }
  class CustomEvent {
    constructor (type, options = {}) { this.type = type; this.detail = options.detail }
  }
  const context = vm.createContext({
    window,
    document: { getElementById: el },
    CustomEvent,
    setTimeout (fn) { const id = ++nextTimer; timers.set(id, fn); return id },
    clearTimeout: id => timers.delete(id),
    console
  })
  const modules = new Map()
  function synthetic (name, exports) {
    modules.set(name, new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value)
    }, { context, identifier: name }))
  }
  synthetic('preview.js', { openPreview: (...args) => calls.preview.push(args) })
  synthetic('pdfjs.js', { default: {}, docParams: {} })
  for (const name of ['util.js', 'textindex.js', 'palette.js']) {
    modules.set(name, new vm.SourceTextModule(fs.readFileSync(path.join(JS_DIR, name), 'utf8'), {
      context, identifier: name
    }))
  }
  await modules.get('palette.js').link(spec => modules.get(path.basename(spec)))
  await modules.get('palette.js').evaluate()
  const index = modules.get('textindex.js').namespace
  await index.initIndex([], 'library-a')
  return {
    el, window, calls, handlers, index,
    open: () => el('btnPalette').emit('click'),
    type (value) { el('paletteInput').value = value; return el('paletteInput').emit('input') },
    change (type) { window.dispatchEvent(new CustomEvent(type)) },
    pendingTimers: () => timers.size,
    runTimers () {
      const pending = [...timers.values()]
      timers.clear()
      return Promise.all(pending.map(fn => fn()))
    }
  }
}

test('a library snapshot returned after a complete switch cannot open the old palette', async () => {
  const oldLibrary = deferred()
  const h = await harness({ getLibrary: () => oldLibrary.promise })
  const opening = h.open()
  h.window.libraryChanging = true
  h.change('solace-library-changing')
  h.window.libraryChanging = false
  h.change('solace-library-moved')
  oldLibrary.resolve(snapshot('old', 'Old book'))
  await opening

  assert.equal(h.el('paletteDialog').open, false)
  assert.equal(h.el('paletteDialog').shown, 0)
  assert.equal(h.el('paletteList').innerHTML, '')
})

test('an old pending open cannot replace a palette reopened for the new library', async () => {
  const oldLibrary = deferred()
  let reads = 0
  const h = await harness({ getLibrary: () => ++reads === 1 ? oldLibrary.promise : Promise.resolve(snapshot('new', 'New book')) })
  const opening = h.open()
  h.change('solace-library-moved')
  await h.index.initIndex([], 'new')
  await h.open()
  const currentHtml = h.el('paletteList').innerHTML
  assert.match(currentHtml, /New book/)

  oldLibrary.resolve(snapshot('old', 'Old book'))
  await opening
  assert.equal(h.el('paletteDialog').shown, 1)
  assert.equal(h.el('paletteList').innerHTML, currentHtml)
})

test('closing the palette cancels a pending debounce before restoring the main search', async () => {
  const h = await harness()
  h.window.addEventListener('solace-palette-closed', () => h.index.searchTextIndex('main', 'library-a'))
  await h.open()
  await h.type('needle')
  assert.equal(h.pendingTimers(), 1)
  h.el('paletteDialog').close()
  assert.equal(h.pendingTimers(), 0)
  await h.runTimers()
  await settle()

  assert.deepEqual(h.calls.search, [['main', 'library-a']])
  assert.equal(h.index.textHit('book', 'main'), 7)
})

test('closing the palette invalidates an in-flight query without a replacement search', async () => {
  const oldSearch = deferred()
  const h = await harness({ searchTextIndex: () => oldSearch.promise })
  await h.open()
  await h.type('needle')
  const searching = h.runTimers()
  assert.equal(h.calls.search.length, 1)
  h.el('paletteDialog').close()
  const writes = h.el('paletteList').writes
  oldSearch.resolve({ book: 2 })
  await searching

  assert.equal(h.index.textHit('book', 'needle'), 0)
  assert.equal(h.el('paletteList').writes, writes)
})

test('palette queries use the session of their captured library snapshot', async () => {
  const h = await harness()
  await h.open()
  await h.index.initIndex([], 'another-library')
  await h.type('needle')
  await h.runTimers()

  assert.deepEqual(h.calls.search, [['needle', 'library-a']])
  assert.match(h.el('paletteList').innerHTML, /Current book/)
})

for (const event of ['solace-library-changing', 'solace-library-moved']) {
  test(`${event} closes the palette and cancels its queued search`, async () => {
    const h = await harness()
    await h.open()
    await h.type('needle')
    h.window.libraryChanging = event === 'solace-library-changing'
    h.change(event)
    assert.equal(h.el('paletteDialog').open, false)
    assert.equal(h.pendingTimers(), 0)
    await h.runTimers()
    assert.deepEqual(h.calls.search, [])
  })
}
