import { openPreview, isPreviewOpen, setResumeEnabled } from './preview.js'
import { ensureCover, coverCache, clearCoverCache } from './covers.js'
import { burst, setConfettiEnabled } from './confetti.js'
import { initIndex, resetIndex, ensureQueued, setIndexPageLimit, textHit, searchTextIndex } from './textindex.js'
import { initTheme, cycleTheme, themeLabel, applyTheme } from './theme.js'
import { normText, esc, fmtRel } from './util.js'
import { askText, askConfirm } from './dialog.js'
import './palette.js' // 命令面板：自带事件注册，引入即生效
import './settings.js' // 设置面板：自带事件注册，引入即生效

let data = null
let refreshSeq = 0
let libraryChanging = false
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

// 偏好缺省值：切库时先清回这里再合并新库的 settings。只做 Object.assign
// 的话，新库没有的键会留着旧库的值（设置是「随库走」的，串味与设计不符）
const PREF_DEFAULTS = {
  theme: 'auto',
  viewMode: 'grid',
  coverSize: 'medium',
  dormantDays: 30,
  indexPageLimit: 1500,
  resumeReading: true,
  confetti: true,
  openingAnimation: true
}

function resetPrefs () {
  for (const k of Object.keys(prefs)) delete prefs[k]
  Object.assign(prefs, PREF_DEFAULTS)
}

// 本次会话实际显示的视图。与 prefs.viewMode 分开的原因：settings.viewMode 是
// 用户选的「启动时的默认视图」，而「从书架点书堆下钻到某个分类」只是临时
// 导航——早先它直接落库改写了 viewMode，用过一次书架就再也回不到「启动即
// 书架」，默认视图被导航动作顶掉了。现在只有用户显式切视图/改设置才落库
let sessionView = null // null = 尚未初始化，首帧从 settings 取

function initSessionView () {
  sessionView = ['grid', 'spine', 'shelf'].includes(prefs.viewMode) ? prefs.viewMode : 'grid'
}

const $ = (sel) => document.querySelector(sel)

function isCurrentLibrary (sessionId) {
  return !libraryChanging && data && data.sessionId === sessionId
}

/* ================= 初始化 ================= */

refresh()

async function refresh () {
  if (libraryChanging) return
  const ticket = ++refreshSeq
  let next
  try {
    next = await window.solace.getLibrary()
  } catch (err) {
    if (ticket === refreshSeq) toast(`资料库读取失败：${err.message || err}`)
    return
  }
  if (libraryChanging || ticket !== refreshSeq || (data && next.sessionId < data.sessionId)) return
  data = next
  Object.assign(prefs, data.settings || {})
  if (sessionView === null) initSessionView() // 首帧（或刚切过库）才从设置取
  applySettingFlags()
  initTheme(prefs)
  syncViewButton()
  renderAll()
  // 每次刷新都同步一次索引状态：缺索引的书会排进后台提取队列
  initIndex(data.documents, data.sessionId)
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
  // 书架总览不显示单本书：应用收藏夹与点分类一样是明确的筛选跳转，
  // 切到封面墙看书（临时导航不落库）。不切的话书堆会无视收藏夹的
  // 分类/标签条件，点击只有侧栏高亮变化，像按钮失灵
  if (sessionView === 'shelf') {
    sessionView = 'grid'
    syncViewButton()
  }
  $('#searchInput').value = filters.keyword
  return refreshTextHits(filters.keyword).then(ok => { if (ok) renderAll() })
}

/* ================= 搜索：全文命中由主进程按需查询 =================
   索引正文留在主进程（textindex/<id>.json 分片），全文命中是异步取回的。
   输入时先按标题/文件名即时出结果，防抖后再补一次带全文命中的渲染；
   searchTicket 保证过期结果不会覆盖新结果 */

let searchTimer = null
let searchTicket = 0

function scheduleFullText (delay) {
  clearTimeout(searchTimer)
  if (libraryChanging) return
  const sessionId = data.sessionId
  const ticket = ++searchTicket
  searchTimer = setTimeout(async () => {
    if (!isCurrentLibrary(sessionId)) return
    await searchTextIndex(filters.keyword, sessionId)
    if (ticket !== searchTicket || !isCurrentLibrary(sessionId)) return
    renderDocList()
  }, delay)
}

// 输入型入口：即时出标题/文件名结果，全文命中稍后补齐
function onKeywordTyped (kw) {
  clearTimeout(searchTimer)
  searchTicket++
  if (!normText(kw)) searchTextIndex('') // 清空搜索：命中表立即作废
  renderDocList()
  if (normText(kw)) scheduleFullText(150)
}

// 非输入型入口（收藏夹 / 命令面板 / 切库）：命中就绪后一并渲染。
// 返回 false 表示期间用户又改了搜索词，本次渲染作废
async function refreshTextHits (kw) {
  clearTimeout(searchTimer)
  if (libraryChanging) return false
  const sessionId = data.sessionId
  const ticket = ++searchTicket
  await searchTextIndex(kw, sessionId)
  return ticket === searchTicket && isCurrentLibrary(sessionId)
}

