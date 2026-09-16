import { openPreview, isPreviewOpen, setResumeEnabled } from './preview.js'
import { ensureCover, coverCache, clearCoverCache } from './covers.js'
import { burst, setConfettiEnabled } from './confetti.js'
import { initIndex, ensureQueued, setIndexPageLimit, textHit } from './textindex.js'
import { initTheme, cycleTheme, themeLabel, applyTheme } from './theme.js'
import { normText, esc, fmtRel } from './util.js'
import { askText, askConfirm } from './dialog.js'
import './palette.js' // 命令面板：自带事件注册，引入即生效
import './settings.js' // 设置面板：自带事件注册，引入即生效

let data = null
const filters = { categoryId: undefined, tagId: null, keyword: '' }
let dragDocId = null
const DEFAULT_DORMANT_DAYS = 30

// 批量管理（多选删除）：只在封面墙视图提供；勾选是纯展示标记（非真实
// checkbox），点击语义统一走卡片的事件委托，避免双切换
let batchMode = false
const batchSelected = new Set()

// 入场编排开关：下一次 renderDocList 是否播 stagger 入场。仅在明确的
// 视图/筛选/收藏夹切换时置 true；搜索逐键、数据刷新等重渲染不重播，
// 否则每敲一个键整个书架就重新入场一次
let entrancePending = true

// 「← 书架」回退标记：仅当封面态由书架点书堆（openPile）进入时为真。
// 其他进入路径（侧栏分类/命令面板/收藏夹）不设——用户主动换了浏览
// 路径，回退语义不成立；任何切换视图/筛选的动作都会将其清除
let fromShelf = false

// 界面偏好（theme/viewMode），refresh 时从 data.settings 同步
const prefs = { theme: 'auto', viewMode: 'grid' }

const $ = (sel) => document.querySelector(sel)

/* ================= 初始化 ================= */

refresh()

async function refresh () {
  data = await window.solace.getLibrary()
  Object.assign(prefs, data.settings || {})
  applySettingFlags()
  initTheme(prefs)
  syncViewButton()
  renderAll()
  // 每次刷新都同步一次索引状态：缺索引的书会排进后台提取队列
  initIndex(data.documents)
  // 开馆动画只播一次：首帧渲染完成后即解除（设置关闭时立即解除不播动画）
  localStorage.setItem('solace-opening', prefs.openingAnimation === false ? 'off' : 'on')
  setTimeout(() => document.body.classList.remove('opening'), prefs.openingAnimation === false ? 0 : 1600)
}

// 把可即时生效的偏好同步给各功能模块（设置面板更改时也会走这里）
function applySettingFlags () {
  setConfettiEnabled(prefs.confetti !== false)
  setResumeEnabled(prefs.resumeReading !== false)
  setIndexPageLimit(prefs.indexPageLimit || 1500)
}

function renderAll () {
  renderCategories()
  renderTags()
  renderShelves()
  renderDocList()
  updateDormantBadge()
}

/* ================= 侧栏：分类树 ================= */

// 折叠状态只存内存，重启后全部展开
const collapsedCats = new Set()

