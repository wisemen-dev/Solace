import { openPreview, isPreviewOpen } from './preview.js'
import { ensureCover, coverCache } from './covers.js'

let data = null
const filters = { categoryId: undefined, tagId: null, keyword: '' }
let dragDocId = null

const $ = (sel) => document.querySelector(sel)

/* ================= 初始化 ================= */

refresh()

async function refresh () {
  data = await window.solace.getLibrary()
  renderAll()
}

function renderAll () {
  renderCategories()
  renderTags()
  renderDocList()
}

/* ================= 侧栏：分类 ================= */

function renderCategories () {
  const counts = {}
  let uncategorized = 0
  for (const d of data.documents) {
    if (d.categoryId) counts[d.categoryId] = (counts[d.categoryId] || 0) + 1
    else uncategorized++
  }

  const catHtml = data.categories.map(c => `
    <li data-action="filter-cat" data-id="${c.id}" class="${filters.categoryId === c.id ? 'active' : ''}">
      <span class="name">${esc(c.name)}</span>
      <span class="ops">
        <button data-action="rename-cat" data-id="${c.id}" title="重命名">✎</button>
        <button data-action="del-cat" data-id="${c.id}" title="删除">✕</button>
      </span>
      <span class="badge">${counts[c.id] || 0}</span>
    </li>`).join('')

  $('#catList').innerHTML = `
    <li data-action="filter-cat" data-id="all" class="${filters.categoryId === undefined ? 'active' : ''}">
      <span class="name">全部</span><span class="badge">${data.documents.length}</span>
    </li>
    ${catHtml}
    <li data-action="filter-cat" data-id="none" class="${filters.categoryId === null ? 'active' : ''}">
      <span class="name">未分类</span><span class="badge">${uncategorized}</span>
    </li>`
}

function renderTags () {
  const counts = {}
  for (const d of data.documents) {
    for (const t of d.tagIds) counts[t] = (counts[t] || 0) + 1
  }
  $('#tagList').innerHTML = data.tags.map(t => `
    <li data-action="filter-tag" data-id="${t.id}" class="${filters.tagId === t.id ? 'active' : ''}">
      <span class="name"># ${esc(t.name)}</span>
      <span class="ops">
        <button data-action="del-tag" data-id="${t.id}" title="删除">✕</button>
      </span>
      <span class="badge">${counts[t.id] || 0}</span>
    </li>`).join('') || '<li class="side-empty" style="cursor:default;color:var(--muted);font-size:12px;">暂无标签</li>'
}

/* ================= 主区：封面墙 ================= */

function visibleDocs () {
  const kw = filters.keyword.trim().toLowerCase()
  return data.documents.filter(d => {
    if (filters.categoryId === null && d.categoryId !== null) return false
    if (typeof filters.categoryId === 'string' && d.categoryId !== filters.categoryId) return false
    if (filters.tagId && !d.tagIds.includes(filters.tagId)) return false
    if (kw && !d.title.toLowerCase().includes(kw)) return false
    return true
  })
}

