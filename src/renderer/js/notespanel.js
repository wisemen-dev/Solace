import { esc, fmtRel } from './util.js'
import { askText, askConfirm } from './dialog.js'

// 预览浮层内的笔记面板：列出当前书 notes/<id>/ 下的 .md 文件（目录扫描
// 为准，最近修改在上）。点条目用 Typora 打开（未找到时询问路径并记住，
// 或回退系统默认关联）；可一键新建（模板含书名/时间/当前页码）、移入
// 回收站、在文件夹中定位。面板由 preview.js 控制开关，本模块只管内容。

const panel = document.getElementById('notesPanel')
const list = document.getElementById('notesList')
const btnNew = document.getElementById('btnNoteNew')
const btnReveal = document.getElementById('btnNoteReveal')
const btnBatch = document.getElementById('btnNoteBatch')
const btnDel = document.getElementById('btnNoteDel')

let doc = null
let getPageCtx = null // () => ({ page, total })，新建笔记时取当前阅读页
let sessionToken = 0
let loadSeq = 0

function captureSession () {
  return doc && !panel.hidden
    ? { id: doc.id, title: doc.title, sessionId: doc.sessionId, token: sessionToken }
    : null
}

function isCurrentSession (session) {
  return !!session && session.token === sessionToken && !panel.hidden &&
    !!doc && doc.id === session.id && doc.sessionId === session.sessionId
}

// 批量模式：条目点击改为切换选中，删除整批移入回收站；换书/关面板即复位
let noteBatch = false
const noteSel = new Set()

function setNoteBatch (on) {
  noteBatch = on
  noteSel.clear()
  panel.classList.toggle('notes-batch', on)
  btnBatch.textContent = on ? '退出' : '批量'
  btnNew.hidden = on
  updateNoteBar()
  load()
}

function updateNoteBar () {
  btnDel.hidden = !noteBatch
  btnDel.textContent = noteSel.size ? `删除(${noteSel.size})` : '删除'
  btnDel.disabled = noteSel.size === 0
}

export function isNotesOpen () {
  return !panel.hidden
}

export function openNotes (d, pageCtx) {
  if (!d) return
  sessionToken++
  doc = d
  getPageCtx = pageCtx
  panel.hidden = false
  list.innerHTML = ''
  setNoteBatch(false)
}

export function closeNotes () {
  sessionToken++
  loadSeq++
  panel.hidden = true
  doc = null
  getPageCtx = null
  list.innerHTML = ''
  setNoteBatch(false)
}

async function load (session = captureSession()) {
  if (!isCurrentSession(session)) return
  const seq = ++loadSeq
  try {
    const { notes } = await window.solace.listNotes(session.id, session.sessionId)
    if (!isCurrentSession(session) || seq !== loadSeq) return
    render(notes)
  } catch (err) {
    if (!isCurrentSession(session) || seq !== loadSeq) return
    list.innerHTML = `<li class="notes-empty">加载失败：${esc(err.message || err)}</li>`
  }
}

// 展示名 = 去掉 .md 的文件名。一键新建的是「2026-09-06 14.30.05」这类
// 时间戳名，用户在文件管理器/Typora 里改名后这里如实跟随（扫描为准）
const displayName = (file) => String(file).replace(/\.md$/i, '')

function render (notes) {
  list.innerHTML = notes.length
    ? notes.map(n => `
      <li data-file="${esc(n.file)}" class="${noteSel.has(n.file) ? 'sel' : ''}" title="${esc(n.file)}\n创建于 ${esc(n.birth)}\n修改于 ${esc(n.mtime)}\n点击用 Typora 打开">
        <div class="note-main">
          <span class="note-name">${esc(displayName(n.file))}</span>
          <span class="note-when">${esc(fmtRel(n.mtime))}修改</span>
        </div>
        <button class="note-del" title="删除（移入回收站）">✕</button>
      </li>`).join('')
    : '<li class="notes-empty">还没有笔记<br>点上方「＋ 新建」开始记录</li>'
}

