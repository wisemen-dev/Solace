// 设置面板：顶栏 ⚙ 或命令面板打开，按「外观 / 阅读与索引 / 笔记 / 提醒 /
// 资料库」分区。所有更改即时生效并落库（settings:set 白名单）。
// 与顶栏快捷开关是双入口同源：本模块只负责读取当前值与写回，
// 应用侧联动（重渲染、纸屑/恢复开关同步、主题重画）由 app.js 监听
// 'solace-settings' 事件完成，避免双向依赖。
// 资料库位置可更改：选文件夹 → 探测目标状态 → 按状态给出对应选项
// （空位置：移动整库 / 新建空库；已有资料库：直接使用）。切换成功后
// 广播 'solace-library-moved'，app.js 清缓存并整体刷新。

import { askChoice } from './dialog.js'
import { esc } from './util.js'

const dlg = document.getElementById('settingsDialog')
const $ = (sel) => document.querySelector(sel)

const THEMES = ['auto', 'ink', 'paper', 'dusk']
const VIEWS = ['grid', 'spine', 'shelf']
const COVER_SIZES = ['small', 'medium', 'large']
const DORMANT_CHOICES = [15, 30, 60, 90]
const INDEX_LIMITS = [300, 800, 1500, 3000, 5000]

let lastDocCount = 0
let panelSession
let panelSeq = 0
let relocating = false

// 控件值全部来自实际存储，打开面板与切库后重填共用
async function fillPanel () {
  const ticket = ++panelSeq
  let data
  try {
    data = await window.solace.getLibrary()
  } catch {
    return
  }
  if (ticket !== panelSeq) return
  panelSession = data.sessionId
  lastDocCount = data.documents.length
  const s = data.settings || {}
  $('#setTheme').value = THEMES.includes(s.theme) ? s.theme : 'auto'
  $('#setView').value = VIEWS.includes(s.viewMode) ? s.viewMode : 'grid'
  $('#setCoverSize').value = COVER_SIZES.includes(s.coverSize) ? s.coverSize : 'medium'
  $('#setOpening').checked = s.openingAnimation !== false
  $('#setConfetti').checked = s.confetti !== false
  $('#setResume').checked = s.resumeReading !== false
  $('#setDormant').value = String(DORMANT_CHOICES.includes(s.dormantDays) ? s.dormantDays : 30)
  $('#setIndexLimit').value = String(INDEX_LIMITS.includes(s.indexPageLimit) ? s.indexPageLimit : 1500)
  $('#setPdfReader').value = s.pdfReaderPath || ''
  $('#setNotesEditor').value = s.notesEditorPath || ''
  $('#setTool').value = s.externalToolPath || ''
  $('#setWatchFolder').value = s.watchFolder || ''
  $('#setWatchEnabled').checked = !!s.watchFolder && s.watchEnabled !== false
  // 自动入库分类下拉随当前资料库的分类重建
  $('#setWatchCategory').innerHTML = '<option value="">不归分类</option>' +
    (data.categories || []).map(c =>
      `<option value="${c.id}" ${s.watchCategory === c.id ? 'selected' : ''}>${esc(c.name)}</option>`
    ).join('')
  try {
    const info = await window.solace.getLibraryInfo()
    if (ticket !== panelSeq) return
    $('#setRootPath').textContent = info.rootDir
    // 位置被 SOLACE_DATA_DIR 固定（开发/测试）：禁用更改，避免「改了但重启不生效」
    const btn = $('#btnRelocate')
    btn.disabled = relocating || !info.canRelocate
    btn.title = info.canRelocate ? '' : '资料库位置已由 SOLACE_DATA_DIR 环境变量固定（开发模式）'
    return info.canRelocate
  } catch {
    if (ticket !== panelSeq) return
    $('#setRootPath').textContent = '（不可用）'
  }
}