/* ================= 主区：陈列视图 =================
   grid 封面墙 / spine 书脊 / shelf 书架（分类书堆总览，参考 Lumin） */

// 分类调色板：按顶级分类顺序循环取色。书架书堆与书脊组头经
// topCategoryColor 取色（子分类继承顶级色）；分类分布图表按自己的
// 排序直接索引
const PALETTE = ['#6ea8fe', '#7bd88f', '#ffd166', '#ef8354', '#c792ea', '#4dd0e1', '#f06292', '#aed581', '#ffb74d']
const MISC_COLOR = '#5b6672'

// 未分类与悬空引用（元数据损坏指向已删分类）用补色；
// 其余沿 parentId 上溯到顶级分类后按其在顶级序列中的位置取色
function topCategoryColor (catId) {
  if (!catId) return MISC_COLOR
  const topIndex = new Map(data.categories.filter(c => !c.parentId).map((c, i) => [c.id, i]))
  let c = data.categories.find(x => x.id === catId)
  while (c && c.parentId) c = data.categories.find(x => x.id === c.parentId)
  return c ? PALETTE[topIndex.get(c.id) % PALETTE.length] : MISC_COLOR
}

function visibleDocs () {
  const kw = normText(filters.keyword)
  // 树状筛选：选中的是具体分类时，子孙分类的书一并显示
  const catIds = typeof filters.categoryId === 'string' ? categorySubtreeIds(filters.categoryId) : null
  return data.documents.filter(d => {
    // 未分类口径与 categoryCounts 的 `!d.categoryId` 保持一致：
    // 缺字段（undefined）的历史条目两边都算未分类，不能一边计数一边不显示
    if (filters.categoryId === null && (d.categoryId ?? null) !== null) return false
    if (catIds && !catIds.has(d.categoryId)) return false
    if (filters.tagId && !d.tagIds.includes(filters.tagId)) return false
    // 三级命中：标题 / 文件名 / 全文索引
    if (kw && !normText(d.title).includes(kw) && !normText(d.fileName).includes(kw) && !textHit(d.id, kw)) return false
    return true
  })
}

// 阅读进度百分比（0–100）：无进度记录或页数异常时记 0。
// 封面墙右上角进度环与书脊底部细进度条共用一套口径
function progressPct (d) {
  const pr = d.progress
  return pr && pr.totalPages >= 1 ? Math.min(100, Math.round(pr.page / pr.totalPages * 100)) : 0
}

function renderDocList () {
  // 本次渲染会整体替换 #docGrid 的内容：旧的 <img> 已脱离文档，但
  // IntersectionObserver 仍持有它们的强引用（不回收），所以先断开再重新观察，
  // 否则长会话里反复渲染会持续堆积不可见的 img 节点
  coverObserver.disconnect()
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

  const grid = $('#docGrid')
  // 封面卡片大小（设置 → 外观）：只影响封面墙，书脊/书架视图有各自固定列宽
  const COVER_MIN = { small: '140px', medium: '172px', large: '220px' }
  grid.style.setProperty('--cover-min', COVER_MIN[prefs.coverSize] || COVER_MIN.medium)
  // 书架（分类书堆总览）：无搜索词时生效；一搜索就回退封面墙显示结果
  const shelf = sessionView === 'shelf' && !nkw
  // 书架视图没有勾选语义：批量中清空搜索回到书架时自动退出（本帧内直接
  // 复位，不递归重渲染）
  if (shelf && batchMode) resetBatchState()
  grid.classList.toggle('spine-mode', sessionView === 'spine' && !shelf)
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

  // 书脊陈列：按分类分组（每个分类一行，组内放不下自动换行）
  if (sessionView === 'spine') {
    renderSpineShelves(docs, entrance)
  } else {
    $('#docGrid').innerHTML = docs.map((d, i) => {
      const cached = cache.get(d.id)
      // 阅读进度：封面墙显示右上角进度环（进度环 title 还需要 pr 的原始页码）
      const pr = d.progress
      const pct = progressPct(d)
      // 全文命中标记：标题/文件名没中但正文命中时提示首个命中页
      const hitPage = nkw && !normText(d.title).includes(nkw) && !normText(d.fileName).includes(nkw)
        ? textHit(d.id, nkw)
        : 0

      return `
    <div class="doc-card${entrance ? ' enter' : ''}" data-id="${d.id}" draggable="true" style="--i:${i}">
      <div class="doc-cover" data-action="preview-doc" data-id="${d.id}" title="点击预览">
        ${batchMode ? `<span class="doc-check${batchSelected.has(d.id) ? ' on' : ''}"></span>` : ''}
        <img class="doc-cover-img" data-doc-id="${d.id}" alt="" ${cached ? `src="${cached}"` : ''}/>
        ${pct ? `<div class="progress-ring${pct >= 100 ? ' done' : ''}" style="--p:${pct}" title="读到 ${pr.page}/${pr.totalPages} 页（${pct}%）"><i></i><span>${pct >= 100 ? '✓' : ''}</span></div>` : ''}
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
          ${d.categoryId ? esc(catName[d.categoryId] || '未知') : '未分类'} · ${fmtSize(d.size)} · 翻开 ${d.openCount} 次${pct ? ` · 读到 ${pr.page}/${pr.totalPages} 页` : ''}
        </div>
      </div>
    </div>`
    }).join('')
  }

  // 没有缓存的封面交给观察器：滚动可见时才读取/生成（三个陈列视图共用）
  for (const img of document.querySelectorAll('.doc-cover-img:not([src])')) {
    const doc = data.documents.find(x => x.id === img.dataset.docId)
    if (doc) coverObserver.observe(img)
  }
}

