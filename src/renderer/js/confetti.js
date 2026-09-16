// 归档庆祝彩蛋：在指定屏幕坐标炸开一小片纸屑粒子，约 1.2 秒后自动清理。
// 可在设置面板关闭（settings.confetti）：关闭后 burst 直接空操作，
// 调用方（app.js 归档 / preview.js 读毕）无需各自判断
let enabled = true

export function setConfettiEnabled (v) {
  enabled = !!v
}

const COLORS = ['#6ea8fe', '#ffd166', '#7bd88f', '#ef8354', '#c792ea']

export function burst (x, y) {
  if (!enabled) return
  const canvas = document.createElement('canvas')
  canvas.className = 'confetti-canvas'
  canvas.width = window.innerWidth
  canvas.height = window.innerHeight
  document.body.appendChild(canvas)
  const ctx = canvas.getContext('2d')

  const parts = Array.from({ length: 32 }, () => ({
    x, y,
    vx: (Math.random() - 0.5) * 9,
    vy: -Math.random() * 9 - 3,
    g: 0.26 + Math.random() * 0.14,
    size: 4 + Math.random() * 4,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
    color: COLORS[Math.floor(Math.random() * COLORS.length)]
  }))

  const t0 = performance.now()
  function frame (t) {
    const dt = (t - t0) / 1000
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const life = Math.max(0, 1 - dt / 1.1)
    for (const p of parts) {
      p.x += p.vx
      p.y += p.vy
      p.vy += p.g
      p.rot += p.vr
      ctx.save()
      ctx.translate(p.x, p.y)
      ctx.rotate(p.rot)
      ctx.globalAlpha = life
      ctx.fillStyle = p.color
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.62)
      ctx.restore()
    }
    if (dt < 1.2) requestAnimationFrame(frame)
    else canvas.remove()
  }
  requestAnimationFrame(frame)
}
