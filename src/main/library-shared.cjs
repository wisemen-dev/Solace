// 双端共享的资料库纯函数（复用优化 C3，2026-10-14 建立）。
// 桌面（本仓库，CJS require）与平板（SolaceMobile 仓库，bridge/ 的 ESM
// import 经 Node/esbuild 的 CJS interop）共用同一份实现——由平板仓库的
// scripts/sync-www.mjs 从本文件搬运到 bridge/library-shared.cjs。
//
// 提取纪律（PORTING.md「共享纯函数层」同步记录）：
// 1. 只收纯函数与常量：入参进、返回值出，不触 fs/DOM/时间（时钟注入）；
// 2. 数据对象经参数传入，函数内不得捕获外层状态；
// 3. 禁止平台分支（window./process./Electron/Capacitor 探测）——平台差异
//    留在两端各自的封装里，宁可少共享也不污染；
// 4. 两端实现已有差异时，取语义更强者统一（曾导致双端 bug 漂移的教训）。
//
// 本文件的首批成员为此前「双份维护且发生过漂移」的逻辑：dayKey 族
// （阅读足迹口径）、搜索关键词归一、孤儿清扫正则、设置白名单归一
// （两端取并集——库互搬时设置不丢）、分类移动防环校验。

'use strict'

// ---- 搜索关键词归一（数据层版；渲染层 util.js 另有一份 ESM，不跨上下文共享）----
function normalizeKeyword (s) {
  return String(s || '').toLowerCase().replace(/\s+/g, '')
}

// ---- 阅读足迹：按天立账 ----
const OPEN_DAYS_KEEP = 400

function dayKey (d) {
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// 计数入账 + 截留最近 OPEN_DAYS_KEEP 天。data 为库根对象（就地修改）
function countOpenDay (at, data) {
  if (!data.openDays || typeof data.openDays !== 'object') data.openDays = {}
  const k = dayKey(new Date(at))
  data.openDays[k] = (data.openDays[k] || 0) + 1
  const keys = Object.keys(data.openDays)
  if (keys.length > OPEN_DAYS_KEEP) {
    keys.sort()
    for (const old of keys.slice(0, keys.length - OPEN_DAYS_KEEP)) delete data.openDays[old]
  }
}

// 近 7/30 个自然日（含今天）的翻开次数。openDays 传已提交快照（读端
// 不暴露在途导入/删除的中间态）；now 注入时钟便于单测
function getOpenStats (openDays, now) {
  const days = openDays || {}
  const d = now
  let opens7d = 0
  let opens30d = 0
  for (let i = 0; i < 30; i++) {
    const n = days[dayKey(d)] || 0
    if (i < 7) opens7d += n
    opens30d += n
    d.setDate(d.getDate() - 1)
  }
  return { opens7d, opens30d }
}

// ---- 孤儿清扫的文件名口径（严格 UUID 命名；两侧统一小写比较）----
const APP_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(pdf|jpg)$/i
const APP_TMP_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json\.tmp$/i

// ---- 设置白名单归一（两端键集取并集：库互搬时设置不丢）----
const SETTINGS_STRINGS = ['notesEditorPath', 'pdfReaderPath', 'externalToolPath', 'watchFolder', 'watchCategory',
  'watchTreeUri', 'watchFolderName', 'externalToolPackage']
const SETTINGS_BOOLEANS = ['resumeReading', 'confetti', 'openingAnimation', 'watchEnabled']
const SETTINGS_NUMBERS = { dormantDays: 1, indexPageLimit: 1 }
const SETTINGS_ENUMS = {
  coverSize: ['small', 'medium', 'large'],
  theme: ['auto', 'ink', 'paper', 'dusk'],
  viewMode: ['grid', 'spine', 'shelf']
}

// 把白名单内的 patch 键归一写入 settings（就地修改）。调用方负责 settings
// 对象的类型守卫与落盘；返回是否发生变更（省一次无谓写盘）
function applySettingsPatch (settings, patch) {
  let changed = false
  for (const key of SETTINGS_STRINGS) {
    if (key in patch && settings[key] !== String(patch[key])) { settings[key] = String(patch[key]); changed = true }
  }
  for (const key of SETTINGS_BOOLEANS) {
    const v = patch[key] === true
    if (key in patch && settings[key] !== v) { settings[key] = v; changed = true }
  }
  for (const key of Object.keys(SETTINGS_NUMBERS)) {
    if (!(key in patch)) continue
    const n = Math.floor(Number(patch[key]))
    if (Number.isFinite(n) && n >= SETTINGS_NUMBERS[key] && settings[key] !== n) { settings[key] = n; changed = true }
  }
  for (const key of Object.keys(SETTINGS_ENUMS)) {
    if (key in patch && SETTINGS_ENUMS[key].includes(patch[key]) && settings[key] !== patch[key]) {
      settings[key] = patch[key]; changed = true
    }
  }
  return changed
}

// ---- 分类移动的防环校验（曾双份维护；环可由互传/手改 library.json 带入）----
// 校验通过返回 { cat, target }，非法抛错；调用方负责落盘
function assertMoveCategory (categories, id, parentId) {
  const cat = categories.find(c => c.id === id)
  if (!cat) throw new Error(`分类不存在: ${id}`)
  const target = parentId || null
  if (target === id) throw new Error('不能移动到自身')
  if (target != null) {
    let cursor = categories.find(c => c.id === target)
    if (!cursor) throw new Error('目标分类不存在')
    // visited 防御：library.json 是人工可编辑的，父链可能已被写成环
    // （本函数会拦住经应用产生的环，拦不住手改的）。撞环说明数据异常，
    // 明确报错而不是沿环无限循环把这次调用卡死
    const seen = new Set()
    while (cursor) {
      if (cursor.id === id) throw new Error('不能移动到自己的子分类下')
      if (seen.has(cursor.id)) throw new Error('分类层级数据异常（parentId 成环），请先修复 library.json')
      seen.add(cursor.id)
      cursor = categories.find(c => c.id === cursor.parentId) || null
    }
  }
  return { cat, target }
}

module.exports = {
  normalizeKeyword,
  OPEN_DAYS_KEEP,
  dayKey,
  countOpenDay,
  getOpenStats,
  APP_FILE_RE,
  APP_TMP_RE,
  SETTINGS_STRINGS,
  SETTINGS_BOOLEANS,
  SETTINGS_NUMBERS,
  SETTINGS_ENUMS,
  applySettingsPatch,
  assertMoveCategory
}
