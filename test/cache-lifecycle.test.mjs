import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const JS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/renderer/js')
const settle = () => new Promise(resolve => setImmediate(resolve))

function deferred () {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function fakePdf (options = {}) {
  const stats = { destroyed: 0, loadingDestroyed: 0, cancelled: 0, pages: [], textReads: 0, cleaned: 0, renders: [] }
  const page = {
    getViewport: ({ scale }) => ({ width: (options.width ?? 600) * scale, height: (options.height ?? 800) * scale }),
    render ({ canvasContext, viewport }) {
      stats.renders.push({ width: canvasContext.canvas.width, height: canvasContext.canvas.height, viewport })
      return { promise: options.render?.promise || Promise.resolve(), cancel () { stats.cancelled++ } }
    },
    getTextContent () {
      stats.textReads++
      return options.text?.promise || Promise.resolve({ items: [{ str: 'Current Text' }] })
    },
    cleanup () { stats.cleaned++ }
  }
  const pdf = {
    numPages: options.numPages ?? 1,
    getPage (n) { stats.pages.push(n); return options.page?.promise || Promise.resolve(page) },
    destroy () { stats.destroyed++; return Promise.resolve() }
  }
  const loading = {
    promise: options.loading?.promise || Promise.resolve(pdf),
    destroy () { stats.loadingDestroyed++; return Promise.resolve() }
  }
  return { loading, pdf, page, stats }
}

async function harness (overrides = {}) {
  assert.equal(typeof vm.SourceTextModule, 'function', 'Run with node --experimental-vm-modules --test test/cache-lifecycle.test.mjs')
  const calls = { getCover: [], setCover: [], readPreview: [], getTextIndexStatus: [], setTextIndex: [], searchTextIndex: [] }
  const defaults = {
    getCover: async () => null,
    setCover: async () => true,
    readPreview: async () => new Uint8Array([1]),
    getTextIndexStatus: async () => ({}),
    setTextIndex: async () => true,
    searchTextIndex: async () => ({})
  }
  const api = { ...defaults, ...overrides }
  const solace = Object.fromEntries(Object.keys(defaults).map(name => [name, (...args) => {
    calls[name].push(args)
    return api[name](...args)
  }]))
  const images = new Map()
  const events = []
  const pdfs = []
  const loaded = []
  let canvasId = 0
  const document = {
    querySelectorAll (selector) {
      const id = selector.match(/data-doc-id="([^"]+)"/)[1]
      return images.has(id) ? [images.get(id)] : []
    },
    createElement () {
      const id = ++canvasId
      return {
        width: 0, height: 0,
        getContext () { return { canvas: this } },
        toDataURL () { return `data:image/jpeg;base64,${id}` }
      }
    }
  }
  class CustomEvent {
    constructor (type, options) { this.type = type; this.detail = options.detail }
  }
  const window = { solace, devicePixelRatio: 2, dispatchEvent (event) { events.push(event) } }
  const context = vm.createContext({ window, document, CustomEvent, Uint8Array, console })
  const pdfStub = new vm.SyntheticModule(['default', 'docParams'], function () {
    this.setExport('default', {
      getDocument () {
        const item = pdfs.shift() || fakePdf()
        loaded.push(item)
        return item.loading
      }
    })
    this.setExport('docParams', {})
  }, { context })
  const modules = new Map([['pdfjs.js', pdfStub]])
  async function load (file) {
    if (modules.has(file)) return modules.get(file)
    const mod = new vm.SourceTextModule(fs.readFileSync(path.join(JS_DIR, file), 'utf8'), { context, identifier: file })
    modules.set(file, mod)
    await mod.link(spec => load(path.basename(spec)))
    return mod
  }
  const covers = await load('covers.js')
  const index = await load('textindex.js')
  const canvas = await load('pdfcanvas.js')
  await covers.evaluate()
  await index.evaluate()
  return {
    covers: covers.namespace, index: index.namespace, canvas: canvas.namespace,
    api, calls, events, pdfs, loaded,
    image (id) { if (!images.has(id)) images.set(id, { src: '' }); return images.get(id) }
  }
}

