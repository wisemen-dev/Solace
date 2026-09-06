// 主题系统：墨水（暗）/ 纸张（暖白）/ 黄昏（琥珀）三套配色 + 按时段自动。
// 配色全部由 style.css 的 [data-theme] CSS 变量承载，这里只负责：
// 1) 把解析后的主题写到 <html data-theme>（并同步 localStorage，供
//    theme-boot.js 在下一帧渲染前设置，避免启动时闪错色）
// 2) 「自动」模式按时段解析：06–16 纸张 / 16–21 黄昏 / 其余墨水
// 3) 顶栏按钮循环切换并持久化

const CYCLE = ['auto', 'ink', 'paper', 'dusk']
const MODE_LABEL = { auto: '自动（晨昏渐变）', ink: '墨水', paper: '纸张', dusk: '黄昏' }

function resolvedFor (mode, hour = new Date().getHours()) {
  if (mode !== 'auto') return mode
  if (hour >= 6 && hour < 16) return 'paper'
  if (hour >= 16 && hour < 21) return 'dusk'
  return 'ink'
}

function apply (settings) {
  const mode = CYCLE.includes(settings.theme) ? settings.theme : 'auto'
  const resolved = resolvedFor(mode)
  document.documentElement.dataset.theme = resolved
  document.documentElement.dataset.themeMode = mode
  localStorage.setItem('solace-theme', resolved)
  return { mode, resolved }
}

function nextMode (mode) {
  return CYCLE[(CYCLE.indexOf(mode) + 1) % CYCLE.length]
}

export function initTheme (settings) {
  paint(settings)
  // 「自动」模式下每小时重估一次时段，应用开着跨过傍晚也会平滑变色
  setInterval(() => {
    if (document.documentElement.dataset.themeMode === 'auto') paint(settings)
  }, 30 * 60 * 1000)
}

function paint (settings) {
  const { mode, resolved } = apply(settings)
  const btn = document.getElementById('btnTheme')
  if (!btn) return
  const icon = resolved === 'paper' ? '☀️' : resolved === 'dusk' ? '🌆' : '🌙'
  btn.textContent = mode === 'auto' ? `🌓 ${icon}` : icon
  btn.title = `主题：${MODE_LABEL[mode]}（点击切换）`
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