// 依 parentId 组树并 DFS 展开为带层级的有序列表；折叠的节点跳过子树。
// respectCollapse=false 供编辑对话框下拉用（要看到全部分类）。
function orderedCategories (respectCollapse = true) {
  const childrenOf = new Map()
  for (const c of data.categories) {
    const key = c.parentId || null
    if (!childrenOf.has(key)) childrenOf.set(key, [])
    childrenOf.get(key).push(c)
  }
  const out = []
  const walk = (parentId, depth) => {
    for (const c of childrenOf.get(parentId) || []) {
      out.push({ cat: c, depth })
      if (!respectCollapse || !collapsedCats.has(c.id)) walk(c.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

// 分类自身 + 全部子孙的 id 集合：点父分类时子分类的书一并显示
function categorySubtreeIds (id) {
  const ids = new Set([id])
  let grew = true
  while (grew) {
    grew = false
    for (const c of data.categories) {
      if (c.parentId && ids.has(c.parentId) && !ids.has(c.id)) { ids.add(c.id); grew = true }
    }
  }
  return ids
}

// 各分类的累计藏书数（含子孙分类）
function categoryCounts () {
  const direct = {}
  let uncategorized = 0
  for (const d of data.documents) {
    if (d.categoryId) direct[d.categoryId] = (direct[d.categoryId] || 0) + 1
    else uncategorized++
  }
  const counts = {}
  for (const c of data.categories) {
    let sum = 0
    for (const id of categorySubtreeIds(c.id)) sum += direct[id] || 0
    counts[c.id] = sum
  }
  return { counts, uncategorized }
}

function catNameOf (id) {
  return data.categories.find(c => c.id === id)?.name || '未知'
}

function renderCategories () {
  const { counts, uncategorized } = categoryCounts()

  const catHtml = orderedCategories().map(({ cat: c, depth }) => {
    const hasKids = data.categories.some(k => (k.parentId || null) === c.id)
    const collapsed = collapsedCats.has(c.id)
    return `
    <li data-action="filter-cat" data-id="${c.id}" class="${filters.categoryId === c.id ? 'active' : ''}" style="--d:${depth}">
      ${hasKids
        ? `<button class="caret" data-action="toggle-cat" data-id="${c.id}" title="${collapsed ? '展开' : '折叠'}">${collapsed ? '▸' : '▾'}</button>`
        : '<span class="caret placeholder"></span>'}
      <span class="name">${esc(c.name)}</span>
      <span class="ops">
        <button data-action="add-subcat" data-id="${c.id}" title="添加子分类">＋</button>
        <button data-action="rename-cat" data-id="${c.id}" title="重命名">✎</button>
        <button data-action="del-cat" data-id="${c.id}" title="删除">✕</button>
      </span>
      <span class="badge">${counts[c.id] || 0}</span>
    </li>`
  }).join('')

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
    </li>`).join('') || '<li class="side-empty">暂无标签</li>'
}

/* ================= 侧栏：智能收藏夹 ================= */

// 收藏夹 = 保存的筛选组合（分类+标签+关键词）。当前筛选与它完全一致时高亮。
function shelfActive (shelf) {
  const f = shelf.filters || {}
  return f.categoryId === filters.categoryId &&
    (f.tagId || null) === filters.tagId &&
    (f.keyword || '') === (filters.keyword || '')
}

function shelfDesc (shelf) {
  const f = shelf.filters || {}
  const parts = []
  if (typeof f.categoryId === 'string') parts.push(`分类：${catNameOf(f.categoryId)}`)
  else if (f.categoryId === null) parts.push('分类：未分类')
  if (f.tagId) parts.push(`标签：#${data.tags.find(t => t.id === f.tagId)?.name || '?'}`)
  if (f.keyword) parts.push(`关键词："${f.keyword}"`)
  return parts.join(' · ') || '空筛选'
}

function renderShelves () {
  const shelves = data.smartShelves || []
  $('#shelfList').innerHTML = shelves.map(s => `
    <li data-action="apply-shelf" data-id="${s.id}" class="${shelfActive(s) ? 'active' : ''}">
      <span class="name" title="${esc(shelfDesc(s))}">⭐ ${esc(s.name)}</span>
      <span class="ops">
        <button data-action="rename-shelf" data-id="${s.id}" title="重命名">✎</button>
        <button data-action="del-shelf" data-id="${s.id}" title="删除">✕</button>
      </span>
    </li>`).join('') || '<li class="side-empty">暂无收藏夹<br>筛选后点上方 ＋ 保存</li>'
}

function suggestedShelfName (f) {
  const parts = []
  if (typeof f.categoryId === 'string') parts.push(catNameOf(f.categoryId))
  else if (f.categoryId === null) parts.push('未分类')
  if (f.tagId) parts.push('#' + (data.tags.find(t => t.id === f.tagId)?.name || ''))
  if (f.keyword) parts.push(`"${f.keyword}"`)
  return parts.join(' + ')
}

function applyShelf (shelf) {
  const f = shelf.filters || {}
  filters.categoryId = f.categoryId === undefined ? undefined : f.categoryId
  filters.tagId = f.tagId || null
  filters.keyword = f.keyword || ''
  fromShelf = false // 收藏夹是明确的筛选跳转：回退语义失效
  entrancePending = true // 应用收藏夹 = 明确的筛选切换
  $('#searchInput').value = filters.keyword
  renderAll()
}

/* ================= 主区：陈列视图 =================
   grid 封面墙 / spine 书脊 / shelf 书架（分类书堆总览，参考 Lumin） */

// 分类分布图表与书架书堆共用的调色板（按顶级分类顺序循环取色）
const PALETTE = ['#6ea8fe', '#7bd88f', '#ffd166', '#ef8354', '#c792ea', '#4dd0e1', '#f06292', '#aed581', '#ffb74d']
const MISC_COLOR = '#5b6672'

function visibleDocs () {
  const kw = normText(filters.keyword)
  // 树状筛选：选中的是具体分类时，子孙分类的书一并显示
  const catIds = typeof filters.categoryId === 'string' ? categorySubtreeIds(filters.categoryId) : null
  return data.documents.filter(d => {
    if (filters.categoryId === null && d.categoryId !== null) return false
    if (catIds && !catIds.has(d.categoryId)) return false
    if (filters.tagId && !d.tagIds.includes(filters.tagId)) return false
    // 三级命中：标题 / 文件名 / 全文索引
    if (kw && !normText(d.title).includes(kw) && !normText(d.fileName).includes(kw) && !textHit(d.id, kw)) return false
    return true
  })
}

function renderDocList () {
  // 搜索触发书架→封面墙回退、清空搜索回到书堆，按钮状态必须跟着实际渲染走
  syncViewButton()
  // 回退按钮显隐与渲染同步（防御：即使某路径漏清标记也不会残留按钮）
  $('#btnBackShelf').hidden = !(fromShelf && effectiveView() === 'grid')
  updateBatchBar()
  updateBatchCategoryOptions()
  const entrance = entrancePending // 本次渲染消费一次入场标记
  entrancePending = false
  const docs = visibleDocs()
  const catName = Object.fromEntries(data.categories.map(c => [c.id, c.name]))
  const tagName = Object.fromEntries(data.tags.map(t => [t.id, t.name]))
  const cache = coverCache()
  const nkw = normText(filters.keyword)

  $('#countText').textContent = `共 ${data.documents.length} 本 · 显示 ${docs.length} 本`

  const grid = $('#docGrid')
  // 封面卡片大小（设置 → 外观）：只影响封面墙，书脊/书架视图有各自固定列宽
  const COVER_MIN = { small: '140px', medium: '172px', large: '220px' }
  grid.style.setProperty('--cover-min', COVER_MIN[prefs.coverSize] || COVER_MIN.medium)
  // 书架（分类书堆总览）：无搜索词时生效；一搜索就回退封面墙显示结果
  const shelf = prefs.viewMode === 'shelf' && !nkw
  // 书架视图没有勾选语义：批量中清空搜索回到书架时自动退出（本帧内直接
  // 复位，不递归重渲染）
  if (shelf && batchMode) resetBatchState()
  grid.classList.toggle('spine-mode', prefs.viewMode === 'spine' && !shelf)
  grid.classList.toggle('shelf-mode', shelf)
  // 批量勾选只在封面墙提供（书脊无操作按钮、书架是分类书堆）
  grid.classList.toggle('batch-mode', batchMode && !shelf)

  if (!docs.length) {
    grid.innerHTML = `<div class="empty">${
      data.documents.length
        ? '没有符合条件的结果<br>试试调整分类、标签或搜索词'
        : '图书馆还是空的<br>把 PDF 拖进窗口，或点击左侧「导入 PDF」'
    }</div>`
    return
  }

  if (shelf) {
    renderPileShelf(entrance)
    return
  }

  $('#docGrid').innerHTML = docs.map((d, i) => {
    const cached = cache.get(d.id)
    // 阅读进度：封面墙显示右上角进度环，书脊模式显示底部细进度条
    const pr = d.progress
    const pct = pr && pr.totalPages >= 1 ? Math.min(100, Math.round(pr.page / pr.totalPages * 100)) : 0
    // 全文命中标记：标题/文件名没中但正文命中时提示首个命中页
    const hitPage = nkw && !normText(d.title).includes(nkw) && !normText(d.fileName).includes(nkw)
      ? textHit(d.id, nkw)
      : 0

    if (prefs.viewMode === 'spine') {
      // 书脊陈列：纯浏览视图（点击预览、拖拽归档仍可用）
      return `
    <div class="doc-card${entrance ? ' enter' : ''}" data-id="${d.id}" draggable="true" style="--i:${i}">
      <div class="doc-cover" data-action="preview-doc" data-id="${d.id}"
           title="${esc(d.title)}${pct ? `（读到 ${pct}%）` : ''} · 点击预览">
        <img class="doc-cover-img" data-doc-id="${d.id}" alt="" ${cached ? `src="${cached}"` : ''}/>
        <span class="spine-name">${esc(d.title)}</span>
        ${pct ? `<i class="spine-progress${pct >= 100 ? ' done' : ''}" style="--p:${pct}"></i>` : ''}
      </div>
    </div>`
    }

    return `
    <div class="doc-card${entrance ? ' enter' : ''}" data-id="${d.id}" draggable="true" style="--i:${i}">
      <div class="doc-cover" data-action="preview-doc" data-id="${d.id}" title="点击预览">
        ${batchMode ? `<span class="doc-check${batchSelected.has(d.id) ? ' on' : ''}"></span>` : ''}
        <img class="doc-cover-img" data-doc-id="${d.id}" alt="" ${cached ? `src="${cached}"` : ''}/>
        ${pct ? `<div class="progress-ring${pct >= 100 ? ' done' : ''}" style="--p:${pct}" title="读到 ${pr.page}/${pr.totalPages} 页（${pct}%）"><i></i><span>${pct >= 100 ? '✓' : pct + '%'}</span></div>` : ''}
        <div class="doc-cover-ops">
          <button class="btn-ghost" data-action="open-doc" data-id="${d.id}" title="用外部阅读器打开">打开</button>
          <button class="btn-ghost" data-action="edit-doc" data-id="${d.id}">编辑</button>
          <button class="btn-ghost btn-danger" data-action="del-doc" data-id="${d.id}">删除</button>
        </div>
      </div>
      <div class="doc-info">
        <div class="doc-title" data-action="preview-doc" data-id="${d.id}" title="预览《${esc(d.title)}》">${esc(d.title)}</div>
        <div class="doc-tags">${
          (hitPage ? `<span class="doc-hit" title="正文命中，点封面预览可直达第 ${hitPage} 页">全文 · 第 ${hitPage} 页</span>` : '') +
          d.tagIds.map(t => `<span class="doc-tag"># ${esc(tagName[t] || '?')}</span>`).join('')
        }</div>
        <div class="doc-meta">
          ${d.categoryId ? esc(catName[d.categoryId] || '未知') : '未分类'} · ${fmtSize(d.size)} · 翻开 ${d.openCount} 次
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

/* ================= 顶栏：视图与主题切换 ================= */

// 视图循环：封面墙 → 书脊 → 书架（分类书堆总览）→ 封面墙
const VIEW_ORDER = ['grid', 'spine', 'shelf']
const VIEW_LABEL = { grid: '📚 封面', spine: '📖 书脊', shelf: '🏛 书架' }
const VIEW_TITLE = { grid: '切换到书脊视图', spine: '切换到书架（分类书堆）', shelf: '切换到封面墙' }

// 实际渲染的视图：书架是分类总览页，搜索中自动回退封面墙显示结果
// （prefs.viewMode 保持书架，清空搜索即回到书堆）
function effectiveView () {
  return prefs.viewMode === 'shelf' && normText(filters.keyword) ? 'grid' : prefs.viewMode
}

function syncViewButton () {
  const v = effectiveView()
  const btn = $('#btnView')
  btn.textContent = VIEW_LABEL[v] || VIEW_LABEL.grid
  btn.title = VIEW_TITLE[v] || ''
}

$('#btnView').addEventListener('click', async () => {
  exitBatch() // 批量管理只在封面墙提供：切视图即退出
  fromShelf = false // 用户主动切视图：回退语义失效
  entrancePending = true // 明确的视图切换：播放入场编排
  const next = VIEW_ORDER[(VIEW_ORDER.indexOf(effectiveView()) + 1) % VIEW_ORDER.length]
  prefs.viewMode = next
  if (next === 'shelf') {
    // 书架是分类总览：进来时清空筛选，与 Lumin「返回书架退出搜索态」一致
    filters.categoryId = undefined
    filters.tagId = null
    filters.keyword = ''
    $('#searchInput').value = ''
  }
  syncViewButton()
  renderAll()
  try { await window.solace.updateSettings({ viewMode: next }) } catch { /* 保存失败不影响本次切换 */ }
})

$('#btnTheme').addEventListener('click', async () => {
  const patch = cycleTheme(prefs)
  try { await window.solace.updateSettings(patch) } catch { /* 保存失败不影响本次切换 */ }
  toast(`主题：${themeLabel()}`)
})

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

/* ================= 书架视图：分类书堆总览 =================
   参考自 Lumin 的书堆书架：每个分类叠成一摞真实感的书（最多 4 本，
   顶部是最新入库的一本），点击书堆进入该分类的封面墙。
   堆叠位沿用其 _stack_for 设计：底书露左下、中层错开露右、顶书端正，
   微旋 1~2°；越靠上的书越亮，阴影只画在最顶一本。 */

// 堆叠位（从底到顶）：[dx, dy, rot(°), scale]，封面基准 172×258
const PILE_STACKS = {
  1: [[0, 0, 0, 1]],
  2: [[22, 22, 2.2, 0.94], [0, 0, 0, 1]],
  3: [[-24, 24, -2.2, 0.94], [22, 6, 2.2, 0.97], [0, 0, 0, 1]],
  4: [[-25, 27, -2.2, 0.94], [25, 4, 2.2, 0.96], [8, 2, -1.2, 0.98], [0, 0, 0, 1]]
}

function renderPileShelf (entrance) {
  const topCats = data.categories.filter(c => !c.parentId)
  const counts = categoryCounts()
  const piles = topCats.map((c, i) => ({
    key: c.id,
    name: c.name,
    color: PALETTE[i % PALETTE.length],
    count: counts.counts[c.id] || 0,
    books: docsInCategory(c.id).slice(0, 4)
  }))
  const uncat = data.documents.filter(d => !d.categoryId)
  if (uncat.length) {
    piles.push({
      key: 'none',
      name: '未分类',
      color: MISC_COLOR,
      count: uncat.length,
      books: uncat.slice(0, 4)
    })
  }

  $('#countText').textContent = `共 ${data.documents.length} 本 · ${piles.length} 摞书堆`

  const grid = $('#docGrid')
  if (!data.documents.length && !piles.length) {
    grid.innerHTML = '<div class="empty">图书馆还是空的<br>把 PDF 拖进窗口，或点击左侧「导入 PDF」</div>'
    return
  }

  grid.innerHTML = piles.map((p, i) => {
    const stack = p.books.length
      ? pileStackHtml(p.books)
      : '<div class="pile-empty">❉<span>空书堆</span></div>'
    return `
    <div class="doc-card pile-card${entrance ? ' enter' : ''}" data-action="pile-open" data-id="${p.key}" style="--i:${i}"
         title="打开「${esc(p.name)}」书堆">
      <div class="pile-stack">${stack}</div>
      <div class="pile-caption">
        <span class="pile-dot" style="background:${p.color}"></span>
        <span class="pile-name">${esc(p.name)}</span>
        <span class="pile-badge">${p.count} 本</span>
      </div>
    </div>`
  }).join('') + `
    <button class="pile-new${entrance ? ' enter' : ''}" data-action="pile-newcat" style="--i:${piles.length}">
      ＋<span>新建分类</span>
    </button>`

  // 封面懒加载：书堆 img 复用 doc-cover-img 管线（缓存/生成/回填）
  for (const img of grid.querySelectorAll('.doc-cover-img:not([src])')) {
    const doc = data.documents.find(x => x.id === img.dataset.docId)
    if (doc) coverObserver.observe(img)
  }
}

function pileStackHtml (books) {
  const n = books.length
  const slots = PILE_STACKS[Math.min(n, 4)]
  // 底→顶叠放：旧的在下，最新的在最顶
  const ordered = [...books].reverse()
  return ordered.map((d, slot) => {
    const [dx, dy, rot, sc] = slots[slot]
    const depth = n > 1 ? slot / (n - 1) : 1 // 越靠上越亮
    const br = (1 - 0.22 * (1 - depth)).toFixed(2)
    // draggable=false：书堆卡携带的是分类 id，img 原生拖拽会伪装成文档拖拽误导归档
    return `
    <img class="doc-cover-img pile-book${slot === n - 1 ? ' top' : ''}" data-doc-id="${d.id}" alt="" draggable="false"
         style="--dx:${dx}px; --dy:${dy}px; --rot:${rot}deg; --sc:${sc}; --br:${br}"
         title="${esc(d.title)}"/>`
  }).join('')
}

// 分类子树内的书，最新入库的在前（书堆顶部 = 最新一本）
function docsInCategory (catId) {
  const ids = categorySubtreeIds(catId)
  return data.documents
    .filter(d => d.categoryId && ids.has(d.categoryId))
    .sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt))
}

// 点书堆 → 应用分类筛选并切到封面墙（对应 Lumin「点堆进入网格」）
async function openPile (key) {
  filters.categoryId = key === 'none' ? null : key
  prefs.viewMode = 'grid'
  fromShelf = true // 由书堆进入：允许一步回退到书架总览
  entrancePending = true // 点书堆进入封面墙：播放入场编排
  syncViewButton()
  renderAll()
  try { await window.solace.updateSettings({ viewMode: 'grid' }) } catch { /* 下次启动仍为书架也可接受 */ }
  $('#docGrid').scrollTo({ top: 0 })
}

// 一步回退到书架总览：清筛选与搜索（书架本就是总览态）、播入场、落库
function backToShelf () {
  if (!fromShelf) return
  fromShelf = false
  prefs.viewMode = 'shelf'
  filters.categoryId = undefined
  filters.tagId = null
  filters.keyword = ''
  $('#searchInput').value = ''
  entrancePending = true
  syncViewButton()
  renderAll()
  window.solace.updateSettings({ viewMode: 'shelf' }).catch(() => {})
  $('#docGrid').scrollTo({ top: 0 })
}

$('#btnBackShelf').addEventListener('click', backToShelf)

/* ================= 批量管理（封面墙多选删除） ================= */

function resetBatchState () {
  batchMode = false
  batchSelected.clear()
  $('#btnBatch').textContent = '☑ 批量'
  $('#batchBar').hidden = true
}

function enterBatch () {
  batchMode = true
  $('#btnBatch').textContent = '✕ 退出批量'
  $('#batchBar').hidden = false
  renderDocList()
}

function exitBatch () {
  if (!batchMode) return
  resetBatchState()
  renderDocList()
}

$('#btnBatch').addEventListener('click', () => {
  if (batchMode) { exitBatch(); return }
  if (effectiveView() !== 'grid') { toast('批量管理仅在封面墙视图可用，请先切换到「📚 封面」'); return }
  enterBatch()
})
$('#btnBatchExit').addEventListener('click', exitBatch)

// 同步操作栏：选中数、删除按钮可用性、全选/取消全选文案。
// 顺带清掉已不存在的选中项（删书/切库后残留的过期 id）
function updateBatchBar () {
  for (const id of [...batchSelected]) {
    if (!data || !data.documents.some(d => d.id === id)) batchSelected.delete(id)
  }
  $('#batchCount').textContent = `已选 ${batchSelected.size} 本`
  $('#btnBatchDel').disabled = batchSelected.size === 0
  $('#batchCategory').disabled = batchSelected.size === 0
  const visible = visibleDocs().map(d => d.id)
  const allSel = visible.length > 0 && visible.every(id => batchSelected.has(id))
  $('#btnBatchAll').textContent = allSel ? '取消全选' : '全选当前结果'
}

// 归档下拉的选项随分类树重建（DFS 顺序、缩进体现层级，不看折叠状态），
// 批量中经侧栏增删分类后随下一次渲染如实刷新
function updateBatchCategoryOptions () {
  $('#batchCategory').innerHTML = '<option value="">归档到分类…</option>' +
    orderedCategories(false).map(({ cat: c, depth }) =>
      `<option value="${c.id}">${'　'.repeat(depth)}${esc(c.name)}</option>`
    ).join('') + '<option value="none">未分类</option>'
}

// 原地切换勾选标记，不整卡重绘（滚动位置与封面懒加载都不动）
function toggleBatchSel (id) {
  if (batchSelected.has(id)) batchSelected.delete(id)
  else batchSelected.add(id)
  const el = document.querySelector(`.doc-card[data-id="${id}"] .doc-check`)
  if (el) el.classList.toggle('on', batchSelected.has(id))
  updateBatchBar()
}

$('#btnBatchAll').addEventListener('click', () => {
  const visible = visibleDocs().map(d => d.id)
  const allSel = visible.length > 0 && visible.every(id => batchSelected.has(id))
  if (allSel) visible.forEach(id => batchSelected.delete(id))
  else visible.forEach(id => batchSelected.add(id))
  renderDocList()
})

// 批量归档：与拖拽单本归档同语义（直接执行不确认，低风险可逆）。
// 已在目标分类的选中项跳过并计入提示；执行后保留选中便于连续调整
$('#batchCategory').addEventListener('change', async (e) => {
  const v = e.target.value
  e.target.value = '' // 下拉只当菜单用，用完即归位到占位项
  if (!v || !batchMode || !batchSelected.size) return
  const target = v === 'none' ? null : v
  if (target && !data.categories.some(c => c.id === target)) { toast('该分类已不存在，请重试'); return }
  const name = target ? catNameOf(target) : '未分类'
  const ids = [...batchSelected].filter(id => {
    const d = data.documents.find(x => x.id === id)
    return d && d.categoryId !== target
  })
  if (!ids.length) { toast(`所选书籍已全部在「${name}」`); return }
  let done = 0
  for (const id of ids) {
    try { await window.solace.updateDoc(id, { categoryId: target }); done++ }
    catch { /* 过期选中项（已被删除）等，跳过 */ }
  }
  refresh()
  const skipped = ids.length - done
  toast(skipped > 0
    ? `已将 ${done} 本归档到「${name}」（${skipped} 本处理失败）`
    : `已将 ${done} 本归档到「${name}」`)
})

// 整批统一一次「是否同时删笔记」勾选（沿用单个删除的确认框语义，默认勾选）
$('#btnBatchDel').addEventListener('click', async () => {
  const ids = [...batchSelected].filter(id => data.documents.some(d => d.id === id))
  if (!ids.length) return
  const res = await askConfirm({
    title: `批量删除 ${ids.length} 本文档`,
    text: '所选书籍将从书架移除，库内副本与封面一并删除（原文件不受影响）。',
    checkLabel: '同时删除所选书籍的全部笔记（移入系统回收站）',
    okText: '删除'
  })
  if (!res) return
  let removed = 0
  const keptNotes = []
  const leftovers = new Set()
  for (const id of ids) {
    try {
      const out = await window.solace.removeDoc(id, { keepNotes: !res.checked })
      removed++
      if (out.notesKeptTo) keptNotes.push(out.notesKeptTo)
      for (const l of out.leftovers || []) leftovers.add(l)
    } catch { /* 过期选中项（已被删除）等，跳过 */ }
  }
  batchSelected.clear()
  refresh()
  const parts = [`已删除 ${removed} 本`]
  if (keptNotes.length) parts.push(`${keptNotes.length} 本的笔记保留在资料库 notes/ 下`)
  if (leftovers.size) parts.push(`${leftovers.size} 个文件正被占用，重启应用后自动清理`)
  toast(parts.join('；'))
})

/* ================= 事件：全局委托 ================= */

document.body.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]')
  if (!el) return
  const { action, id } = el.dataset

  try {
    switch (action) {
      case 'filter-cat': {
        filters.categoryId = id === 'all' ? undefined : id === 'none' ? null : id
        fromShelf = false // 侧栏分类不是书堆入口：不提供回退
        entrancePending = true // 明确的筛选切换：播放入场编排
        // 书架总览不显示单本书：点了分类就切到封面墙看书
        if (prefs.viewMode === 'shelf') {
          prefs.viewMode = 'grid'
          syncViewButton()
          window.solace.updateSettings({ viewMode: 'grid' }).catch(() => {})
        }
        renderAll()
        break
      }
      case 'pile-open': {
        await openPile(id)
        break
      }
      case 'pile-newcat': {
        const name = await askText('新建分类')
        if (name) { try { await window.solace.addCategory(name); refresh() } catch (err) { toast(err.message) } }
        break
      }
      case 'toggle-cat': {
        // 折叠/展开分类树节点（只重画侧栏，不动筛选）
        if (collapsedCats.has(id)) collapsedCats.delete(id)
        else collapsedCats.add(id)
        renderCategories()
        break
      }
      case 'add-subcat': {
        const name = await askText('新建子分类')
        if (name) { try { await window.solace.addCategory(name, id); refresh() } catch (err) { toast(err.message) } }
        break
      }
      case 'apply-shelf': {
        const shelf = (data.smartShelves || []).find(s => s.id === id)
        if (shelf) applyShelf(shelf)
        break
      }
      case 'rename-shelf': {
        const shelf = (data.smartShelves || []).find(s => s.id === id)
        if (!shelf) break
        const name = await askText('重命名收藏夹', shelf.name)
        if (name && name !== shelf.name) { await window.solace.renameShelf(id, name); refresh() }
        break
      }
      case 'del-shelf': {
        if (confirm('删除该收藏夹？只移除筛选组合，不影响藏书。')) {
          await window.solace.removeShelf(id)
          refresh()
        }
        break
      }
      case 'filter-tag': {
        filters.tagId = filters.tagId === id ? null : id
        fromShelf = false
        entrancePending = true
        renderAll()
        break
      }
      case 'rename-cat': {
        const cat = data.categories.find(c => c.id === id)
        if (!cat) break
        const name = await askText('重命名分类', cat.name)
        if (name && name !== cat.name) { await window.solace.renameCategory(id, name); refresh() }
        break
      }
      case 'del-cat': {
        if (confirm('删除该分类？子分类与直属文档将上移到其父分类（顶级分类的文档变为未分类）。')) {
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
        // 批量模式下点击卡片 = 切换选中，不打开预览
        if (batchMode) { toggleBatchSel(id); break }
        const doc = data.documents.find(d => d.id === id)
        // 搜索中点开的书：全文命中时直接跳到首个命中页
        const kw = normText(filters.keyword)
        const jump = kw ? textHit(id, kw) : 0
        openPreview(doc, jump || null)
        break
      }
      case 'open-doc': {
        await window.solace.openDoc(id)
        refresh()
        break
      }
      case 'edit-doc': {
        const doc = data.documents.find(d => d.id === id)
        if (doc) await openEditDialog(doc)
        break
      }
      case 'del-doc': {
        const doc = data.documents.find(d => d.id === id)
        if (!doc) break
        const res = await askConfirm({
          title: '删除文档',
          text: `《${doc.title}》将从书架移除，库内副本与封面一并删除（原文件不受影响）。`,
          checkLabel: '同时删除这本书的全部笔记（移入系统回收站）',
          okText: '删除'
        })
        if (res) {
          const out = await window.solace.removeDoc(id, { keepNotes: !res.checked })
          refresh()
          const parts = []
          if (out.notesKeptTo) parts.push(`笔记已保留在资料库 notes/${out.notesKeptTo}/`)
          if (out.leftovers && out.leftovers.length) parts.push(`${out.leftovers.join('、')} 正被其他程序占用，重启应用后自动清理`)
          toast(`《${out.title}》已删除${parts.length ? '；' + parts.join('；') : ''}`)
        }
        break
      }
    }
  } catch (err) {
    toast(`操作失败：${err.message || err}`)
  }
})

/* ================= 拖拽：卡片 → 分类归档，分类 → 分类换父 ================= */

$('#docGrid').addEventListener('dragstart', (e) => {
  if (batchMode) return // 批量选择中禁用拖拽归档，避免与勾选点击混淆
  const card = e.target.closest('.doc-card')
  if (!card) return
  // 书架（分类书堆）卡的 data-id 是分类 id，不是文档 id，不参与归档拖拽；
  // 堆内封面 img 的原生拖拽已在生成处禁用，这里再拦一道防回归
  if (card.classList.contains('pile-card')) return
  dragDocId = card.dataset.id
  e.dataTransfer.setData('application/x-solace-doc', dragDocId)
  e.dataTransfer.effectAllowed = 'move'
  card.classList.add('dragging')
})

document.addEventListener('dragend', () => {
  document.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'))
  document.querySelectorAll('.drop-hint').forEach(el => el.classList.remove('drop-hint'))
  dragDocId = null
  dragCatId = null
})

const catList = $('#catList')

// 拖分类到分类换父级（「全部/未分类」不可作为被拖对象）
let dragCatId = null

catList.addEventListener('dragstart', (e) => {
  const li = e.target.closest('li[data-action="filter-cat"]')
  if (!li || li.dataset.id === 'all' || li.dataset.id === 'none') return
  dragCatId = li.dataset.id
  e.dataTransfer.setData('application/x-solace-cat', dragCatId)
  e.dataTransfer.effectAllowed = 'move'
  li.classList.add('dragging')
})

function dropTargetOk (li, type) {
  if (!li) return false
  if (type === 'doc') return li.dataset.id !== 'all'
  return li.dataset.id !== 'all' && li.dataset.id !== 'none' && li.dataset.id !== dragCatId
}

catList.addEventListener('dragover', (e) => {
  const li = e.target.closest('li[data-action="filter-cat"]')
  const types = e.dataTransfer.types
  const isDoc = dragDocId && types.includes('application/x-solace-doc')
  const isCat = dragCatId && types.includes('application/x-solace-cat')
  // 外部文件拖到分类/未分类上：提示可「导入并归档到此处」（「全部」不承载归档）
  if (!isDoc && !isCat && types.includes('Files')) {
    if (!li || li.dataset.id === 'all') return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    li.classList.add('drop-hint')
    return
  }
  if ((!isDoc && !isCat) || !dropTargetOk(li, isDoc ? 'doc' : 'cat')) return
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
  const types = e.dataTransfer.types
  const target = li.dataset.id // 'all' | 'none' | 分类id

  // 分类换父级
  const catId = e.dataTransfer.getData('application/x-solace-cat')
  if (catId && !types.includes('application/x-solace-doc')) {
    if (!dropTargetOk(li, 'cat')) return
    e.preventDefault()
    e.stopPropagation()
    catList.querySelectorAll('.drop-hint').forEach(el => el.classList.remove('drop-hint'))
    try {
      await window.solace.moveCategory(catId, target)
      refresh()
      toast(`「${catNameOf(catId)}」已移动到「${catNameOf(target)}」下`)
    } catch (err) {
      toast(`移动失败：${err.message || err}`)
    }
    return
  }

  // 文档归档（原有逻辑）
  const docId = e.dataTransfer.getData('application/x-solace-doc')
  if (!docId) return
  e.preventDefault()
  e.stopPropagation()
  catList.querySelectorAll('.drop-hint').forEach(el => el.classList.remove('drop-hint'))

  const doc = data.documents.find(d => d.id === docId)
  if (!doc) return
  if (target === 'all') { toast('拖到具体分类或「未分类」即可归档'); return }
  const categoryId = target === 'none' ? null : target
  if (doc.categoryId === categoryId) return

  try {
    await window.solace.updateDoc(docId, { categoryId })
    refresh()
    toast(`《${doc.title}》已归档到「${categoryId ? catNameOf(categoryId) : '未分类'}」`)
    burst(e.clientX, e.clientY)
  } catch (err) {
    toast(`归档失败：${err.message || err}`)
  }
})

/* ================= 事件：导入与搜索 ================= */

$('#btnImport').addEventListener('click', async () => {
  try {
    const { imported, errors, duplicates } = await window.solace.importDialog()
    imported.forEach(d => ensureQueued(d.id))
    notifyImport(imported, errors, duplicates)
    refresh()
  } catch (err) {
    toast(`导入失败：${err.message || err}`)
  }
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

$('#btnAddShelf').addEventListener('click', async () => {
  const f = { categoryId: filters.categoryId, tagId: filters.tagId, keyword: filters.keyword }
  if (f.categoryId === undefined && !f.tagId && !f.keyword) {
    toast('先用分类/标签/搜索设一个筛选，再保存为收藏夹')
    return
  }
  const name = await askText('保存当前筛选为收藏夹', suggestedShelfName(f))
  if (!name) return
  try { await window.solace.saveShelf(name, f); refresh() } catch (err) { toast(err.message) }
})

// 命令面板（palette.js）派发的筛选与动作
window.addEventListener('solace-palette', (e) => {
  const d = e.detail || {}
  if (d.type === 'filter') {
    filters.categoryId = d.categoryId === undefined ? undefined : d.categoryId
    filters.tagId = d.tagId || null
    filters.keyword = d.keyword || ''
    fromShelf = false // 命令面板筛选跳转：不提供回退
    entrancePending = true // 命令面板的筛选跳转：播放入场编排
    $('#searchInput').value = filters.keyword
    renderAll()
  } else if (d.type === 'action') {
    if (d.name === 'tool') {
      window.solace.launchTool().catch(err => toast(`启动失败：${err.message || err}`))
      return
    }
    const map = { import: '#btnImport', 'new-cat': '#btnAddCat', 'new-tag': '#btnAddTag', 'save-shelf': '#btnAddShelf', stats: '#btnStats', dormant: '#btnDormant', settings: '#btnSettings' }
    const btn = map[d.name] && $(map[d.name])
    if (btn) btn.click()
  }
})

// 设置面板（settings.js）派发的更改：更新本地偏好并做对应联动。
// 与顶栏快捷开关同源同向——无论从哪边改，都以事件为唯一联动入口
window.addEventListener('solace-settings', (e) => {
  const patch = e.detail || {}
  Object.assign(prefs, patch)
  if ('theme' in patch) applyTheme(prefs)
  if ('viewMode' in patch) { entrancePending = true; fromShelf = false }
  if ('viewMode' in patch || 'coverSize' in patch) renderAll()
  if ('dormantDays' in patch) updateDormantBadge()
  if ('confetti' in patch || 'resumeReading' in patch || 'indexPageLimit' in patch) applySettingFlags()
  if ('openingAnimation' in patch) {
    localStorage.setItem('solace-opening', prefs.openingAnimation === false ? 'off' : 'on')
  }
})

// 资料库位置切换（settings.js 派发）：所有内存态按新库重建——关闭预览
// （旧库的书在新库不存在，翻页进度会全部写失败）、封面缓存清空、
// 筛选复位（旧库的分类/标签 id 在新库无意义）、偏好与索引随 refresh 重载
window.addEventListener('solace-library-moved', async (e) => {
  const res = e.detail || {}
  window.closePreview?.()
  clearCoverCache()
  exitBatch() // 旧库的选中 id 在新库无意义
  fromShelf = false // 新库里「从书架进入」的上下文无意义
  filters.categoryId = undefined
  filters.tagId = null
  filters.keyword = ''
  $('#searchInput').value = ''
  await refresh()
  const head = {
    moved: '资料库已整体移动到新位置',
    adopted: `已切换到该位置的资料库（${res.docCount} 本）`,
    created: '已在新位置创建空资料库'
  }[res.mode] || '资料库位置已更改'
  const tail = res.mode === 'moved' && res.oldRemoved === false
    ? `；旧位置 ${res.oldLocation} 有文件被占用未删净，可稍后手动删除`
    : ''
  toast(head + tail)
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
  // 落点在具体分类/未分类条目上时：导入后直接归档到该分类（拖到哪归到哪）
  const li = document.elementFromPoint(e.clientX, e.clientY)?.closest('#catList li[data-action="filter-cat"]')
  const dropCatId = li && li.dataset.id !== 'all' && li.dataset.id !== 'none' ? li.dataset.id : null
  let result
  try {
    result = await window.solace.importPaths(paths)
  } catch (err) {
    toast(`导入失败：${err.message || err}`)
    return
  }
  const { imported, errors, duplicates } = result
  if (dropCatId && imported.length) {
    for (const d of imported) {
      try { await window.solace.updateDoc(d.id, { categoryId: dropCatId }) } catch { /* 归档失败不掩盖导入结果 */ }
    }
  }
  imported.forEach(d => ensureQueued(d.id))
  notifyImport(imported, errors, duplicates, dropCatId)
  refresh()
})

function notifyImport (imported, errors, duplicates = [], dropCatId = null) {
  const parts = []
  if (imported.length) {
    parts.push(dropCatId
      ? `已入库 ${imported.length} 本并归档到「${catNameOf(dropCatId)}」`
      : `已入库 ${imported.length} 本`)
  }
  if (duplicates.length) parts.push(`跳过重复 ${duplicates.length} 本（内容已在库中）：${duplicates.map(x => `《${x.title}》`).join('、')}`)
  if (errors.length) parts.push(`${errors.length} 个失败：${errors.map(x => x.file).join('、')}`)
  if (parts.length) toast(parts.join('；'))
}

/* ================= 编辑对话框 ================= */

let editingId = null

function openEditDialog (doc) {
  editingId = doc.id
  $('#editTitle').value = doc.title
  // 下拉按树的 DFS 顺序排列，缩进体现层级（不看折叠状态，始终全量）
  $('#editCat').innerHTML = `
    <option value="">未分类</option>
    ${orderedCategories(false).map(({ cat: c, depth }) =>
      `<option value="${c.id}" ${c.id === doc.categoryId ? 'selected' : ''}>${'　'.repeat(depth)}${esc(c.name)}</option>`
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
  try {
    await window.solace.updateDoc(editingId, patch)
  } catch (err) {
    toast(`保存失败：${err.message || err}`)
    return
  }
  $('#editDialog').close()
  refresh()
})

$('#btnEditCancel').addEventListener('click', () => $('#editDialog').close())

/* ================= 阅读足迹与沉睡提醒 ================= */

// 沉睡判定：以「最近一次打开」（从未打开则用入库时间）距今超过阈值天数为准
// （阈值可在设置面板调整，默认 30 天）
function dormantDays () {
  const n = Math.floor(Number(prefs.dormantDays))
  return n >= 1 ? n : DEFAULT_DORMANT_DAYS
}

function dormantDocs () {
  const cutoff = Date.now() - dormantDays() * 86400000
  return data.documents
    .filter(d => new Date(d.openedAt || d.addedAt).getTime() < cutoff)
    .sort((a, b) => new Date(a.openedAt || a.addedAt) - new Date(b.openedAt || b.addedAt))
}

function updateDormantBadge () {
  const n = dormantDocs().length
  const btn = $('#btnDormant')
  btn.hidden = n === 0
  $('#dormantCount').textContent = n
  btn.title = `${n} 本书已沉睡超过 ${dormantDays()} 天`
}

function renderCategoryChart () {
  const chart = $('#statsChart')
  const docs = data.documents
  if (!docs.length) {
    chart.innerHTML = '<span style="color:var(--muted);font-size:12.5px;">还没有藏书，导入后这里会出现分类分布</span>'
    return
  }

  const catStats = [
    ...data.categories.map(c => ({ name: c.name, books: 0, opens: 0 })),
    { name: '未分类', books: 0, opens: 0, misc: true }
  ]
  const indexOfCat = new Map(data.categories.map((c, i) => [c.id, i]))
  for (const d of docs) {
    const i = d.categoryId != null && indexOfCat.has(d.categoryId)
      ? indexOfCat.get(d.categoryId)
      : catStats.length - 1
    catStats[i].books += 1
    catStats[i].opens += d.openCount
  }

  const colored = catStats
    .filter(s => s.books > 0)
    .map((s, i) => ({ ...s, color: s.misc ? MISC_COLOR : PALETTE[i % PALETTE.length] }))

  const total = docs.length
  let acc = 0
  const stops = colored.map(s => {
    const from = (acc / total) * 100
    acc += s.books
    const to = (acc / total) * 100
    return `${s.color} ${from}% ${to}%`
  }).join(', ')

  chart.innerHTML = `
    <div class="donut" style="background: conic-gradient(${stops})">
      <div class="donut-hole"><b>${total}</b><em>本书</em></div>
    </div>
    <ul class="legend">
      ${colored.map(s => `
        <li title="${esc(s.name)}">
          <i style="background:${s.color}"></i>
          <span class="n">${esc(s.name)}</span>
          <span class="v">${s.books} 本 · 翻开 ${s.opens} 次</span>
        </li>`).join('')}
    </ul>`
}

function renderStats () {
  const now = Date.now()
  const docs = data.documents
  const totalOpens = docs.reduce((s, d) => s + d.openCount, 0)
  const inDays = days => (data.history || [])
    .filter(h => now - new Date(h.at).getTime() <= days * 86400000).length
  const dormant = dormantDocs()
  $('#statsDormantHint').textContent = `超过 ${dormantDays()} 天未读`

  $('#statsOverview').innerHTML = `
    <span class="stats-chip"><b>${docs.length}</b>本藏书</span>
    <span class="stats-chip"><b>${totalOpens}</b>次累计翻开</span>
    <span class="stats-chip"><b>${inDays(7)}</b>次近 7 天</span>
    <span class="stats-chip"><b>${inDays(30)}</b>次近 30 天</span>
    <span class="stats-chip"><b>${dormant.length}</b>本沉睡中</span>`

  renderCategoryChart()

  const titleOf = id => {
    const d = docs.find(x => x.id === id)
    return d ? d.title : '（已删除文档）'
  }
  const recent = (data.history || []).slice(-8).reverse()
  $('#statsRecent').innerHTML = recent.length
    ? recent.map(h =>
        // type='read' 是预览翻页产生的足迹，标注来源区分外部打开（旧数据无 type）
        `<li><span class="t">《${esc(titleOf(h.docId))}》</span><span class="when">${h.type === 'read' ? '预览 · ' : ''}${fmtRel(h.at)}</span></li>`
      ).join('')
    : '<li class="empty-line">还没有阅读记录，从封面预览或「打开」开始第一页吧</li>'

  $('#statsDormant').innerHTML = dormant.length
    ? dormant.slice(0, 12).map(d => {
        const last = d.openedAt || d.addedAt
        const days = Math.floor((now - new Date(last).getTime()) / 86400000)
        const reason = d.openCount === 0 ? `入库 ${days} 天，还没翻开过` : `${days} 天没翻开了`
        return `<li><span class="t">《${esc(d.title)}》</span><span class="reason">${reason}</span>` +
          `<button class="btn-ghost" data-action="open-doc" data-id="${d.id}">打开</button></li>`
      }).join('') + (dormant.length > 12 ? `<li class="empty-line">…还有 ${dormant.length - 12} 本</li>` : '')
    : '<li class="empty-line">没有沉睡的书，保持得很好 🌿</li>'
}

$('#btnStats').addEventListener('click', () => { renderStats(); $('#statsDialog').showModal() })
$('#btnStatsClose').addEventListener('click', () => $('#statsDialog').close())
$('#btnDormant').addEventListener('click', () => { renderStats(); $('#statsDialog').showModal() })

/* ================= 预览浮层的关闭按钮 ================= */

// 关闭后刷新列表：预览期间记下的阅读进度（进度环）要立刻反映到卡片上。
// 先等进度落库完成再取数据，避免读写竞争拿到旧进度。
async function closePreviewAndRefresh () {
  await window.closePreview?.()
  refresh()
}

$('#btnPreviewClose').addEventListener('click', closePreviewAndRefresh)
$('#btnPreviewExternal').addEventListener('click', async () => {
  if (window.currentPreviewId) {
    try {
      await window.solace.openDoc(window.currentPreviewId)
      refresh()
    } catch (err) {
      window.toast?.(`打开失败：${err.message || err}`)
    }
  }
})

// 预览打开时按 Esc 关闭（对话框之外的 Esc；有对话框开着时先关对话框）。
// 预览/对话框都不在前台时，若处于「书堆进入的封面态」则 Esc 回退书架
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  const dialogOpen = !!document.querySelector('dialog[open]')
  if (isPreviewOpen() && !dialogOpen) { closePreviewAndRefresh(); return }
  if (!dialogOpen && fromShelf) backToShelf()
})

/* ================= 自动入库事件（主进程推送） ================= */

// 连续落盘会推送多次：刷新做 400ms 防抖合并；toast 文案由主进程聚合成批
let watchRefreshTimer = null
window.solace.onWatchEvent?.((ev) => {
  if (ev.type === 'imported') {
    ev.docs.forEach(d => ensureQueued(d.id))
    const names = ev.docs.slice(0, 3).map(d => `《${d.title}》`).join('、')
    toast(`自动入库 ${ev.docs.length} 本：${names}${ev.docs.length > 3 ? '…' : ''}`)
    clearTimeout(watchRefreshTimer)
    watchRefreshTimer = setTimeout(() => refresh(), 400)
  } else if (ev.type === 'error') {
    toast(`自动入库：${ev.message}`)
  }
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
// 供 preview.js 读毕庆祝等跨模块场景复用
window.toast = toast

/* ================= 全文索引进度提示 ================= */

const indexStatus = $('#indexStatus')

window.addEventListener('solace-index', (e) => {
  const n = e.detail.pending
  indexStatus.hidden = n === 0
  if (n) indexStatus.textContent = `📖 全文索引中… 剩 ${n} 本`
})

// 单本索引完成即刷新列表：让搜索中的全文命中即时出现
window.addEventListener('solace-index-doc', () => {
  if (normText(filters.keyword)) renderDocList()
})

function fmtSize (n) {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
  return Math.max(1, Math.round(n / 1024)) + ' KB'
}

function fmtDate (iso) {
  return iso ? new Date(iso).toLocaleDateString('zh-CN') : '—'
}