test('cover reset isolates a late stored-cover read and preserves the new in-flight task', async () => {
  const oldRead = deferred()
  const newRead = deferred()
  const h = await harness({ getCover: (id, session) => session === 'old' ? oldRead.promise : newRead.promise })
  const doc = { id: 'same', hasCover: true }
  const image = h.image(doc.id)
  h.covers.ensureCover(doc, image, 'old')
  h.covers.clearCoverCache()
  h.covers.ensureCover(doc, image, 'new')
  oldRead.resolve('old-cover')
  await settle()
  assert.equal(h.covers.coverCache().size, 0)
  assert.equal(image.src, '')
  h.covers.ensureCover(doc, image, 'new')
  assert.equal(h.calls.getCover.length, 2)
  newRead.resolve('new-cover')
  await settle()
  assert.equal(h.covers.coverCache().get(doc.id), 'new-cover')
  assert.equal(image.src, 'new-cover')
  assert.deepEqual(h.calls.getCover.map(args => args[1]), ['old', 'new'])
})

test('cover reset drops the old queue and starts the new library before old reads settle', async () => {
  const oldRead = deferred()
  const h = await harness({ readPreview: (id, session) => session === 'old' ? oldRead.promise : Promise.resolve(new Uint8Array([2])) })
  h.covers.ensureCover({ id: 'same' }, h.image('same'), 'old')
  h.covers.ensureCover({ id: 'old-queued' }, h.image('old-queued'), 'old')
  h.covers.clearCoverCache()
  h.covers.ensureCover({ id: 'same' }, h.image('same'), 'new')
  await settle()
  assert.equal(h.calls.setCover.length, 1)
  assert.equal(h.calls.setCover[0][2], 'new')
  oldRead.resolve(new Uint8Array([1]))
  await settle()
  assert.equal(h.loaded.length, 1)
  assert.deepEqual(h.calls.readPreview.map(args => args[0]), ['same', 'same'])
  assert.equal(h.calls.setCover.length, 1)
})

test('cover reset cancels rendering and suppresses late render output', async () => {
  const render = deferred()
  const oldPdf = fakePdf({ render })
  const h = await harness()
  h.pdfs.push(oldPdf)
  h.covers.ensureCover({ id: 'same' }, h.image('same'), 'old')
  await settle()
  assert.equal(oldPdf.stats.renders.length, 1)
  h.covers.clearCoverCache()
  assert.equal(oldPdf.stats.cancelled, 1)
  assert.equal(oldPdf.stats.destroyed, 1)
  h.covers.ensureCover({ id: 'same' }, h.image('same'), 'new')
  await settle()
  const newCover = h.covers.coverCache().get('same')
  assert.ok(newCover)
  render.resolve()
  await settle()
  assert.equal(h.calls.setCover.length, 1)
  assert.equal(h.covers.coverCache().get('same'), newCover)
  assert.equal(h.image('same').src, newCover)
})

test('late cover persistence cannot repopulate a reset cache', async () => {
  const write = deferred()
  const h = await harness({ setCover: (id, data, session) => session === 'old' ? write.promise : Promise.resolve(true) })
  h.covers.ensureCover({ id: 'same' }, h.image('same'), 'old')
  await settle()
  assert.equal(h.calls.setCover.length, 1)
  h.covers.clearCoverCache()
  write.resolve(true)
  await settle()
  assert.equal(h.covers.coverCache().size, 0)
  h.covers.ensureCover({ id: 'same' }, h.image('same'), 'new')
  await settle()
  assert.deepEqual(h.calls.setCover.map(args => args[2]), ['old', 'new'])
  assert.equal(h.image('same').src, h.calls.setCover[1][1])
})

