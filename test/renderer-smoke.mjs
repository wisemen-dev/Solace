/* 渲染层冒烟台：用最小 DOM 桩真实执行 src/renderer/js 下的模块，跑通
   「模块初始化 → 首屏渲染 → 搜索 → 视图切换 → 足迹面板 → 预览/笔记」的
   主链路，把纯 UI 状态逻辑（异步搜索接线、书架下钻语义、切库状态重建等）
   变成可回归的断言——这些是单测 library.js 覆盖不到的部分。

   跑法：npm run test:renderer
   （需要 --experimental-vm-modules：Node 的 vm 模块 ESM 支持还是实验特性，
   所以它不并进默认的 `npm test`。） */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

// 没带 --experimental-vm-modules 时给出可读提示而不是抛难懂的 TypeError
if (typeof vm.SourceTextModule !== 'function') {
  console.log('跳过渲染层冒烟台：请用 `npm run test:renderer`（需要 --experimental-vm-modules）')
  process.exit(0)
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const JS_DIR = path.resolve(__dirname, '../src/renderer/js')

const results = {}
const check = (name, cond, extra) => {
  results[name] = { pass: !!cond, ...(extra !== undefined ? { detail: extra } : {}) }
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`, extra !== undefined ? JSON.stringify(extra) : '')
}

/* ---------------- DOM 桩 ---------------- */
const ctx2d = new Proxy({}, { get: () => () => {} })
function makeEl (tag = 'div') {
  const el = {
    tagName: String(tag).toUpperCase(),
    dataset: {}, value: '', textContent: '', innerHTML: '',
    hidden: false, disabled: false, checked: false, open: false, className: '',
    clientWidth: 900, clientHeight: 600,
    _listeners: {}, _classes: new Set(), _style: {},
    style: { setProperty (k, v) { el._style[k] = v }, getPropertyValue (k) { return el._style[k] } },
    classList: {
      add (c) { el._classes.add(c) },
      remove (c) { el._classes.delete(c) },
      toggle (c, on) { if (on === undefined) el._classes.has(c) ? el._classes.delete(c) : el._classes.add(c); else on ? el._classes.add(c) : el._classes.delete(c) },
      contains (c) { return el._classes.has(c) }
    },
    addEventListener (t, fn) { (el._listeners[t] = el._listeners[t] || []).push(fn) },
    removeEventListener () {},
    emit (t, ev = {}) { for (const fn of el._listeners[t] || []) fn(Object.assign({ target: el, preventDefault () {}, stopPropagation () {} }, ev)) },
    appendChild () {}, remove () {}, setAttribute () {}, focus () {}, select () {}, blur () {},
    showModal () { el.open = true }, close () { el.open = false },
    querySelector () { return null }, querySelectorAll () { return [] }, closest () { return null },
    contains () { return false }, scrollTo () {}, scrollIntoView () {},
    getBoundingClientRect () { return { left: 0, top: 0, width: 100, height: 100 } },
    getContext () { return ctx2d },
    toDataURL () { return 'data:image/jpeg;base64,AAAA' }
  }
  return el
}
const els = new Map()
const el = (sel) => {
  if (!els.has(sel)) els.set(sel, makeEl(sel.startsWith('#btn') || sel.startsWith('#set') || sel.startsWith('#input') ? 'button' : 'div'))
  return els.get(sel)
}
const documentStub = {
  documentElement: makeEl('html'),
  body: makeEl('body'),
  querySelector: (s) => el(s),
  querySelectorAll: () => [],
  getElementById: (id) => el('#' + id),
  createElement: (t) => makeEl(t),
  addEventListener () {}, removeEventListener () {},
  elementFromPoint: () => null,
  startViewTransition: null
}

/* ---------------- window.solace 桩 ---------------- */
const LIB = {
  categories: [{ id: 'c1', name: '技术', parentId: null }],
  tags: [{ id: 't1', name: 'rust' }],
  smartShelves: [{ id: 's1', name: '技术书', filters: { categoryId: 'c1', tagId: null, keyword: '' } }],
  settings: { theme: 'ink', viewMode: 'grid' },
  history: new Array(200).fill(0).map((_, i) => ({ docId: 'd1', at: new Date(Date.now() - i * 3600 * 1000).toISOString(), type: 'open' })),
  documents: [
    { id: 'd1', title: 'Rust 程序设计语言', fileName: 'rust.pdf', size: 1024, addedAt: '2026-01-01T00:00:00.000Z', openedAt: null, openCount: 3, categoryId: 'c1', tagIds: ['t1'] },
    { id: 'd2', title: '无关标题', fileName: 'other.pdf', size: 2048, addedAt: '2026-01-02T00:00:00.000Z', openedAt: null, openCount: 0, categoryId: null, tagIds: [] }
  ]
}
// d2 只在正文里命中「rust」
const FULLTEXT = { d2: 4 }
const calls = { search: [], status: 0, updateSettings: [], openStats: 0, watchCb: null, markRead: [], trash: [] }
// 当前生效的资料库对象：切库用例会把 calls.lib 换成新库
const currentLib = () => calls.lib || LIB

// 可控的 listNotes：用来构造「笔记面板异步竞态」（B7）
let notesDeferred = null
const makeDeferred = () => { let r; const p = new Promise(res => { r = res }); return { p, resolve: r } }

const solace = {
  getLibrary: async () => JSON.parse(JSON.stringify(currentLib())),
  getLibraryInfo: async () => ({ rootDir: 'X', canRelocate: true }),
  // history 有 200 条、若按旧口径直接数数组会得到「近 7 天 168 / 近 30 天 200」，
  // 按天账则是 11 / 42——断言里认的就是后者
  getOpenStats: async () => { calls.openStats++; return { opens7d: 11, opens30d: 42 } },
  getTextIndexStatus: async () => { calls.status++; return { d1: { ver: 2, failed: false } } },
  searchTextIndex: async (kw) => { calls.search.push(kw); return /rust/.test(kw) ? FULLTEXT : {} },
  setTextIndex: async () => true,
  readPreview: async () => new Uint8Array([1, 2, 3]),
  getCover: async () => null,
  setCover: async () => true,
  updateSettings: async (p) => {
    calls.updateSettings.push(p)
    // 模仿主进程白名单：只接受合法枚举值，其余原样留在存储里（用于验证
    //「设置面板广播的是实际落库值，而不是提交值」）
    const s = currentLib().settings
    if (['small', 'medium', 'large'].includes(p.coverSize)) s.coverSize = p.coverSize
    if (['auto', 'ink', 'paper', 'dusk'].includes(p.theme)) s.theme = p.theme
    if (['grid', 'spine', 'shelf'].includes(p.viewMode)) s.viewMode = p.viewMode
    if (Number.isFinite(p.dormantDays) && p.dormantDays >= 1) s.dormantDays = p.dormantDays
    return s
  },
  listNotes: async (id) => {
    if (notesDeferred) return notesDeferred.p
    return { notes: id === 'd1' ? [{ file: 'A书笔记.md', mtime: new Date().toISOString(), birth: new Date().toISOString(), size: 1 }] : [] }
  },
  onWatchEvent: (cb) => { calls.watchCb = cb },
  markRead: async (id) => { calls.markRead.push(id); return true },
  setProgress: async () => true,
  trashNote: async (id, file) => { calls.trash.push(file); return true },
  createNote: async () => ({ file: 'x.md' }),
  openNote: async () => ({ opened: true, editor: 'x' }),
  revealNote: async () => true,
  removeCategory: async () => true,
  removeTag: async () => true,
  removeShelf: async () => true,
  pathForFile: () => ''
}

// 事件委托：body 上的 click 处理器靠 e.target.closest('[data-action]') 取动作
async function clickAction (action, id) {
  const fake = { dataset: { action, id }, closest: () => fake }
  documentStub.body.emit('click', { target: { closest: () => fake } })
  await new Promise(r => setTimeout(r, 40))
}

// 渲染层的 data 是快照：直接改 LIB 不会生效，要走一次后台 refresh 才重读
async function refreshFromLibrary () {
  calls.watchCb({ type: 'imported', docs: [] })
  await new Promise(r => setTimeout(r, 520))
}

const win = {
  solace,
  _listeners: {},
  addEventListener (t, fn) { (win._listeners[t] = win._listeners[t] || []).push(fn) },
  removeEventListener () {},
  dispatchEvent (ev) { for (const fn of win._listeners[ev.type] || []) fn(ev); return true },
  matchMedia: () => ({ matches: false }),
  innerWidth: 1280, innerHeight: 840, devicePixelRatio: 1,
  closePreview: null, currentPreviewId: null,
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
  requestAnimationFrame: () => 0,
  localStorage: { _d: {}, getItem (k) { return this._d[k] ?? null }, setItem (k, v) { this._d[k] = String(v) }, removeItem (k) { delete this._d[k] } },
  CustomEvent: class { constructor (t, o) { this.type = t; this.detail = o && o.detail } },
  IntersectionObserver: class {
    constructor () { ioStats.created++ }
    observe () { ioStats.observe++ }
    unobserve () {}
    disconnect () { ioStats.disconnect++ }
  },
  confirm: () => true, alert () {}, performance
}
const ioStats = { created: 0, observe: 0, disconnect: 0 }

const sandbox = {
  window: win, document: documentStub, localStorage: win.localStorage,
  IntersectionObserver: win.IntersectionObserver, CustomEvent: win.CustomEvent,
  setTimeout, clearTimeout, setInterval: win.setInterval, clearInterval: win.clearInterval,
  requestAnimationFrame: win.requestAnimationFrame, performance, console,
  alert: win.alert, confirm: win.confirm, Math, JSON, Date, Promise, Number, String, Object, Array, Set, Map, RegExp, Error, Uint8Array
}
sandbox.globalThis = sandbox
sandbox.self = sandbox
const context = vm.createContext(sandbox)

/* ---------------- 模块加载（ESM 链接器） ----------------
   Node 的 link() 要求返回的模块「已经链好」，所以这里先按依赖顺序把整张图
   逐个 link 完，再求值 app.js */
const makePdfjsStub = () => new vm.SyntheticModule(
  ['default', 'docParams'],
  function () {
    this.setExport('default', {
      GlobalWorkerOptions: {},
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: sandbox.__pdfPages || 0,
          getPage: async () => ({
            getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }),
            render: () => ({ promise: Promise.resolve() }),
            getTextContent: async () => ({ items: [{ str: 'hello' }] }),
            cleanup () {}
          }),
          getOutline: async () => null,
          destroy () {},
          getDestination: async () => null,
          getPageIndex: async () => 0
        })
      })
    })
    this.setExport('docParams', {})
  },
  { context }
)

const mods = new Map()
function getModule (file) {
  if (!mods.has(file)) {
    mods.set(file, new vm.SourceTextModule(fs.readFileSync(file, 'utf8'), { identifier: file, context }))
  }
  return mods.get(file)
}

// pdfjs.js 里是 worker/资源 URL 的构造，依赖真实 URL 解析环境，且本次改动
// 没有碰它——冒烟台里替换成桩，其余模块全部走真实源码
const isStub = (spec) => spec.includes('node_modules') || spec.endsWith('pdfjs.js')

const linked = new Set()
async function linkAll (file) {
  if (linked.has(file)) return
  linked.add(file)
  const mod = getModule(file)
  for (const spec of mod.dependencySpecifiers) {
    if (isStub(spec)) continue
    await linkAll(path.resolve(path.dirname(file), spec))
  }
  await mod.link((spec, referencing) => {
    if (isStub(spec)) return makePdfjsStub()
    return getModule(path.resolve(path.dirname(referencing.identifier), spec))
  })
}

const errors = []
const trace = (m) => fs.writeSync(2, `[trace] ${m}\n`)
process.on('unhandledRejection', (e) => {
  errors.push('unhandledRejection: ' + (e && e.message || e))
  trace('unhandledRejection: ' + (e && e.stack || e))
})
process.on('uncaughtException', (e) => {
  errors.push('uncaughtException: ' + (e && e.message || e))
  trace('uncaughtException: ' + (e && e.stack || e))
})

const APP = path.join(JS_DIR, 'app.js')
await linkAll(APP)
trace('模块图已链接')
const app = getModule(APP)
await app.evaluate()
trace('app.js 已求值')

// refresh() 在模块顶层被调用，等它和索引初始化落定
await new Promise(r => setTimeout(r, 60))

check('模块初始化无异常', errors.length === 0, errors)
check('开局拉取索引清单（不再拉整份索引）', calls.status === 1, { status: calls.status })
check('提交首屏渲染', el('#docGrid').innerHTML.includes('doc-card'), { len: el('#docGrid').innerHTML.length })
check('首屏含两本书', (el('#docGrid').innerHTML.match(/class="doc-card/g) || []).length === 2)

/* ---------------- 搜索链路 ---------------- */
const search = el('#searchInput')
search.value = 'rust'
search.emit('input')
const immediate = el('#docGrid').innerHTML
check('输入即时过滤（标题命中先出结果）', immediate.includes('Rust 程序设计语言'))
check('即时渲染时全文命中尚未取回（d2 不出现）', !immediate.includes('无关标题'))

await new Promise(r => setTimeout(r, 320)) // 等防抖 150ms + 异步查询
const after = el('#docGrid').innerHTML
check('防抖后向主进程查了归一化关键词', calls.search.includes('rust'), calls.search)
check('全文命中的书出现在结果里', after.includes('无关标题'))
check('全文命中带页码标记', after.includes('全文 · 第 4 页'), after.match(/doc-hit[^>]*>[^<]*/) || null)

/* ---------------- 清空搜索 ---------------- */
search.value = ''
search.emit('input')
await new Promise(r => setTimeout(r, 60))
check('清空后恢复完整列表', (el('#docGrid').innerHTML.match(/class="doc-card/g) || []).length === 2)

/* ---------------- C3 命令面板关闭后恢复主窗口全文命中 ----------------
   面板与主窗口共用同一张命中表：打开即清空、输入即覆盖。关闭时必须按
   主窗口当前关键词重查，否则后台一次重渲染就会丢掉「仅正文命中」的书 */
el('#searchInput').value = 'rust'
el('#searchInput').emit('input')
await new Promise(r => setTimeout(r, 320)) // 主搜索的全文命中就绪
const searchCallsBeforePalette = calls.search.length
el('#btnPalette').emit('click') // 打开面板：共享命中表被清空（面板的既有行为）
await new Promise(r => setTimeout(r, 60))
el('#paletteDialog').emit('close') // 关闭面板：应按主窗口关键词重查恢复
await new Promise(r => setTimeout(r, 120))
check('C3 面板关闭后按主窗口关键词重查全文',
  calls.search.length > searchCallsBeforePalette && calls.search.at(-1) === 'rust',
  calls.search.slice(searchCallsBeforePalette))
await refreshFromLibrary() // 一次后台重渲染（自动入库/索引完成的等价物）
check('C3 后台重渲染后「仅正文命中」的书不丢', el('#docGrid').innerHTML.includes('无关标题'))

/* ---------------- 命令面板 filter 事件 ---------------- */
check('palette/settings 模块加载无异常', errors.length === 0, errors)

/* ---------------- 步骤 4：C1 书架视图语义 ---------------- */
// 顶栏按钮切两次：grid → spine → shelf（显式切换，应当落库）
el('#btnView').emit('click')
await new Promise(r => setTimeout(r, 20))
el('#btnView').emit('click')
await new Promise(r => setTimeout(r, 20))
const persistedAfterSwitch = calls.updateSettings.filter(p => 'viewMode' in p).map(p => p.viewMode)
check('显式切视图会落库', persistedAfterSwitch.join(',') === 'spine,shelf', persistedAfterSwitch)
check('书架总览渲染出书堆', el('#docGrid').innerHTML.includes('pile-card'), el('#docGrid').innerHTML.slice(0, 80))

// 点书堆下钻：应当只改会话视图，不再动用户的默认视图
const beforePile = calls.updateSettings.length
await clickAction('pile-open', 'c1')
check('下钻后渲染封面墙', el('#docGrid').innerHTML.includes('doc-card') && !el('#docGrid').innerHTML.includes('pile-card'))
check('下钻不再改写默认视图（不落库）', calls.updateSettings.length === beforePile,
  calls.updateSettings.slice(beforePile))
check('下钻后出现「← 书架」回退按钮', el('#btnBackShelf').hidden === false)

// 关键回归：后台刷新（自动入库/索引完成都会触发 refresh）不能把视图拉回书架
calls.watchCb?.({ type: 'imported', docs: [{ id: 'd9', title: '新书' }] })
await new Promise(r => setTimeout(r, 520))
check('后台刷新后仍停在下钻出的封面墙', !el('#docGrid').innerHTML.includes('pile-card'))

// 一步回退：回到书架总览并落库
el('#btnBackShelf').emit('click')
await new Promise(r => setTimeout(r, 20))
check('回退后回到书架总览', el('#docGrid').innerHTML.includes('pile-card'))
check('回退会落库书架视图',
  calls.updateSettings.filter(p => 'viewMode' in p).map(p => p.viewMode).join(',') === 'spine,shelf,shelf',
  calls.updateSettings.filter(p => 'viewMode' in p).map(p => p.viewMode))

/* ---------------- C1 书架态的其余筛选入口 ----------------
   书堆只按顶级分类组织、无视标签/收藏夹条件：这些入口在书架态必须
   切到封面墙，否则点击只有侧栏高亮在变，像按钮失灵 */
// C1a 书架态点标签
await clickAction('filter-tag', 't1')
check('C1a 书架态点标签切到封面墙', !el('#docGrid').innerHTML.includes('pile-card'))
check('C1a 按标签筛出结果（只有打了标签的那本）',
  el('#docGrid').innerHTML.includes('Rust 程序设计语言') && !el('#docGrid').innerHTML.includes('无关标题'))
await clickAction('filter-tag', 't1') // 再点一次取消标签筛选

// C1b 书架态命令面板跳分类
el('#btnView').emit('click') // 封面 → 书脊
await new Promise(r => setTimeout(r, 20))
el('#btnView').emit('click') // 书脊 → 书架
await new Promise(r => setTimeout(r, 20))
check('重新回到书架总览', el('#docGrid').innerHTML.includes('pile-card'))
win.dispatchEvent(new win.CustomEvent('solace-palette', { detail: { type: 'filter', categoryId: 'c1', tagId: null, keyword: '' } }))
await new Promise(r => setTimeout(r, 40))
check('C1b 书架态命令面板跳分类切到封面墙', !el('#docGrid').innerHTML.includes('pile-card'))
check('C1b 面板跳转按分类筛出结果',
  el('#docGrid').innerHTML.includes('Rust 程序设计语言') && !el('#docGrid').innerHTML.includes('无关标题'))

// C1c 设置面板切到书架：进总览要清掉挂着的筛选（书堆无视它们），
// 否则残留条件会在下钻书堆时叠加出更窄的结果
LIB.documents.push({
  id: 'd4', title: '第二本技术书', fileName: 'tech2.pdf', size: 4096,
  addedAt: '2026-01-04T00:00:00.000Z', openedAt: null, openCount: 0,
  categoryId: 'c1', tagIds: [] // 在 c1 分类里但不带 rust 标签
})
await refreshFromLibrary()
await clickAction('filter-tag', 't1') // 网格态挂上标签筛选（此时只剩 d1）
win.dispatchEvent(new win.CustomEvent('solace-settings', { detail: { viewMode: 'shelf' } }))
await new Promise(r => setTimeout(r, 40))
check('C1c 设置切书架清空筛选（搜索框与标签态归零）',
  el('#searchInput').value === '' && el('#docGrid').innerHTML.includes('pile-card'))
await clickAction('pile-open', 'c1')
check('C1c 下钻书堆不带残留标签筛选（c1 两本都在）',
  el('#docGrid').innerHTML.includes('Rust 程序设计语言') && el('#docGrid').innerHTML.includes('第二本技术书'))

// C1d 书架态应用收藏夹（s1 = 分类 c1 的收藏夹）
el('#btnBackShelf').emit('click') // 回到书架总览
await new Promise(r => setTimeout(r, 20))
await clickAction('apply-shelf', 's1')
check('C1d 书架态应用收藏夹切到封面墙', !el('#docGrid').innerHTML.includes('pile-card'))
check('C1d 收藏夹的分类条件生效',
  el('#docGrid').innerHTML.includes('第二本技术书') && !el('#docGrid').innerHTML.includes('无关标题'))
LIB.documents.pop() // 清理临时书目
await refreshFromLibrary()
await clickAction('filter-cat', 'all')

/* ---------------- 步骤 4：B4 足迹口径 ---------------- */
el('#btnStats').emit('click') // 顶栏按钮是直接绑定，不走 body 委托
await new Promise(r => setTimeout(r, 40))
const statsHtml = el('#statsOverview').innerHTML
check('足迹面板向主进程取窗口统计', calls.openStats >= 1, { calls: calls.openStats })
check('近 7 天用主进程的按天账（不是 history 条数）',
  statsHtml.includes('<b>11</b>次近 7 天') && statsHtml.includes('<b>42</b>次近 30 天'), statsHtml)

/* ---------------- 步骤 4：B15 危险动作默认不勾 ---------------- */
const dialogMod = getModule(path.join(JS_DIR, 'dialog.js'))
await dialogMod.evaluate()
const dialogNs = dialogMod.namespace
dialogNs.askConfirm({ title: 't', text: 'x', checkLabel: '同时删除全部笔记' })
check('危险勾选项默认不勾（checkDefault 缺省仍为 true）', el('#confirmDialogCheck').checked === true)
dialogNs.askConfirm({ title: 't', text: 'x', checkLabel: '同时删除全部笔记', checkDefault: false })
check('显式 checkDefault:false 生效', el('#confirmDialogCheck').checked === false)

/* ---------------- B18 askText 输入框回车即确认 ---------------- */
const askPromise = dialogNs.askText('重命名', '初值')
check('B18 askText 打开后输入值就位', el('#inputDialogInput').value === '初值')
el('#inputDialogInput').onkeydown({ key: 'Enter', preventDefault () {} })
check('B18 回车触发确认并返回修剪后的输入',
  el('#inputDialog').open === false && await askPromise === '初值')

/* ---------------- 步骤 5：B10 封面观察器不累积 ---------------- */
const beforeDisconnect = ioStats.disconnect
el('#searchInput').value = 'x'
el('#searchInput').emit('input')
await new Promise(r => setTimeout(r, 30))
check('B10 每次重渲染前先 disconnect 观察器', ioStats.disconnect > beforeDisconnect,
  { before: beforeDisconnect, after: ioStats.disconnect })
el('#searchInput').value = ''
el('#searchInput').emit('input')
await new Promise(r => setTimeout(r, 30))

/* ---------------- 步骤 5：B9「未分类」口径 ---------------- */
LIB.documents.push({
  id: 'd3', title: '缺字段旧条目', fileName: 'legacy.pdf', size: 10,
  addedAt: '2026-01-03T00:00:00.000Z', openedAt: null, openCount: 0, tagIds: []
  // 故意不给 categoryId（undefined）——旧库/手改过的库会出现
})
await refreshFromLibrary()
await clickAction('filter-cat', 'none')
const uncatHtml = el('#docGrid').innerHTML
check('B9 缺 categoryId 的条目算作未分类并显示出来',
  uncatHtml.includes('缺字段旧条目') && !uncatHtml.includes('Rust 程序设计语言'),
  uncatHtml.includes('缺字段旧条目'))
LIB.documents.pop()
await refreshFromLibrary()
await clickAction('filter-cat', 'all')

/* ---------------- 步骤 5：B17 不再用原生 confirm ---------------- */
let nativeConfirmCalled = false
sandbox.confirm = () => { nativeConfirmCalled = true; return true }
await clickAction('del-cat', 'c1')
check('B17 删除分类走自建确认框（不弹原生 confirm）', !nativeConfirmCalled &&
  el('#confirmDialogTitle').textContent === '删除分类', el('#confirmDialogTitle').textContent)
el('#confirmDialogCancel').emit('click') // 关掉，避免影响后续
await new Promise(r => setTimeout(r, 20))

/* ---------------- 步骤 5：B12 单页 PDF 也记阅读足迹 ---------------- */
sandbox.__pdfPages = 1
await clickAction('preview-doc', 'd1')
await new Promise(r => setTimeout(r, 40))
check('B12 单页文档：打开后不记足迹（打开即关不算）', calls.markRead.length === 0, calls.markRead)
el('#btnNextPage').emit('click') // 页码 1 → clamp 到 1，页码没变，但这是显式翻页动作
await new Promise(r => setTimeout(r, 30))
check('B12 单页文档：显式翻页算读过一次', calls.markRead.join(',') === 'd1', calls.markRead)
el('#btnNextPage').emit('click')
await new Promise(r => setTimeout(r, 20))
check('B12 足迹每次会话只记一次', calls.markRead.length === 1)

/* ---------------- 步骤 5：B7 笔记面板切书竞态 ---------------- */
notesDeferred = makeDeferred()
el('#btnNotes').emit('click') // 打开 A 书笔记面板：请求挂起
await new Promise(r => setTimeout(r, 20))
await clickAction('preview-doc', 'd2') // 切到 B 书
await new Promise(r => setTimeout(r, 40))
notesDeferred.resolve({ notes: [{ file: 'A书笔记.md', mtime: new Date().toISOString(), birth: new Date().toISOString(), size: 1 }] })
await new Promise(r => setTimeout(r, 40))
check('B7 切书后旧书的笔记清单不会渲染到新书下',
  !el('#notesList').innerHTML.includes('A书笔记'), el('#notesList').innerHTML.slice(0, 60))
notesDeferred = null
el('#btnPreviewClose').emit('click')
await new Promise(r => setTimeout(r, 40))

/* ---------------- 步骤 5：B13 切库时偏好不串味 ---------------- */
LIB.settings.coverSize = 'large'
await refreshFromLibrary()
check('B13 旧库的 coverSize 生效', el('#docGrid')._style['--cover-min'] === '220px',
  el('#docGrid')._style['--cover-min'])
const newLib = JSON.parse(JSON.stringify(LIB))
newLib.settings = {} // 新库没有任何设置项
newLib.documents = [LIB.documents[0]]
calls.lib = newLib
win.dispatchEvent(new win.CustomEvent('solace-library-moved', { detail: { mode: 'created' } }))
await new Promise(r => setTimeout(r, 60))
check('B13 切库后旧库偏好被清掉（回到默认 medium）',
  el('#docGrid')._style['--cover-min'] === '172px', el('#docGrid')._style['--cover-min'])

/* ---------------- 步骤 5：设置面板广播「实际落库的值」 ---------------- */
const settingsEvents = []
win.addEventListener('solace-settings', (e) => settingsEvents.push(e.detail))

el('#setCoverSize').value = 'large'
el('#setCoverSize').emit('change')
await new Promise(r => setTimeout(r, 40))
check('设置面板的更改落库并联动渲染',
  currentLib().settings.coverSize === 'large' && el('#docGrid')._style['--cover-min'] === '220px',
  { stored: currentLib().settings.coverSize, min: el('#docGrid')._style['--cover-min'] })

el('#setView').value = 'spine' // 先存一个合法值
el('#setView').emit('change')
await new Promise(r => setTimeout(r, 40))
check('合法值按提交内容落库并广播',
  currentLib().settings.viewMode === 'spine' && settingsEvents.at(-1).viewMode === 'spine',
  settingsEvents.at(-1))

el('#setView').value = 'carousel' // 非法枚举：主进程白名单会拒
el('#setView').emit('change')
await new Promise(r => setTimeout(r, 40))
check('值被拒时广播的是真实存储值，而不是提交值',
  currentLib().settings.viewMode === 'spine' && settingsEvents.at(-1).viewMode === 'spine',
  settingsEvents.at(-1))

/* ---------------- 资料库生命周期与跨库操作 ---------------- */
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const fire = async (target, type, event = {}) => {
  for (const fn of target._listeners[type] || []) {
    await fn({ target, preventDefault () {}, stopPropagation () {}, ...event })
  }
}
const snapshot = (sessionId, title) => ({
  ...JSON.parse(JSON.stringify(LIB)), sessionId,
  settings: { viewMode: 'grid' },
  documents: LIB.documents.map((d, i) => ({ ...d, sessionId, categoryId: null, title: i === 0 ? title : d.title }))
})
const switchLibrary = async (sessionId, title) => {
  await win.prepareLibraryChange()
  calls.lib = snapshot(sessionId, title)
  await fire(win, 'solace-library-moved', { detail: { mode: 'adopted', docCount: 2 } })
}
await switchLibrary(1, '第一资料库')
solace.getTextIndexStatus = async () => ({ d1: { ver: 2 }, d2: { ver: 2 } })
await refreshFromLibrary()
search.value = 'rust'
search.emit('input')
await new Promise(resolve => setTimeout(resolve, 180))
check('切库失败回归的前置：仅正文命中可见', el('#docGrid').innerHTML.includes('无关标题'))
const queriesBeforeCancel = calls.search.length
await win.prepareLibraryChange()
await fire(win, 'solace-library-change-cancelled')
check('取消切库后重新查询全文并恢复原结果', calls.search.length > queriesBeforeCancel &&
  el('#docGrid').innerHTML.includes('无关标题'))
search.value = ''
search.emit('input')

const realGetLibrary = solace.getLibrary
const oldRefresh = makeDeferred()
const newRefresh = makeDeferred()
let refreshRequests = 0
solace.getLibrary = () => (++refreshRequests === 1 ? oldRefresh.p : newRefresh.p)
const firstRefresh = fire(el('#btnPreviewClose'), 'click')
await tick()
const secondRefresh = fire(el('#btnPreviewClose'), 'click')
await tick()
newRefresh.resolve(snapshot(1, '最新刷新'))
await tick()
oldRefresh.resolve(snapshot(1, '过期刷新'))
await Promise.all([firstRefresh, secondRefresh])
await tick()
check('后返回的旧刷新不会覆盖新刷新', el('#docGrid').innerHTML.includes('最新刷新') &&
  !el('#docGrid').innerHTML.includes('过期刷新'))

const beforeSwitch = makeDeferred()
solace.getLibrary = () => beforeSwitch.p
await fire(el('#btnPreviewClose'), 'click')
await tick()
await win.prepareLibraryChange()
beforeSwitch.resolve(snapshot(1, '切换中旧响应'))
await tick()
check('准备切库后旧刷新不再渲染', !el('#docGrid').innerHTML.includes('切换中旧响应'))
solace.getLibrary = realGetLibrary
calls.lib = snapshot(2, '第二资料库')
await fire(win, 'solace-library-moved', { detail: { mode: 'adopted', docCount: 2 } })

// 批量归档完成后必须清空选中：否则上一批残留勾选会随下一批一起归档
// （复现：批 1 勾 d1 归「技术」，批 2 只勾 d2 归「第二类」——修复前 d1
// 也会被挪进「第二类」）
currentLib().categories.push({ id: 'c2', name: '第二类', parentId: null })
const batchArchiveCalls = []
solace.updateDoc = (id, patch) => {
  batchArchiveCalls.push(id)
  const d = currentLib().documents.find(x => x.id === id)
  if (d) d.categoryId = patch.categoryId
  return Promise.resolve({})
}
const pickCard = (id) => fire(documentStub.body, 'click', {
  target: { closest: () => ({ dataset: { action: 'preview-doc', id } }) }
})
await fire(el('#btnBatch'), 'click')
await pickCard('d1')
await fire(el('#batchCategory'), 'change', { target: { value: 'c1' } })
await tick()
check('批量归档后选中清零、操作按钮禁用',
  el('#batchCount').textContent === '已选 0 本' && el('#btnBatchDel').disabled)
await pickCard('d2')
await fire(el('#batchCategory'), 'change', { target: { value: 'c2' } })
await tick()
const afterBatch = currentLib().documents
check('第二批归档不带上一批残留（d1 仍在原分类）',
  batchArchiveCalls.join() === 'd1,d2' &&
  afterBatch.find(x => x.id === 'd1').categoryId === 'c1' &&
  afterBatch.find(x => x.id === 'd2').categoryId === 'c2',
  { calls: batchArchiveCalls })
await fire(el('#btnBatchExit'), 'click')

await fire(el('#btnBatch'), 'click')
await fire(el('#btnBatchAll'), 'click')
const archiveCalls = []
const archiveGate = makeDeferred()
solace.updateDoc = (id, patch, sessionId) => {
  archiveCalls.push({ id, sessionId })
  return archiveGate.p
}
const archiving = fire(el('#batchCategory'), 'change', { target: { value: 'c1' } })
await tick()
await switchLibrary(3, '第三资料库')
archiveGate.resolve({})
await archiving
check('批量归档固定原会话，切库后停止剩余操作', archiveCalls.length === 1 &&
  archiveCalls[0].sessionId === 2 && el('#docGrid').innerHTML.includes('第三资料库'), archiveCalls)

await fire(el('#btnBatch'), 'click')
await fire(el('#btnBatchAll'), 'click')
const removeCalls = []
const removeGate = makeDeferred()
solace.removeDoc = (id, opts, sessionId) => {
  removeCalls.push({ id, sessionId })
  return removeGate.p
}
const removing = fire(el('#btnBatchDel'), 'click')
el('#confirmDialogOk').onclick()
await tick()
await switchLibrary(4, '第四资料库')
removeGate.resolve({})
await removing
check('批量删除固定原会话，切库后不删除新库同 ID 文档', removeCalls.length === 1 &&
  removeCalls[0].sessionId === 3, removeCalls)

const singleDelete = fire(documentStub.body, 'click', {
  target: { closest: () => ({ dataset: { action: 'del-doc', id: 'd1' } }) }
})
await switchLibrary(5, '第五资料库')
el('#confirmDialogOk').onclick()
await singleDelete
check('旧库删除确认不能作用于新库同 ID 文档', removeCalls.length === 1, removeCalls)

await fire(documentStub.body, 'click', {
  target: { closest: () => ({ dataset: { action: 'edit-doc', id: 'd1' } }) }
})
await switchLibrary(6, '第六资料库')
const updatesBeforeSave = archiveCalls.length
await fire(el('#btnEditSave'), 'click')
check('旧库编辑表单不能保存到新库同 ID 文档', archiveCalls.length === updatesBeforeSave)

const importGate = makeDeferred()
const dragUpdates = []
solace.importPaths = async () => ({ imported: [{ id: 'd1' }, { id: 'd2' }], errors: [], duplicates: [] })
solace.updateDoc = (id, patch, sessionId) => { dragUpdates.push({ id, sessionId }); return importGate.p }
documentStub.elementFromPoint = () => ({ closest: () => ({ dataset: { id: 'c1' } }) })
const dropping = fire(win, 'drop', { dataTransfer: { types: ['Files'], files: [{ name: 'book.pdf' }] } })
await tick()
await switchLibrary(7, '第七资料库')
importGate.resolve({})
await dropping
check('拖入后的归档在切库时停止，旧任务不再排队', dragUpdates.length === 1 &&
  dragUpdates[0].sessionId === 6, dragUpdates)
check('生命周期测试没有异步未处理异常', errors.length === 0, errors)

console.log('\n===SUMMARY===')
const failed = Object.entries(results).filter(([, v]) => !v.pass).map(([k]) => k)
console.log(failed.length ? `FAILED: ${failed.join(', ')}` : 'ALL PASS')
process.exitCode = failed.length ? 1 : 0
// 不用 process.exit：Node 在 Windows 管道下会截断还没冲刷的 stdout
