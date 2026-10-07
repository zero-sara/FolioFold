# FolioFold

FolioFold 是一个在你自己电脑上运行的**简历/作品集编辑器与发布工具**。写内容、调版式、随时预览，然后把简历/作品集发布成一个属于你自己的网站。

FolioFold is a local-first **résumé/portfolio builder and publisher**. Write it, shape it, and publish it — without fighting your tools.

> Less fighting with layouts, more time making your résumé/portfolio look like you.

---

## ✨ Try the FolioFold Demo

- **[打开 FolioFold Demo](https://zero-sara.github.io/FolioFrame/)**
- **[备用入口 / Mirror](https://folioframe-site-d4f57yrt27bf927f-1486162327.tcloudbaseapp.com/FolioFrame-2/)**

这是公开的展示示例，可以看 FolioFold 做出来的实际效果。

---

## ⚡ Quick Start

> ⚠️ **两种启动方式其实是同一个软件**：方式一是双击 `FolioFold.exe` 启动器（Windows 一键），方式二是双击 `FolioFold 启动.bat` / `停止.bat`。两者都会启动同一套本地服务，只是入口不同，效果完全一样。**两种方式都要求本机已安装 Python 3.11**。

**方式一 · EXE 启动器（Windows 一键）**
1. 确保本机已装 **Python 3.11**（服务器依赖 Python 3.12 之后被移除的 `cgi` 模块，3.12+ 不可用）
2. 双击项目根目录的 **`FolioFold.exe`** 启动，浏览器自动打开 <http://127.0.0.1:3000/>
3. 关闭时双击 **`FolioFold 停止.bat`**

**方式二 · BAT（最稳妥的兜底，推荐先用这个）**
1. 确保本机已装 **Python 3.11**
2. 双击项目根目录的 **`FolioFold 启动.bat`**
3. 浏览器自动打开 <http://127.0.0.1:3000/>
4. 关闭时双击 **`FolioFold 停止.bat`**（只停 FolioFold 自己的服务，不影响其他程序）

> 想省事就双击 `.exe`；更稳、更可排查就双击 `.bat`。两者都不是"另一个软件"。

---

## 🤖 让 AI 帮我安装

不想自己敲命令？把下面**对应的一段**整段复制给任意 AI 助手（如 ChatGPT / Claude / 本机 AI 助手），它就能照着在你的电脑上装好并跑起来。

**单语言版（界面固定一种语言，没有语言切换入口）**：

```
请帮我在我的电脑上安装并启动 FolioFold（一个本地运行的简历/作品集编辑器，做成单语言版）。
步骤：
1. 打开终端，运行：git clone https://github.com/zero-sara/FolioFold.git  然后 cd FolioFold
2. 确认本机已安装 Python 3.11（不是 3.12+，因为服务器依赖已被移除的 cgi 模块；没装的话先去 python.org 装 3.11）
3. 编辑仓库里的 dist-config.js，把 langMode 设为 'single'、defaultLang 设为 'zh-CN'（中文单语言；想要英文就填 'en'）
4. 双击项目根目录的「FolioFold 启动.bat」启动，浏览器会自动打开 http://127.0.0.1:3000/
5. 关闭时双击「FolioFold 停止.bat」
如果遇到端口被占用或 Python 报错，请把报错原样贴给我。
```

**多语言版（保留中英文等语言切换入口，完整 i18n）**：

```
请帮我在我的电脑上安装并启动 FolioFold（一个本地运行的简历/作品集编辑器，支持多语言）。
步骤：
1. 打开终端，运行：git clone https://github.com/zero-sara/FolioFold.git  然后 cd FolioFold
2. 确认本机已安装 Python 3.11（不是 3.12+，因为服务器依赖已被移除的 cgi 模块；没装的话先去 python.org 装 3.11）
3. 保持 dist-config.js 默认（langMode: 'multi'，完整 i18n，保留语言切换入口）
4. 双击项目根目录的「FolioFold 启动.bat」启动，浏览器会自动打开 http://127.0.0.1:3000/
5. 关闭时双击「FolioFold 停止.bat」
如果遇到端口被占用或 Python 报错，请把报错原样贴给我。
```

> 说明：FolioFold 不是"下载完 EXE 就能直接跑、无需任何环境"的软件——它的启动器依赖本机 **Python 3.11**。仓库里没有预编译的 Release 安装包下载链接，请直接 `git clone` 源码后用上面的方式启动。单语言/多语言只是同一份代码的一个开关（`dist-config.js`），切换不需要改任何其它文件。

---

**[中文说明 ↓](#中文说明)** ・ **[English ↓](#english)**

---

## 中文说明

### FolioFold 是什么

一个运行在本地的个人简历/作品集编辑器与发布工具。不需要构建工具，也不需要联网：在本机启动它，用浏览器打开，就能一边编辑一边看到真实效果。

做好的简历/作品集可以留在本地，也可以发布成公开可访问的网站，或者导出成单个 HTML 文件、ZIP 或 PDF。

内容和视觉是分开存放的——改文字不会弄坏排版，改排版也不会弄丢内容。

### 它能做什么

- **编辑内容**：About / Experience / Works / Showreel 等区块，包含文字、图片、视频，以及 Showreel 章节时间点
- **调整视觉**：拖拽区块顺序、调整留白、在画布上直接改文字、切换配色主题（内置多套浅色 / 深色预设）
- **实时预览**：改动立刻反映在预览里，所见即所得
- **内置两套模板**：Starter 与 FolioFold Demo（见下）；也可以把一套版式导出成模板文件，在别处导入套用
- **单语言 / 多语言**：默认完整多语言（中英文等随意切换）；想做成单语言发行物，只改 `dist-config.js` 一个开关即可隐藏所有语言切换入口
- **本地优先**：内容和设计都存成本机文件，方便复制、备份、版本管理
- **发布与导出**：发布到 GitHub Pages，或导出 HTML / ZIP / PDF

### 内置模板

FolioFold 内置两套模板：

| 模板 | 用途 |
|---|---|
| **Starter** | 干净的起点，内容是中性占位文案，适合直接改成自己的东西 |
| **FolioFold Demo** | 完整的演示简历/作品集，能看到 FolioFold 做出来的样子（也就是上面的公开 Demo） |

> **Main 不是"第三套模板"。** 你在编辑器里正在编辑、属于你自己的那份内容，保存在本机，叫 **Main（你的工作区）**，它不会进入仓库，也不在"可供选择的模板"列表中。第一次启动时，如果本机还没有自己的内容，FolioFold 会用 **Starter** 初始化你的工作区；之后这个工作区就是你自己的项目，可以继续编辑和添加内容。你已有的内容永远不会被覆盖。

也可以把一套版式导出成模板文件（只含视觉设计，不含文字和媒体），在别处导入套用。

### 🛠️ 开始使用

需要 **Python 3.11**。FolioFold 本身没有第三方依赖，但服务器用到了 Python 3.12 之后被移除的 `cgi` 模块。

```bash
git clone https://github.com/zero-sara/FolioFold.git
cd FolioFold
py server.py
```

然后在浏览器打开 <http://127.0.0.1:3000/>。

Windows 用户直接双击项目根目录的 **`FolioFold 启动.bat`**（端口被占用时会自动处理）；关闭时双击 **`FolioFold 停止.bat`**。想要一键启动也可以用 **`FolioFold.exe`** 启动器。

### 🚀 发布与导出

简历/作品集做好之后：

- **发布到 GitHub Pages**：用你自己的 GitHub 账号授权（设备码流程，不需要你创建 OAuth App），FolioFold 会帮你建 / 更新仓库并启用 Pages
- **导出 ZIP**：完整的静态站点，可以放到任意托管平台
- **导出单文件 HTML**：一个文件，离线也能打开
- **导出 PDF**：用浏览器打印成 PDF

### 你的数据留在本机

FolioFold 没有自己的服务器。内容、媒体和令牌都只存在你的电脑上，涉及凭据的文件都不会进入仓库。内容与设计分开保存，每次保存都会留一份上一版，方便回滚。

---

## English

### What FolioFold is

A résumé/portfolio editor and publisher that runs on your own machine. No build step, no cloud account — start it locally, open it in a browser, and edit while looking at the real thing.

Keep it private, publish it as a public site, or export it as a single HTML file, a ZIP, or a PDF.

Content and visual design are stored separately, so editing your words never breaks your layout, and tweaking the layout never touches your words.

### What you can do

- **Write your content** — about, experience, projects, showreel sections, images, video and showreel chapter markers
- **Shape the look** — reorder sections by dragging, adjust spacing, edit text right on the page, switch between built-in light and dark themes
- **Preview as you go** — changes show up immediately
- **Start from a template** — two built-in templates (see below); export or import a look you like
- **Single-language or multi-language** — full i18n by default (switch between languages freely); to ship a single-language build, flip one switch in `dist-config.js` to hide all language switchers
- **Stay local** — everything lives in plain files on your machine, easy to copy, back up, or version control
- **Publish or export** — push to GitHub Pages, or export HTML / ZIP / PDF

### Built-in templates

FolioFold ships with two templates:

| Template | What it's for |
|---|---|
| **Starter** | A clean starting point. Neutral placeholder content you replace with your own. |
| **FolioFold Demo** | A complete sample résumé/portfolio showing what FolioFold can look like — the public demo above. |

> **Main is not a "third template."** The portfolio you're actively editing — your own content — is stored locally and is called **Main (your workspace)**. It never enters the repository and is not listed as a selectable template. On first run, if you don't have a portfolio yet, FolioFold initializes one from **Starter**. After that, this workspace is your own project — keep editing and adding to it. Your existing content is never overwritten.

You can also export a look as a template file (visual design only, no text or media) and import it elsewhere.

### 🛠️ Getting started

Requires **Python 3.11**. FolioFold itself has no third-party dependencies, but the server uses the `cgi` module, which was removed in Python 3.12.

```bash
git clone https://github.com/zero-sara/FolioFold.git
cd FolioFold
py server.py
```

Then open <http://127.0.0.1:3000/> in your browser.

On Windows, just double-click **`FolioFold 启动.bat`** in the project root (it handles a busy port for you); to stop, double-click **`FolioFold 停止.bat`**. You can also use the **`FolioFold.exe`** launcher for one-click start.

### 🚀 Publish & export

When your résumé/portfolio is ready:

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