test('missing stored covers remain deduplicated while regeneration runs', async () => {
  const read = deferred()
  const h = await harness({ readPreview: () => read.promise })
  const doc = { id: 'same', hasCover: true }
  h.covers.ensureCover(doc, h.image('same'), 'current')
  await settle()
  h.covers.ensureCover(doc, h.image('same'), 'current')
  assert.equal(h.calls.getCover.length, 1)
  assert.equal(h.calls.readPreview.length, 1)
  read.resolve(new Uint8Array([1]))
  await settle()
  assert.equal(h.calls.setCover.length, 1)
})

test('canvas bounds hold for tall, wide, square, and enormous pages', async () => {
  const h = await harness()
  for (const [width, height] of [[1, 1e12], [1e12, 1], [1e8, 1e8], [1e300, 1e300], [600, 800]]) {
    const item = fakePdf({ width, height })
    const result = h.canvas.fitPageViewport(item.page, 4)
    assert.ok(result.width >= 1 && result.width <= 8192)
    assert.ok(result.height >= 1 && result.height <= 8192)
    assert.ok(result.width * result.height <= 16 * 1024 * 1024)
    assert.ok(result.viewport.width <= 8192 + 1e-8)
    assert.ok(result.viewport.height <= 8192 + 1e-8)
  }
  const tall = fakePdf({ width: 1, height: 1e12 })
  h.pdfs.push(tall)
  h.covers.ensureCover({ id: 'tall' }, h.image('tall'), 'current')
  await settle()
  assert.equal(h.calls.setCover.length, 1)
  assert.ok(tall.stats.renders[0].height <= 8192)
  assert.ok(tall.stats.renders[0].width >= 1)
  assert.throws(() => h.canvas.fitPageViewport(fakePdf({ width: 0 }).page, 1), /Invalid PDF/)
})

test('index reset discards late initialization and clears prior status', async () => {
  const status = deferred()
  const h = await harness({ getTextIndexStatus: session => session === 'old' ? status.promise : Promise.resolve({}) })
  const oldInit = h.index.initIndex([{ id: 'old-only' }], 'old')
  h.index.resetIndex()
  await h.index.initIndex([], 'new')
  status.resolve({ same: { ver: 2, failed: true } })
  await oldInit
  h.index.ensureQueued('same')
  await settle()
  assert.deepEqual(h.calls.readPreview.map(args => [args[0], args[1]]), [['same', 'new']])
  assert.equal(h.calls.setTextIndex[0][2], 'new')
  assert.equal(h.calls.setTextIndex[0][1].pages[0], 'currenttext')
})

test('index reset invalidates late search success and failure', async () => {
  for (const fail of [false, true]) {
    const search = deferred()
    const h = await harness({ searchTextIndex: (kw, session) => session === 'old' ? search.promise : Promise.resolve({ same: 7 }) })
    await h.index.initIndex([], 'old')
    const oldSearch = h.index.searchTextIndex(' Word ')
    h.index.resetIndex()
    assert.equal(h.index.textHit('same', 'word'), 0)
    await h.index.initIndex([], 'new')
    await h.index.searchTextIndex('Word')
    if (fail) search.reject(new Error('late failure'))
    else search.resolve({ same: 2 })
    await oldSearch
    assert.equal(h.index.textHit('same', 'word'), 7)
    assert.deepEqual(h.calls.searchTextIndex.map(args => [args[0], args[1]]), [['word', 'old'], ['word', 'new']])
  }
})

test('index reset restarts immediately and never persists a stale read failure', async () => {
  const oldRead = deferred()
  const newRead = deferred()
  const h = await harness({ readPreview: (id, session) => session === 'old' ? oldRead.promise : newRead.promise })
  await h.index.initIndex([{ id: 'same' }, { id: 'old-queued' }], 'old')
  h.index.resetIndex()
  await h.index.initIndex([{ id: 'same' }], 'new')
  assert.deepEqual(h.calls.readPreview.map(args => args[1]), ['old', 'new'])
  oldRead.reject(new Error('old file removed'))
  await settle()
  h.index.ensureQueued('same', 'new')
  assert.equal(h.calls.readPreview.length, 2)
  assert.equal(h.calls.setTextIndex.length, 0)
  newRead.resolve(new Uint8Array([2]))
  await settle()
  assert.equal(h.calls.setTextIndex.length, 1)
  assert.equal(h.calls.setTextIndex[0][2], 'new')
  assert.equal(h.calls.setTextIndex[0][1].failed, undefined)
  assert.equal(h.events.filter(event => event.type === 'solace-index-doc').length, 1)
})

