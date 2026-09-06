# 初始化与环境记录（INIT_LOG）

> 本文档是 Solace 项目的问题追踪起点：记录初始化时的环境快照、已发现的环境异常、
> 产品决策依据，以及从零复现本项目的完整步骤。排查问题时请先读本文件。

---

## 1. 初始化快照

| 项目 | 值 |
|---|---|
| 初始化日期 | 2026-09-05 |
| 初始版本 | v0.1.0 |
| 操作系统 | Windows 10.0.26200 x64 |
| 工作区路径 | `E:\Learning\pycharm\ExperProject\Solace_Rust` |
| Git 实际安装位置 | `C:\Program Files\Git` |
| Node.js / npm 版本 | Node v24.15.0 / npm 12.0.1（2026-09-05 实测） |
| Git 版本 | 2.54.0.windows.1（2026-09-05 实测） |
| Electron 实测版本 | 38.8.6 |
| pdfjs-dist 实测版本 | 4.10.38 |
| 版本管理 | 已执行 `git init`（main 分支），首次提交 ea5665c |

## 2. 环境异常记录

### 异常 #1：工作区目录在资源管理器中不存在

- **现象**：ZCode 会话配置的工作目录
  `E:\Learning\pycharm\ExperProject\Solace_Rust` 在资源管理器中找不到。
- **排查**：逐级探测路径链，`E:\Learning` → `pycharm` → `ExperProject` 均存在，
  断在最后一层 `Solace_Rust`。
- **结论**：该目录**从未被创建过**（此前仅作为工作区路径配置存在，不是被移动或删除）。
- **处置**：2026-09-05 初始化时由本次创建，自此该路径真实存在。
- **影响**：无遗留问题。若未来再出现"目录消失"，先逐级探测路径链确认断点层级。

### 异常 #2：ZCode Bash 工具无法启动（spawn ENOENT）

- **现象**：本会话中所有 Bash 工具调用均报错
  `spawn E:\Git\bin\bash.exe ENOENT`。
- **排查**：`E:\Git\bin\bash.exe` 确实不存在；但 `C:\Program Files\Git\bin\bash.exe`
  存在，说明 Git 曾装在 E:\Git 且现已不在，客户端 Shell 探测结果未更新。
  `C:\Users\Molly\.zcode\cli\config.json` 不存在，无用户级配置可改。
- **结论**：ZCode 客户端缓存的 Git Bash 路径指向旧安装位置（疑似旧版 Git 安装于
  E:\Git，重装/迁移到 C 盘后残留 PATH 或注册表旧值）。
- **影响**：仅影响开发会话内的命令执行（npm / git 等），不影响应用代码与运行。
- **修复建议**（任选其一，修复后重启 ZCode 生效）：
  1. 检查系统环境变量 PATH，移除指向 `E:\Git\...` 的旧条目；
  2. 检查注册表 `HKCU\Software\Git for Windows` 的 `InstallPath` 值，
     若指向 `E:\Git` 改为 `C:\Program Files\Git`（或删除后重装 Git for Windows）；
  3. 最简单：重新运行 Git for Windows 安装程序选择 Repair。
- **验证方法**：修复后在新 ZCode 会话中执行 `echo ok`，能返回即恢复。
- **结案（2026-09-05）**：未做任何修复操作，同日稍后 Shell 自行恢复；
  `E:\Git` 目录实际存在，推测当时为 E: 盘瞬时未就绪/重新挂载所致。
  用户确认本机 Git 环境正常。若复发，按上述排查项依次检查；
  该故障只影响开发会话内的命令执行，与应用本身无关。

## 3. 产品决策记录（v0.1 范围的来源）

以下决策由需求澄清确认，是当前功能范围的依据：