/* ================= 书脊视图：分类分组陈列 =================
   每个分类独占一行，组内 flex-wrap——一行放不下的书脊自动排进下一行，
   不再把所有分类挤作一排。组序与侧栏分类树一致（父前子后），
   「未分类」收尾；只列有书的分类，空分类没有书脊可排。 */

function renderSpineShelves (docs, entrance) {
  const cache = coverCache()
  const byCat = new Map()
  for (const d of docs) {
    // 未分类口径与 visibleDocs 一致（?? null：空串不算未分类）
    const key = d.categoryId ?? null
    if (!byCat.has(key)) byCat.set(key, [])
    byCat.get(key).push(d)
  }
  const groups = orderedCategories(false)
    .filter(({ cat }) => byCat.has(cat.id))
    .map(({ cat }) => ({ key: cat.id, name: cat.name, docs: byCat.get(cat.id) }))
  // 兜底：指向已不存在分类的书（元数据损坏）不从书脊视图凭空消失
  const known = new Set(groups.map(g => g.key))
  for (const [key, ds] of byCat) {
    if (key && !known.has(key)) groups.push({ key, name: '未知', docs: ds })
  }
  if (byCat.has(null)) groups.push({ key: null, name: '未分类', docs: byCat.get(null) })

  let i = 0 // 入场 stagger 序号跨组连续：整墙书脊按序错峰入场
  $('#docGrid').innerHTML = groups.map(g => `
    <section class="spine-group">
      <div class="spine-group-head">
        <span class="pile-dot" style="background:${topCategoryColor(g.key)}"></span>
        <span class="spine-group-name">${esc(g.name)}</span>
        <span class="pile-badge">${g.docs.length} 本</span>
      </div>
      <div class="spine-row">${
        g.docs.map(d => {
          const cached = cache.get(d.id)
          const pct = progressPct(d)
          return `
        <div class="doc-card${entrance ? ' enter' : ''}" data-id="${d.id}" draggable="true" style="--i:${i++}">
          <div class="doc-cover" data-action="preview-doc" data-id="${d.id}"
               title="${esc(d.title)}${pct ? `（读到 ${pct}%）` : ''} · 点击预览">
            <img class="doc-cover-img" data-doc-id="${d.id}" alt="" ${cached ? `src="${cached}"` : ''}/>
            <span class="spine-name">${esc(d.title)}</span>
            ${pct ? `<i class="spine-progress${pct >= 100 ? ' done' : ''}" style="--p:${pct}"></i>` : ''}
          </div>
        </div>`
        }).join('')
      }</div>
    </section>`).join('')
}

/* ================= 顶栏：视图与主题切换 ================= */

// 视图循环：封面墙 → 书脊 → 书架（分类书堆总览）→ 封面墙
const VIEW_ORDER = ['grid', 'spine', 'shelf']
const VIEW_LABEL = { grid: '📚 封面', spine: '📖 书脊', shelf: '🏛 书架' }
const VIEW_TITLE = { grid: '切换到书脊视图', spine: '切换到书架（分类书堆）', shelf: '切换到封面墙' }

// 实际渲染的视图：书架是分类总览页，搜索中自动回退封面墙显示结果
// （sessionView 保持书架，清空搜索即回到书堆）
function effectiveView () {
  return sessionView === 'shelf' && normText(filters.keyword) ? 'grid' : sessionView
}

function syncViewButton () {
  const v = effectiveView()
  const btn = $('#btnView')
  btn.textContent = VIEW_LABEL[v] || VIEW_LABEL.grid
  btn.title = VIEW_TITLE[v] || ''
}

$('#btnView').addEventListener('click', async () => {
  if (!data || libraryChanging) return
  const sessionId = data.sessionId
  exitBatch() // 批量管理只在封面墙提供：切视图即退出
  fromShelf = false // 用户主动切视图：回退语义失效
  entrancePending = true // 明确的视图切换：播放入场编排
  const next = VIEW_ORDER[(VIEW_ORDER.indexOf(effectiveView()) + 1) % VIEW_ORDER.length]
  sessionView = next
  prefs.viewMode = next
  if (next === 'shelf') {
    // 书架是分类总览：进来时清空筛选，与 Lumin「返回书架退出搜索态」一致
    filters.categoryId = undefined
    filters.tagId = null
    filters.keyword = ''
    $('#searchInput').value = ''
    searchTextIndex('') // 命中表随搜索词一起作废
  }
  syncViewButton()
  renderAll()
  try { await window.solace.updateSettings({ viewMode: next }, sessionId) } catch { /* 保存失败不影响本次切换 */ }
})