test('reset destroys loading PDFs and discards documents that load after cancellation', async () => {
  for (const kind of ['covers', 'index']) {
    const loading = deferred()
    const item = fakePdf({ loading })
    const h = await harness()
    h.pdfs.push(item)
    if (kind === 'covers') h.covers.ensureCover({ id: 'old' }, h.image('old'), 'old')
    else await h.index.initIndex([{ id: 'old' }], 'old')
    await settle()
    if (kind === 'covers') h.covers.clearCoverCache()
    else h.index.resetIndex()
    assert.equal(item.stats.loadingDestroyed, 1)
    loading.resolve(item.pdf)
    await settle()
    assert.equal(item.stats.destroyed, 1)
    assert.equal(item.stats.pages.length, 0)
    assert.equal(h.calls.setCover.length + h.calls.setTextIndex.length, 0)
  }
})

test('index reset suppresses stale page and text callbacks', async () => {
  for (const stage of ['page', 'text']) {
    const waiting = deferred()
    const item = fakePdf({ [stage]: waiting })
    const h = await harness()
    h.pdfs.push(item)
    await h.index.initIndex([{ id: 'same' }], 'old')
    await settle()
    h.index.resetIndex()
    assert.equal(item.stats.destroyed, 1)
    if (stage === 'page') waiting.resolve(item.page)
    else waiting.reject(new Error('old text task cancelled'))
    await settle()
    assert.equal(h.calls.setTextIndex.length, 0)
    if (stage === 'page') assert.equal(item.stats.textReads, 0)
    h.index.ensureQueued('same', 'new')
    await settle()
    assert.equal(h.calls.setTextIndex.length, 1)
    assert.equal(h.calls.setTextIndex[0][2], 'new')
  }
})

test('late index persistence cannot restore old status or write a failure into the new library', async () => {
  for (const fail of [false, true]) {
    const write = deferred()
    const h = await harness({ setTextIndex: (id, payload, session) => session === 'old' ? write.promise : Promise.resolve(true) })
    await h.index.initIndex([{ id: 'same' }], 'old')
    await settle()
    assert.equal(h.calls.setTextIndex.length, 1)
    h.index.resetIndex()
    if (fail) write.reject(new Error('old library no longer active'))
    else write.resolve(true)
    await settle()
    h.index.ensureQueued('same', 'new')
    await settle()
    assert.deepEqual(h.calls.setTextIndex.map(args => args[2]), ['old', 'new'])
    assert.ok(h.calls.setTextIndex.every(args => !args[1].failed))
    assert.equal(h.events.filter(event => event.type === 'solace-index-doc').length, 1)
  }
})

test('index reset restores the default page limit for a new library', async () => {
  const h = await harness()
  h.index.setIndexPageLimit(1)
  h.index.resetIndex()
  const item = fakePdf({ numPages: 2 })
  h.pdfs.push(item)
  await h.index.initIndex([{ id: 'new' }], 'new')
  await settle()
  assert.deepEqual(item.stats.pages, [1, 2])
  assert.equal(h.calls.setTextIndex[0][1].pages.length, 2)
})

test('a stale import callback cannot enqueue index work for the current library', async () => {
  const h = await harness()
  await h.index.initIndex([], 'new')
  h.index.ensureQueued('same', 'old')
  await settle()
  assert.equal(h.calls.readPreview.length, 0)
  assert.equal(h.calls.setTextIndex.length, 0)
  h.index.ensureQueued('same', 'new')
  await settle()
  assert.deepEqual(h.calls.readPreview.map(args => [args[0], args[1]]), [['same', 'new']])
  assert.equal(h.calls.setTextIndex.length, 1)
  assert.equal(h.calls.setTextIndex[0][1].failed, undefined)
})