| 决策点 | 结论 | 影响 |
|---|---|---|
| 文档规模 | 一两百份以内 | 不做全文检索与索引优化，元数据用 JSON 而非 SQLite |
| 分类方式 | 纯手动整理 | 不做自动分类 / AI 辅助，交互以拖拽与直接编辑为主 |
| 阅读功能 | 内置轻量预览 | pdf.js 翻页预览；深读跳转外部阅读器，不做批注 |
| 创意方向 | 视觉书架、阅读足迹、沉浸小彩蛋 | v0.2 封面墙、v0.3 统计与彩蛋；明确不做智能助手 |
| 入库方式 | 导入库模式 | 复制进资料库，原文件不动；代价是磁盘占用翻倍 |
| 技术栈 | Electron + JavaScript | Mineradio 同路线，视觉功能生态成熟 |
| 项目名 | Solace（目录名 Solace_Rust 中的 _Rust 为历史遗留命名，保留未改） | — |

## 4. 从零复现步骤

在一台新的 Windows 机器上重建本项目并运行：

```bash
# 1. 前置条件：安装 Node.js ≥ 20 与 Git for Windows
node -v && npm -v

# 2. 克隆 / 拷贝本项目目录（当前尚未建远程仓库，直接拷贝目录即可）

# 3. 安装依赖（electron 二进制较大，耐心等待）
npm install

# 4. 启动应用
npm start
```

初始化本仓库时（2026-09-05）实测踩到的两个坑，复现时必看：

1. **npm ≥ 12 默认拦截依赖安装脚本**：`npm install` 后 electron 的
   postinstall 被阻止，Electron 二进制不会下载。需执行
   `npm install-scripts approve electron` 后再 `npm rebuild electron`。
2. **Electron 二进制默认走境外源，可能极慢**：实测直连 12 分钟未完成，
   换镜像后数十秒完成：
   `ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" npm rebuild electron`。

## 5. 待办（初始化遗留）

- [x] 补记 Node.js / npm / Git / electron 实测版本到第 1 节
- [x] 执行 `git init` 并完成首次提交（ea5665c）
- [x] 首次 `npm start` 运行验证，结果见第 6 节

## 6. 运行验证记录

### 2026-09-05 · v0.1.0 首次启动验证

- 命令：`npm start`
- 结果：**成功**。启动日志无异常输出，进程管理器可见 4 个 electron.exe
  （主进程 + GPU 等子进程），窗口正常显示。
- 期间验证：`node_modules/pdfjs-dist/build/pdf.min.mjs` 与
  `pdf.worker.min.mjs` 存在，渲染进程引用路径（`../../../node_modules/...`）
  与实际位置一致。
- 待人工确认项：导入真实 PDF → 预览翻页 → 外部打开 → 分类/标签编辑
  等交互流程，由日常使用反馈。

### 2026-09-06 · 空白界面问题修复与视觉验证

- **现象**：用户反馈窗口打开后"什么都没有"。
- **排查**：`ELECTRON_ENABLE_LOGGING=1` 启动无任何 JS 报错 → 改用桌面截图
  实际观察，发现主界面渲染正常，只是被常驻的预览浮层遮挡。
- **根因**：`.preview-overlay { display: flex }` 优先级高于 `hidden` 属性的
  浏览器默认 `display: none`，浮层从启动起就盖住整个窗口。
- **修复**：新增 `.preview-overlay[hidden] { display: none }`（提交 e9591ca）。
- **验证**：重启后截图确认主界面（侧栏/搜索/空状态提示）显示正常。
- **教训**：「进程存活」不等于「界面正常」，GUI 验证必须看实际渲染效果。

### 2026-09-06 · v0.2.0 封面墙验证 + 空白复发 + 数据迁移

- **封面墙**：3 份真实 PDF（2.8 ~ 17.7 MB）封面全部自动生成并落库，拖拽归档、
  分类计数、筛选均实测正常（其中拖拽归档由用户实时操作验证）。
