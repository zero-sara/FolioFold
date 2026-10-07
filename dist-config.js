/* FolioFold 发行配置 (dist-config)
 * 必须在 i18n.js 之前加载。由「构建 / 发行」时选择，无需改动任何多语言资源文件。
 *
 * langMode:
 *   'multi' (默认) —— 完整 i18n：编辑器顶部 / 作品集页面 / 排版编辑 三处语言切换入口都可用。
 *   'single'       —— 单语言发行：锁定 defaultLang，隐藏所有语言切换入口（运行时固定、不可再切）。
 *
 * defaultLang: 单语言模式下的固定语言，例如 'zh-CN' / 'en'。
 *
 * 想出「FolioFold-ZH / FolioFold-EN / FolioFold-Multi」三个发行物时，
 * 复制本项目、只改本文件的 langMode / defaultLang 即可，其余代码无需改动。
 */
window.__FF_DIST__ = window.__FF_DIST__ || {
  langMode: 'multi',     // 'multi' | 'single'
  defaultLang: 'zh-CN'   // 仅 single 模式生效
};
