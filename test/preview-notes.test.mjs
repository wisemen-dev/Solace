import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const JS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/renderer/js')
const tick = () => new Promise(resolve => setImmediate(resolve))
const doc = (id, sessionId = 'library-a') => ({ id, title: id, sessionId })
const note = file => ({ file, birth: '2026-09-01T00:00:00Z', mtime: '2026-09-01T00:00:00Z' })

function deferred () {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function element (id) {
  const listeners = new Map()
  const classes = new Set()
  return {
    id, hidden: false, value: '', textContent: '', innerHTML: '', style: {},
    clientWidth: 900, width: 0, height: 0, scrollTop: 0,
    classList: { toggle (name, on) { if (on) classes.add(name); else classes.delete(name) } },
    addEventListener (name, fn) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
    },
    emit (name, event = {}) {
      return Promise.all((listeners.get(name) || []).map(fn => fn({
        target: this, preventDefault () {}, stopPropagation () {}, ...event
      })))
    },
    getContext: () => ({ clearRect () {} }),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    select () {}, blur () {}
  }
}

function page (onRender = () => ({ promise: Promise.resolve(), cancel () {} })) {
  return {
    getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }),
    render: onRender
  }
}

function pdf (overrides = {}) {
  return {
    numPages: 10, destroyed: 0,
    getPage: async () => page(),
    getOutline: async () => null,
    getDestination: async () => [{ num: 1, gen: 0 }],
    getPageIndex: async () => 0,
    destroy () { this.destroyed++; return Promise.resolve() },
    ...overrides
  }
}

function loading (pdfDoc, promise = Promise.resolve(pdfDoc)) {
  return { promise, destroyed: 0, destroy () { this.destroyed++; return pdfDoc.destroy() } }
}

async function harness (overrides = {}) {
  assert.equal(typeof vm.SourceTextModule, 'function', 'Run with --experimental-vm-modules')
  const elements = new Map()
  const el = id => {
    if (!elements.has(id)) elements.set(id, element(id))
    return elements.get(id)
  }
  for (const id of ['previewOverlay', 'notesPanel', 'tocPanel', 'previewError']) el(id).hidden = true
  const calls = { read: [], progress: [], mark: [], list: [], create: [], open: [], trash: [], reveal: [], settings: [], toast: [], burst: [] }
  const handlers = {
    getDocument: () => loading(pdf()),
    readPreview: async () => new Uint8Array([1]),
    setProgress: async () => true,
    markRead: async () => true,
    listNotes: async () => ({ notes: [] }),
    createNote: async () => ({ file: 'new.md' }),
    openNote: async () => ({ opened: true }),
    trashNote: async () => true,
    revealNote: async () => true,
    getLibrary: async () => ({ settings: {} }),
    updateSettings: async () => ({}),
    askConfirm: async () => ({ ok: true }),
    askText: async () => '',
    ...overrides
  }
  const timers = new Map()
  let timerId = 0
  const solace = { getLibrary: (...args) => handlers.getLibrary(...args) }
  for (const [method, name] of Object.entries({
    readPreview: 'read', setProgress: 'progress', markRead: 'mark', listNotes: 'list',
    createNote: 'create', openNote: 'open', trashNote: 'trash', revealNote: 'reveal', updateSettings: 'settings'
  })) {
    solace[method] = (...args) => { calls[name].push(structuredClone(args)); return handlers[method](...args) }
  }
  const window = {
    solace, devicePixelRatio: 1, addEventListener () {},
    toast: (...args) => calls.toast.push(args)
  }
  const context = vm.createContext({
    window,
    document: { getElementById: el, querySelector: () => null },
    setTimeout (fn) { const id = ++timerId; timers.set(id, fn); return id },
    clearTimeout: id => timers.delete(id),
    Uint8Array, console
  })
  const modules = new Map()
  function synthetic (name, exports) {
    const mod = new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value)
    }, { context, identifier: name })
    modules.set(name, mod)
  }
  synthetic('pdfjs.js', { default: { getDocument: (...args) => handlers.getDocument(...args) }, docParams: {} })
  synthetic('confetti.js', { burst: (...args) => calls.burst.push(args) })
  synthetic('dialog.js', {
    askConfirm: (...args) => handlers.askConfirm(...args),
    askText: (...args) => handlers.askText(...args)
  })
  for (const name of ['util.js', 'pdfcanvas.js', 'notespanel.js', 'preview.js']) {
    modules.set(name, new vm.SourceTextModule(fs.readFileSync(path.join(JS_DIR, name), 'utf8'), {
      identifier: name, context
    }))
  }
  for (const mod of modules.values()) {
    if (mod.status === 'unlinked') await mod.link(spec => modules.get(path.basename(spec)))
  }
  await modules.get('preview.js').evaluate()
  return {
    el, calls, handlers, window,
    preview: modules.get('preview.js').namespace,
    notes: modules.get('notespanel.js').namespace,
    runTimers () {
      const pending = [...timers.values()]
      timers.clear()
      return Promise.all(pending.map(fn => fn()))
    },
    clickNote (file, remove = false) {
      const li = { dataset: { file }, classList: { toggle () {} } }
      return el('notesList').emit('click', { target: {
        closest: selector => selector === 'li[data-file]' ? li : remove ? {} : null
      } })
    }
  }
}