- **空白复发（已修复）**：一次启动后窗口整体不重绘（连静态 HTML 都不可见，
  与 0.1.0 的浮层遮挡不同，渲染进程无任何 JS 报错）。结合复现时机（窗口
  最小化/恢复）判定为 Windows 上 Chromium 原生窗口遮挡计算（
  `CalculateNativeWinOcclusion`）的已知缺陷。处置：主进程禁用该特性 +
  改为 `ready-to-show` 后显示窗口（见 CHANGELOG 0.2.0）。若再遇空白窗口，
  优先怀疑环境/GPU 因素，用 `ELECTRON_ENABLE_LOGGING=1 npm start` 复现抓日志。
- **数据迁移**：v0.2 测试用了 `SOLACE_DATA_DIR` 隔离库，用户在其间导入并
  整理的 3 份文档（含封面、分类）落在测试库。已将测试库合并回默认库
  （以数据更全的测试库为准，保留默认库多出的标签），迁移前默认库已备份为
  `%APPDATA%/solace/SolaceLibrary/library.json.bak-20260906`。
  迁移后经截图验证：3 本封面墙 + 分类 LearinngRust(2)/Stream(1) +
  标签 LearningRust 完整呈现。

### 2026-09-06 · v0.3.0 足迹面板 / 沉睡提醒 / 彩蛋验证

- **验证方法**：构造带回填日期的夹具库（`tmp/fixture`，4 本：2 小时前打开、
  40 天没读、60 天从未翻、新入库），以 `SOLACE_DATA_DIR` 隔离启动。
- **通过项**（截图确认）：顶栏 🌙 徽章计数 = 2 正确；足迹面板五项指标
  （4 本藏书 / 7 次累计打开 / 近 7 天 1 / 近 30 天 1 / 沉睡 2）全部正确；
  最近打开时间线显示《足迹A》2 小时前；沉睡清单按沉睡时长排序、
  文案区分「入库 N 天，还没翻开过」与「N 天没打开了」，且带「打开」按钮。
- **受限项**：归档彩蛋的自动化拖拽验证受阻——CUA 合成鼠标事件（快速或
  分步）均无法触发 Chromium 的 HTML5 拖放协议，属测试工具限制而非应用
  缺陷（拖拽归档链路已由用户在 v0.2 实测通过，v0.3 仅在其成功分支追加
  `burst(落点)` 一行）。彩蛋待用户首次真实拖拽时确认视觉效果。
- **遗留**：`tmp/fixture`、`tmp/solace-test-data` 已在 .gitignore 中，
  可随时删除。

### 2026-09-06 · v0.3.1 标题搜索修复

- **现象**：用户反馈标题搜索不能正常使用。
- **排查**：实机复现测过英文（Rust）、中文（通过）、✕ 清除按钮均正常，
  最终检查资料库标题发现《Rust 程序设计语言》含半角空格——原实现为严格
  子串匹配，搜「rust程序」（不带空格）必然零结果。
- **修复**：匹配前对搜索词与标题/文件名做归一化（`normText`：小写化 +
  剔除 `\s+` 全部空白，含全角空格），并将文件名纳入匹配范围。
- **验证**：重启后搜「rust程序」命中《Rust 程序设计语言》（修复前为
  零结果），截图确认。
- **经验**：中英混排标题里的空格是搜索的隐形陷阱，CJK 场景匹配前应做
  空白归一化。

## 7. 排查指引

- 应用能启动但预览报错 → 先看是否 pdf.js worker 加载失败（渲染进程控制台），
  v0.1 使用 `pdfjs-dist/build/pdf.min.mjs` + 同目录 `pdf.worker.min.mjs`
- 资料库数据异常 → 检查 `%APPDATA%/solace/SolaceLibrary/library.json`
  （写入为原子操作，损坏概率低；`.tmp` 残留文件可安全删除）
- 导入的文件找不到 → 库内文件以文档 id 重命名存于 `SolaceLibrary/files/`，
  原文件名只记录在 library.json 的 `fileName` 字段