function renderDocList () {
  const docs = visibleDocs()
  const catName = Object.fromEntries(data.categories.map(c => [c.id, c.name]))
  const tagName = Object.fromEntries(data.tags.map(t => [t.id, t.name]))
  const cache = coverCache()

  $('#countText').textContent = `共 ${data.documents.length} 本 · 显示 ${docs.length} 本`

  if (!docs.length) {
    $('#docGrid').innerHTML = `<div class="empty">${
      data.documents.length
        ? '没有符合条件的结果<br>试试调整分类、标签或搜索词'
        : '图书馆还是空的<br>把 PDF 拖进窗口，或点击左侧「导入 PDF」'
    }</div>`
    return
  }

  $('#docGrid').innerHTML = docs.map((d, i) => {
    const cached = cache.get(d.id)
    return `
    <div class="doc-card" data-id="${d.id}" draggable="true" style="--i:${i}">
      <div class="doc-cover" data-action="preview-doc" data-id="${d.id}" title="点击预览">
        <img class="doc-cover-img" data-doc-id="${d.id}" alt="" ${cached ? `src="${cached}"` : ''}/>
        <div class="doc-cover-ops">
          <button class="btn-ghost" data-action="open-doc" data-id="${d.id}" title="用外部阅读器打开">打开</button>
          <button class="btn-ghost" data-action="edit-doc" data-id="${d.id}">编辑</button>
          <button class="btn-ghost btn-danger" data-action="del-doc" data-id="${d.id}">删除</button>
        </div>
      </div>
      <div class="doc-info">
        <div class="doc-title" data-action="open-doc" data-id="${d.id}" title="${esc(d.title)}">${esc(d.title)}</div>
        <div class="doc-tags">${
          d.tagIds.map(t => `<span class="doc-tag"># ${esc(tagName[t] || '?')}</span>`).join('')
        }</div>
        <div class="doc-meta">
          ${d.categoryId ? esc(catName[d.categoryId] || '未知') : '未分类'} · ${fmtSize(d.size)} · 打开 ${d.openCount} 次
        </div>
      </div>
    </div>`
  }).join('')

  // 没有缓存的封面交给观察器：滚动可见时才读取/生成
  for (const img of document.querySelectorAll('.doc-cover-img:not([src])')) {
    const doc = data.documents.find(x => x.id === img.dataset.docId)
    if (doc) coverObserver.observe(img)
  }
}

// 卡片进入可视区域后再取/生成封面，导入大图书馆时首屏不被拖慢
const coverObserver = new IntersectionObserver((entries) => {
  for (const en of entries) {
    if (!en.isIntersecting) continue
    const img = en.target
    coverObserver.unobserve(img)
    const doc = data && data.documents.find(x => x.id === img.dataset.docId)
    if (doc) ensureCover(doc, img)
  }
}, { root: document.getElementById('docGrid'), rootMargin: '120px' })

/* ================= 事件：全局委托 ================= */

document.body.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]')
  if (!el) return
  const { action, id } = el.dataset

  try {
    switch (action) {
      case 'filter-cat': {
        filters.categoryId = id === 'all' ? undefined : id === 'none' ? null : id
        renderAll()
        break
      }
      case 'filter-tag': {
        filters.tagId = filters.tagId === id ? null : id
        renderAll()
        break
      }
      case 'rename-cat': {
        const cat = data.categories.find(c => c.id === id)
        const name = await askText('重命名分类', cat.name)
        if (name && name !== cat.name) { await window.solace.renameCategory(id, name); refresh() }
        break
      }
      case 'del-cat': {
        if (confirm('删除该分类？分类下的文档会变为未分类。')) {
          if (filters.categoryId === id) filters.categoryId = undefined
          await window.solace.removeCategory(id)
          refresh()
        }
        break
      }
      case 'del-tag': {
        if (confirm('删除该标签？会同时从所有文档上移除。')) {
          if (filters.tagId === id) filters.tagId = null
          await window.solace.removeTag(id)
          refresh()
        }
        break
      }
      case 'preview-doc': {
        const doc = data.documents.find(d => d.id === id)
        openPreview(doc)
        break
      }
      case 'open-doc': {
        await window.solace.openDoc(id)
        refresh()
        break
      }
      case 'edit-doc': {
        const doc = data.documents.find(d => d.id === id)
        await openEditDialog(doc)
        break
      }
      case 'del-doc': {
        const doc = data.documents.find(d => d.id === id)
        if (confirm(`删除《${doc.title}》？\n将移除库内副本与封面（原文件不受影响）。`)) {
          await window.solace.removeDoc(id)
          refresh()
        }
        break
      }
    }
  } catch (err) {
    toast(`操作失败：${err.message || err}`)
  }
})

/* ================= 拖拽归档：卡片 → 侧栏分类 ================= */

$('#docGrid').addEventListener('dragstart', (e) => {
  const card = e.target.closest('.doc-card')
  if (!card) return
  dragDocId = card.dataset.id
  e.dataTransfer.setData('application/x-solace-doc', dragDocId)
  e.dataTransfer.effectAllowed = 'move'
  card.classList.add('dragging')
})

document.addEventListener('dragend', () => {
  document.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'))
  document.querySelectorAll('.drop-hint').forEach(el => el.classList.remove('drop-hint'))
  dragDocId = null
})

const catList = $('#catList')

catList.addEventListener('dragover', (e) => {
  if (!dragDocId) return
  const li = e.target.closest('li[data-action="filter-cat"]')
  if (!li) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'move'
  li.classList.add('drop-hint')
})

catList.addEventListener('dragleave', (e) => {
  const li = e.target.closest('li')
  if (li && !li.contains(e.relatedTarget)) li.classList.remove('drop-hint')
})

catList.addEventListener('drop', async (e) => {
  const li = e.target.closest('li[data-action="filter-cat"]')
  if (!li) return
  const docId = e.dataTransfer.getData('application/x-solace-doc')
  if (!docId) return
  e.preventDefault()
  e.stopPropagation()
  catList.querySelectorAll('.drop-hint').forEach(el => el.classList.remove('drop-hint'))

  const doc = data.documents.find(d => d.id === docId)
  if (!doc) return
  const target = li.dataset.id // 'all' | 'none' | 分类id
  if (target === 'all') { toast('拖到具体分类或「未分类」即可归档'); return }
  const categoryId = target === 'none' ? null : target
  if (doc.categoryId === categoryId) return

  try {
    await window.solace.updateDoc(docId, { categoryId })
    const cat = data.categories.find(c => c.id === categoryId)
    refresh()
    toast(`《${doc.title}》已归档到「${cat ? cat.name : '未分类'}」`)
  } catch (err) {
    toast(`归档失败：${err.message || err}`)
  }
})

/* ================= 事件：导入与搜索 ================= */

$('#btnImport').addEventListener('click', async () => {
  const { imported, errors } = await window.solace.importDialog()
  notifyImport(imported, errors)
  refresh()
})

$('#searchInput').addEventListener('input', (e) => {
  filters.keyword = e.target.value
  renderDocList()
})

$('#btnAddCat').addEventListener('click', async () => {
  const name = await askText('新建分类')
  if (name) { try { await window.solace.addCategory(name); refresh() } catch (err) { toast(err.message) } }
})

$('#btnAddTag').addEventListener('click', async () => {
  const name = await askText('新建标签')
  if (name) { try { await window.solace.addTag(name); refresh() } catch (err) { toast(err.message) } }
})

// 文件拖入导入（应用内部拖拽归档不触发导入）
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', async (e) => {
  e.preventDefault()
  const types = [...(e.dataTransfer?.types || [])]
  if (types.includes('application/x-solace-doc')) return
  const files = [...(e.dataTransfer?.files || [])]
  const pdfs = files.filter(f => f.name.toLowerCase().endsWith('.pdf'))
  if (!pdfs.length) return
  const paths = pdfs.map(f => window.solace.pathForFile(f))
  const { imported, errors } = await window.solace.importPaths(paths)
  notifyImport(imported, errors)
  refresh()
})

function notifyImport (imported, errors) {
  const parts = []
  if (imported.length) parts.push(`已入库 ${imported.length} 本`)
  if (errors.length) parts.push(`${errors.length} 个失败：${errors.map(x => x.file).join('、')}`)
  if (parts.length) toast(parts.join('；'))
}

/* ================= 编辑对话框 ================= */

let editingId = null

function openEditDialog (doc) {
  editingId = doc.id
  $('#editTitle').value = doc.title
  $('#editCat').innerHTML = `
    <option value="">未分类</option>
    ${data.categories.map(c =>
      `<option value="${c.id}" ${c.id === doc.categoryId ? 'selected' : ''}>${esc(c.name)}</option>`
    ).join('')}`
  $('#editTags').innerHTML = data.tags.map(t => `
    <label><input type="checkbox" value="${t.id}" ${doc.tagIds.includes(t.id) ? 'checked' : ''}/> # ${esc(t.name)}</label>
  `).join('') || '<span style="color:var(--muted);font-size:12px;">还没有标签，可在左栏新建</span>'
  $('#editDialog').showModal()
}

$('#btnEditSave').addEventListener('click', async () => {
  const patch = {
    title: $('#editTitle').value.trim() || '未命名文档',
    categoryId: $('#editCat').value || null,
    tagIds: [...$('#editTags').querySelectorAll('input:checked')].map(i => i.value)
  }
  await window.solace.updateDoc(editingId, patch)
  $('#editDialog').close()
  refresh()
})

$('#btnEditCancel').addEventListener('click', () => $('#editDialog').close())

/* ================= 通用文本输入对话框 ================= */

function askText (title, initial = '') {
  return new Promise((resolve) => {
    const dlg = $('#inputDialog')
    const input = $('#inputDialogInput')
    $('#inputDialogTitle').textContent = title
    input.value = initial
    let settled = false
    $('#inputDialogOk').onclick = () => { settled = true; dlg.close(); resolve(input.value.trim()) }
    $('#inputDialogCancel').onclick = () => { settled = true; dlg.close(); resolve(null) }
    dlg.onclose = () => { if (!settled) resolve(null) }
    dlg.showModal()
    input.focus()
    input.select()
  })
}

/* ================= 预览浮层的关闭按钮 ================= */

$('#btnPreviewClose').addEventListener('click', () => window.closePreview?.())
$('#btnPreviewExternal').addEventListener('click', async () => {
  if (window.currentPreviewId) {
    await window.solace.openDoc(window.currentPreviewId)
    refresh()
  }
})

// 预览打开时按 Esc 关闭（对话框之外的 Esc）
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isPreviewOpen()) window.closePreview?.()
})

/* ================= 工具函数 ================= */

function toast (text) {
  const box = $('#toastBox')
  const el = document.createElement('div')
  el.className = 'toast'
  el.textContent = text
  box.appendChild(el)
  setTimeout(() => el.classList.add('out'), 2200)
  setTimeout(() => el.remove(), 2700)
}

function esc (s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]))
}

function fmtSize (n) {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
  return Math.max(1, Math.round(n / 1024)) + ' KB'
}

function fmtDate (iso) {
  return iso ? new Date(iso).toLocaleDateString('zh-CN') : '—'
}