test('same-book reopen ignores the first pending file read', async () => {
  const oldRead = deferred()
  let reads = 0
  let loads = 0
  const h = await harness({
    readPreview: () => ++reads === 1 ? oldRead.promise : Promise.resolve(new Uint8Array([2])),
    getDocument: () => { loads++; return loading(pdf()) }
  })
  h.preview.openPreview(doc('a'))
  await h.preview.closePreview()
  h.preview.openPreview(doc('a'), 3)
  await tick()
  oldRead.resolve(new Uint8Array([1]))
  await tick()
  assert.equal(loads, 1)
  assert.equal(h.el('pageJump').value, 3)
  assert.equal(h.el('previewOverlay').hidden, false)
  assert.deepEqual(h.calls.read, [['a', 'library-a'], ['a', 'library-a']])
  await h.preview.closePreview()
})

test('a superseded PDF load is destroyed and cannot replace the reopened book', async () => {
  const oldLoad = deferred()
  const oldPdf = pdf({ numPages: 99 })
  const oldTask = loading(oldPdf, oldLoad.promise)
  let loads = 0
  const h = await harness({ getDocument: () => ++loads === 1 ? oldTask : loading(pdf({ numPages: 10 })) })
  h.preview.openPreview(doc('a'))
  await tick()
  await h.preview.closePreview()
  h.preview.openPreview(doc('a'), 4)
  await tick()
  oldLoad.resolve(oldPdf)
  await tick()
  assert.equal(oldTask.destroyed, 1)
  assert.ok(oldPdf.destroyed >= 1)
  assert.equal(h.el('pageTotal').textContent, 10)
  assert.equal(h.el('pageJump').value, 4)
  await h.preview.closePreview()
})

test('a superseded load error does not close the reopened book', async () => {
  const oldLoad = deferred()
  let loads = 0
  const h = await harness({ getDocument: () => ++loads === 1 ? loading(pdf(), oldLoad.promise) : loading(pdf()) })
  h.preview.openPreview(doc('a'))
  await tick()
  await h.preview.closePreview()
  h.preview.openPreview(doc('a'))
  await tick()
  oldLoad.reject(new Error('old load failed'))
  await tick()
  assert.equal(h.window.currentPreviewId, 'a')
  assert.equal(h.el('previewOverlay').hidden, false)
  assert.equal(h.calls.toast.length, 0)
  await h.preview.closePreview()
})

test('an old getPage completion cannot unlock a new render or draw old pixels', async () => {
  const oldPage = deferred()
  const newRender = deferred()
  let oldDraws = 0
  let newDraws = 0
  let loads = 0
  const oldPdf = pdf({ getPage: () => oldPage.promise })
  const newPdf = pdf({ getPage: async () => page(() => {
    newDraws++
    return { promise: newDraws === 1 ? newRender.promise : Promise.resolve(), cancel () {} }
  }) })
  const h = await harness({ getDocument: () => loading(++loads === 1 ? oldPdf : newPdf) })
  h.preview.openPreview(doc('a'))
  await tick()
  h.preview.openPreview(doc('b'))
  await tick()
  assert.equal(newDraws, 1, 'The new book must not wait for the old getPage')
  oldPage.resolve(page(() => { oldDraws++; return { promise: Promise.resolve() } }))
  await tick()
  await h.el('btnNextPage').emit('click')
  await tick()
  assert.equal(oldDraws, 0)
  assert.equal(newDraws, 1, 'Only one render may own the canvas')
  newRender.resolve()
  await tick()
  assert.equal(newDraws, 2, 'The pending new page must render after the current page')
  assert.equal(oldPdf.destroyed, 1)
  await h.preview.closePreview()
})

