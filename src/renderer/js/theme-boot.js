// 首帧防闪：在 CSS 加载前把解析出的主题写到 <html data-theme>。
// 「自动」是按时段模式，落盘的解析值可能已过期（如昨晚存的纸张、现在
// 是晚上）：这里按当前时间重新解析一次，其余模式用上次落盘值。
// theme.js 每次应用主题都会同步这两个 localStorage 键。
;(function () {
  const mode = localStorage.getItem('solace-theme-mode') || 'auto'
  let resolved = localStorage.getItem('solace-theme') || 'ink'
  if (mode === 'auto') {
    const h = new Date().getHours()
    resolved = h >= 7 && h < 12 ? 'paper' : h >= 12 && h < 18 ? 'dusk' : 'ink'
  }
  document.documentElement.dataset.theme = resolved
})()

// 开馆动画开关（设置 → 外观）：关闭时解析完成后立即摘掉 body.opening，
// 入场动画不再播放（theme.js 会同步这个 localStorage 键）
document.addEventListener('DOMContentLoaded', () => {
  if (localStorage.getItem('solace-opening') === 'off') document.body.classList.remove('opening')
})
