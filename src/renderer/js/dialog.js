// 通用文本输入对话框（Electron 不支持 window.prompt）。
// 从 index.html 的 #inputDialog 元素驱动，app.js（新建分类/标签/收藏夹等）
// 与笔记面板（编辑器路径询问）共用。
export function askText (title, initial = '') {
  return new Promise((resolve) => {
    const dlg = document.querySelector('#inputDialog')
    const input = document.querySelector('#inputDialogInput')
    document.querySelector('#inputDialogTitle').textContent = title
    input.value = initial
    let settled = false
    document.querySelector('#inputDialogOk').onclick = () => { settled = true; dlg.close(); resolve(input.value.trim()) }
    document.querySelector('#inputDialogCancel').onclick = () => { settled = true; dlg.close(); resolve(null) }
    dlg.onclose = () => { if (!settled) resolve(null) }
    dlg.showModal()
    input.focus()
    input.select()
  })
}

// 通用确认对话框：可带一个勾选项（如删除文档时「同时删除笔记」）。
// 确认返回 { ok: true, checked: 勾选状态 }；取消/Esc 返回 null。
export function askConfirm ({ title, text, checkLabel = null, okText = '确定' }) {
  return new Promise((resolve) => {
    const dlg = document.querySelector('#confirmDialog')
    const checkRow = document.querySelector('#confirmCheckRow')
    const check = document.querySelector('#confirmDialogCheck')
    document.querySelector('#confirmDialogTitle').textContent = title
    document.querySelector('#confirmDialogText').textContent = text
    checkRow.hidden = !checkLabel
    if (checkLabel) document.querySelector('#confirmCheckLabel').textContent = checkLabel
    check.checked = true
    let settled = false
    document.querySelector('#confirmDialogOk').textContent = okText
    document.querySelector('#confirmDialogOk').onclick = () => { settled = true; dlg.close(); resolve({ ok: true, checked: check.checked }) }
    document.querySelector('#confirmDialogCancel').onclick = () => { settled = true; dlg.close(); resolve(null) }
    dlg.onclose = () => { if (!settled) resolve(null) }
    dlg.showModal()
  })
}

// 多选对话框：若干个动作按钮（如「移动当前资料库 / 新建空资料库」）。
// 返回被点按钮的 value；取消/Esc 返回 null。按钮动态生成，无勾选逻辑
export function askChoice ({ title, text, choices }) {
  return new Promise((resolve) => {
    const dlg = document.querySelector('#choiceDialog')
    const box = document.querySelector('#choiceButtons')
    document.querySelector('#choiceDialogTitle').textContent = title
    document.querySelector('#choiceDialogText').textContent = text
    box.innerHTML = ''
    let settled = false
    const done = (v) => {
      if (settled) return
      settled = true
      dlg.close()
      resolve(v)
    }
    for (const c of choices) {
      const b = document.createElement('button')
      b.className = c.primary ? 'btn-primary' : 'btn-ghost'
      b.textContent = c.label
      b.onclick = () => done(c.value)
      box.appendChild(b)
    }
    const cancel = document.createElement('button')
    cancel.className = 'btn-ghost'
    cancel.textContent = '取消'
    cancel.onclick = () => done(null)
    box.appendChild(cancel)
    dlg.onclose = () => done(null)
    dlg.showModal()
    // 焦点落在首个动作按钮上：Enter 即确认（与确认对话框行为一致），Esc 原生关闭
    ;(box.querySelector('.btn-primary') || box.querySelector('button'))?.focus()
  })
}