test('closing cancels the render task and destroys the loaded document', async () => {
  const rendering = deferred()
  let cancelled = 0
  const pdfDoc = pdf({ getPage: async () => page(() => ({
    promise: rendering.promise,
    cancel () { cancelled++; rendering.reject(new Error('render cancelled')) }
  })) })
  const h = await harness({ getDocument: () => loading(pdfDoc) })
  h.preview.openPreview(doc('a'))
  await tick()
  await h.preview.closePreview()
  await tick()
  assert.equal(cancelled, 1)
  assert.equal(pdfDoc.destroyed, 1)
  assert.equal(h.el('previewError').hidden, true)
  assert.equal(h.calls.toast.length, 0)
})

test('a new book waits for the previous canvas render to finish cancelling', async () => {
  const oldRender = deferred()
  let cancelled = 0
  let loads = 0
  const newPages = []
  const oldPdf = pdf({ getPage: async () => page(() => ({
    promise: oldRender.promise,
    cancel () { cancelled++ }
  })) })
  const newPdf = pdf({ getPage: async number => page(() => {
    newPages.push(number)
    return { promise: Promise.resolve(), cancel () {} }
  }) })
  const h = await harness({ getDocument: () => loading(++loads === 1 ? oldPdf : newPdf) })
  h.preview.openPreview(doc('a'))
  await tick()
  h.preview.openPreview(doc('b'))
  await tick()
  await h.el('btnNextPage').emit('click')
  await tick()
  assert.equal(cancelled, 1)
  assert.deepEqual(newPages, [], 'The previous render must release the canvas first')
  oldRender.reject(new Error('render cancelled'))
  await tick()
  assert.deepEqual(newPages, [1, 2], 'The queued new page remains scheduled after cancellation')
  assert.equal(h.el('pageJump').value, 2)
  assert.equal(h.el('previewError').hidden, true)
  await h.preview.closePreview()
})

test('switching books disables page actions until the new PDF is loaded', async () => {
  const newRead = deferred()
  let reads = 0
  const h = await harness({ readPreview: () => ++reads === 1 ? Promise.resolve(new Uint8Array([1])) : newRead.promise })
  h.preview.openPreview(doc('a'))
  await tick()
  h.preview.openPreview(doc('b', 'library-b'))
  await h.el('btnNextPage').emit('click')
  await tick()
  assert.equal(h.calls.mark.length, 0)
  assert.equal(h.el('pageTotal').textContent, '0')
  newRead.resolve(new Uint8Array([2]))
  await tick()
  await h.preview.closePreview()
  assert.deepEqual(h.calls.progress.map(args => [args[0], args[1], args[3]]), [
    ['a', 1, 'library-a'], ['b', 1, 'library-b']
  ])
})

test('close waits for an in-flight progress write and the queued final page', async () => {
  const writes = [deferred(), deferred()]
  let n = 0
  const h = await harness({ setProgress: () => writes[n++].promise })
  h.preview.openPreview(doc('a'))
  await tick()
  const firstWrite = h.runTimers()
  await tick()
  await h.el('btnNextPage').emit('click')
  let closed = false
  const closing = h.preview.closePreview().then(() => { closed = true })
  await tick()
  assert.equal(closed, false)
  assert.equal(h.calls.progress.length, 1)
  writes[0].resolve()
  await tick()
  assert.equal(h.calls.progress.length, 2)
  assert.equal(closed, false)
  writes[1].resolve()
  await Promise.all([firstWrite, closing])
  assert.deepEqual(h.calls.progress, [
    ['a', 1, 10, 'library-a'], ['a', 2, 10, 'library-a']
  ])
})

