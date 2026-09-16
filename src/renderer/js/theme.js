// 主题系统：自动（按时段）/ 墨水（暗）/ 纸张（暖白）/ 黄昏（琥珀）。
// 配色全部由 style.css 的 [data-theme] CSS 变量承载，这里只负责：
// 1) 把解析后的主题写到 <html data-theme>（并同步 localStorage，供
//    theme-boot.js 在下一帧渲染前设置，避免启动时闪错色）
// 2) 「自动」= 按时段切换：7–12 点纸张，12–18 点黄昏，其余（18 点–次日
//    7 点）墨水；运行中每分钟重估，到点实时跟随（0.10.0 曾改为跟随系统
//    深浅色，现按需求改回时段制）
// 3) 顶栏按钮循环切换并持久化；设置面板可直接选定（双入口同源）；
//    手动切到固定主题即离开「自动」，定时器不再干预
// 4) 同步「开馆动画」开关到 localStorage，供 theme-boot.js 跳过首帧动画

const CYCLE = ['auto', 'ink', 'paper', 'dusk']
const MODE_LABEL = { auto: '自动（按时段）', ink: '墨水', paper: '纸张', dusk: '黄昏' }

// 导出仅供边界时间测试使用
export function resolvedFor (mode, now = new Date()) {
  if (mode !== 'auto') return mode
  const h = now.getHours()
  if (h >= 7 && h < 12) return 'paper'
  if (h >= 12 && h < 18) return 'dusk'
  return 'ink'
}

function apply (settings) {
  const mode = CYCLE.includes(settings.theme) ? settings.theme : 'auto'
  const resolved = resolvedFor(mode)
  document.documentElement.dataset.theme = resolved
  document.documentElement.dataset.themeMode = mode
  localStorage.setItem('solace-theme', resolved)
  // 模式一并落盘：theme-boot.js 首帧对「自动」按当前时间重新解析
  localStorage.setItem('solace-theme-mode', mode)
  syncOpeningFlag(settings)
  return { mode, resolved }
}

// 开馆动画开关随设置同步（theme-boot.js 读它决定是否移除 body.opening）
function syncOpeningFlag (settings) {
  localStorage.setItem('solace-opening', settings.openingAnimation === false ? 'off' : 'on')
}

function nextMode (mode) {
  return CYCLE[(CYCLE.indexOf(mode) + 1) % CYCLE.length]
}

let listenerBound = false // refresh() 会反复调 initTheme，时段定时器只挂一次

export function initTheme (settings) {
  paint(settings)
  if (listenerBound) return
  listenerBound = true
  // 「自动」按时段实时跟随：每分钟重估一次，仅在仍处于「自动」时生效。
  // 手动循环/设置面板切到固定主题后不再受定时器影响；重新选「自动」即恢复
  // （settings 是 app.js 的同一个 prefs 对象引用，后续修改会如实反映到这里）
  setInterval(() => {
    if ((document.documentElement.dataset.themeMode || 'auto') !== 'auto') return
    paint(settings)
  }, 60_000)
}

function paint (settings) {
  const { mode, resolved } = apply(settings)
  const btn = document.getElementById('btnTheme')
  if (!btn) return
  const icon = resolved === 'paper' ? '☀️' : resolved === 'dusk' ? '🌆' : '🌙'
  btn.textContent = mode === 'auto' ? `🌓 ${icon}` : icon
  btn.title = `主题：${MODE_LABEL[mode]}（点击切换）`
}

// 供设置面板在更改主题后立即重画（顶栏按钮图标 + 配色）
export function applyTheme (settings) {
  paint(settings)
}

// 循环切换：自动 → 墨水 → 纸张 → 黄昏 → 自动。返回持久化用的 patch。
export function cycleTheme (settings) {
  const current = document.documentElement.dataset.themeMode || 'auto'
  settings.theme = nextMode(current)
  paint(settings)
  return { theme: settings.theme }
}

export function themeLabel () {
  const mode = document.documentElement.dataset.themeMode || 'auto'
  return MODE_LABEL[mode] || mode
}