$('#btnTheme').addEventListener('click', async () => {
  if (!data || libraryChanging) return
  const sessionId = data.sessionId
  const patch = cycleTheme(prefs)
  try { await window.solace.updateSettings(patch, sessionId) } catch { /* 保存失败不影响本次切换 */ }
  if (!isCurrentLibrary(sessionId)) return
  toast(`主题：${themeLabel()}`)
})

/* ================= 顶栏溢出菜单（平板评审 3.3） =================
   ⌘K / 主题 / 足迹 / 设置 收进「⋯」。这几个按钮的 ID 与既有监听全部保留，
   故只是换了位置、业务逻辑零改动。
   生命周期收口：点触发器切换、点菜单项后收起、点菜单外收起、Esc 收起。
   收起用捕获相监听 document，避免与卡片/侧栏的事件委托互相干扰。 */
const topbarMore = $('#topbarMore')
const topbarMoreTrigger = $('#btnTopbarMore')

function closeTopbarMore () {
  topbarMore.classList.remove('open')
  topbarMoreTrigger.classList.remove('on')
  topbarMoreTrigger.setAttribute('aria-expanded', 'false')
}

topbarMoreTrigger.addEventListener('click', (e) => {
  e.stopPropagation()
  const open = !topbarMore.classList.contains('open')
  topbarMore.classList.toggle('open', open)
  topbarMoreTrigger.classList.toggle('on', open)
  topbarMoreTrigger.setAttribute('aria-expanded', String(open))
})

// 点菜单项即收起。**必须排除触发器**：stopPropagation 只挡冒泡、不挡同一
// 元素上的其它监听器，而 .topbar-more 自己的 click 监听会收到来自触发器
// 子元素的事件——不排除就会「开→立即关」
topbarMore.addEventListener('click', (e) => {
  const btn = e.target.closest('button')
  if (btn && btn !== topbarMoreTrigger) closeTopbarMore()
})

// 点菜单外收起（同样把触发器排除，交由它自己的 toggle 处理）
document.addEventListener('click', (e) => {
  if (!topbarMore.classList.contains('open')) return
  if (topbarMoreTrigger.contains(e.target)) return
  if (!topbarMore.contains(e.target)) closeTopbarMore()
})

// Esc 收起菜单；菜单没开时不拦（把 Esc 让给书架的返回总览等既有语义）
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !topbarMore.classList.contains('open')) return
  e.stopPropagation()
  closeTopbarMore()
}, true)

