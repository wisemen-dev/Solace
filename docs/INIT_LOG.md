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

## 7. 排查指引

- 应用能启动但预览报错 → 先看是否 pdf.js worker 加载失败（渲染进程控制台），
  v0.1 使用 `pdfjs-dist/build/pdf.min.mjs` + 同目录 `pdf.worker.min.mjs`
- 资料库数据异常 → 检查 `%APPDATA%/solace/SolaceLibrary/library.json`
  （写入为原子操作，损坏概率低；`.tmp` 残留文件可安全删除）
- 导入的文件找不到 → 库内文件以文档 id 重命名存于 `SolaceLibrary/files/`，
  原文件名只记录在 library.json 的 `fileName` 字段
