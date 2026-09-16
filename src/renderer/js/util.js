// 渲染进程共享的小工具：文本归一化、HTML 转义、相对时间。
// app.js（搜索过滤/足迹）、palette.js（命令面板）、textindex.js（正文提取）、
// notespanel.js（笔记列表）共用，调整规则只改这里。

// 搜索与索引共用的文本归一化：小写化并剔除全部空白（含全角空格），
// 使「rust程序」能命中「Rust 程序设计语言」这类中英混排带空格的文本。
export const normText = (s) => String(s || '').toLowerCase().replace(/\s+/g, '')

export const esc = (s) => String(s).replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]))

export function fmtRel (iso) {
  if (!iso) return '—'
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  return new Date(iso).toLocaleDateString('zh-CN')
}
