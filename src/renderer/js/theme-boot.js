// 首帧防闪：在 CSS 加载前把持久化的主题写到 <html data-theme>。
// theme.js 每次应用主题都会同步 localStorage；读不到就用默认墨水。
document.documentElement.dataset.theme = localStorage.getItem('solace-theme') || 'ink'