list.addEventListener('click', async (e) => {
  const session = captureSession()
  if (!session) return
  const li = e.target.closest('li[data-file]')
  if (!li) return
  const file = li.dataset.file
  if (e.target.closest('.note-del')) {
    const res = await askConfirm({
      title: '删除笔记',
      text: `「${displayName(file)}」将移入系统回收站。`,
      okText: '删除'
    })
    if (res && isCurrentSession(session)) {
      try {
        await window.solace.trashNote(session.id, file, session.sessionId)
        if (!isCurrentSession(session)) return
        load(session)
      } catch (err) {
        if (isCurrentSession(session)) window.toast?.(`删除失败：${err.message || err}`)
      }
    }
    return
  }
  // 批量模式：点击条目 = 切换选中
  if (noteBatch) {
    if (noteSel.has(file)) noteSel.delete(file)
    else noteSel.add(file)
    li.classList.toggle('sel', noteSel.has(file))
    updateNoteBar()
    return
  }
  await openOne(file, session)
})

btnBatch.addEventListener('click', () => setNoteBatch(!noteBatch))

btnDel.addEventListener('click', async () => {
  const session = captureSession()
  const files = [...noteSel]
  if (!session || !files.length) return
  const res = await askConfirm({
    title: `删除所选 ${files.length} 条笔记`,
    text: '将移入系统回收站。',
    okText: '删除'
  })
  if (!res || !isCurrentSession(session)) return
  let ok = 0
  for (const file of files) {
    try {
      await window.solace.trashNote(session.id, file, session.sessionId)
      if (!isCurrentSession(session)) return
      ok++
    } catch (err) {
      if (!isCurrentSession(session)) return
      window.toast?.(`删除失败：${err.message || err}`)
    }
  }
  for (const file of files) noteSel.delete(file)
  updateNoteBar()
  load(session)
  if (ok) window.toast?.(`已删除 ${ok} 条笔记`)
})

async function openOne (file, session) {
  if (!isCurrentSession(session)) return
  try {
    const res = await window.solace.openNote(session.id, file, {}, session.sessionId)
    if (!isCurrentSession(session)) return
    if (res.opened) {
      if (res.editor === 'default') window.toast?.('未找到 Typora，已用系统默认程序打开')
      return
    }
    if (res.error) { window.toast?.(res.error); return }
    if (res.needEditor) {
      // 没探测到 Typora 且未设置路径：问一次并记住；留空则回退系统默认
      const prev = (await window.solace.getLibrary()).settings?.notesEditorPath || ''
      if (!isCurrentSession(session)) return
      const p = await askText('未检测到 Typora——输入 Typora.exe 完整路径（留空用系统默认）', prev)
      if (p === null || !isCurrentSession(session)) return
      if (p) {
        await window.solace.updateSettings({ notesEditorPath: p }, session.sessionId)
        if (!isCurrentSession(session)) return
      }
      const retry = await window.solace.openNote(session.id, file, p ? {} : { forceDefault: true }, session.sessionId)
      if (!isCurrentSession(session)) return
      if (retry.error) window.toast?.(retry.error)
      else if (!p) window.toast?.('已用系统默认程序打开')
    }
  } catch (err) {
    if (isCurrentSession(session)) window.toast?.(`打开失败：${err.message || err}`)
  }
}

btnNew.addEventListener('click', async () => {
  const session = captureSession()
  if (!session) return
  const ctx = getPageCtx ? getPageCtx() : {}
  try {
    const { file } = await window.solace.createNote(session.id, { title: session.title, page: ctx.page, total: ctx.total }, session.sessionId)
    if (!isCurrentSession(session)) return
    load(session)
    await openOne(file, session)
  } catch (err) {
    if (isCurrentSession(session)) window.toast?.(`新建失败：${err.message || err}`)
  }
})

btnReveal.addEventListener('click', async () => {
  const session = captureSession()
  if (!session) return
  try {
    const { notes } = await window.solace.listNotes(session.id, session.sessionId)
    if (!isCurrentSession(session)) return
    if (!notes.length) { window.toast?.('这本书还没有笔记'); return }
    await window.solace.revealNote(session.id, notes[0].file, session.sessionId)
  } catch { /* 忽略：定位失败无副作用 */ }
})
