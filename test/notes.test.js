const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const vm = require('vm')
const { createRequire } = require('module')

const NOTES_FILE = path.join(__dirname, '..', 'src', 'main', 'notes.js')
const NOTES_SOURCE = fs.readFileSync(NOTES_FILE, 'utf8')
const DOC_ID = '11111111-1111-4111-8111-111111111111'

function harness (t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'solace-notes-'))
  const root = path.join(base, 'library')
  fs.mkdirSync(root)
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const calls = []
  const shell = {
    async openPath (file) { calls.push({ action: 'open', file }); return '' },
    async trashItem (file) {
      calls.push({ action: 'trash', file })
      fs.rmSync(file)
    },
    showItemInFolder (file) { calls.push({ action: 'reveal', file }) }
  }
  const nativeRequire = createRequire(NOTES_FILE)
  const context = {
    module: { exports: {} },
    require: name => name === 'electron' ? { shell } : nativeRequire(name),
    process,
    setTimeout
  }
  vm.runInNewContext(NOTES_SOURCE, context, { filename: NOTES_FILE })
  const notes = context.module.exports
  notes.init(root, () => ({}))
  return { notes, base, root, calls }
}

function linkDirectory (t, target, link) {
  try {
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    return true
  } catch (err) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(err.code)) throw err
    t.skip(`Directory links are unavailable: ${err.code}`)
    return false
  }
}

test('notes support UUID documents and ordinary markdown basenames', async (t) => {
  const { notes, root, calls } = harness(t)
  const created = await notes.create(DOC_ID, { title: 'A book', page: 4, total: 12 })
  const initialPath = path.join(root, 'notes', DOC_ID, created.file)
  assert.ok(fs.existsSync(initialPath))
  assert.match(fs.readFileSync(initialPath, 'utf8'), /A book/)

  const file = 'Chapter 1 (draft).md'
  const notePath = path.join(root, 'notes', DOC_ID, file)
  fs.renameSync(initialPath, notePath)
  const listed = await notes.list(DOC_ID)
  assert.equal(listed.notes.length, 1)
  assert.equal(listed.notes[0].file, file)
  assert.equal((await notes.open(DOC_ID, file, { forceDefault: true })).opened, true)
  assert.equal(notes.reveal(DOC_ID, file), true)
  assert.equal(await notes.trash(DOC_ID, file), true)
  assert.equal(fs.existsSync(notePath), false)
  assert.deepEqual(calls, [
    { action: 'open', file: notePath },
    { action: 'reveal', file: notePath },
    { action: 'trash', file: notePath }
  ])
})

for (const replaced of ['notes', 'document']) {
  test(`notes reject a ${replaced} directory replaced by a junction after init`, async (t) => {
    const { notes, base, root, calls } = harness(t)
    const notesDir = path.join(root, 'notes')
    const replacedDir = replaced === 'notes' ? notesDir : path.join(notesDir, DOC_ID)
    const outside = path.join(base, 'outside')
    const outsideDoc = replaced === 'notes' ? path.join(outside, DOC_ID) : outside
    fs.mkdirSync(outsideDoc, { recursive: true })
    fs.mkdirSync(replacedDir, { recursive: true })
    fs.rmdirSync(replacedDir)
    const externalFile = path.join(outsideDoc, 'keep.md')
    fs.writeFileSync(externalFile, 'external note must remain untouched')
    if (!linkDirectory(t, outside, replacedDir)) return

    await assert.rejects(notes.create(DOC_ID, { title: 'Must not be created' }))
    await assert.rejects(notes.list(DOC_ID))
    await assert.rejects(notes.open(DOC_ID, 'keep.md', { forceDefault: true }))
    await assert.rejects(notes.trash(DOC_ID, 'keep.md'))
    assert.throws(() => notes.reveal(DOC_ID, 'keep.md'))
    assert.deepEqual(calls, [])
    assert.equal(fs.readFileSync(externalFile, 'utf8'), 'external note must remain untouched')
    assert.deepEqual(fs.readdirSync(outsideDoc), ['keep.md'])
  })
}

test('notes accept an explicitly selected library root that is a junction', async (t) => {
  const { notes, base, root, calls } = harness(t)
  const selectedRoot = path.join(base, 'selected-library')
  if (!linkDirectory(t, root, selectedRoot)) return
  notes.init(selectedRoot, () => ({}))
  const created = await notes.create(DOC_ID, { title: 'Selected root' })
  const actualFile = path.join(root, 'notes', DOC_ID, created.file)
  assert.ok(fs.existsSync(actualFile))
  assert.equal((await notes.open(DOC_ID, created.file, { forceDefault: true })).opened, true)
  assert.equal(calls[0].file, path.join(selectedRoot, 'notes', DOC_ID, created.file))
})

test('notes reject invalid document IDs and non-basename filenames', async (t) => {
  const { notes, root, calls } = harness(t)
  for (const id of ['../outside', '..\\outside', 'not-a-uuid']) {
    await assert.rejects(notes.create(id))
    await assert.rejects(notes.open(id, 'keep.md', { forceDefault: true }))
    await assert.rejects(notes.trash(id, 'keep.md'))
    assert.throws(() => notes.reveal(id, 'keep.md'))
  }
  for (const file of ['../keep.md', '..\\keep.md', 'nested/keep.md', 'keep.md:stream', '.hidden.md', ' keep.md']) {
    await assert.rejects(notes.open(DOC_ID, file, { forceDefault: true }))
    await assert.rejects(notes.trash(DOC_ID, file))
    assert.throws(() => notes.reveal(DOC_ID, file))
  }
  assert.deepEqual(calls, [])
  assert.deepEqual(fs.readdirSync(root), [])
})
