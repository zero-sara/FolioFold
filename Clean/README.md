# Clean — 安全清理暂存区

本目录是 **已确认可清理内容的暂存区**，用于集中存放经过确认、可以安全删除的历史 / 废弃内容。它本身不是垃圾箱：只有「确认安全」的东西才放进这里，真正清空由 `FolioFold-Clean.bat` 完成。

## 当前暂存内容
- `build-caches/` — 过时构建产物（`release/`、`build/`、`__pycache__/`）。gitignored、可随时重新生成、无任何用户数据。
- `media-unref/` — 经脚本全仓交叉确认 **没有任何引用** 的历史媒体文件（照片、占位图标、旧音频 / 视频等，约 100 MB）。个人简历等私人文档已排除，保留在 `public/media`。

## 如何真正清空
运行 `FolioFold-Clean.bat`：
1. **严格校验路径** 必须是 `G:\FolioFold\Clean`，任何情况下都不会删除 Clean 之外的文件；
2. 需手动输入 `YES` 二次确认；
3. 只删除 `build-caches/` 与 `media-unref/`，保留 `.gitkeep` 与 `README.md` 作为占位标记。

## 安全边界（放东西进来前必须确认）
- 不被代码 / 模板 / 发布 / 媒体引用；
- 非私人资料、非其他项目、非恢复 / 备份机制；
- 不影响启动、编辑、发布。
- **绝不可移入**：`public/media/`（整体）、`content/`、`_backups/`、`.folioframe/`、`D:\_ff_tmp`、`G:\AI Voice S`，以及任何无法确认用途的文件。

## GitHub 仓库内的 Clean/
源码仓库 `FolioFold` 的 `Clean/` 目录 **只保留 `.gitkeep` 与 `README.md` 占位**，不存放真实废弃媒体 / 私人资料 / token / 大型文件。