// 左侧分类导航：点哪边右侧只显示哪一分区（控件与读写机制不变）
function showSection (sec) {
  document.querySelectorAll('#settingsNav button').forEach(b => b.classList.toggle('active', b.dataset.sec === sec))
  document.querySelectorAll('#settingsDialog .settings-group').forEach(g => g.classList.toggle('active', g.dataset.sec === sec))
}

$('#settingsNav').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-sec]')
  if (btn) showSection(btn.dataset.sec)
})

async function openSettings () {
  showSection('appearance') // 每次打开回到第一分区，避免停留在上次的分区误导
  await fillPanel()
  dlg.showModal()
}

// 写回并广播；应用侧监听后联动界面。失败静默（下次打开面板会读到真实值）
// 广播的是「实际落库的值」而不是「提交的值」：白名单会拒绝非法值（枚举/下界），
// 按提交值广播会让界面显示一个其实没存进去的偏好
async function save (patch, sessionId = panelSession) {
  if (relocating || sessionId !== panelSession) return
  let stored
  try {
    stored = await window.solace.updateSettings(patch, sessionId)
  } catch {
    return
  }
  if (relocating || sessionId !== panelSession) return
  const applied = {}
  for (const key of Object.keys(patch)) {
    if (stored && key in stored) applied[key] = stored[key]
  }
  window.dispatchEvent(new CustomEvent('solace-settings', { detail: applied }))
}

$('#setTheme').addEventListener('change', (e) => save({ theme: e.target.value }))
$('#setView').addEventListener('change', (e) => save({ viewMode: e.target.value }))
$('#setCoverSize').addEventListener('change', (e) => save({ coverSize: e.target.value }))
$('#setOpening').addEventListener('change', (e) => save({ openingAnimation: e.target.checked }))
$('#setConfetti').addEventListener('change', (e) => save({ confetti: e.target.checked }))
$('#setResume').addEventListener('change', (e) => save({ resumeReading: e.target.checked }))
$('#setDormant').addEventListener('change', (e) => save({ dormantDays: Number(e.target.value) }))
$('#setIndexLimit').addEventListener('change', (e) => save({ indexPageLimit: Number(e.target.value) }))

// 阅读器/编辑器路径：手动输入失焦保存，「浏览…」走系统文件对话框
$('#setPdfReader').addEventListener('change', (e) => save({ pdfReaderPath: e.target.value.trim() }))
$('#setNotesEditor').addEventListener('change', (e) => save({ notesEditorPath: e.target.value.trim() }))
$('#btnBrowsePdfReader').addEventListener('click', async () => {
  if (relocating) return
  const sessionId = panelSession
  try {
    const p = await window.solace.pickFile({ title: '选择 PDF 阅读器程序' })
    if (!p || relocating || sessionId !== panelSession) return
    $('#setPdfReader').value = p
    await save({ pdfReaderPath: p }, sessionId)
  } catch (err) {
    if (!relocating && sessionId === panelSession) window.toast?.(`选择失败：${err.message || err}`)
  }
})
$('#btnBrowseNotesEditor').addEventListener('click', async () => {
  if (relocating) return
  const sessionId = panelSession
  try {
    const p = await window.solace.pickFile({ title: '选择笔记编辑器程序' })
    if (!p || relocating || sessionId !== panelSession) return
    $('#setNotesEditor').value = p
    await save({ notesEditorPath: p }, sessionId)
  } catch (err) {
    if (!relocating && sessionId === panelSession) window.toast?.(`选择失败：${err.message || err}`)
  }
})
$('#setTool').addEventListener('change', (e) => save({ externalToolPath: e.target.value.trim() }))
$('#btnBrowseTool').addEventListener('click', async () => {
  if (relocating) return
  const sessionId = panelSession
  try {
    const p = await window.solace.pickFile({ title: '选择外部工具程序' })
    if (!p || relocating || sessionId !== panelSession) return
    $('#setTool').value = p
    await save({ externalToolPath: p }, sessionId)
  } catch (err) {
    if (!relocating && sessionId === panelSession) window.toast?.(`选择失败：${err.message || err}`)
  }
})

