import { openPreview } from './preview.js'
import { textHit, searchTextIndex } from './textindex.js'
import { normText, esc } from './util.js'

// Ctrl+K 命令面板：搜书（标题/文件名/全文）、执行常用动作、跳转到分类/标签。
// 每次打开现取一次资料库（一次 IPC）；筛选与动作经 'solace-palette' 事件
// 交回 app.js 执行，本模块不持有主界面状态。

const dlg = document.getElementById('paletteDialog')
const input = document.getElementById('paletteInput')
const list = document.getElementById('paletteList')

const ACTIONS = [
  { icon: '＋', label: '导入 PDF…', payload: { type: 'action', name: 'import' } },
  { icon: '📁', label: '新建分类…', payload: { type: 'action', name: 'new-cat' } },
  { icon: '#', label: '新建标签…', payload: { type: 'action', name: 'new-tag' } },
  { icon: '⭐', label: '把当前筛选保存为收藏夹…', payload: { type: 'action', name: 'save-shelf' } },
  { icon: '📊', label: '打开阅读足迹', payload: { type: 'action', name: 'stats' } },
  { icon: '🌙', label: '打开沉睡清单', payload: { type: 'action', name: 'dormant' } },
  { icon: '🚀', label: '打开外部工具', payload: { type: 'action', name: 'tool' } },
  { icon: '⚙', label: '打开设置', payload: { type: 'action', name: 'settings' } }
]

let lastData = null
let items = []
let activeIdx = 0

async function openPalette () {
  try {
    lastData = await window.solace.getLibrary()
  } catch {
    return
  }
  input.value = ''
  await searchTextIndex('') // 全文命中表随面板打开重置（正文在主进程，按需查）
  rebuild('')
  dlg.showModal()
  input.focus()
}

function buildItems (data, kw) {
  const nkw = normText(kw)
  const out = []
  const hit = (s) => !nkw || normText(s).includes(nkw)

  if (!nkw) {
    // 空关键词：常用动作 + 最近翻开的书
    for (const a of ACTIONS) out.push({ kind: 'action', icon: a.icon, label: a.label, hint: '动作', payload: a.payload })
    const seen = new Set()
    for (const h of (data.history || []).slice(-5).reverse()) {
      if (seen.has(h.docId)) continue
      seen.add(h.docId)
      const d = data.documents.find(x => x.id === h.docId)
      if (d) out.push({ kind: 'book', icon: '🕘', label: d.title, hint: '最近翻开', payload: { doc: d, hitPage: null } })
    }
    return out.slice(0, 14)
  }

  for (const a of ACTIONS) {
    if (hit(a.label)) out.push({ kind: 'action', icon: a.icon, label: a.label, hint: '动作', payload: a.payload })
  }

  const tagName = Object.fromEntries(data.tags.map(t => [t.id, t.name]))
  for (const d of data.documents) {
    const titleHit = normText(d.title).includes(nkw) || normText(d.fileName).includes(nkw)
    const hp = titleHit ? 0 : textHit(d.id, nkw)
    if (!titleHit && !hp) continue
    out.push({
      kind: 'book', icon: '📕', label: d.title,
      hint: hp ? `全文·第${hp}页` : (d.tagIds.map(t => '#' + (tagName[t] || '?')).join(' ') || '书籍'),
      payload: { doc: d, hitPage: hp || null }
    })
  }
  for (const c of data.categories) {
    if (hit(c.name)) out.push({ kind: 'filter', icon: '📁', label: c.name, hint: '分类', payload: { type: 'filter', categoryId: c.id, tagId: null, keyword: '' } })
  }
  for (const t of data.tags) {
    if (hit(t.name)) out.push({ kind: 'filter', icon: '#', label: t.name, hint: '标签', payload: { type: 'filter', categoryId: undefined, tagId: t.id, keyword: '' } })
  }
  return out.slice(0, 14)
}

function rebuild (kw) {
  items = lastData ? buildItems(lastData, kw) : []
  activeIdx = 0
  renderItems()
}

function renderItems () {
  activeIdx = Math.min(activeIdx, Math.max(0, items.length - 1))
  list.innerHTML = items.length
    ? items.map((it, i) => `
      <li data-idx="${i}" class="${i === activeIdx ? 'active' : ''}">
        <span class="icon">${it.icon}</span>
        <span class="label">${esc(it.label)}</span>
        <span class="hint">${esc(it.hint)}</span>
      </li>`).join('')
    : '<li class="palette-empty">没有匹配的结果</li>'
  list.querySelector('li.active')?.scrollIntoView({ block: 'nearest' })
}

function updateActive (delta) {
  if (!items.length) return
  activeIdx = (activeIdx + delta + items.length) % items.length
  renderItems()
}

function execute (item) {
  if (!item) return
  dlg.close()
  if (item.kind === 'book') {
    openPreview(item.payload.doc, item.payload.hitPage)
  } else {
    window.dispatchEvent(new CustomEvent('solace-palette', { detail: item.payload }))
  }
}

// 全文命中要问主进程（索引正文不在渲染层），所以输入先出标题/文件名结果，
// 防抖后补一次带全文命中的结果；ticket 防止过期结果覆盖新结果
let queryTimer = null
let queryTicket = 0

input.addEventListener('input', () => {
  const kw = input.value
  clearTimeout(queryTimer)
  const ticket = ++queryTicket
  rebuild(kw)
  if (!normText(kw)) return
  queryTimer = setTimeout(async () => {
    await searchTextIndex(kw)
    if (ticket !== queryTicket) return
    rebuild(kw)
  }, 120)
})

input.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); updateActive(1) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); updateActive(-1) }
  else if (e.key === 'Enter') { e.preventDefault(); execute(items[activeIdx]) }
})

list.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-idx]')
  if (li) execute(items[Number(li.dataset.idx)])
})

list.addEventListener('mousemove', (e) => {
  const li = e.target.closest('li[data-idx]')
  const idx = li ? Number(li.dataset.idx) : -1
  if (idx >= 0 && idx !== activeIdx) { activeIdx = idx; renderItems() }
})

// 点对话框空白处（backdrop）关闭
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close() })

// 关闭后通知 app.js 恢复主窗口的全文命中表：本面板与主窗口共用 textindex.js
// 里那张模块级命中表——openPalette 打开即清空、输入即覆盖。主窗口还挂着
// 的搜索词若不按原词重查，下一次重渲染就会丢掉「仅正文命中」的结果
dlg.addEventListener('close', () => {
  window.dispatchEvent(new CustomEvent('solace-palette-closed'))
})

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    if (!dlg.open) openPalette()
  }
})

document.getElementById('btnPalette').addEventListener('click', openPalette)
