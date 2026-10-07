# FolioFold

FolioFold 是一个在你自己电脑上运行的作品集编辑器。写内容、调版式、随时预览，然后把作品集发布成一个属于你自己的网站。

FolioFold is a local-first portfolio builder. Write it, shape it, and publish it — without fighting your tools.

> Less fighting with layouts, more time making your portfolio look like you.

---

## ✨ Try the FolioFold Demo

- **[打开 FolioFold Demo](https://zero-sara.github.io/FolioFrame/)**
- **[备用入口 / Mirror](https://folioframe-site-d4f57yrt27bf927f-1486162327.tcloudbaseapp.com/FolioFrame-2/)**

这是公开的展示示例，可以看 FolioFold 做出来的实际效果。

---

## ⚡ Quick Start

**中文**：下载或 `git clone` 之后，不需要懂 Python 或 server.py：
1. 双击项目根目录的 **`FolioFold 启动.bat`**
2. 浏览器自动打开 <http://127.0.0.1:3000/>
3. 编辑你的作品集
4. 关闭时双击 **`FolioFold 停止.bat`**（只停 FolioFold 自己的服务，不影响其他程序）

> 需要本机已安装 **Python 3.11**（`cgi` 依赖，3.12+ 不可用）。

**English**: After you download or `git clone`, you don't need to know Python or server.py:
1. Double-click **`FolioFold 启动.bat`** in the project root
2. Your browser opens <http://127.0.0.1:3000/> automatically
3. Edit your portfolio
4. To stop, double-click **`FolioFold 停止.bat`** (it stops only FolioFold's own server — other programs are untouched)

> Requires **Python 3.11** locally (uses the `cgi` module, removed in 3.12+).

**可选 · Windows 一键启动**：GitHub Releases 里提供 `FolioFold.exe`（把启动逻辑打包成的 launcher，仍需本机 Python 3.11）。双击即可启动；根目录的 `FolioFold 启动.bat` / `停止.bat` 依旧保留，作为最稳妥的兜底。

**Optional · one-click (Windows)**: GitHub Releases also ships `FolioFold.exe` — a packaged launcher (still requires local Python 3.11). The `FolioFold 启动.bat` / `停止.bat` stay in the repo as the reliable fallback.

---

**[中文说明 ↓](#中文说明)** ・ **[English ↓](#english)**

---

## 中文说明

### FolioFold 是什么

一个运行在本地的个人作品集编辑器。不需要构建工具，也不需要联网：在本机启动它，用浏览器打开，就能一边编辑一边看到真实效果。

做好的作品集可以留在本地，也可以发布成公开可访问的网站，或者导出成单个 HTML 文件、ZIP 或 PDF。

内容和视觉是分开存放的——改文字不会弄坏排版，改排版也不会弄丢内容。

### 它能做什么

- **编辑内容**：About / Experience / Works / Showreel 等区块，包含文字、图片、视频，以及 Showreel 章节时间点
- **调整视觉**：拖拽区块顺序、调整留白、在画布上直接改文字、切换配色主题（内置多套浅色 / 深色预设）
- **实时预览**：改动立刻反映在预览里，所见即所得
- **多模板**：自带几套风格不同的模板，也可以导出 / 导入自己的版式
- **多语言**：支持中英文等多种语言切换
- **本地优先**：内容和设计都存成本机文件，方便复制、备份、版本管理
- **发布与导出**：发布到 GitHub Pages，或导出 HTML / ZIP / PDF

### 内置模板

自带三套模板，风格与用途都不同：

| 模板 | 用途 |
|---|---|
| **Starter** | 干净的起点，内容是中性占位文案，适合直接改成自己的东西 |
| **FolioFold Demo** | 完整的演示作品集，能看到 FolioFold 做出来的样子（也就是上面的公开 Demo） |
| **Main（你的作品集）** | 你自己正在编辑的那一份，保存在本机，不会进入仓库 |

首次启动时，如果本机还没有作品集数据，FolioFold 会用 **Starter** 自动初始化一份。你已有的内容永远不会被覆盖。

也可以把一套版式导出成模板文件（只含视觉设计，不含文字和媒体），在别处导入套用。

### 🛠️ 开始使用

需要 **Python 3.11**。FolioFold 本身没有第三方依赖，但服务器用到了 Python 3.12 之后被移除的 `cgi` 模块。

```bash
git clone https://github.com/<你的用户名>/<仓库名>.git
cd FolioFold
py server.py
```

然后在浏览器打开 <http://127.0.0.1:3000/>。

Windows 用户直接双击项目根目录的 **`FolioFold 启动.bat`** 即可（端口被占用时会自动处理）；关闭时双击 **`FolioFold 停止.bat`**。

### 🚀 发布与导出

作品集做好之后：

- **发布到 GitHub Pages**：用你自己的 GitHub 账号授权（设备码流程，不需要你创建 OAuth App），FolioFold 会帮你建 / 更新仓库并启用 Pages
- **导出 ZIP**：完整的静态站点，可以放到任意托管平台
- **导出单文件 HTML**：一个文件，离线也能打开
- **导出 PDF**：用浏览器打印成 PDF

### 你的数据留在本机

FolioFold 没有自己的服务器。内容、媒体和令牌都只存在你的电脑上，涉及凭据的文件都不会进入仓库。内容与设计分开保存，每次保存都会留一份上一版，方便回滚。

---

## English

### What FolioFold is

A portfolio builder that runs on your own machine. No build step, no cloud account — start it locally, open it in a browser, and edit while looking at the real thing.

Keep it private, publish it as a public site, or export it as a single HTML file, a ZIP, or a PDF.

Content and visual design are stored separately, so editing your words never breaks your layout, and tweaking the layout never touches your words.

### What you can do

- **Write your content** — about, experience, projects, showreel sections, images, video and showreel chapter markers
- **Shape the look** — reorder sections by dragging, adjust spacing, edit text right on the page, switch between built-in light and dark themes
- **Preview as you go** — changes show up immediately
- **Start from a template** — several built-in templates with different feels; export or import a look you like
- **Write in more than one language**
- **Stay local** — everything lives in plain files on your machine, easy to copy, back up, or version control
- **Publish or export** — push to GitHub Pages, or export HTML / ZIP / PDF

### Built-in templates

Three templates, each with a different purpose:

| Template | What it's for |
|---|---|
| **Starter** | A clean starting point. Neutral placeholder content you replace with your own. |
| **FolioFold Demo** | A complete sample portfolio showing what FolioFold can look like — the public demo above. |
| **Main (yours)** | The portfolio you're editing. Stored locally, never committed to the repository. |

On first run, if you don't have a portfolio yet, FolioFold initializes one from **Starter**. Your existing content is never overwritten.

### 🛠️ Getting started

Requires **Python 3.11**. FolioFold itself has no third-party dependencies, but the server uses the `cgi` module, which was removed in Python 3.12.

```bash
git clone https://github.com/<your-username>/<repo>.git
cd FolioFold
py server.py
```

Then open <http://127.0.0.1:3000/> in your browser.

On Windows, just double-click **`FolioFold 启动.bat`** in the project root (it handles a busy port for you); to stop, double-click **`FolioFold 停止.bat`**.

### 🚀 Publish & export

When your portfolio is ready:

- **GitHub Pages** — authorize with your own GitHub account (device flow, no OAuth app to create); FolioFold creates or updates the repo and enables Pages
- **ZIP** — a complete static site you can host anywhere
- **Single-file HTML** — one file you can open offline
- **PDF** — print your published portfolio to PDF

### Your data stays local

FolioFold has no server of its own. Your content, media and tokens stay on your machine, and credential files never enter the repository. Each save keeps a previous version you can roll back to.

---

## License

[MIT](./LICENSE) © FolioFold contributors.

本仓库只包含 FolioFold 本体和一份公开 Demo，不含任何个人作品集——你自己的数据只存在于本机，不会被提交。

This repository ships the FolioFold app itself and a public demo. It contains no personal portfolio; your own data lives only on your machine and is never committed.
