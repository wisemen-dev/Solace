# Solace

[![CI](https://github.com/wisemen-dev/Solace/actions/workflows/ci.yml/badge.svg)](https://github.com/wisemen-dev/Solace/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/wisemen-dev/Solace)](https://github.com/wisemen-dev/Solace/releases)

> 本地 PDF 私人图书馆 —— 集中管理、手动分类、轻量预览，再加一点让人会心一笑的小趣味。

Solace 是一款 Windows 桌面应用（Electron），把散落各处的 PDF 收进一座本地图书馆：
手动分类归档、封面墙浏览、随手翻阅。不联网、不登录、不动你的原文件。

## 功能

**v0.8（当前）**
- 导入入库：拖拽或对话框导入 PDF，复制进统一资料库，原文件保持不动
- 封面墙：自动渲染 PDF 首页生成封面缩略图，滚动可见时后台生成并落库缓存
- 书架视图：每个分类叠成一摞真实感的书堆（参考 Lumin），顶书最新、
  悬停整摞抬升，点击书堆进入该分类的封面墙
- 书脊模式：竖排书名立在架上，悬停抽书，底部细进度条显示读到哪
- 主题系统：墨水 / 纸张 / 黄昏三套配色，可按时段自动切换（晨纸张、
  昏黄昏、夜墨水）
- 开馆动画：启动时侧栏与顶栏错峰点亮
- 拖拽归档：拖动封面卡到侧栏分类即完成归档，落点有纸屑小庆祝；
  分类也能拖到分类下改变层级
- 嵌套分类树：侧栏分类可折叠、可建子分类，点父分类含子分类一起筛
- 智能收藏夹：把「分类+标签+关键词」筛选组合存成虚拟书架，一键恢复
- 命令面板：Ctrl+K 搜书、执行动作、跳分类标签
- 切换运镜：分类切换时封面瀑布式入场动画
- 分类与标签：自定义分类、多标签，纯手动管理
- 轻量预览：内置 pdf.js 快速翻页，一键跳转系统默认阅读器深读
- 阅读进度：预览翻页自动记忆，封面右上角进度环实时显示，读毕变绿庆祝
- 全文检索：后台逐本提取正文建立索引，搜索覆盖标题/文件名/正文，
  从命中卡片打开预览直达首个命中页
- 预览目录：有书签的 PDF 显示大纲面板，点击条目跳页
- 查找：按标题即时过滤，可叠加分类/标签筛选
- 阅读足迹：统计面板（藏书 / 打开次数 / 近 7 天 / 近 30 天 / 最近打开时间线 /
  分类分布环形图）
- 沉睡提醒：超过 30 天未读的书在顶栏 🌙 徽章提示，清单可一键打开

**路线图**
- 既定路线已全部完成：v0.1 管理底座 → v0.2 封面墙 → v0.3 足迹与彩蛋 →
  v0.4 图表与打包 → v0.5 进度 / 全文检索 / 目录 → v0.6 分类树 / 收藏夹 /
  命令面板 → v0.7 主题 / 书脊 / 开馆动画 → v0.8 书架视图
- 候选方向（按需再启动）：年度热力图、阅读连击徽章、本地备份

## 快速开始

要求：Node.js ≥ 20。

```bash
npm install
npm start
```

日常使用推荐**双击项目根目录的 `start-solace.bat`** 启动；也可以在终端执行
`npm start`。首次拿到代码需先执行一次 `npm install`。

开发/测试技巧：`SOLACE_DATA_DIR=<目录> npm start` 可将资料库隔离到指定位置；
`node scripts/make-sample-pdfs.js` 可生成测试用 PDF（输出到 `tmp/`）。

回归测试：

```bash
npm test              # 数据层与监视器单测（纯 Node，不依赖 Electron）
npm run test:renderer # 渲染层冒烟台（DOM 桩里真实跑 app.js 主链路）
```

## 推荐搭配

- **电子书下载：[Olib](https://github.com/shiyi-0x7f/o-lib)** —— 开源、免费、
  无广告的图书桌面客户端（aria2 多线程下载，支持 Win/macOS/Linux）。把它的
  保存目录设为 Solace 的「自动入库 · 监视文件夹」，搜到的书落盘即自动入库，
  从下载到上架一条龙
- **笔记编辑器：[Typora](https://typora.io/)** —— 所见即所得的 Markdown 编辑器，
  Solace 会自动探测已安装的 Typora，点笔记即开即写；也可在 设置 → 笔记 里指定
  任意编辑器（Obsidian、VS Code 皆可）——笔记本身就是普通的 `.md` 文件，
  随时可迁移

## 打包发布

```bash
npm run dist
```

产物：`dist/Solace-Setup-<版本>.exe`（NSIS 安装包，可选安装目录）+
`dist/win-unpacked/Solace.exe`（免安装绿色版）。打包前如需更新图标，
执行 `npm run icon`（纯 Node 生成的 `build/icon.ico`，含 256/48/32/16 四档）。

说明：打包关闭了 asar，原因是渲染进程直接以相对路径引用 node_modules 内
pdf.js 的 ESM 模块与 worker，asar 内的 Worker 加载存在已知限制。
国内网络建议为构建工具链设置镜像：
`ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`。

## 目录结构

```
Solace_Rust/
├── src/
│   ├── main/        # Electron 主进程：窗口、IPC、资料库数据层、目录监视
│   └── renderer/    # 渲染进程：界面、样式、pdf.js 预览
├── test/            # 回归测试：library/watcher 单测 + 渲染层冒烟台
├── scripts/         # 开发脚本：图标生成、示例 PDF 生成
├── docs/
│   └── INIT_LOG.md  # 初始化与环境记录（问题追踪从这里开始）
├── CHANGELOG.md
└── package.json
```

## 数据存放在哪里

资料库默认位于系统用户数据目录：
`%APPDATA%/solace/SolaceLibrary/`

```
SolaceLibrary/
├── library.json      # 全部元数据：分类、标签、文档条目（含阅读进度）、打开记录
├── textindex/        # 全文检索索引：index.json 清单 + <文档id>.json 一本一分片
├── covers/           # 封面缩略图缓存（以文档 id 命名）
├── files/            # 入库的 PDF 副本（以文档 id 命名）
└── notes/            # 每本书的 Markdown 笔记：notes/<文档id>/*.md
```

索引按本分片是为了避免「每提取一本就重写整份索引」的写放大；正文由主进程
按需读取，渲染层只拿命中页码。`textindex/` 整目录删掉也无妨，重新打开应用
会按需重建。

## 开发约定

- 主进程与渲染进程只通过 preload 暴露的 `window.solace.*` IPC 通信
- 元数据写入采用「临时文件 + 原子重命名」，避免写入中断损坏 library.json
- `library.js` / `watcher.js` 不依赖 Electron，可直接在 Node 下单测——
  改动数据层请顺手补 `test/` 用例
- 启动时的孤儿清理只认严格 UUID 命名的文件，且库为空时不清扫：
  误删用户的 PDF 副本是不可逆的，宁可多留
- 环境异常、初始化步骤、复现方法统一记录在 `docs/INIT_LOG.md`，功能变更记入 `CHANGELOG.md`

## 许可证

[MIT](LICENSE) —— 霞鹜文楷 Lite 字体（OFL）与 pdf.js（Apache-2.0）等
依赖遵循其各自的开源协议。
