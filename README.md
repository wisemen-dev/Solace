# Solace

> 本地 PDF 私人图书馆 —— 集中管理、手动分类、轻量预览，再加一点让人会心一笑的小趣味。

Solace 是一款 Windows 桌面应用（Electron），把散落各处的 PDF 收进一座本地图书馆：
手动分类归档、封面墙浏览、随手翻阅。不联网、不登录、不动你的原文件。

## 功能

**v0.3（当前）**
- 导入入库：拖拽或对话框导入 PDF，复制进统一资料库，原文件保持不动
- 封面墙：自动渲染 PDF 首页生成封面缩略图，滚动可见时后台生成并落库缓存
- 拖拽归档：拖动封面卡到侧栏分类即完成归档，落点有纸屑小庆祝
- 切换运镜：分类切换时封面瀑布式入场动画
- 分类与标签：自定义分类、多标签，纯手动管理
- 轻量预览：内置 pdf.js 快速翻页，一键跳转系统默认阅读器深读
- 查找：按标题即时过滤，可叠加分类/标签筛选
- 阅读足迹：统计面板（藏书 / 打开次数 / 近 7 天 / 近 30 天 / 最近打开时间线）
- 沉睡提醒：超过 30 天未读的书在顶栏 🌙 徽章提示，清单可一键打开

**路线图**
- 候选：打包发布（electron-builder → 安装包）、按分类的统计图表、全文检索

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

## 目录结构

```
Solace_Rust/
├── src/
│   ├── main/        # Electron 主进程：窗口、IPC、资料库数据层
│   └── renderer/    # 渲染进程：界面、样式、pdf.js 预览
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
├── library.json    # 全部元数据：分类、标签、文档条目、打开记录
└── files/          # 入库的 PDF 副本（以文档 id 命名）
```

## 开发约定

- 主进程与渲染进程只通过 preload 暴露的 `window.solace.*` IPC 通信
- 元数据写入采用「临时文件 + 原子重命名」，避免写入中断损坏 library.json
- 环境异常、初始化步骤、复现方法统一记录在 `docs/INIT_LOG.md`，功能变更记入 `CHANGELOG.md`