/* ---- 自动入库（监视文件夹） ---- */

$('#setWatchFolder').addEventListener('change', (e) => save({ watchFolder: e.target.value.trim() }))
$('#btnBrowseWatch').addEventListener('click', async () => {
  if (relocating) return
  const sessionId = panelSession
  try {
    const p = await window.solace.pickDirectory({ title: '选择自动入库监视文件夹' })
    if (!p || relocating || sessionId !== panelSession) return
    $('#setWatchFolder').value = p
    $('#setWatchEnabled').checked = true // 选了文件夹即视为想启用
    await save({ watchFolder: p, watchEnabled: true }, sessionId)
  } catch (err) {
    if (!relocating && sessionId === panelSession) window.toast?.(`选择失败：${err.message || err}`)
  }
})
$('#setWatchEnabled').addEventListener('change', (e) => save({ watchEnabled: e.target.checked }))
$('#setWatchCategory').addEventListener('change', (e) => save({ watchCategory: e.target.value }))

$('#btnOpenRoot').addEventListener('click', async () => {
  try { await window.solace.openLibraryRoot() } catch (err) { window.toast?.(`打开失败：${err.message || err}`) }
})

/* ---- 更改资料库位置 ---- */

$('#btnRelocate').addEventListener('click', async () => {
  if (relocating) return
  relocating = true
  const sessionId = panelSession
  const button = $('#btnRelocate')
  button.disabled = true
  let prepared = false
  try {
    const dir = await window.solace.pickDirectory({ title: '选择新的资料库位置' })
    if (!dir || sessionId !== panelSession) return

    let info
    try {
      info = await window.solace.inspectTarget(dir)
    } catch (err) {
      if (sessionId === panelSession) window.toast?.(`无法使用该位置：${err.message || err}`)
      return
    }
    if (sessionId !== panelSession) return
    if (info.sameAsCurrent) {
      window.toast?.('所选位置就是当前资料库位置')
      return
    }
    if (info.insideCurrent) {
      window.toast?.('所选位置在当前资料库内部，请选择资料库以外的文件夹')
      return
    }

    // 按目标状态呈现对应选项：已有库 → 只能「使用」（移动会覆盖）；空 → 移动或新建
    const choice = info.hasLibrary
      ? await askChoice({
        title: '切换资料库',
        text: `所选位置已有资料库（${info.docCount} 本书）。切换后使用那里的资料库；当前资料库原样保留在原处。`,
        choices: [{ label: `使用该资料库（${info.docCount} 本）`, value: 'adopt', primary: true }]
      })
      : await askChoice({
        title: '更改资料库位置',
        text: `要把当前资料库（${lastDocCount} 本）整体移动到 ${info.targetRoot}，还是在所选位置新建一个空资料库？`,
        choices: [
          { label: '移动当前资料库', value: 'move', primary: true },
          { label: '新建空资料库', value: 'new' }
        ]
      })
    if (!choice || sessionId !== panelSession) return

    prepared = true
    await window.prepareLibraryChange?.()
    if (sessionId !== panelSession) return
    const res = await window.solace.relocateLibrary(dir, { move: choice === 'move', sessionId })
    prepared = false
    window.dispatchEvent(new CustomEvent('solace-library-moved', { detail: res }))
  } catch (err) {
    if (sessionId === panelSession) window.toast?.(`更改失败：${err.message || err}`)
  } finally {
    if (prepared) window.dispatchEvent(new CustomEvent('solace-library-change-cancelled'))
    let canRelocate = false
    try {
      canRelocate = await fillPanel()
    } finally {
      relocating = false
      button.disabled = !canRelocate
    }
  }
})

document.getElementById('btnSettings').addEventListener('click', openSettings)
document.getElementById('btnSettingsClose').addEventListener('click', () => dlg.close())
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close() }) // 点 backdrop 关闭