// 卡片进入可视区域后再取/生成封面，导入大图书馆时首屏不被拖慢
const coverObserver = new IntersectionObserver((entries) => {
  for (const en of entries) {
    if (!en.isIntersecting) continue
    const img = en.target
    coverObserver.unobserve(img)
    const doc = data && data.documents.find(x => x.id === img.dataset.docId)
    if (doc && !libraryChanging) ensureCover(doc, img, data.sessionId)
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
  const piles = topCats.map(c => ({
    key: c.id,
    name: c.name,
    color: topCategoryColor(c.id),
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

// 点书堆 → 应用分类筛选并切到封面墙（对应 Lumin「点堆进入网格」）。
// 这是临时导航：只改本次会话的视图，不落库——否则用户设的「启动即书架」
// 会被一次下钻永久顶掉
async function openPile (key) {
  filters.categoryId = key === 'none' ? null : key
  sessionView = 'grid'
  fromShelf = true // 由书堆进入：允许一步回退到书架总览
  entrancePending = true // 点书堆进入封面墙：播放入场编排
  syncViewButton()
  renderAll()
  $('#docGrid').scrollTo({ top: 0 })
}

// 一步回退到书架总览：清筛选与搜索（书架本就是总览态）、播入场、落库
function backToShelf () {
  if (!fromShelf) return
  fromShelf = false
  sessionView = 'shelf'
  prefs.viewMode = 'shelf'
  filters.categoryId = undefined
  filters.tagId = null
  filters.keyword = ''
  $('#searchInput').value = ''
  searchTextIndex('') // 命中表随搜索词一起作废
  entrancePending = true
  syncViewButton()
  renderAll()
  window.solace.updateSettings({ viewMode: 'shelf' }, data.sessionId).catch(() => {})
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

// 归档下拉的选项随分类树重建（DFS 顺序、缩进体现层级，不看折叠状态）。
// 用「分类树签名」门控：数据刷新（索引完成/自动入库等触发的重渲染）但
// 分类树没变时跳过重建——否则用户正打开的下拉会被击落、选中项被重置
let batchCatSig = ''
function updateBatchCategoryOptions () {
  const sig = data.categories.map(c => `${c.id}:${c.parentId || ''}:${c.name}`).join('|')
  if (sig === batchCatSig) return
  batchCatSig = sig
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
// 已在目标分类的选中项跳过并计入提示；归档完成后清空选中——否则上一批
// 勾选残留进下一批，会把已归好的书一并挪进新选的分类（全部失败时保留，
// 便于原地重试）
$('#batchCategory').addEventListener('change', async (e) => {
  if (!data || libraryChanging) return
  const sessionId = data.sessionId
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
    if (!isCurrentLibrary(sessionId)) return
    try { await window.solace.updateDoc(id, { categoryId: target }, sessionId); done++ }
    catch { /* 过期选中项（已被删除）等，跳过 */ }
  }
  if (!isCurrentLibrary(sessionId)) return
  if (done > 0) batchSelected.clear() // 本批已落库：选中即视为消费完毕，下一批从零勾起
  refresh()
  const skipped = ids.length - done
  toast(skipped > 0
    ? `已将 ${done} 本归档到「${name}」（${skipped} 本处理失败）`
    : `已将 ${done} 本归档到「${name}」`)
})

// 整批统一一次「是否同时删笔记」勾选（沿用单个删除的确认框语义，默认勾选）
$('#btnBatchDel').addEventListener('click', async () => {
  if (!data || libraryChanging) return
  const sessionId = data.sessionId
  const ids = [...batchSelected].filter(id => data.documents.some(d => d.id === id))
  if (!ids.length) return
  const res = await askConfirm({
    title: `批量删除 ${ids.length} 本文档`,
    text: '所选书籍将从书架移除，库内副本与封面一并删除（原文件不受影响）。',
    checkLabel: '同时删除所选书籍的全部笔记（移入系统回收站）',
    okText: '删除',
    checkDefault: false // 默认保留笔记：误按回车不该丢内容
  })
  if (!res || !isCurrentLibrary(sessionId)) return
  let removed = 0
  const keptNotes = []
  const leftovers = new Set()
  let purged = 0
  for (const id of ids) {
    if (!isCurrentLibrary(sessionId)) return
    try {
      const out = await window.solace.removeDoc(id, { keepNotes: !res.checked }, sessionId)
      removed++
      if (out.notesKeptTo) keptNotes.push(out.notesKeptTo)
      if (out.notesPurged) purged++
      for (const l of out.leftovers || []) leftovers.add(l)
    } catch { /* 过期选中项（已被删除）等，跳过 */ }
  }
  if (!isCurrentLibrary(sessionId)) return
  batchSelected.clear()
  refresh()
  const parts = [`已删除 ${removed} 本`]
  if (keptNotes.length) parts.push(`${keptNotes.length} 本的笔记保留在资料库 notes/ 下`)
  if (purged) parts.push(`${purged} 本的笔记已永久删除（系统回收站不可用）`)
  if (leftovers.size) parts.push(`${leftovers.size} 个文件正被占用，重启应用后自动清理`)
  toast(parts.join('；'))
})

/* ================= 事件：全局委托 ================= */

document.body.addEventListener('click', async (e) => {
  if (!data || libraryChanging) return
  const sessionId = data.sessionId
  const el = e.target.closest('[data-action]')
  if (!el) return
  const { action, id } = el.dataset

  try {
    switch (action) {
      case 'filter-cat': {
        filters.categoryId = id === 'all' ? undefined : id === 'none' ? null : id
        fromShelf = false // 侧栏分类不是书堆入口：不提供回退
        entrancePending = true // 明确的筛选切换：播放入场编排
        // 书架总览不显示单本书：点了分类就切到封面墙看书。
        // 与书堆下钻同理，这是临时导航，只改会话视图不落库
        if (sessionView === 'shelf') {
          sessionView = 'grid'
          syncViewButton()
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
        if (name && isCurrentLibrary(sessionId)) { await window.solace.addCategory(name, null, sessionId); refresh() }
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
        if (name && isCurrentLibrary(sessionId)) { await window.solace.addCategory(name, id, sessionId); refresh() }
        break
      }
      case 'apply-shelf': {
        const shelf = (data.smartShelves || []).find(s => s.id === id)
        if (shelf) await applyShelf(shelf)
        break
      }
      case 'rename-shelf': {
        const shelf = (data.smartShelves || []).find(s => s.id === id)
        if (!shelf) break
        const name = await askText('重命名收藏夹', shelf.name)
        if (name && name !== shelf.name && isCurrentLibrary(sessionId)) { await window.solace.renameShelf(id, name, sessionId); refresh() }
        break
      }
      case 'del-shelf': {
        const res = await askConfirm({ title: '删除收藏夹', text: '只移除筛选组合，不影响藏书。', okText: '删除' })
        if (res && isCurrentLibrary(sessionId)) {
          await window.solace.removeShelf(id, sessionId)
          refresh()
        }
        break
      }
      case 'filter-tag': {
        filters.tagId = filters.tagId === id ? null : id
        fromShelf = false
        entrancePending = true
        // 书架总览不显示单本书：点了标签同样切到封面墙看书（与 filter-cat
        // 同语义）。书堆只按分类组织、无视标签筛选，不切视图的话这次点击
        // 只有侧栏高亮在变；残留的 tagId 还会在之后下钻书堆时叠加出
        // 「莫名筛得更少」的结果
        if (sessionView === 'shelf') {
          sessionView = 'grid'
          syncViewButton()
        }
        renderAll()
        break
      }
      case 'rename-cat': {
        const cat = data.categories.find(c => c.id === id)
        if (!cat) break
        const name = await askText('重命名分类', cat.name)
        if (name && name !== cat.name && isCurrentLibrary(sessionId)) { await window.solace.renameCategory(id, name, sessionId); refresh() }
        break
      }
      case 'del-cat': {
        const res = await askConfirm({
          title: '删除分类',
          text: '子分类与直属文档将上移到其父分类（顶级分类的文档变为未分类）。',
          okText: '删除'
        })
        if (res && isCurrentLibrary(sessionId)) {
          if (filters.categoryId === id) filters.categoryId = undefined
          await window.solace.removeCategory(id, sessionId)
          refresh()
        }
        break
      }
      case 'del-tag': {
        const res = await askConfirm({ title: '删除标签', text: '会同时从所有文档上移除。', okText: '删除' })
        if (res && isCurrentLibrary(sessionId)) {
          if (filters.tagId === id) filters.tagId = null
          await window.solace.removeTag(id, sessionId)
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
        await window.solace.openDoc(id, sessionId)
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
          okText: '删除',
          checkDefault: false // 默认保留笔记：误按回车不该丢内容
        })
        if (res && isCurrentLibrary(sessionId)) {
          const out = await window.solace.removeDoc(id, { keepNotes: !res.checked }, sessionId)
          if (!isCurrentLibrary(sessionId)) return
          refresh()
          const parts = []
          if (out.notesKeptTo) parts.push(`笔记已保留在资料库 notes/${out.notesKeptTo}/`)
          if (out.notesPurged) parts.push('笔记已永久删除（系统回收站不可用）')
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
  if (!data || libraryChanging) return
  const sessionId = data.sessionId
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
      await window.solace.moveCategory(catId, target, sessionId)
      if (!isCurrentLibrary(sessionId)) return
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
    await window.solace.updateDoc(docId, { categoryId }, sessionId)
    if (!isCurrentLibrary(sessionId)) return
    refresh()
    toast(`《${doc.title}》已归档到「${categoryId ? catNameOf(categoryId) : '未分类'}」`)
    burst(e.clientX, e.clientY)
  } catch (err) {
    toast(`归档失败：${err.message || err}`)
  }
})

/* ================= 事件：导入与搜索 ================= */

$('#btnImport').addEventListener('click', async () => {
  if (!data || libraryChanging) return
  const sessionId = data.sessionId
  try {
    const { imported, errors, duplicates } = await window.solace.importDialog(sessionId)
    if (libraryChanging || data.sessionId !== sessionId) return
    imported.forEach(d => ensureQueued(d.id, sessionId))
    notifyImport(imported, errors, duplicates)
    refresh()
  } catch (err) {
    toast(`导入失败：${err.message || err}`)
  }
})

$('#searchInput').addEventListener('input', (e) => {
  filters.keyword = e.target.value
  onKeywordTyped(filters.keyword)
})

$('#btnAddCat').addEventListener('click', async () => {
  if (!data || libraryChanging) return
  const sessionId = data.sessionId
  const name = await askText('新建分类')
  if (name && isCurrentLibrary(sessionId)) { try { await window.solace.addCategory(name, null, sessionId); refresh() } catch (err) { toast(err.message) } }
})

$('#btnAddTag').addEventListener('click', async () => {
  if (!data || libraryChanging) return
  const sessionId = data.sessionId
  const name = await askText('新建标签')
  if (name && isCurrentLibrary(sessionId)) { try { await window.solace.addTag(name, sessionId); refresh() } catch (err) { toast(err.message) } }
})

$('#btnAddShelf').addEventListener('click', async () => {
  if (!data || libraryChanging) return
  const sessionId = data.sessionId
  const f = { categoryId: filters.categoryId, tagId: filters.tagId, keyword: filters.keyword }
  if (f.categoryId === undefined && !f.tagId && !f.keyword) {
    toast('先用分类/标签/搜索设一个筛选，再保存为收藏夹')
    return
  }
  const name = await askText('保存当前筛选为收藏夹', suggestedShelfName(f))
  if (!name || !isCurrentLibrary(sessionId)) return
  try { await window.solace.saveShelf(name, f, sessionId); refresh() } catch (err) { toast(err.message) }
})

// 命令面板（palette.js）派发的筛选与动作
window.addEventListener('solace-palette', async (e) => {
  if (libraryChanging) return
  const d = e.detail || {}
  if (d.type === 'filter') {
    filters.categoryId = d.categoryId === undefined ? undefined : d.categoryId
    filters.tagId = d.tagId || null
    filters.keyword = d.keyword || ''
    fromShelf = false // 命令面板筛选跳转：不提供回退
    entrancePending = true // 命令面板的筛选跳转：播放入场编排
    // 书架总览不显示单本书：面板跳分类/标签同样切到封面墙（与 filter-cat 同语义）
    if (sessionView === 'shelf') {
      sessionView = 'grid'
      syncViewButton()
    }
    $('#searchInput').value = filters.keyword
    if (await refreshTextHits(filters.keyword)) renderAll()
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

// 命令面板关闭：恢复主窗口的全文命中表。面板与主窗口共用 textindex.js 的
// 模块级命中表，面板打开即清空、输入即覆盖；不恢复的话，主窗口还挂着的
// 搜索在下一次重渲染（自动入库刷新、切视图等）时会丢掉「仅正文命中」的书。
// 主窗口没有关键词时命中表本就该是空的，不必动；执行面板动作（换筛选/开书）
// 时本监听与 solace-palette 会先后触发，refreshTextHits 的 ticket 机制保证
// 只有最后一次查询生效，不会互相覆盖
window.addEventListener('solace-palette-closed', async () => {
  if (!normText(filters.keyword)) return
  if (await refreshTextHits(filters.keyword)) renderDocList()
})

// 设置面板（settings.js）派发的更改：更新本地偏好并做对应联动。
// 与顶栏快捷开关同源同向——无论从哪边改，都以事件为唯一联动入口
window.addEventListener('solace-settings', (e) => {
  const patch = e.detail || {}
  Object.assign(prefs, patch)
  if ('theme' in patch) applyTheme(prefs)
  if ('viewMode' in patch) {
    // 设置面板改的是「启动时的默认视图」：当前会话也跟着切过去（与旧行为一致）
    sessionView = patch.viewMode
    entrancePending = true
    fromShelf = false
    // 书架是分类总览页，不显示单本书：切进来时清空筛选（与顶栏按钮同语义）。
    // 否则网格里正挂着的分类/标签筛选会被书堆无视，看起来像「切了没反应」；
    // 残留条件还会在之后下钻书堆时叠加出更窄的结果
    if (patch.viewMode === 'shelf') {
      filters.categoryId = undefined
      filters.tagId = null
      filters.keyword = ''
      $('#searchInput').value = ''
      searchTextIndex('') // 命中表随搜索词一起作废
    }
  }
  if ('viewMode' in patch || 'coverSize' in patch) renderAll()
  if ('dormantDays' in patch) updateDormantBadge()
  if ('confetti' in patch || 'resumeReading' in patch || 'indexPageLimit' in patch) applySettingFlags()
  if ('openingAnimation' in patch) {
    localStorage.setItem('solace-opening', prefs.openingAnimation === false ? 'off' : 'on')
  }
})

// Settings awaits this before sending relocation IPC, while progress still
// belongs to the old library. Late refreshes and background jobs are invalidated.
window.prepareLibraryChange = async () => {
  libraryChanging = true
  window.libraryChanging = true
  window.dispatchEvent(new CustomEvent('solace-library-changing'))
  refreshSeq++
  clearTimeout(watchRefreshTimer)
  clearTimeout(searchTimer)
  searchTicket++
  coverObserver.disconnect()
  clearCoverCache()
  resetIndex()
  await window.closePreview?.()
}

window.addEventListener('solace-library-change-cancelled', async () => {
  libraryChanging = false
  window.libraryChanging = false
  const sessionId = data?.sessionId
  await refresh()
  if (isCurrentLibrary(sessionId) && await refreshTextHits(filters.keyword)) renderDocList()
})

window.addEventListener('solace-library-moved', async (e) => {
  const res = e.detail || {}
  refreshSeq++
  clearCoverCache()
  resetIndex()
  libraryChanging = false
  window.libraryChanging = false
  exitBatch() // 旧库的选中 id 在新库无意义
  fromShelf = false // 新库里「从书架进入」的上下文无意义
  sessionView = null // 视图偏好随库走：下次 refresh 从新库的 settings 取
  resetPrefs() // 旧库的偏好不残留（新库缺该键时不会沿用旧值）
  filters.categoryId = undefined
  filters.tagId = null
  filters.keyword = ''
  $('#searchInput').value = ''
  searchTextIndex('') // 命中表随搜索词一起作废
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
  if (!data || libraryChanging) return
  const sessionId = data.sessionId
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
    result = await window.solace.importPaths(paths, sessionId)
  } catch (err) {
    toast(`导入失败：${err.message || err}`)
    return
  }
  if (libraryChanging || data.sessionId !== sessionId) return
  const { imported, errors, duplicates } = result
  if (dropCatId && imported.length) {
    for (const d of imported) {
      if (!isCurrentLibrary(sessionId)) return
      try { await window.solace.updateDoc(d.id, { categoryId: dropCatId }, sessionId) } catch { /* 归档失败不掩盖导入结果 */ }
    }
  }
  if (!isCurrentLibrary(sessionId)) return
  imported.forEach(d => ensureQueued(d.id, sessionId))
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
let editingSession

function openEditDialog (doc) {
  editingId = doc.id
  editingSession = data.sessionId
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
  const sessionId = editingSession
  if (!isCurrentLibrary(sessionId)) return
  const patch = {
    title: $('#editTitle').value.trim() || '未命名文档',
    categoryId: $('#editCat').value || null,
    tagIds: [...$('#editTags').querySelectorAll('input:checked')].map(i => i.value)
  }
  try {
    await window.solace.updateDoc(editingId, patch, sessionId)
  } catch (err) {
    toast(`保存失败：${err.message || err}`)
    return
  }
  if (!isCurrentLibrary(sessionId)) return
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

async function renderStats () {
  const now = Date.now()
  const docs = data.documents
  const totalOpens = docs.reduce((s, d) => s + d.openCount, 0)
  // 近 7/30 天次数由主进程按天立账算出（history 有 200 条上限，不能拿来
  // 做时间窗口统计，否则翻多了数字会互相打架）
  let opens7d = 0
  let opens30d = 0
  try {
    const s = await window.solace.getOpenStats()
    opens7d = s.opens7d
    opens30d = s.opens30d
  } catch { /* 统计取不到就显示 0，不影响其余面板 */ }
  const dormant = dormantDocs()
  $('#statsDormantHint').textContent = `超过 ${dormantDays()} 天未读`

  $('#statsOverview').innerHTML = `
    <span class="stats-chip"><b>${docs.length}</b>本藏书</span>
    <span class="stats-chip"><b>${totalOpens}</b>次累计翻开</span>
    <span class="stats-chip"><b>${opens7d}</b>次近 7 天</span>
    <span class="stats-chip"><b>${opens30d}</b>次近 30 天</span>
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

$('#btnStats').addEventListener('click', async () => { await renderStats(); $('#statsDialog').showModal() })
$('#btnStatsClose').addEventListener('click', () => $('#statsDialog').close())
$('#btnDormant').addEventListener('click', async () => { await renderStats(); $('#statsDialog').showModal() })

/* ================= 预览浮层的关闭按钮 ================= */

// 关闭后刷新列表：预览期间记下的阅读进度（进度环）要立刻反映到卡片上。
// 先等进度落库完成再取数据，避免读写竞争拿到旧进度。
async function closePreviewAndRefresh () {
  try { await window.closePreview?.() } catch (err) { toast(`阅读进度保存失败：${err.message || err}`) }
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
// 预览/对话框都不在前台时，若处于「书堆进入的封面态」则 Esc 回退书架。
// 输入控件内的 Esc 让位给原生行为（搜索框还原搜索词、下拉收起）——
// 否则一次按键既还原输入又跳回书架，双动作太突然
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  const tag = e.target && e.target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
  const dialogOpen = !!document.querySelector('dialog[open]')
  if (isPreviewOpen() && !dialogOpen) { closePreviewAndRefresh(); return }
  if (!dialogOpen && fromShelf) backToShelf()
})

/* ================= 自动入库事件（主进程推送） ================= */

// 连续落盘会推送多次：刷新做 400ms 防抖合并；toast 文案由主进程聚合成批
let watchRefreshTimer = null
window.solace.onWatchEvent?.((ev) => {
  if (libraryChanging || (ev.sessionId !== undefined && ev.sessionId !== data?.sessionId)) return
  if (ev.type === 'imported') {
    ev.docs.forEach(d => ensureQueued(d.id, data.sessionId))
    const names = ev.docs.slice(0, 3).map(d => `《${d.title}》`).join('、')
    toast(`自动入库 ${ev.docs.length} 本：${names}${ev.docs.length > 3 ? '…' : ''}`)
    clearTimeout(watchRefreshTimer)
    watchRefreshTimer = setTimeout(() => refresh(), 400)
  } else if (ev.type === 'error') {
    toast(`自动入库：${ev.message}`)
  }
})

/* ================= 工具函数 ================= */

// text：提示文案（textContent 写入，无需转义）
// ms：停留时长，默认 2.2s；需要用户看清的长文案（如预览加载失败）可传更长
function toast (text, ms = 2200) {
  const box = $('#toastBox')
  const el = document.createElement('div')
  el.className = 'toast'
  el.textContent = text
  box.appendChild(el)
  setTimeout(() => el.classList.add('out'), ms)
  setTimeout(() => el.remove(), ms + 500)
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

// 单本索引完成即重查全文命中：防抖合并，整库建索引期间不会每完成一本
// 就整表重渲染一次
window.addEventListener('solace-index-doc', () => {
  if (normText(filters.keyword)) scheduleFullText(300)
})

function fmtSize (n) {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
  return Math.max(1, Math.round(n / 1024)) + ' KB'
}