test('close also waits when a timer already consumed the final progress', async () => {
  const writing = deferred()
  const h = await harness({ setProgress: () => writing.promise })
  h.preview.openPreview(doc('a'))
  await tick()
  const timed = h.runTimers()
  await tick()
  let closed = false
  const closing = h.preview.closePreview().then(() => { closed = true })
  await tick()
  assert.equal(closed, false)
  writing.resolve()
  await Promise.all([timed, closing])
  assert.equal(h.calls.progress.length, 1)
})

test('close reports a failed progress save and retries the captured page', async () => {
  let writes = 0
  const h = await harness({ setProgress: async () => {
    if (++writes === 1) throw new Error('disk full')
  } })
  h.preview.openPreview(doc('a'))
  await tick()
  await h.el('btnNextPage').emit('click')
  await assert.rejects(h.preview.closePreview(), /disk full/)
  await h.preview.closePreview()
  assert.deepEqual(h.calls.progress, [
    ['a', 2, 10, 'library-a'], ['a', 2, 10, 'library-a']
  ])
})

test('a timer save failure is handled and remains retryable when closing', async () => {
  let writes = 0
  const h = await harness({ setProgress: async () => {
    if (++writes === 1) throw new Error('disk full')
  } })
  h.preview.openPreview(doc('a'))
  await tick()
  await h.runTimers()
  assert.equal(h.calls.toast.length, 1)
  await h.preview.closePreview()
  assert.equal(h.calls.progress.length, 2)
})

test('outline resolution stops after a book switch', async () => {
  const destination = deferred()
  let oldIndexes = 0
  let loads = 0
  const oldPdf = pdf({
    getOutline: async () => [{ title: 'Old chapter', dest: 'old' }],
    getDestination: () => destination.promise,
    getPageIndex: async () => { oldIndexes++; return 0 }
  })
  const newPdf = pdf({ getOutline: async () => [{ title: 'New chapter', dest: [{ num: 2, gen: 0 }] }] })
  const h = await harness({ getDocument: () => loading(++loads === 1 ? oldPdf : newPdf) })
  h.preview.openPreview(doc('a'))
  await tick()
  h.preview.openPreview(doc('b'))
  await tick()
  destination.resolve([{ num: 1, gen: 0 }])
  await tick()
  assert.equal(oldIndexes, 0)
  assert.match(h.el('tocList').innerHTML, /New chapter/)
  assert.doesNotMatch(h.el('tocList').innerHTML, /Old chapter/)
  await h.preview.closePreview()
})

test('reopening the same notes panel discards the earlier listing', async () => {
  const oldList = deferred()
  let lists = 0
  const h = await harness({ listNotes: () => ++lists === 1 ? oldList.promise : Promise.resolve({ notes: [note('new.md')] }) })
  h.notes.openNotes(doc('a'), () => ({}))
  h.notes.closeNotes()
  h.notes.openNotes(doc('a'), () => ({}))
  await tick()
  oldList.resolve({ notes: [note('old.md')] })
  await tick()
  assert.match(h.el('notesList').innerHTML, /new\.md/)
  assert.doesNotMatch(h.el('notesList').innerHTML, /old\.md/)
})

test('only the newest listing updates the current notes panel', async () => {
  const oldList = deferred()
  let lists = 0
  const h = await harness({ listNotes: () => ++lists === 1 ? oldList.promise : Promise.resolve({ notes: [note('latest.md')] }) })
  h.notes.openNotes(doc('a'), () => ({}))
  await h.el('btnNoteBatch').emit('click')
  await tick()
  oldList.resolve({ notes: [note('old.md')] })
  await tick()
  assert.match(h.el('notesList').innerHTML, /latest\.md/)
  assert.doesNotMatch(h.el('notesList').innerHTML, /old\.md/)
})

test('a delete confirmation cannot delete from a later notes session', async () => {
  const confirmation = deferred()
  const h = await harness({ askConfirm: () => confirmation.promise })
  h.notes.openNotes(doc('a'), () => ({}))
  const deleting = h.clickNote('shared.md', true)
  h.notes.closeNotes()
  h.notes.openNotes(doc('a'), () => ({}))
  confirmation.resolve({ ok: true })
  await deleting
  assert.equal(h.calls.trash.length, 0)
})

