# FolioFold

FolioFold 把你散落的经历、作品与想法，整理成一份**内容组织清晰、信息完整、条理分明**的简历 / 作品集，并在同一套界面里完成编辑、排版与发布——本地优先，随时预览，发布即上线。

FolioFold helps you turn scattered experience, work and ideas into a **résumé/portfolio that is clearly organized, complete and well-structured** — edit, lay out and publish from one unified workspace, preview as you go, and go live the moment you publish.

> Less fighting with layouts, more time making your résumé/portfolio look like you.

---

## ✨ Try the FolioFold Demo

- **[打开 FolioFold Demo](https://zero-sara.github.io/FolioFoldPages/)**

这是公开的展示示例，可以看 FolioFold 做出来的实际效果。

### 🖼️ 产品截图 / Screenshots

**文本编辑 / Text editor** — 按区块结构化地编辑内容（About / Experience / Works / Showreel…）

![文本编辑界面](docs/images/text-editor.png)

**排版编辑 / Visual (layout) editor** — 拖拽调整区块顺序与留白、切换主题，右侧实时预览成品

![排版编辑界面](docs/images/visual-editor.png)

---

## ⚡ Quick Start

> FolioFold 是**本地运行**的软件，需要你本机有 **Git** 和 **Python**。**不需要**手动 `pip install` 任何东西——FolioFold 自身没有第三方依赖。
>
> **建议使用 Python 3.11 或 3.12**（本项目已实际验证 3.11.6 与 3.12.14）。**Python 3.13 及以上目前无法运行**：项目依赖的 `cgi` 模块已在 3.13 移除；3.8 / 3.9 / 3.10 本机未安装、未验证，请使用 3.11 或 3.12。

**方式一 · BAT 启动脚本（推荐，clone 下来就能用）**
1. 确认本机已装 **Python 3.11 或 3.12**（启动脚本会在两者之间自动挑选）
2. 双击项目根目录的 **`FolioFold 启动.bat`**
3. 浏览器自动打开 <http://127.0.0.1:3000/>
4. 关闭时双击 **`FolioFold 停止.bat`**（只停 FolioFold 自己的服务，不影响其他程序）

**方式二 · EXE 启动器（可选，非必需）**
`FolioFold.exe` 是一个**可选的一键启动器**，它**不是独立软件**——运行它同样要求本机装有 Python 3.11 或 3.12。它**不在源码仓库里**（通过 GitHub Releases 单独分发），也可以运行 `build_exe.bat` 自行构建；拿到后放进项目根目录双击即可。

> 简单说：**`git clone` 之后请用方式一**；方式二只是给想要一键图标的用户准备的替代入口。两者运行的是同一套本地服务，效果完全一样。

---

## 🤖 让 AI 帮我安装

不想自己敲命令？把**下面整段**复制给任意 AI 助手（ChatGPT / Claude / 本机 AI 助手等）。它会先检查你的电脑环境，再决定怎么装、怎么启动——而不是一上来就假定环境已经就绪。

当前支持 **10** 种语言：中文 / 繁體中文 / English / 日本語 / 한국어 / Français / Español / Italiano / Deutsch / Português
<sub>语言代码：zh-CN · zh-TW · en · ja · ko · fr · es · it · de · pt（以仓库 `i18n.js` 的 `LANGS` 为准）</sub>

```
请帮我在我的电脑上检查环境、安装并启动 FolioFold（一个本地运行的简历 / 作品集编辑器）。

请按“先检测 → 再判断 → 缺什么装什么 → 安装后复检 → 最后启动”的顺序进行，
不要一上来就假定环境已经就绪。

1) 检测环境
   - 告诉我当前的操作系统与版本。
   - 检查是否安装了 Git（git --version）。
   - 列出本机所有已安装的 Python 版本（Windows 可先跑 `py -0p`，再用
     `python --version` / `python3 --version` 交叉确认；必要时扫描常见安装路径）。

2) 判断版本
   - FolioFold 需要 Python 3.11 或 3.12，二者都可以。
   - 如果本机只有 3.13 / 3.14：说明服务器用到的 cgi 模块在 3.13 已被移除，
     这些版本无法运行，需要安装 3.11 或 3.12。
   - 如果本机没有任何 Python：需要先安装 3.11 或 3.12（去 Python.org 官方下载页下载 3.11 或 3.12 的 Windows installer）。
   - 无论哪种情况，都请明确告诉我：现在是什么状态、需要什么、为什么、下一步做什么；
     不要只丢一句“你自己去装 Python”。

3) 安装缺失项（如需要）
   - 动手前先把我需要安装的东西列出来，并征得我同意。
   - Windows 可用 winget（例如 winget install Python.Python.3.12）或去 Python.org 官方下载页
     https://www.python.org/downloads/windows/ 手动下载 3.11 / 3.12 的 Windows installer；
     macOS 可用 Homebrew；Linux 可用系统包管理器。安装完成后重新执行第 1、2 步复检，确认 3.11 或 3.12 可用。
   - 不要假装安装完成；如果需要管理员权限或需要我手动点确认，请明确告诉我。

4) 检查目录与代码
   - 检查我打算存放 FolioFold 的目录里是否已经有 FolioFold，避免重复克隆。
   - 若没有，执行：git clone https://github.com/zero-sara/FolioFold.git  然后进入该目录。

5) 检查端口 3000
   - 检查 127.0.0.1:3000 是否被占用。
   - 若占用者是已经在运行的 FolioFold，直接打开浏览器即可，不要重复启动。
   - 若是别的程序占用，不要结束它；请告诉我，并给出可行的解决办法。

6) 启动
   - Windows：运行项目根目录的「FolioFold 启动.bat」。
   - 也可以在仓库目录手动运行：`py -3.11 server.py` 或 `py -3.12 server.py`
     （macOS / Linux 用兼容版本的：python3 server.py）。
   - （可选，仅当我想做单语言版时）编辑仓库里的 dist-config.js，把 langMode 设为
     'single'、defaultLang 设为 'zh-CN'（想用其他语言就填对应代码，如 'en'）。
     默认是多语言，不需要改动。

7) 验证与收尾
   - 访问 http://127.0.0.1:3000/api/version 与 http://127.0.0.1:3000/api/health，
     确认都返回 200。
   - 把浏览器地址 http://127.0.0.1:3000/ 给我，让我能直接打开。
   - 告诉我关闭方法：Windows 双击「FolioFold 停止.bat」；或在运行它的终端里按 Ctrl+C。

8) 出错时
   - 如果遇到端口被占用、Python 报错或启动失败，请把我终端里的报错原文贴回给我，
     并解释原因和下一步。
```

> 说明：仓库里没有预编译的安装包下载链接（EXE 通过 GitHub Releases 单独分发），请 `git clone` 源码后按上面的方式启动。单语言 / 多语言只是同一份代码里的一个开关（`dist-config.js`），切换不需要改动其它文件。

---

**[中文说明 ↓](#中文说明)** ・ **[English ↓](#english)**

---

## 中文说明

### FolioFold 是什么

一个运行在本地的个人简历 / 作品集编辑器与发布工具。不需要构建工具，也不需要联网：在本机启动它，用浏览器打开，就能一边编辑一边看到真实效果。

做好的简历 / 作品集可以留在本地，也可以发布成公开可访问的网站，或者导出成单个 HTML 文件、ZIP 或 PDF。

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

FolioFold 自带两个模板：Starter 和 FolioFold Demo。
Starter 是你开始制作自己的简历 / 作品集的起点；FolioFold Demo 用来查看完整示例。
你可以直接编辑 Starter，并把它逐步变成自己的项目。

| 模板 | 用途 |
|---|---|
| **Starter** | 你的起点。自带基本排版、栏目和可编辑的示例内容，直接改就能变成自己的简历 / 作品集，不需要从空白开始 |
| **FolioFold Demo** | 官方演示模板，用来查看 FolioFold 的完整效果；不作为制作自己内容的默认起点 |

你也可以继续导入或制作其他模板：把一套版式导出成模板文件（只含视觉设计，不含文字和媒体），在别处导入套用。

### 🛠️ 开始使用

FolioFold 目前建议使用 **Python 3.11 或 3.12**。本项目已实际验证 Python 3.11.6 和 3.12.14；Python 3.13 及以上目前无法运行（项目依赖的 `cgi` 模块已在 3.13 移除）；3.8 / 3.9 / 3.10 本机未安装、未验证。你还需要 **Git**，但 FolioFold 自身没有第三方依赖，**不需要** `pip install`。

```bash
git clone https://github.com/zero-sara/FolioFold.git
cd FolioFold
py -3.11 server.py    # 或 py -3.12 server.py
```

然后在浏览器打开 <http://127.0.0.1:3000/>。

Windows 用户直接双击项目根目录的 **`FolioFold 启动.bat`**（自动在 3.11 / 3.12 之间挑选，端口被占用时会自动处理）；关闭时双击 **`FolioFold 停止.bat`**。`FolioFold.exe` 是**可选**的一键启动器（不在源码仓库内，可从 GitHub Releases 获取或自行构建），运行它同样需要本机装有 Python 3.11 或 3.12。

### Python 环境

运行 FolioFold 需要 **Python 3.11 或 3.12**。推荐普通用户直接安装 Python 3.11 或 3.12 的官方 Windows 版本。

- **推荐**：Python 3.11 或 3.12
- **不要使用**：Python 3.13 及以上
- **Windows 用户下载**：[Python 官方下载页](https://www.python.org/downloads/windows/)（请选择 **3.11** 或 **3.12** 的 64-bit Windows installer）
- 安装完成后，再双击 **`FolioFold 启动.bat`** 即可。

### 🚀 发布与导出

简历 / 作品集做好之后：

- **发布到 GitHub Pages**：用你自己的 GitHub 账号授权（设备码流程，不需要你创建 OAuth App），FolioFold 会帮你建 / 更新仓库并启用 Pages
- **导出 ZIP**：完整的静态站点，可以放到任意托管平台
- **导出单文件 HTML**：一个文件，离线也能打开
- **导出 PDF**：用浏览器打印成 PDF

#### 发布后的网址长什么样

```
https://<你的 GitHub 用户名>.github.io/FolioFoldPages/<子路径>/
```

- **仓库名**默认是 `FolioFoldPages`（在 `server.py` 的 `GH_PUBLISH_REPO` 里固定）。它建在**你自己**的 GitHub 账号下，不会占用别人的空间。1.0 暂不支持在发布面板里自定义仓库名（这是计划中的增强项）；GitHub 的仓库名是按「账号命名空间」独立的——不同用户可以用同名仓库，但同一账号下不能重名。
- **子路径**可以在发布面板里自己填，用来区分多份简历 / 作品集；留空就是仓库根目录。
- Pages 的启用是 FolioFold 自动做的，你不需要手动去 GitHub 设置里开。
- ⚠ **发布用的这个仓库建好后，建议不要改名、也不要设为私有**：改名会让旧的 Pages 链接直接失效（GitHub 不会对项目站点做重定向），设为私有会让 Pages 返回 404；如果确实需要改名，改名后请重新发布一次，并更新你发出去的所有旧链接。

⚠️ **改名的后果（GitHub 的真实行为，不是猜测）**：

- **改 GitHub 用户名** → 你名下仓库的引用会自动跳转到新用户名，但**旧的个人主页和 gist 链接会 404**。Pages 站点**不在**自动重定向范围内：旧的 `https://旧用户名.github.io/FolioFoldPages/` 会直接失效（返回 404），只有新用户名下的 `https://新用户名.github.io/FolioFoldPages/` 能用。FolioFold 在「重新发布 / 更新当前发布」时会用实时授权身份取到新用户名并更新本机发布记录，所以改完用户名后点一次「重新发布」即可让链接回到最新。
- **改 Pages 仓库名** → 按 GitHub 官方文档，**项目站网址不在重定向范围内**，旧的 `https://<用户名>.github.io/<旧仓库名>/` 会直接失效。改名后请重新发布，并更新你发出去的旧链接。

### 媒体文件放在哪

上传的图片、音频、视频**都保存在本机项目目录 `public/media/` 下**，按用途分好类：`experience/`（经历）、`projects/`（作品）、`showreel/`（片头视频）、`ai-voices/`（配音）、`brand/`（品牌图标）、`uploads/`（原始上传）。

发布时只会上传**当前内容真正引用到的**那部分媒体，未被引用的文件不会跟着上线。反过来，你在本机删掉某个媒体后，它在 `public/media/` 里的文件会保留下来，方便你随时恢复。

⚠ **`public/media/` 不能整目录删除**：里面既有当前内容正在引用的媒体，也有大量历史遗留文件。删除前请先用引用检查确认某个文件已无任何内容引用——当前内容正在引用的媒体（本机实测约 870MB）一旦删除，会导致线上页面缺图 / 缺视频。未被引用的历史遗留媒体（本机实测约 800MB）可以安全归档 / 删除，但不会因「发布」而被自动清除。构建缓存目录（`release/`、`build/`、`__pycache__/`）同样可以直接删除，不影响任何内容。

### 你的数据留在本机

FolioFold 没有自己的服务器。内容、媒体和令牌都只存在你的电脑上，涉及凭据的文件都不会进入仓库。内容与设计分开保存，每次保存都会留一份上一版，方便回滚。

### 隐私边界（概念澄清）

- **发布仓库（FolioFoldPages）里出现你的真实姓名、联系方式、作品，是正常且预期的**——那是你主动发布的内容，不是泄露。
- **源码仓库（FolioFold 本体）不能包含任何私人信息**：所有私人内容都在你本机 `content/` 下（已被 `.gitignore` 排除），不会进入公开源码。
- **你未用于公开发布的私人内容，不应被发布到公开的 Pages 仓库**：发布面板只会发布你明确选择发布的模板；如果你发现不该公开的内容被发了出去，那属于需要修正的问题。

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

FolioFold ships with two templates: Starter and FolioFold Demo.
Starter is where you begin making your own résumé/portfolio; FolioFold Demo is for seeing the full example.
You can edit Starter directly and gradually turn it into your own project.

| Template | What it's for |
|---|---|
| **Starter** | Your starting point. It comes with basic layout, sections and editable sample content — edit it into your own résumé/portfolio instead of starting from blank. |
| **FolioFold Demo** | The official demo template for viewing what FolioFold can produce; not the default starting point for making your own content. |

You can also import or make other templates: export a look as a template file (visual design only, no text or media) and import it elsewhere.

### 🛠️ Getting started

FolioFold currently recommends **Python 3.11 or 3.12**. This project has actually verified Python 3.11.6 and 3.12.14; Python 3.13 and later cannot run (the `cgi` module it depends on was removed in 3.13); 3.8 / 3.9 / 3.10 are not installed on this machine and untested. You also need **Git**, but FolioFold itself has no third-party dependencies, so there is **nothing to `pip install`**.

```bash
git clone https://github.com/zero-sara/FolioFold.git
cd FolioFold
py -3.11 server.py    # or py -3.12 server.py
```

Then open <http://127.0.0.1:3000/> in your browser.

On Windows, just double-click **`FolioFold 启动.bat`** in the project root (it picks 3.11 or 3.12 automatically and handles a busy port for you); to stop, double-click **`FolioFold 停止.bat`**. **`FolioFold.exe`** is an **optional** one-click launcher — it is not part of the source repo (it ships separately via GitHub Releases, or you can build it with `build_exe.bat`), and it still requires Python 3.11 or 3.12 installed.

### Python environment

Running FolioFold requires **Python 3.11 or 3.12**. Ordinary users are recommended to install the official Windows build of Python 3.11 or 3.12.

- **Recommended**: Python 3.11 or 3.12
- **Do not use**: Python 3.13 or later
- **Windows users**: download from the official Python site — [Python Releases for Windows](https://www.python.org/downloads/windows/) (pick the 64-bit Windows installer for **3.11** or **3.12**)
- After installing, just double-click **`FolioFold 启动.bat`** to start.

### 🤖 Let an AI install it for me

Don't want to type the commands yourself? Copy **the whole block below** to any AI assistant (ChatGPT / Claude / a local AI helper, etc.). It will first inspect your computer's environment, then decide how to install and how to start — instead of assuming the environment is already ready.

```
Please check the environment on my computer, install, and start FolioFold (a locally-running résumé/portfolio editor) for me.

Proceed in this order: detect first → then judge → install only what's missing → re-check after installing → finally start. Do not assume the environment is already ready.

1) Detect the environment
   - Tell me the current OS and version.
   - Check whether Git is installed (git --version).
   - List every Python version installed on this machine (on Windows run `py -0p` first, then cross-check with `python --version` / `python3 --version`; scan common install paths if needed).

2) Judge the version
   - FolioFold needs Python 3.11 or 3.12; either works.
   - If the machine only has 3.13 / 3.14: the server's cgi module was removed in 3.13, so those versions cannot run it — install 3.11 or 3.12.
   - If the machine has no Python at all: install 3.11 or 3.12 first (download the 3.11 or 3.12 Windows installer from the official Python site: https://www.python.org/downloads/windows/).
   - In every case, clearly tell me: the current state, what is needed, why, and what to do next. Don't just drop a "go install Python yourself".

3) Install what's missing (if needed)
   - Before doing anything, list what needs to be installed and get my consent.
   - On Windows use winget (e.g. `winget install Python.Python.3.12`) or download the 3.11/3.12 Windows installer manually from the official Python site https://www.python.org/downloads/windows/; on macOS use Homebrew; on Linux use the system package manager. After installing, re-run steps 1 and 2 to confirm 3.11 or 3.12 is usable.
   - Don't pretend the install finished; if admin rights or a manual confirmation from me is required, say so clearly.

4) Check the directory and code
   - Check whether FolioFold already exists in the directory where I intend to keep it, to avoid cloning twice.
   - If not, run: git clone https://github.com/zero-sara/FolioFold.git   then enter that directory.

5) Check port 3000
   - Check whether 127.0.0.1:3000 is occupied.
   - If the occupant is an already-running FolioFold, just open the browser — don't start it again.
   - If another program occupies it, don't kill it; tell me and suggest a workable fix.

6) Start
   - Windows: run `FolioFold 启动.bat` in the project root.
   - Or manually run in the repo: `py -3.11 server.py` or `py -3.12 server.py` (on macOS / Linux use the compatible version: `python3 server.py`).
   - (Optional, only if I want a single-language build) edit `dist-config.js` in the repo and set `langMode` to 'single' and `defaultLang` to 'zh-CN' (or the code for another language, e.g. 'en'). The default is multi-language; no change needed.

7) Verify and wrap up
   - Visit http://127.0.0.1:3000/api/version and http://127.0.0.1:3000/api/health and confirm both return 200.
   - Give me the browser URL http://127.0.0.1:3000/ so I can open it directly.
   - Tell me how to stop it: on Windows double-click `FolioFold 停止.bat`; or press Ctrl+C in the terminal running it.

8) On errors
   - If the port is taken, Python errors out, or startup fails, paste the original error text from my terminal back to me and explain the cause and next step.
```

> Note: there is no prebuilt installer download link in the repo (the EXE ships separately via GitHub Releases), so `git clone` the source and start it as above. Single- vs multi-language is just one switch (`dist-config.js`) in the same codebase — switching needs no other file changes.

### 🚀 Publish & export

When your résumé/portfolio is ready:

- **GitHub Pages** — authorize with your own GitHub account (device flow, no OAuth app to create); FolioFold creates or updates the repo and enables Pages
- **ZIP** — a complete static site you can host anywhere
- **Single-file HTML** — one file you can open offline
- **PDF** — print your published portfolio to PDF

#### What your published URL looks like

```
https://<your-github-username>.github.io/FolioFoldPages/<sub-path>/
```

- The **repository name** defaults to `FolioFoldPages` (fixed in `GH_PUBLISH_REPO` in `server.py`). It is created under **your own** account. Customizing the repo name from the publish panel is not in 1.0 (planned enhancement); GitHub repo names are per-account namespace — different users may share a name, but one account cannot have two repos with the same name.
- The **sub-path** is editable in the publish panel — use it to keep several résumés/portfolios apart; leave it empty to publish at the repository root.
- FolioFold enables GitHub Pages for you. You don't have to flip anything in GitHub's settings.
- ⚠ **Once this publish repository is created, we recommend you do not rename it and do not make it private**: renaming breaks the old Pages link immediately (GitHub does not redirect project sites), and making it private makes Pages return 404. If you must rename, republish afterwards and update any links you shared.

⚠️ **What renaming actually does (GitHub's documented behaviour, not guesswork)**:

- **Renaming your GitHub username** — references to your repositories redirect automatically, but your **old profile page and old gists return 404**. GitHub Pages sites are **not** redirected: the old `https://old-username.github.io/FolioFoldPages/` stops working (404) and only `https://new-username.github.io/FolioFoldPages/` works. FolioFold reads the live authenticated username when you **republish / update current publish**, so doing that once after a username change refreshes your stored link.
- **Renaming the Pages repository** — per GitHub's docs, **project site URLs are not included in the redirect**, so `https://<username>.github.io/<old-repo>/` breaks immediately. Republish afterwards and update any links you shared.

### Where media files live

Uploaded images, audio and video are stored locally under `public/media/`, sorted by purpose: `experience/`, `projects/`, `showreel/`, `ai-voices/`, `brand/`, `uploads/`.

Publishing uploads **only the media your content actually references** — unreferenced files never go online. Conversely, removing a media item from your portfolio leaves its file on disk for easy recovery.

⚠ **Do not delete `public/media/` as a whole**: it holds both media your current content references and a large amount of legacy files. Before deleting anything, confirm via a reference check that the file is no longer referenced — the media your current content references (≈870MB on this machine) must stay or your live pages will lose images/videos. Unreferenced legacy media (≈800MB on this machine) is safe to archive/delete, but it is never removed automatically by publishing. Build-cache directories (`release/`, `build/`, `__pycache__/`) can also be deleted freely without affecting any content.

### Your data stays local

FolioFold has no server of its own. Your content, media and tokens stay on your machine, and credential files never enter the repository. Each save keeps a previous version you can roll back to.

### Privacy boundary (concept clarification)

- **Seeing your real name, contact info, or work inside the publish repository (FolioFoldPages) is normal and expected** — that is content you chose to publish, not a leak.
- **The source repository (FolioFold itself) must contain no personal information**: all private content lives in `content/` on your machine (excluded by `.gitignore`) and never enters the public source.
- **Private content you did not intend to publish must never end up in the public Pages repository**: the publish panel only publishes the template you explicitly choose; if something you did not intend to publish goes live, that is a bug to fix.

---

## License

[MIT](./LICENSE) © FolioFold contributors.

本仓库只包含 FolioFold 本体和一份公开 Demo，不含任何个人作品集——你自己的数据只存在于本机，不会被提交。

This repository ships the FolioFold app itself and a public demo. It contains no personal portfolio; your own data lives only on your machine and is never committed.