test('batch delete uses the confirmed file snapshot', async () => {
  const first = deferred()
  let deletes = 0
  const h = await harness({ trashNote: () => ++deletes === 1 ? first.promise : Promise.resolve() })
  h.notes.openNotes(doc('a'), () => ({}))
  await h.el('btnNoteBatch').emit('click')
  await h.clickNote('one.md')
  await h.clickNote('two.md')
  const deleting = h.el('btnNoteDel').emit('click')
  await tick()
  await h.clickNote('later.md')
  first.resolve()
  await deleting
  assert.deepEqual(h.calls.trash, [['a', 'one.md', 'library-a'], ['a', 'two.md', 'library-a']])
  assert.match(h.el('btnNoteDel').textContent, /1/)
})

test('batch deletion stops after switching books while a deletion is in flight', async () => {
  const first = deferred()
  const h = await harness({ trashNote: () => first.promise })
  h.notes.openNotes(doc('a'), () => ({}))
  await h.el('btnNoteBatch').emit('click')
  await h.clickNote('one.md')
  await h.clickNote('two.md')
  const deleting = h.el('btnNoteDel').emit('click')
  await tick()
  h.notes.openNotes(doc('b', 'library-b'), () => ({}))
  first.resolve()
  await deleting
  assert.deepEqual(h.calls.trash, [['a', 'one.md', 'library-a']])
  assert.equal(h.calls.toast.length, 0)
})

test('a late create result cannot open its file under the next book', async () => {
  const created = deferred()
  const h = await harness({ createNote: () => created.promise })
  h.notes.openNotes(doc('a'), () => ({ page: 4, total: 10 }))
  const creating = h.el('btnNoteNew').emit('click')
  h.notes.openNotes(doc('b', 'library-b'), () => ({ page: 1, total: 20 }))
  created.resolve({ file: 'new.md' })
  await creating
  assert.deepEqual(h.calls.create, [['a', { title: 'a', page: 4, total: 10 }, 'library-a']])
  assert.equal(h.calls.open.length, 0)
})

test('an editor prompt from an earlier panel cannot save settings or retry opening', async () => {
  const editor = deferred()
  const h = await harness({ openNote: async () => ({ needEditor: true }), askText: () => editor.promise })
  h.notes.openNotes(doc('a'), () => ({}))
  const opening = h.clickNote('one.md')
  await tick()
  h.notes.openNotes(doc('b', 'library-b'), () => ({}))
  editor.resolve('C:/Editor/editor.exe')
  await opening
  assert.equal(h.calls.settings.length, 0)
  assert.equal(h.calls.open.length, 1)
  assert.deepEqual(h.calls.open[0], ['a', 'one.md', {}, 'library-a'])
})

test('cancelling the editor prompt does not launch the default application', async () => {
  const h = await harness({ openNote: async () => ({ needEditor: true }), askText: async () => null })
  h.notes.openNotes(doc('a'), () => ({}))
  await h.clickNote('one.md')
  assert.equal(h.calls.open.length, 1)
  assert.equal(h.calls.settings.length, 0)
})

test('changing panels while editor settings save prevents the retry', async () => {
  const saving = deferred()
  const h = await harness({
    openNote: async () => ({ needEditor: true }), askText: async () => 'C:/Editor/editor.exe',
    updateSettings: () => saving.promise
  })
  h.notes.openNotes(doc('a'), () => ({}))
  const opening = h.clickNote('one.md')
  await tick()
  h.notes.openNotes(doc('b', 'library-b'), () => ({}))
  saving.resolve({})
  await opening
  assert.equal(h.calls.open.length, 1)
  assert.deepEqual(h.calls.settings, [[{ notesEditorPath: 'C:/Editor/editor.exe' }, 'library-a']])
})

test('a pending reveal request cannot reveal the next book with the old file name', async () => {
  const listing = deferred()
  let lists = 0
  const h = await harness({ listNotes: () => ++lists === 2 ? listing.promise : Promise.resolve({ notes: [] }) })
  h.notes.openNotes(doc('a'), () => ({}))
  await tick()
  const revealing = h.el('btnNoteReveal').emit('click')
  h.notes.openNotes(doc('b', 'library-b'), () => ({}))
  listing.resolve({ notes: [note('old.md')] })
  await revealing
  assert.equal(h.calls.reveal.length, 0)
})
