/* FolioFold i18n runtime  —— 2026-09-22 重构
 *
 * 设计目标（按用户实际反馈定的，不是拍脑袋加的）：
 *   1. **一个语言，全局一份**。以前 locale 按「scope + 模板」分键存，于是
 *      外壳顶栏、文本编辑、排版编辑（scope=editor）、作品集画布（scope=public）
 *      各存各的 —— 顶栏切了英文，画布里还是中文，用户看到的就是「切了没用」。
 *      现在只有一把键 `folioframe.locale`，旧键在首次读取时自动迁移过来。
 *   2. **切换立即生效，不重载页面**。以前切语言靠的是一串 location.reload()，
 *      于是「挪完间距刷新两三下」「要手动刷新才变」。现在改成原地重翻：
 *      每个文本节点/属性都记住源语言原文（WeakMap），切语言就是把当前 DOM
 *      按新语言重算一遍 —— 中文能切回英文，英文也能切回中文（双向）。
 *   3. **界面文案 vs 用户内容，两套字典分开**。
 *      - 界面文案：中文当 key 的 FF_ZH_I18N（由 tools/i18n/build_dict.py 生成），
 *        只翻产品自己的按钮/提示/标签，绝不碰用户写的简历正文。
 *      - 用户内容：FF_CONTENT_I18N（服务端整篇翻译后下发），只有画布会用它，
 *        并且「不跟随语言」的字段（见 content.localePins）根本不会出现在表里。
 *   4. 查不到就原样返回 —— 漏翻只会看到中文，永远不会出现空白或乱码。
 */
(function (global) {
  'use strict';

  /* ————————————————————————— 语言注册表 ————————————————————————— */
  // 顺序就是下拉栏里的顺序。short 用在紧凑的小方块按钮上。
  // 2026-09-26（B 线第 2 期）：正式扩到 10 种目标语言。
  const LANGS = [
    { id: 'zh-CN', name: '中文',    short: '中',  code: 'ZH' },
    { id: 'zh-TW', name: '繁體中文', short: '繁',  code: 'ZH-TW' },
    { id: 'en',    name: 'English', short: 'EN',  code: 'EN' },
    { id: 'ja',    name: '日本語',   short: 'JA',  code: 'JA' },
    { id: 'ko',    name: '한국어',   short: 'KO',  code: 'KO' },
    { id: 'fr',    name: 'Français', short: 'FR',  code: 'FR' },
    { id: 'es',    name: 'Español',  short: 'ES',  code: 'ES' },
    { id: 'it',    name: 'Italiano', short: 'IT',  code: 'IT' },
    { id: 'de',    name: 'Deutsch',  short: 'DE',  code: 'DE' },
    { id: 'pt',    name: 'Português', short: 'PT', code: 'PT' }
  ];
  const SOURCE = 'zh-CN';                       // 数据的源语言，永远是中文
  // 非源语言缺词时整段回退到英文，再回退中文（方案文档 §八：全部兜底 en，不让非英语言互指）。
  const FALLBACK = { 'zh-TW': 'en', ja: 'en', ko: 'en', fr: 'en', es: 'en', it: 'en', de: 'en', pt: 'en' };
  const byId = {}; LANGS.forEach(l => { byId[l.id] = l; });

  /* ————————————————— 发行开关：有 / 无「语言系统」两个版本 —————————————————
   * 用户要打两个包传 GitHub：**带语言系统**（可切语言 + 自动翻译）与**不带语言系统**
   * —— 后者不该出现切换入口，否则会让人以为"点了没反应 / 坏了"。
   *
   *   MODE = 'auto'（默认）：跟随本机能力 —— 探测翻译服务，**没有就把入口整个收起来**。
   *          · 没装 / 没配 Ollama → 不出现语言按钮（用户原话：「他如果没有下载 ollama，
   *            那就等于说不支持这个语言切换，那到时候就不要出现这个按键了」）
   *          · 发布出去的静态页（界面字典与内容译文都已内联）→ 照常可用
   *   MODE = 'full'：无论探测结果如何都显示语言按钮（＝"有语言系统"版本）。
   *          本机自用也建议用它 —— 免得 Ollama 一时没起来按钮就没了。
   *   MODE = 'off' ：永远不显示语言按钮，界面固定中文（＝"无语言系统"版本）。
   *
   * 不改文件也能试：地址后面加 `?i18n=full` / `?i18n=off`，
   * 或控制台 `localStorage.setItem('folioframe.i18n.mode','full')` 之后刷新。 */
  const MODE = (function () {
    try {
      const q = /[?&]i18n=(auto|full|off)\b/.exec((global.location && global.location.search) || '');
      if (q) return q[1];
    } catch (_) {}
    try {
      const v = global.FF_I18N_MODE;
      if (v === 'full' || v === 'off' || v === 'auto') return v;
    } catch (_) {}
    try {
      const v = localStorage.getItem('folioframe.i18n.mode');
      if (v === 'full' || v === 'off' || v === 'auto') return v;
    } catch (_) {}
    return 'auto';
  })();

  /* "没有语言系统"时按钮长什么样：
   *   'hide'（默认）—— 整个入口不出现（干净、不会误会；用户给的第一方案）
   *   'locked'      —— 留一个小方块只显示「中」，**没有下拉、点不动**（用户给的第二方案）
   * 想换成第二方案：把下面这行改成 'locked' 即可，别处不用动。 */
  const NO_SYS_UI = 'hide';

  /* 运行时能力。null = 还没探出来 —— auto 模式下先按"有"渲染（避免每次刷新闪一下），
   * 探回来若为"没有"再收起；结果缓存进 localStorage，下次刷新第一帧就是对的。 */
  const CAP_KEY = 'folioframe.i18n.cap';
  let _capable = MODE === 'full' ? true : (MODE === 'off' ? false : null);
  function capCached() { try { const v = localStorage.getItem(CAP_KEY); return v === null ? null : v === '1'; } catch (_) { return null; } }
  function capable() {
    if (_capable !== null) return _capable;
    const c = capCached();
    return c === null ? true : c;
  }
  const _mounts = [];          // 已挂载的切换器宿主：能力定了之后要重挂 / 收起

  // 键值对层（data-i18n 属性用）。只放"程序里要按键取值"的那几十条；
  // 界面上占绝大多数的静态文案走下面的「中文当 key」字典层，不用在这里登记。
  const UI = {
    'zh-CN': {
      'nav.portfolio':'作品集', 'nav.editor':'文本编辑', 'nav.visual':'排版编辑',
      'action.refresh':'刷新当前', 'action.publish':'发布', 'action.save':'保存草稿',
      'action.preview':'预览作品集', 'action.restore':'恢复上一版', 'action.rename':'重命名',
      'action.delete':'删除', 'action.new':'＋ 新建', 'action.import':'⬇ 导入模板',
      'action.expand':'展开', 'action.collapse':'收起', 'action.close':'关闭',
      'label.template':'模板', 'label.language':'语言', 'label.chinese':'中文', 'label.english':'English',
      'status.loading':'读取中…', 'status.draft':'当前草稿', 'status.synced':'已同步', 'status.unsaved':'● 未保存',
      'section.structure':'页面结构', 'section.profile':'资料', 'section.categories':'分类',
      'section.experience':'经历', 'section.projects':'项目', 'section.showreel':'Showreel',
      'section.styles':'设置', 'section.ai':'AI Project',
      'settings.title':'设置', 'settings.lang':'语言设置', 'settings.theme':'主题预设',
      'public.language':'语言', 'public.publish':'发布', 'public.expand':'展开', 'public.collapse':'收起',
      // 底部状态条（#version-bar）。它挂在 body 上、在 #app 之外，文案是 JS 拼的，
      // 所以走键值层（data-i18n）而不是「中文当 key」的字典层 —— 也避免污染用户内容词典。
      'bar.draft':'草稿预览', 'bar.published':'已发布版',
      'bar.draftNote':'你在编辑器里保存的内容会立刻出现在这里',
      'bar.pubNote':'只有点「更新」后才会同步草稿的最新改动',
      'bar.viewPublished':'看已发布版', 'bar.backToDraft':'回到草稿',
      'bar.update':'更新', 'bar.updating':'更新中…',
      'bar.updateTitle':'把当前草稿更新到发布版',
      'bar.checking':'检查中…', 'bar.dirty':'有未更新的改动', 'bar.clean':'已与发布版同步',
      'translation.title':'英文翻译 Draft', 'translation.flow':'当前语言：中文原文 → English Draft',
      'translation.unconfigured':'尚未配置翻译服务', 'translation.draft':'英文草稿待审核',
      'translation.reviewed':'英文内容已审核', 'translation.stale':'原文已更新，英文 Draft 待复核',
      'translation.failed':'翻译请求失败', 'translation.empty':'尚未生成英文 Draft。',
      'translation.generate':'生成英文 Draft', 'translation.regenerate':'重新翻译',
      'translation.apply':'应用 / 审核英文内容', 'translation.cancel':'取消',
      'translation.generating':'正在生成…', 'translation.generated':'英文 Draft 已生成，请预览后明确应用',
      'translation.applied':'英文内容已审核：English 浏览者将看到此版本',
      'translation.cancelled':'英文 Draft 已取消，中文原文未改变',
      'translation.notGenerated':'尚未生成英文 Draft',
      'translation.readyHint':'翻译服务已就绪；点「生成英文 Draft」开始。',
      'pin.on':'此板块已设置为不跟随语言设置切换', 'pin.off':'此板块已恢复跟随语言设置',
      'tr.quality':'翻译质量',
      'tr.modeTitle':'翻译模式',
      'tr.modeReview':'发布前审核',
      'tr.modeReviewDesc':'机器翻译完成后，需要你确认翻译内容，确认后才会作为正式翻译显示和发布。',
      'tr.modeDirect':'机器翻译直接使用',
      'tr.modeDirectDesc':'翻译完成后即可用于作品集和发布，无需逐条确认；之后仍可预览和修改。',
      'tr.approve':'确认翻译 ✓',
      'tr.notGenerated':'未生成',
      'tr.draftPending':'翻译草稿 · 待确认',
      'tr.ready':'已就绪',
      'tr.mtReady':'机器翻译 · 已就绪',
      'tr.stale':'需要重新检查',
      'ai.label.positioning':'定位',
      'ai.label.role':'我的角色',
      'ai.label.contribution':'我的贡献',
      'ai.label.highlights':'亮点',
      'pin.hint':'点板块名称可以把它设为「不跟随语言」：设了之后，作品集不管切到哪种语言，这一板都保持原样。',
      /* Phase 4（2026-09-26）：环境检查 + 意外关闭恢复 */
      'env.title':'环境检查', 'env.hint':'一键体检本机运行环境：Python、依赖、FFmpeg、关键目录、端口与可选组件。检查是只读的；「一键修复」只会创建缺失的空目录，绝不改动内容、媒体与备份。',
      'env.run':'运行环境检查', 'env.checking':'正在检查…', 'env.checkFailed':'环境检查失败',
      'env.st.ok':'正常', 'env.st.fixable':'可修复', 'env.st.optional':'可选', 'env.st.blocked':'阻塞',
      'env.repair':'一键修复（仅创建缺失目录）', 'env.repairNote':'修复说明：只创建缺失的空目录，不写入、不删除、不覆盖任何文件。',
      'env.repaired':'修复完成：新建', 'env.repairFailed':'修复失败',
      'recovery.title':'检测到上次未恢复的编辑内容', 'recovery.found':'找到了上次未正常收尾时自动保存的抢救副本：',
      'recovery.diff':'查看差异', 'recovery.restore':'恢复最新一份', 'recovery.dismiss':'放弃',
      'recovery.diffLoading':'正在比较…', 'recovery.diffTitle':'与当前草稿的差异（顶层摘要）：',
      'recovery.st.same':'一致', 'recovery.st.changed':'有改动', 'recovery.st.onlyRescued':'仅备份里有', 'recovery.st.onlyDraft':'仅草稿里有'
    },
    'en': {
      'nav.portfolio':'Portfolio', 'nav.editor':'Content Editor', 'nav.visual':'Visual Editor',
      'action.refresh':'Refresh', 'action.publish':'Publish', 'action.save':'Save Draft',
      'action.preview':'Preview Portfolio', 'action.restore':'Restore Previous Version', 'action.rename':'Rename',
      'action.delete':'Delete', 'action.new':'＋ New', 'action.import':'⬇ Import Template',
      'action.expand':'Expand', 'action.collapse':'Collapse', 'action.close':'Close',
      'label.template':'Template', 'label.language':'Language', 'label.chinese':'中文', 'label.english':'English',
      'status.loading':'Loading…', 'status.draft':'Current Draft', 'status.synced':'Synced', 'status.unsaved':'● Unsaved',
      'section.structure':'Page Structure', 'section.profile':'Profile', 'section.categories':'Categories',
      'section.experience':'Experience', 'section.projects':'Projects', 'section.showreel':'Showreel',
      'section.styles':'Settings', 'section.ai':'AI Project',
      'settings.title':'Settings', 'settings.lang':'Language', 'settings.theme':'Theme Presets',
      'public.language':'Language', 'public.publish':'Publish', 'public.expand':'Expand', 'public.collapse':'Collapse',
      'bar.draft':'Draft preview', 'bar.published':'Published version',
      'bar.draftNote':'what you save in the editor shows up here immediately',
      'bar.pubNote':'your latest draft changes sync only after you click Update',
      'bar.viewPublished':'View published', 'bar.backToDraft':'Back to draft',
      'bar.update':'Update', 'bar.updating':'Updating…',
      'bar.updateTitle':'Update the published site with the current draft',
      'bar.checking':'Checking…', 'bar.dirty':'Unpublished changes', 'bar.clean':'In sync with the published version',
      'translation.title':'Translation Draft', 'translation.flow':'Current language: Chinese source → draft',
      'translation.unconfigured':'Translation service is not configured', 'translation.draft':'Draft awaiting review',
      'translation.reviewed':'Translated content reviewed', 'translation.stale':'Source changed; draft needs review',
      'translation.failed':'Translation request failed', 'translation.empty':'No draft has been generated.',
      'translation.generate':'Generate Draft', 'translation.regenerate':'Retranslate',
      'translation.apply':'Apply / Review Translated Content', 'translation.cancel':'Cancel',
      'translation.generating':'Generating…', 'translation.generated':'Draft generated. Review it before applying.',
      'translation.applied':'Translated content reviewed. Visitors in this language will see this version.',
      'translation.cancelled':'Draft cancelled. The Chinese source was not changed.',
      'translation.notGenerated':'No draft yet',
      'translation.readyHint':'The translation service is ready. Click “Generate Draft” to start.',
      'pin.on':'This block is set to keep its original language', 'pin.off':'This block follows the interface language again',
      'tr.quality':'Translation Quality',
      'tr.modeTitle':'Translation mode',
      'tr.modeReview':'Review before publishing',
      'tr.modeReviewDesc':'Once machine translation finishes, you confirm the translated content; only confirmed translations are shown and published as official.',
      'tr.modeDirect':'Use machine translation directly',
      'tr.modeDirectDesc':'Translations are usable in the portfolio and publishing as soon as they are generated, with no per-item confirmation; preview and edits remain available.',
      'tr.approve':'Approve translation ✓',
      'tr.notGenerated':'Not generated',
      'tr.draftPending':'Draft · awaiting confirmation',
      'tr.ready':'Ready',
      'tr.mtReady':'Machine translation · Ready',
      'tr.stale':'Needs re-check',
      'ai.label.positioning':'Positioning',
      'ai.label.role':'My Role',
      'ai.label.contribution':'Contribution',
      'ai.label.highlights':'Highlights',
      'pin.hint':'Click a block name to make it ignore the language switch: whatever language the portfolio is in, that block stays exactly as you typed it.',
      /* Phase 4 (2026-09-26): environment check + unexpected-close recovery */
      'env.title':'Environment Check', 'env.hint':'One-click check of the local runtime: Python, dependencies, FFmpeg, key folders, port and optional components. The check is read-only; “Repair” only creates missing empty folders and never touches your content, media or backups.',
      'env.run':'Run Environment Check', 'env.checking':'Checking…', 'env.checkFailed':'Environment check failed',
      'env.st.ok':'OK', 'env.st.fixable':'Fixable', 'env.st.optional':'Optional', 'env.st.blocked':'Blocked',
      'env.repair':'Repair (create missing folders only)', 'env.repairNote':'About this repair: it only creates missing empty folders — nothing is written, deleted or overwritten.',
      'env.repaired':'Repair finished: created', 'env.repairFailed':'Repair failed',
      'recovery.title':'Unrecovered edits from last session detected', 'recovery.found':'Auto-saved rescue copies from an unfinished last session were found:',
      'recovery.diff':'View Diff', 'recovery.restore':'Restore Latest', 'recovery.dismiss':'Dismiss',
      'recovery.diffLoading':'Comparing…', 'recovery.diffTitle':'Diff against current draft (top-level summary):',
      'recovery.st.same':'Same', 'recovery.st.changed':'Changed', 'recovery.st.onlyRescued':'Only in backup', 'recovery.st.onlyDraft':'Only in draft'
    },
    /* ——— 2026-09-26（B 线第 2 期）：键值层补齐 10 语言。之前只有 zh-CN/en，
     * ja/ko 的导航、状态条、翻译面板在 t() 里退回中文原文 —— 正是「下拉变了、页面还有中文」
     * 的一个结构性来源。下面 8 张表与 zh-CN/en 的键一一对应。 ——— */
    'zh-TW': {
      'nav.portfolio':'作品集', 'nav.editor':'文字編輯', 'nav.visual':'排版編輯',
      'action.refresh':'重新整理', 'action.publish':'發布', 'action.save':'儲存草稿',
      'action.preview':'預覽作品集', 'action.restore':'回上一版', 'action.rename':'重新命名',
      'action.delete':'刪除', 'action.new':'＋ 新增', 'action.import':'⬇ 匯入範本',
      'action.expand':'展開', 'action.collapse':'收合', 'action.close':'關閉',
      'label.template':'範本', 'label.language':'語言', 'label.chinese':'中文', 'label.english':'English',
      'status.loading':'讀取中…', 'status.draft':'目前草稿', 'status.synced':'已同步', 'status.unsaved':'● 未儲存',
      'section.structure':'頁面結構', 'section.profile':'資料', 'section.categories':'分類',
      'section.experience':'經歷', 'section.projects':'專案', 'section.showreel':'Showreel',
      'section.styles':'設定', 'section.ai':'AI Project',
      'settings.title':'設定', 'settings.lang':'語言設定', 'settings.theme':'主題預設',
      'public.language':'語言', 'public.publish':'發布', 'public.expand':'展開', 'public.collapse':'收合',
      'bar.draft':'草稿預覽', 'bar.published':'已發布版',
      'bar.draftNote':'你在編輯器裡儲存的內容會立刻出現在這裡',
      'bar.pubNote':'只有點「更新」後才會同步草稿的最新修改',
      'bar.viewPublished':'看已發布版', 'bar.backToDraft':'回到草稿',
      'bar.update':'更新', 'bar.updating':'更新中…',
      'bar.updateTitle':'把目前草稿更新到發布版',
      'bar.checking':'檢查中…', 'bar.dirty':'有未更新的修改', 'bar.clean':'已與發布版同步',
      'translation.title':'英文翻譯 Draft', 'translation.flow':'目前語言：中文原文 → English Draft',
      'translation.unconfigured':'尚未設定翻譯服務', 'translation.draft':'英文草稿待審核',
      'translation.reviewed':'英文內容已審核', 'translation.stale':'原文已更新，英文 Draft 待複核',
      'translation.failed':'翻譯請求失敗', 'translation.empty':'尚未產生英文 Draft。',
      'translation.generate':'產生英文 Draft', 'translation.regenerate':'重新翻譯',
      'translation.apply':'套用 / 審核英文內容', 'translation.cancel':'取消',
      'translation.generating':'正在產生…', 'translation.generated':'英文 Draft 已產生，請預覽後明確套用',
      'translation.applied':'英文內容已審核：English 瀏覽者將看到此版本',
      'translation.cancelled':'英文 Draft 已取消，中文原文未改變',
      'translation.notGenerated':'尚未產生英文 Draft',
      'translation.readyHint':'翻譯服務已就緒；點「產生英文 Draft」開始。',
      'pin.on':'此板塊已設定為不跟隨語言設定切換', 'pin.off':'此板塊已恢復跟隨語言設定',
      'tr.quality':'翻譯品質',
      'tr.modeTitle':'翻譯模式',
      'tr.modeReview':'發布前確認',
      'tr.modeReviewDesc':'機器翻譯完成後，需要你確認翻譯內容，確認後才會作為正式翻譯顯示和發布。',
      'tr.modeDirect':'機器翻譯直接使用',
      'tr.modeDirectDesc':'翻譯完成後即可用於作品集和發布，無需逐條確認；之後仍可預覽和修改。',
      'tr.approve':'確認翻譯 ✓',
      'tr.notGenerated':'未生成',
      'tr.draftPending':'翻譯草稿 · 待確認',
      'tr.ready':'已就緒',
      'tr.mtReady':'機器翻譯 · 已就緒',
      'tr.stale':'需要重新檢查',
      'ai.label.positioning':'定位',
      'ai.label.role':'我的角色',
      'ai.label.contribution':'我的貢獻',
      'ai.label.highlights':'亮點',
      'pin.hint':'點板塊名稱可以把它設為「不跟隨語言」：設了之後，作品集不管切到哪種語言，這一板都保持原樣。',
      /* Phase 4（2026-09-26）：環境檢查 + 意外關閉恢復 */
      'env.title':'環境檢查', 'env.hint':'一鍵體檢本機執行環境：Python、相依套件、FFmpeg、關鍵目錄、連接埠與可選元件。檢查是唯讀的；「一鍵修復」只會建立缺失的空目錄，絕不更動內容、媒體與備份。',
      'env.run':'執行環境檢查', 'env.checking':'正在檢查…', 'env.checkFailed':'環境檢查失敗',
      'env.st.ok':'正常', 'env.st.fixable':'可修復', 'env.st.optional':'可選', 'env.st.blocked':'阻塞',
      'env.repair':'一鍵修復（僅建立缺失目錄）', 'env.repairNote':'修復說明：只建立缺失的空目錄，不寫入、不刪除、不覆蓋任何檔案。',
      'env.repaired':'修復完成：新建', 'env.repairFailed':'修復失敗',
      'recovery.title':'偵測到上次未復原的編輯內容', 'recovery.found':'找到了上次未正常收尾時自動儲存的搶救副本：',
      'recovery.diff':'檢視差異', 'recovery.restore':'還原最新一份', 'recovery.dismiss':'放棄',
      'recovery.diffLoading':'正在比較…', 'recovery.diffTitle':'與目前草稿的差異（頂層摘要）：',
      'recovery.st.same':'一致', 'recovery.st.changed':'有改動', 'recovery.st.onlyRescued':'僅備份裡有', 'recovery.st.onlyDraft':'僅草稿裡有'
    },
    'ja': {
      'nav.portfolio':'ポートフォリオ', 'nav.editor':'テキスト編集', 'nav.visual':'レイアウト編集',
      'action.refresh':'再読み込み', 'action.publish':'公開', 'action.save':'下書きを保存',
      'action.preview':'ポートフォリオをプレビュー', 'action.restore':'前の版に戻す', 'action.rename':'名前を変更',
      'action.delete':'削除', 'action.new':'＋ 新規作成', 'action.import':'⬇ テンプレートを取り込む',
      'action.expand':'展開', 'action.collapse':'折りたたむ', 'action.close':'閉じる',
      'label.template':'テンプレート', 'label.language':'言語', 'label.chinese':'中文', 'label.english':'English',
      'status.loading':'読み込み中…', 'status.draft':'現在の下書き', 'status.synced':'同期済み', 'status.unsaved':'● 未保存',
      'section.structure':'ページ構成', 'section.profile':'プロフィール', 'section.categories':'カテゴリ',
      'section.experience':'職歴', 'section.projects':'プロジェクト', 'section.showreel':'Showreel',
      'section.styles':'設定', 'section.ai':'AI Project',
      'settings.title':'設定', 'settings.lang':'言語設定', 'settings.theme':'テーマプリセット',
      'public.language':'言語', 'public.publish':'公開', 'public.expand':'展開', 'public.collapse':'折りたたむ',
      'bar.draft':'下書きプレビュー', 'bar.published':'公開版',
      'bar.draftNote':'エディタで保存した内容はすぐここに反映されます',
      'bar.pubNote':'「更新」を押した後に下書きの変更が同期されます',
      'bar.viewPublished':'公開版を見る', 'bar.backToDraft':'下書きに戻る',
      'bar.update':'更新', 'bar.updating':'更新中…',
      'bar.updateTitle':'現在の下書きを公開版に更新する',
      'bar.checking':'確認中…', 'bar.dirty':'未更新の変更があります', 'bar.clean':'公開版と同期済み',
      'translation.title':'英語翻訳 Draft', 'translation.flow':'現在の言語：中国語原文 → English Draft',
      'translation.unconfigured':'翻訳サービスが未設定です', 'translation.draft':'英語下書きは審査待ち',
      'translation.reviewed':'英語コンテンツは審査済み', 'translation.stale':'原文が更新されました。英文 Draft を再確認してください',
      'translation.failed':'翻訳リクエストが失敗しました', 'translation.empty':'英文 Draft はまだ生成されていません。',
      'translation.generate':'英文 Draft を生成', 'translation.regenerate':'再翻訳',
      'translation.apply':'適用 / 英語コンテンツを審査', 'translation.cancel':'キャンセル',
      'translation.generating':'生成中…', 'translation.generated':'英文 Draft を生成しました。プレビューしてから明示的に適用してください',
      'translation.applied':'英語コンテンツは審査済み：英語の閲覧者にはこの版が表示されます',
      'translation.cancelled':'英文 Draft を取り消しました。中国語原文は変更されていません',
      'translation.notGenerated':'英文 Draft はまだありません',
      'translation.readyHint':'翻訳サービスは準備できています。「英文 Draft を生成」を押して開始してください。',
      'pin.on':'このブロックは言語設定に追従しないよう設定されています', 'pin.off':'このブロックは再び言語設定に追従します',
      'tr.quality':'翻訳品質',
      'tr.modeTitle':'翻訳モード',
      'tr.modeReview':'公開前に確認',
      'tr.modeReviewDesc':'機械翻訳の完了後、翻訳内容を確認する必要があります。確認後に正式な翻訳として表示・公開されます。',
      'tr.modeDirect':'機械翻訳をそのまま使用',
      'tr.modeDirectDesc':'翻訳が完了すればすぐポートフォリオと公開に使えます。1件ずつの確認は不要です。後からプレビュー・修正もできます。',
      'tr.approve':'翻訳を確認 ✓',
      'tr.notGenerated':'未生成',
      'tr.draftPending':'翻訳ドラフト · 確認待ち',
      'tr.ready':'準備完了',
      'tr.mtReady':'機械翻訳 · 準備完了',
      'tr.stale':'要再確認',
      'ai.label.positioning':'位置づけ',
      'ai.label.role':'私の役割',
      'ai.label.contribution':'私の貢献',
      'ai.label.highlights':'ハイライト',
      'pin.hint':'ブロック名をクリックすると「言語に追従しない」設定になります。設定後はポートフォリオの言語を切り替えても、そのブロックは元のテキストのままです。',
      /* Phase 4（2026-09-26）：環境チェック + 意外終了からの復旧 */
      'env.title':'環境チェック', 'env.hint':'ローカル実行環境をワンクリックで診断：Python・依存関係・FFmpeg・主要フォルダ・ポート・オプション要素。チェックは読み取り専用。「一括修復」は不足している空フォルダの作成のみ行い、内容・メディア・バックアップには一切触れません。',
      'env.run':'環境チェックを実行', 'env.checking':'チェック中…', 'env.checkFailed':'環境チェックに失敗しました',
      'env.st.ok':'正常', 'env.st.fixable':'修復可能', 'env.st.optional':'オプション', 'env.st.blocked':'要対応',
      'env.repair':'一括修復（不足フォルダの作成のみ）', 'env.repairNote':'修復について：不足している空フォルダを作成するのみで、ファイルの書き込み・削除・上書きは行いません。',
      'env.repaired':'修復完了：作成', 'env.repairFailed':'修復に失敗しました',
      'recovery.title':'前回未保存のまま残った編集内容を検出', 'recovery.found':'前回正常に終了しなかった際に自動保存されたレスキューコピーが見つかりました：',
      'recovery.diff':'差分を表示', 'recovery.restore':'最新のものを復元', 'recovery.dismiss':'破棄',
      'recovery.diffLoading':'比較中…', 'recovery.diffTitle':'現在の下書きとの差分（トップレベル概要）：',
      'recovery.st.same':'一致', 'recovery.st.changed':'変更あり', 'recovery.st.onlyRescued':'バックアップのみ', 'recovery.st.onlyDraft':'下書きのみ'
    },
    'ko': {
      'nav.portfolio':'포트폴리오', 'nav.editor':'텍스트 편집', 'nav.visual':'레이아웃 편집',
      'action.refresh':'새로 고침', 'action.publish':'게시', 'action.save':'초안 저장',
      'action.preview':'포트폴리오 미리보기', 'action.restore':'이전 버전 복원', 'action.rename':'이름 바꾸기',
      'action.delete':'삭제', 'action.new':'＋ 새로 만들기', 'action.import':'⬇ 템플릿 가져오기',
      'action.expand':'펼치기', 'action.collapse':'접기', 'action.close':'닫기',
      'label.template':'템플릿', 'label.language':'언어', 'label.chinese':'中文', 'label.english':'English',
      'status.loading':'불러오는 중…', 'status.draft':'현재 초안', 'status.synced':'동기화됨', 'status.unsaved':'● 저장 안 됨',
      'section.structure':'페이지 구조', 'section.profile':'프로필', 'section.categories':'카테고리',
      'section.experience':'경력', 'section.projects':'프로젝트', 'section.showreel':'Showreel',
      'section.styles':'설정', 'section.ai':'AI Project',
      'settings.title':'설정', 'settings.lang':'언어 설정', 'settings.theme':'테마 프리셋',
      'public.language':'언어', 'public.publish':'게시', 'public.expand':'펼치기', 'public.collapse':'접기',
      'bar.draft':'초안 미리보기', 'bar.published':'게시 버전',
      'bar.draftNote':'편집기에서 저장한 내용이 바로 여기에 표시됩니다',
      'bar.pubNote':'「업데이트」를 눌러야 초안의 최신 변경 사항이 동기화됩니다',
      'bar.viewPublished':'게시 버전 보기', 'bar.backToDraft':'초안으로 돌아가기',
      'bar.update':'업데이트', 'bar.updating':'업데이트 중…',
      'bar.updateTitle':'현재 초안을 게시 버전으로 업데이트',
      'bar.checking':'확인 중…', 'bar.dirty':'업데이트되지 않은 변경 사항', 'bar.clean':'게시 버전과 동기화됨',
      'translation.title':'영어 번역 Draft', 'translation.flow':'현재 언어: 중국어 원문 → English Draft',
      'translation.unconfigured':'번역 서비스가 설정되지 않았습니다', 'translation.draft':'영어 초안 검토 대기 중',
      'translation.reviewed':'영어 콘텐츠 검토 완료', 'translation.stale':'원문이 업데이트되었습니다. 영어 Draft를 다시 검토하세요',
      'translation.failed':'번역 요청 실패', 'translation.empty':'아직 영어 Draft가 생성되지 않았습니다.',
      'translation.generate':'영어 Draft 생성', 'translation.regenerate':'다시 번역',
      'translation.apply':'적용 / 영어 콘텐츠 검토', 'translation.cancel':'취소',
      'translation.generating':'생성 중…', 'translation.generated':'영어 Draft가 생성되었습니다. 미리보기 후 명시적으로 적용하세요',
      'translation.applied':'영어 콘텐츠 검토 완료: 영어 방문자에게 이 버전이 표시됩니다',
      'translation.cancelled':'영어 Draft가 취소되었습니다. 중국어 원문은 변경되지 않았습니다',
      'translation.notGenerated':'아직 영어 Draft가 없습니다',
      'translation.readyHint':'번역 서비스가 준비되었습니다. 「영어 Draft 생성」을 눌러 시작하세요.',
      'pin.on':'이 블록은 언어 설정을 따르지 않도록 설정되었습니다', 'pin.off':'이 블록은 다시 언어 설정을 따릅니다',
      'tr.quality':'번역 품질',
      'tr.modeTitle':'번역 모드',
      'tr.modeReview':'게시 전 확인',
      'tr.modeReviewDesc':'기계 번역 후 번역 내용을 확인해야 하며, 확인 후에야 정식 번역으로 표시·게시됩니다.',
      'tr.modeDirect':'기계 번역 바로 사용',
      'tr.modeDirectDesc':'번역이 완료되면 포트폴리오와 게시에 바로 사용됩니다. 항목별 확인이 필요 없으며 이후에도 미리 보기·수정할 수 있습니다.',
      'tr.approve':'번역 확인 ✓',
      'tr.notGenerated':'미생성',
      'tr.draftPending':'번역 초안 · 확인 대기',
      'tr.ready':'준비됨',
      'tr.mtReady':'기계 번역 · 준비됨',
      'tr.stale':'다시 확인 필요',
      'ai.label.positioning':'포지셔닝',
      'ai.label.role':'내 역할',
      'ai.label.contribution':'내 기여',
      'ai.label.highlights':'하이라이트',
      'pin.hint':'블록 이름을 클릭하면 「언어 따르지 않기」로 설정됩니다. 설정 후에는 포트폴리오 언어를 바꿔도 이 블록은 원본 그대로 유지됩니다.',
      /* Phase 4(2026-09-26): 환경 점검 + 비정상 종료 복구 */
      'env.title':'환경 점검', 'env.hint':'로컬 실행 환경을 한 번에 점검합니다: Python, 의존성, FFmpeg, 주요 폴더, 포트, 선택 구성 요소. 점검은 읽기 전용이며, 「한 번에 복구」는 누락된 빈 폴더 생성만 하고 콘텐츠·미디어·백업은 절대 건드리지 않습니다.',
      'env.run':'환경 점검 실행', 'env.checking':'점검 중…', 'env.checkFailed':'환경 점검 실패',
      'env.st.ok':'정상', 'env.st.fixable':'복구 가능', 'env.st.optional':'선택', 'env.st.blocked':'차단',
      'env.repair':'한 번에 복구(누락 폴더 생성만)', 'env.repairNote':'복구 안내: 누락된 빈 폴더를 생성할 뿐, 파일을 쓰거나 삭제·덮어쓰기 하지 않습니다.',
      'env.repaired':'복구 완료: 생성', 'env.repairFailed':'복구 실패',
      'recovery.title':'마지막에 복구되지 않은 편집 내용이 감지됨', 'recovery.found':'마지막에 비정상 종료될 때 자동 저장된 구조 복사본을 찾았습니다:',
      'recovery.diff':'차이 보기', 'recovery.restore':'최신 항목 복원', 'recovery.dismiss':'버리기',
      'recovery.diffLoading':'비교 중…', 'recovery.diffTitle':'현재 초안과의 차이(최상위 요약):',
      'recovery.st.same':'동일', 'recovery.st.changed':'변경됨', 'recovery.st.onlyRescued':'백업에만 있음', 'recovery.st.onlyDraft':'초안에만 있음'
    },
    'fr': {
      'nav.portfolio':'Portfolio', 'nav.editor':'Éditeur de texte', 'nav.visual':'Éditeur de mise en page',
      'action.refresh':'Actualiser', 'action.publish':'Publier', 'action.save':'Enregistrer le brouillon',
      'action.preview':'Aperçu du portfolio', 'action.restore':'Restaurer la version précédente', 'action.rename':'Renommer',
      'action.delete':'Supprimer', 'action.new':'＋ Nouveau', 'action.import':'⬇ Importer un modèle',
      'action.expand':'Déplier', 'action.collapse':'Replier', 'action.close':'Fermer',
      'label.template':'Modèle', 'label.language':'Langue', 'label.chinese':'中文', 'label.english':'English',
      'status.loading':'Chargement…', 'status.draft':'Brouillon actuel', 'status.synced':'Synchronisé', 'status.unsaved':'● Non enregistré',
      'section.structure':'Structure de la page', 'section.profile':'Profil', 'section.categories':'Catégories',
      'section.experience':'Expérience', 'section.projects':'Projets', 'section.showreel':'Showreel',
      'section.styles':'Réglages', 'section.ai':'AI Project',
      'settings.title':'Réglages', 'settings.lang':'Langue', 'settings.theme':'Thèmes prédéfinis',
      'public.language':'Langue', 'public.publish':'Publier', 'public.expand':'Déplier', 'public.collapse':'Replier',
      'bar.draft':'Aperçu du brouillon', 'bar.published':'Version publiée',
      'bar.draftNote':'ce que vous enregistrerez dans l’éditeur apparaît ici immédiatement',
      'bar.pubNote':'les dernières modifications du brouillon ne se synchronisent qu’après avoir cliqué sur Mettre à jour',
      'bar.viewPublished':'Voir la version publiée', 'bar.backToDraft':'Retour au brouillon',
      'bar.update':'Mettre à jour', 'bar.updating':'Mise à jour…',
      'bar.updateTitle':'Mettre à jour la version publiée avec le brouillon actuel',
      'bar.checking':'Vérification…', 'bar.dirty':'Modifications non publiées', 'bar.clean':'Synchronisé avec la version publiée',
      'translation.title':'Traduction anglaise (Draft)', 'translation.flow':'Langue actuelle : source chinoise → English Draft',
      'translation.unconfigured':'Service de traduction non configuré', 'translation.draft':'Brouillon anglais en attente de validation',
      'translation.reviewed':'Contenu anglais validé', 'translation.stale':'La source a changé ; le draft anglais doit être revu',
      'translation.failed':'Échec de la requête de traduction', 'translation.empty':'Aucun draft anglais n’a encore été généré.',
      'translation.generate':'Générer le draft anglais', 'translation.regenerate':'Retraduire',
      'translation.apply':'Appliquer / Valider le contenu anglais', 'translation.cancel':'Annuler',
      'translation.generating':'Génération…', 'translation.generated':'Draft anglais généré. Vérifiez-le avant de l’appliquer.',
      'translation.applied':'Contenu anglais validé : les visiteurs anglophones verront cette version',
      'translation.cancelled':'Draft anglais annulé. La source chinoise n’a pas été modifiée',
      'translation.notGenerated':'Aucun draft pour le moment',
      'translation.readyHint':'Le service de traduction est prêt. Cliquez sur « Générer le draft anglais » pour commencer.',
      'pin.on':'Cette section est réglée pour garder sa langue d’origine', 'pin.off':'Cette section suit à nouveau la langue de l’interface',
      'tr.quality':'Qualité de traduction',
      'tr.modeTitle':"Mode de traduction",
      'tr.modeReview':'Vérifier avant publication',
      'tr.modeReviewDesc':'Une fois la traduction automatique terminée, vous confirmez le contenu traduit ; il ne sera affiché et publié comme traduction officielle qu’après confirmation.',
      'tr.modeDirect':'Traduction automatique directe',
      'tr.modeDirectDesc':'Dès la traduction terminée, elle est utilisable dans le portfolio et pour la publication, sans confirmation ligne par ligne ; prévisualisation et modification toujours possibles ensuite.',
      'tr.approve':'Approuver la traduction ✓',
      'tr.notGenerated':'Non générée',
      'tr.draftPending':'Brouillon · à confirmer',
      'tr.ready':'Prête',
      'tr.mtReady':'Traduction automatique · Prête',
      'tr.stale':'À revérifier',
      'ai.label.positioning':'Positionnement',
      'ai.label.role':'Mon rôle',
      'ai.label.contribution':'Ma contribution',
      'ai.label.highlights':'Points forts',
      'pin.hint':'Cliquez sur le nom d’une section pour qu’elle ignore le changement de langue : quelle que soit la langue du portfolio, cette section reste exactement telle que vous l’avez écrite.',
      /* Phase 4 (26/09/2026) : vérification de l’environnement + récupération après fermeture inattendue */
      'env.title':'Vérification de l’environnement', 'env.hint':'Vérification en un clic de l’environnement local : Python, dépendances, FFmpeg, dossiers clés, port et composants optionnels. La vérification est en lecture seule ; « Réparer » ne fait que créer les dossiers vides manquants et ne touche jamais au contenu, aux médias ni aux sauvegardes.',
      'env.run':'Lancer la vérification', 'env.checking':'Vérification…', 'env.checkFailed':'Échec de la vérification de l’environnement',
      'env.st.ok':'OK', 'env.st.fixable':'Réparable', 'env.st.optional':'Optionnel', 'env.st.blocked':'Bloqué',
      'env.repair':'Réparer (créer uniquement les dossiers manquants)', 'env.repairNote':'À propos de la réparation : seuls les dossiers vides manquants sont créés — aucun fichier n’est écrit, supprimé ni écrasé.',
      'env.repaired':'Réparation terminée : créé', 'env.repairFailed':'Échec de la réparation',
      'recovery.title':'Modifications non récupérées détectées', 'recovery.found':'Des copies de secours enregistrées automatiquement lors de la dernière session interrompue ont été trouvées :',
      'recovery.diff':'Voir les différences', 'recovery.restore':'Restaurer la plus récente', 'recovery.dismiss':'Abandonner',
      'recovery.diffLoading':'Comparaison…', 'recovery.diffTitle':'Différences avec le brouillon actuel (résumé de premier niveau) :',
      'recovery.st.same':'Identique', 'recovery.st.changed':'Modifié', 'recovery.st.onlyRescued':'Uniquement dans la sauvegarde', 'recovery.st.onlyDraft':'Uniquement dans le brouillon'
    },
    'es': {
      'nav.portfolio':'Portafolio', 'nav.editor':'Editor de texto', 'nav.visual':'Editor de diseño',
      'action.refresh':'Actualizar', 'action.publish':'Publicar', 'action.save':'Guardar borrador',
      'action.preview':'Vista previa del portafolio', 'action.restore':'Restaurar versión anterior', 'action.rename':'Renombrar',
      'action.delete':'Eliminar', 'action.new':'＋ Nuevo', 'action.import':'⬇ Importar plantilla',
      'action.expand':'Desplegar', 'action.collapse':'Plegar', 'action.close':'Cerrar',
      'label.template':'Plantilla', 'label.language':'Idioma', 'label.chinese':'中文', 'label.english':'English',
      'status.loading':'Cargando…', 'status.draft':'Borrador actual', 'status.synced':'Sincronizado', 'status.unsaved':'● Sin guardar',
      'section.structure':'Estructura de la página', 'section.profile':'Perfil', 'section.categories':'Categorías',
      'section.experience':'Experiencia', 'section.projects':'Proyectos', 'section.showreel':'Showreel',
      'section.styles':'Ajustes', 'section.ai':'AI Project',
      'settings.title':'Ajustes', 'settings.lang':'Idioma', 'settings.theme':'Temas predefinidos',
      'public.language':'Idioma', 'public.publish':'Publicar', 'public.expand':'Desplegar', 'public.collapse':'Plegar',
      'bar.draft':'Vista previa del borrador', 'bar.published':'Versión publicada',
      'bar.draftNote':'lo que guardes en el editor aparece aquí de inmediato',
      'bar.pubNote':'los últimos cambios del borrador se sincronizan solo tras pulsar Actualizar',
      'bar.viewPublished':'Ver la versión publicada', 'bar.backToDraft':'Volver al borrador',
      'bar.update':'Actualizar', 'bar.updating':'Actualizando…',
      'bar.updateTitle':'Actualizar la versión publicada con el borrador actual',
      'bar.checking':'Comprobando…', 'bar.dirty':'Cambios sin publicar', 'bar.clean':'Sincronizado con la versión publicada',
      'translation.title':'Traducción al inglés (Draft)', 'translation.flow':'Idioma actual: origen chino → English Draft',
      'translation.unconfigured':'Servicio de traducción sin configurar', 'translation.draft':'Borrador inglés pendiente de revisión',
      'translation.reviewed':'Contenido inglés revisado', 'translation.stale':'El origen cambió; el draft inglés necesita revisión',
      'translation.failed':'Error en la solicitud de traducción', 'translation.empty':'Aún no se ha generado ningún draft inglés.',
      'translation.generate':'Generar draft inglés', 'translation.regenerate':'Retraducir',
      'translation.apply':'Aplicar / Revisar el contenido inglés', 'translation.cancel':'Cancelar',
      'translation.generating':'Generando…', 'translation.generated':'Draft inglés generado. Revísalo antes de aplicarlo.',
      'translation.applied':'Contenido inglés revisado: los visitantes anglófonos verán esta versión',
      'translation.cancelled':'Draft inglés cancelado. El texto original en chino no se modificó',
      'translation.notGenerated':'Aún no hay borrador',
      'translation.readyHint':'El servicio de traducción está listo. Pulsa «Generar draft inglés» para empezar.',
      'pin.on':'Este bloque está configurado para mantener su idioma original', 'pin.off':'Este bloque vuelve a seguir el idioma de la interfaz',
      'tr.quality':'Calidad de traducción',
      'tr.modeTitle':"Modo de traducción",
      'tr.modeReview':'Revisar antes de publicar',
      'tr.modeReviewDesc':'Una vez terminada la traducción automática, debes confirmar el contenido traducido; solo después de confirmar se mostrará y publicará como traducción oficial.',
      'tr.modeDirect':'Usar traducción automática directamente',
      'tr.modeDirectDesc':'Al terminar la traducción se puede usar en el portafolio y publicarse sin confirmar elemento por elemento; luego sigues pudiendo previsualizar y modificar.',
      'tr.approve':'Aprobar traducción ✓',
      'tr.notGenerated':'Sin generar',
      'tr.draftPending':'Borrador · pendiente de confirmar',
      'tr.ready':'Lista',
      'tr.mtReady':'Traducción automática · Lista',
      'tr.stale':'Necesita revisarse',
      'ai.label.positioning':'Posicionamiento',
      'ai.label.role':'Mi rol',
      'ai.label.contribution':'Mi contribución',
      'ai.label.highlights':'Aspectos destacados',
      'pin.hint':'Haz clic en el nombre de un bloque para que ignore el cambio de idioma: sea cual sea el idioma del portafolio, ese bloque se mantiene tal como lo escribiste.',
      /* Phase 4 (26/09/2026): comprobación del entorno + recuperación tras cierre inesperado */
      'env.title':'Comprobación del entorno', 'env.hint':'Comprueba el entorno local de un clic: Python, dependencias, FFmpeg, carpetas clave, puerto y componentes opcionales. La comprobación es de solo lectura; «Reparar» solo crea las carpetas vacías que falten y nunca toca tu contenido, tus medios ni tus copias de seguridad.',
      'env.run':'Ejecutar comprobación', 'env.checking':'Comprobando…', 'env.checkFailed':'Error en la comprobación del entorno',
      'env.st.ok':'OK', 'env.st.fixable':'Reparable', 'env.st.optional':'Opcional', 'env.st.blocked':'Bloqueado',
      'env.repair':'Reparar (solo crear carpetas que falten)', 'env.repairNote':'Sobre la reparación: solo crea las carpetas vacías que falten; no escribe, elimina ni sobrescribe ningún archivo.',
      'env.repaired':'Reparación completada: creadas', 'env.repairFailed':'Error en la reparación',
      'recovery.title':'Se detectaron ediciones no recuperadas de la sesión anterior', 'recovery.found':'Se encontraron copias de rescate guardadas automáticamente al terminar de forma inesperada la última sesión:',
      'recovery.diff':'Ver diferencias', 'recovery.restore':'Restaurar la más reciente', 'recovery.dismiss':'Descartar',
      'recovery.diffLoading':'Comparando…', 'recovery.diffTitle':'Diferencias con el borrador actual (resumen de primer nivel):',
      'recovery.st.same':'Igual', 'recovery.st.changed':'Modificado', 'recovery.st.onlyRescued':'Solo en la copia', 'recovery.st.onlyDraft':'Solo en el borrador'
    },
    'it': {
      'nav.portfolio':'Portfolio', 'nav.editor':'Editor di testo', 'nav.visual':'Editor del layout',
      'action.refresh':'Aggiorna', 'action.publish':'Pubblica', 'action.save':'Salva bozza',
      'action.preview':'Anteprima del portfolio', 'action.restore':'Ripristina versione precedente', 'action.rename':'Rinomina',
      'action.delete':'Elimina', 'action.new':'＋ Nuovo', 'action.import':'⬇ Importa modello',
      'action.expand':'Espandi', 'action.collapse':'Comprimi', 'action.close':'Chiudi',
      'label.template':'Modello', 'label.language':'Lingua', 'label.chinese':'中文', 'label.english':'English',
      'status.loading':'Caricamento…', 'status.draft':'Bozza attuale', 'status.synced':'Sincronizzato', 'status.unsaved':'● Non salvato',
      'section.structure':'Struttura della pagina', 'section.profile':'Profilo', 'section.categories':'Categorie',
      'section.experience':'Esperienza', 'section.projects':'Progetti', 'section.showreel':'Showreel',
      'section.styles':'Impostazioni', 'section.ai':'AI Project',
      'settings.title':'Impostazioni', 'settings.lang':'Lingua', 'settings.theme':'Temi predefiniti',
      'public.language':'Lingua', 'public.publish':'Pubblica', 'public.expand':'Espandi', 'public.collapse':'Comprimi',
      'bar.draft':'Anteprima della bozza', 'bar.published':'Versione pubblicata',
      'bar.draftNote':'ciò che salvi nell’editor appare qui immediatamente',
      'bar.pubNote':'le ultime modifiche alla bozza si sincronizzano solo dopo aver premuto Aggiorna',
      'bar.viewPublished':'Vedi la versione pubblicata', 'bar.backToDraft':'Torna alla bozza',
      'bar.update':'Aggiorna', 'bar.updating':'Aggiornamento…',
      'bar.updateTitle':'Aggiorna la versione pubblicata con la bozza attuale',
      'bar.checking':'Verifica…', 'bar.dirty':'Modifiche non pubblicate', 'bar.clean':'Sincronizzato con la versione pubblicata',
      'translation.title':'Traduzione inglese (Draft)', 'translation.flow':'Lingua attuale: origine cinese → English Draft',
      'translation.unconfigured':'Servizio di traduzione non configurato', 'translation.draft':'Bozza inglese in attesa di revisione',
      'translation.reviewed':'Contenuto inglese revisionato', 'translation.stale':'L’origine è cambiata; la bozza inglese va riveduta',
      'translation.failed':'Richiesta di traduzione non riuscita', 'translation.empty':'Nessuna bozza inglese generata finora.',
      'translation.generate':'Genera bozza inglese', 'translation.regenerate':'Ritraduci',
      'translation.apply':'Applica / Revisiona il contenuto inglese', 'translation.cancel':'Annulla',
      'translation.generating':'Generazione…', 'translation.generated':'Bozza inglese generata. Verificala prima di applicarla.',
      'translation.applied':'Contenuto inglese revisionato: i visitatori anglofoni vedranno questa versione',
      'translation.cancelled':'Bozza inglese annullata. Il testo originale in cinese non è stato modificato',
      'translation.notGenerated':'Ancora nessuna bozza',
      'translation.readyHint':'Il servizio di traduzione è pronto. Fai clic su «Genera bozza inglese» per iniziare.',
      'pin.on':'Questa sezione è impostata per mantenere la lingua originale', 'pin.off':'Questa sezione segue di nuovo la lingua dell’interfaccia',
      'tr.quality':'Qualità della traduzione',
      'tr.modeTitle':"Modalità di traduzione",
      'tr.modeReview':'Verifica prima della pubblicazione',
      'tr.modeReviewDesc':'Una volta completata la traduzione automatica, devi confermare il contenuto tradotto; solo dopo la conferma verrà mostrato e pubblicato come traduzione ufficiale.',
      'tr.modeDirect':'Usa direttamente la traduzione automatica',
      'tr.modeDirectDesc':'Al termine della traduzione è utilizzabile nel portfolio e pubblicabile senza conferme voce per voce; puoi comunque previsualizzare e modificare in seguito.',
      'tr.approve':'Approva traduzione ✓',
      'tr.notGenerated':'Non generata',
      'tr.draftPending':'Bozza · da confermare',
      'tr.ready':'Pronta',
      'tr.mtReady':'Traduzione automatica · Pronta',
      'tr.stale':'Da riverificare',
      'ai.label.positioning':'Posizionamento',
      'ai.label.role':'Il mio ruolo',
      'ai.label.contribution':'Il mio contributo',
      'ai.label.highlights':'In evidenza',
      'pin.hint':'Fai clic sul nome di una sezione per far sì che ignori il cambio di lingua: qualunque sia la lingua del portfolio, quella sezione resta esattamente come l’hai scritta.',
      /* Phase 4 (26/09/2026): verifica dell’ambiente + ripristino dopo chiusura imprevista */
      'env.title':'Verifica ambiente', 'env.hint':'Controllo con un clic dell’ambiente locale: Python, dipendenze, FFmpeg, cartelle chiave, porta e componenti opzionali. La verifica è di sola lettura; «Ripara» si limita a creare le cartelle vuote mancanti e non tocca mai contenuti, media o backup.',
      'env.run':'Esegui verifica ambiente', 'env.checking':'Verifica in corso…', 'env.checkFailed':'Verifica dell’ambiente non riuscita',
      'env.st.ok':'OK', 'env.st.fixable':'Riparabile', 'env.st.optional':'Opzionale', 'env.st.blocked':'Bloccato',
      'env.repair':'Ripara (crea solo le cartelle mancanti)', 'env.repairNote':'Nota sulla riparazione: vengono create solo le cartelle vuote mancanti; nessun file viene scritto, eliminato o sovrascritto.',
      'env.repaired':'Riparazione completata: create', 'env.repairFailed':'Riparazione non riuscita',
      'recovery.title':'Rilevate modifiche non ripristinate della sessione precedente', 'recovery.found':'Trovate copie di salvataggio automatiche lasciate dalla sessione precedente terminata in modo anomalo:',
      'recovery.diff':'Vedi differenze', 'recovery.restore':'Ripristina la più recente', 'recovery.dismiss':'Ignora',
      'recovery.diffLoading':'Confronto…', 'recovery.diffTitle':'Differenze rispetto alla bozza attuale (riepilogo di primo livello):',
      'recovery.st.same':'Uguale', 'recovery.st.changed':'Modificato', 'recovery.st.onlyRescued':'Solo nella copia', 'recovery.st.onlyDraft':'Solo nella bozza'
    },
    'de': {
      'nav.portfolio':'Portfolio', 'nav.editor':'Texteditor', 'nav.visual':'Layout-Editor',
      'action.refresh':'Aktualisieren', 'action.publish':'Veröffentlichen', 'action.save':'Entwurf speichern',
      'action.preview':'Portfolio-Vorschau', 'action.restore':'Vorherige Version wiederherstellen', 'action.rename':'Umbenennen',
      'action.delete':'Löschen', 'action.new':'＋ Neu', 'action.import':'⬇ Vorlage importieren',
      'action.expand':'Ausklappen', 'action.collapse':'Einklappen', 'action.close':'Schließen',
      'label.template':'Vorlage', 'label.language':'Sprache', 'label.chinese':'中文', 'label.english':'English',
      'status.loading':'Wird geladen…', 'status.draft':'Aktueller Entwurf', 'status.synced':'Synchronisiert', 'status.unsaved':'● Nicht gespeichert',
      'section.structure':'Seitenstruktur', 'section.profile':'Profil', 'section.categories':'Kategorien',
      'section.experience':'Werdegang', 'section.projects':'Projekte', 'section.showreel':'Showreel',
      'section.styles':'Einstellungen', 'section.ai':'AI Project',
      'settings.title':'Einstellungen', 'settings.lang':'Sprache', 'settings.theme':'Designvorlagen',
      'public.language':'Sprache', 'public.publish':'Veröffentlichen', 'public.expand':'Ausklappen', 'public.collapse':'Einklappen',
      'bar.draft':'Entwurfsvorschau', 'bar.published':'Veröffentlichte Version',
      'bar.draftNote':'was du im Editor speicherst, erscheint sofort hier',
      'bar.pubNote':'die neuesten Entwurfsänderungen werden erst nach Klick auf Aktualisieren synchronisiert',
      'bar.viewPublished':'Veröffentlichte Version ansehen', 'bar.backToDraft':'Zurück zum Entwurf',
      'bar.update':'Aktualisieren', 'bar.updating':'Wird aktualisiert…',
      'bar.updateTitle':'Die veröffentlichte Version mit dem aktuellen Entwurf aktualisieren',
      'bar.checking':'Prüfung…', 'bar.dirty':'Unveröffentlichte Änderungen', 'bar.clean':'Mit der veröffentlichten Version synchronisiert',
      'translation.title':'Englische Übersetzung (Draft)', 'translation.flow':'Aktuelle Sprache: chinesische Quelle → English Draft',
      'translation.unconfigured':'Übersetzungsdienst nicht konfiguriert', 'translation.draft':'Englischer Entwurf wartet auf Prüfung',
      'translation.reviewed':'Englischer Inhalt geprüft', 'translation.stale':'Quelle wurde geändert; englischer Entwurf muss geprüft werden',
      'translation.failed':'Übersetzungsanfrage fehlgeschlagen', 'translation.empty':'Noch kein englischer Entwurf erzeugt.',
      'translation.generate':'Englischen Entwurf erzeugen', 'translation.regenerate':'Neu übersetzen',
      'translation.apply':'Anwenden / Englischen Inhalt prüfen', 'translation.cancel':'Abbrechen',
      'translation.generating':'Wird erzeugt…', 'translation.generated':'Englischer Entwurf erzeugt. Vor dem Anwenden prüfen.',
      'translation.applied':'Englischer Inhalt geprüft: Besucher in dieser Sprache sehen diese Version',
      'translation.cancelled':'Englischer Entwurf abgebrochen. Die chinesische Quelle wurde nicht geändert',
      'translation.notGenerated':'Noch kein Entwurf vorhanden',
      'translation.readyHint':'Der Übersetzungsdienst ist bereit. Klicke auf „Englischen Entwurf erzeugen“, um zu starten.',
      'pin.on':'Dieser Block ist so eingestellt, dass er seine Originalsprache behält', 'pin.off':'Dieser Block folgt wieder der Sprache der Oberfläche',
      'tr.quality':'Übersetzungsqualität',
      'tr.modeTitle':"Übersetzungsmodus",
      'tr.modeReview':'Vor Veröffentlichung prüfen',
      'tr.modeReviewDesc':'Nach Abschluss der Maschinenübersetzung bestätigst du den übersetzten Inhalt; erst nach der Bestätigung wird er als offizielle Übersetzung angezeigt und veröffentlicht.',
      'tr.modeDirect':'Maschinenübersetzung direkt verwenden',
      'tr.modeDirectDesc':'Nach Abschluss der Übersetzung sofort für Portfolio und Veröffentlichung nutzbar, ohne einzelne Bestätigungen; Vorschau und Änderungen sind weiterhin möglich.',
      'tr.approve':'Übersetzung bestätigen ✓',
      'tr.notGenerated':'Nicht erstellt',
      'tr.draftPending':'Entwurf · Bestätigung ausstehend',
      'tr.ready':'Bereit',
      'tr.mtReady':'Maschinenübersetzung · Bereit',
      'tr.stale':'Erneut prüfen',
      'ai.label.positioning':'Positionierung',
      'ai.label.role':'Meine Rolle',
      'ai.label.contribution':'Mein Beitrag',
      'ai.label.highlights':'Highlights',
      'pin.hint':'Klicke auf den Namen eines Blocks, damit er den Sprachwechsel ignoriert: In welcher Sprache das Portfolio auch gezeigt wird, dieser Block bleibt genau so, wie du ihn geschrieben hast.',
      /* Phase 4 (26.09.2026): Umgebungsprüfung + Wiederherstellung nach unerwartetem Beenden */
      'env.title':'Umgebungsprüfung', 'env.hint':'Prüfung der lokalen Umgebung mit einem Klick: Python, Abhängigkeiten, FFmpeg, wichtige Ordner, Port und optionale Komponenten. Die Prüfung ist rein lesend; „Reparieren“ legt nur fehlende leere Ordner an und fasst Inhalte, Medien oder Backups niemals an.',
      'env.run':'Umgebungsprüfung starten', 'env.checking':'Prüfe…', 'env.checkFailed':'Umgebungsprüfung fehlgeschlagen',
      'env.st.ok':'OK', 'env.st.fixable':'Reparierbar', 'env.st.optional':'Optional', 'env.st.blocked':'Blockiert',
      'env.repair':'Reparieren (nur fehlende Ordner anlegen)', 'env.repairNote':'Hinweis zur Reparatur: Es werden nur fehlende leere Ordner angelegt — nichts wird geschrieben, gelöscht oder überschrieben.',
      'env.repaired':'Reparatur abgeschlossen: angelegt', 'env.repairFailed':'Reparatur fehlgeschlagen',
      'recovery.title':'Nicht wiederhergestellte Änderungen der letzten Sitzung erkannt', 'recovery.found':'Automatisch gespeicherte Rettungskopien der zuletzt unfreiwillig beendeten Sitzung gefunden:',
      'recovery.diff':'Unterschiede ansehen', 'recovery.restore':'Neueste wiederherstellen', 'recovery.dismiss':'Verwerfen',
      'recovery.diffLoading':'Vergleiche…', 'recovery.diffTitle':'Unterschiede zum aktuellen Entwurf (Überblick auf oberster Ebene):',
      'recovery.st.same':'Gleich', 'recovery.st.changed':'Geändert', 'recovery.st.onlyRescued':'Nur im Backup', 'recovery.st.onlyDraft':'Nur im Entwurf'
    },
    'pt': {
      'nav.portfolio':'Portfólio', 'nav.editor':'Editor de texto', 'nav.visual':'Editor de layout',
      'action.refresh':'Atualizar', 'action.publish':'Publicar', 'action.save':'Salvar rascunho',
      'action.preview':'Pré-visualização do portfólio', 'action.restore':'Restaurar versão anterior', 'action.rename':'Renomear',
      'action.delete':'Excluir', 'action.new':'＋ Novo', 'action.import':'⬇ Importar modelo',
      'action.expand':'Expandir', 'action.collapse':'Recolher', 'action.close':'Fechar',
      'label.template':'Modelo', 'label.language':'Idioma', 'label.chinese':'中文', 'label.english':'English',
      'status.loading':'Carregando…', 'status.draft':'Rascunho atual', 'status.synced':'Sincronizado', 'status.unsaved':'● Não salvo',
      'section.structure':'Estrutura da página', 'section.profile':'Perfil', 'section.categories':'Categorias',
      'section.experience':'Experiência', 'section.projects':'Projetos', 'section.showreel':'Showreel',
      'section.styles':'Configurações', 'section.ai':'AI Project',
      'settings.title':'Configurações', 'settings.lang':'Idioma', 'settings.theme':'Temas predefinidos',
      'public.language':'Idioma', 'public.publish':'Publicar', 'public.expand':'Expandir', 'public.collapse':'Recolher',
      'bar.draft':'Pré-visualização do rascunho', 'bar.published':'Versão publicada',
      'bar.draftNote':'o que você salvar no editor aparece aqui imediatamente',
      'bar.pubNote':'as últimas alterações do rascunho só sincronizam depois de clicar em Atualizar',
      'bar.viewPublished':'Ver a versão publicada', 'bar.backToDraft':'Voltar ao rascunho',
      'bar.update':'Atualizar', 'bar.updating':'Atualizando…',
      'bar.updateTitle':'Atualizar a versão publicada com o rascunho atual',
      'bar.checking':'Verificando…', 'bar.dirty':'Alterações não publicadas', 'bar.clean':'Sincronizado com a versão publicada',
      'translation.title':'Tradução para o inglês (Draft)', 'translation.flow':'Idioma atual: origem em chinês → English Draft',
      'translation.unconfigured':'Serviço de tradução não configurado', 'translation.draft':'Rascunho em inglês aguardando revisão',
      'translation.reviewed':'Conteúdo em inglês revisado', 'translation.stale':'A origem mudou; o rascunho em inglês precisa de revisão',
      'translation.failed':'Falha na solicitação de tradução', 'translation.empty':'Nenhum rascunho em inglês gerado ainda.',
      'translation.generate':'Gerar rascunho em inglês', 'translation.regenerate':'Retraduzir',
      'translation.apply':'Aplicar / Revisar o conteúdo em inglês', 'translation.cancel':'Cancelar',
      'translation.generating':'Gerando…', 'translation.generated':'Rascunho em inglês gerado. Revise-o antes de aplicar.',
      'translation.applied':'Conteúdo em inglês revisado: visitantes anglofonos verão esta versão',
      'translation.cancelled':'Rascunho em inglês cancelado. O texto original em chinês não foi alterado',
      'translation.notGenerated':'Ainda não há rascunho',
      'translation.readyHint':'O serviço de tradução está pronto. Clique em «Gerar rascunho em inglês» para começar.',
      'pin.on':'Este bloco está configurado para manter o idioma original', 'pin.off':'Este bloco volta a seguir o idioma da interface',
      'tr.quality':'Qualidade da tradução',
      'tr.modeTitle':"Modo de tradução",
      'tr.modeReview':'Revisar antes de publicar',
      'tr.modeReviewDesc':'Após a tradução automática, é necessário confirmar o conteúdo traduzido; só depois da confirmação será exibido e publicado como tradução oficial.',
      'tr.modeDirect':'Usar tradução automática diretamente',
      'tr.modeDirectDesc':'Após a tradução, já pode ser usado no portfólio e publicado sem confirmação item por item; ainda é possível pré-visualizar e modificar depois.',
      'tr.approve':'Aprovar tradução ✓',
      'tr.notGenerated':'Não gerada',
      'tr.draftPending':'Rascunho · aguardando confirmação',
      'tr.ready':'Pronta',
      'tr.mtReady':'Tradução automática · Pronta',
      'tr.stale':'Precisa ser reverificado',
      'ai.label.positioning':'Posicionamento',
      'ai.label.role':'Meu papel',
      'ai.label.contribution':'Minha contribuição',
      'ai.label.highlights':'Destaques',
      'pin.hint':'Clique no nome de um bloco para que ele ignore a troca de idioma: seja qual for o idioma do portfólio, esse bloco permanece exatamente como você o escreveu.',
      /* Phase 4 (26/09/2026): verificação do ambiente + recuperação após encerramento inesperado */
      'env.title':'Verificação do ambiente', 'env.hint':'Diagnóstico do ambiente local com um clique: Python, dependências, FFmpeg, pastas essenciais, porta e componentes opcionais. A verificação é somente leitura; «Reparar» apenas cria as pastas vazias que faltam e nunca altera conteúdo, mídia ou backups.',
      'env.run':'Executar verificação', 'env.checking':'Verificando…', 'env.checkFailed':'Falha na verificação do ambiente',
      'env.st.ok':'OK', 'env.st.fixable':'Reparável', 'env.st.optional':'Opcional', 'env.st.blocked':'Bloqueado',
      'env.repair':'Reparar (criar apenas pastas que faltam)', 'env.repairNote':'Sobre a reparação: apenas cria as pastas vazias que faltam — nenhum arquivo é gravado, excluído ou sobrescrito.',
      'env.repaired':'Reparação concluída: criadas', 'env.repairFailed':'Falha na reparação',
      'recovery.title':'Edições não recuperadas da sessão anterior detectadas', 'recovery.found':'Cópias de resgate salvas automaticamente quando a última sessão terminou de forma inesperada:',
      'recovery.diff':'Ver diferenças', 'recovery.restore':'Restaurar a mais recente', 'recovery.dismiss':'Descartar',
      'recovery.diffLoading':'Comparando…', 'recovery.diffTitle':'Diferenças em relação ao rascunho atual (resumo de primeiro nível):',
      'recovery.st.same':'Igual', 'recovery.st.changed':'Alterado', 'recovery.st.onlyRescued':'Somente na cópia', 'recovery.st.onlyDraft':'Somente no rascunho'
    }
  };
  const DEFAULT_SECTION_LABELS = { about:'About', experience:'Experience', works:'Works', showreel:'Showreel', aiVoices:'AI Project' };

  /* ————————————————————————— locale 读写 ————————————————————————— */
  /* 2026-09-23：**编辑器语言 与 作品集语言 是两把键**（用户明确要求的）。
   *
   * 为什么必须分开：作品集是给不同语言的人看的，而使用者自己可能一直是中文操作习惯
   * ——「中文编辑器 + 英文简历（给对方看）」是很常见的组合。原来只有一把全局键，
   * 在作品集页面切语言会把编辑器也切了，用户想同时维护中/英两版就必须来回切，很难用。
   *
   * 跟随规则（**单向**，这是关键）：
   *   · 编辑器（外壳顶栏 / 文本编辑 / 排版编辑）换语言 → 顺手把作品集语言也改成同一个
   *     （用户原话：「你可以针对于作品集里面的语言一起更改」）。
   *   · 作品集页面里换语言 → **只改作品集**，绝不回头改编辑器的语言设置
   *     （用户原话：「如果在作品集里面更改了语言系统，你不应该让编辑器也跟随」）。
   *
   * 老版本只有一把 `folioframe.locale`：首次读取时把它当作两个 scope 的初始值迁移过来，
   * 否则用户浏览器里已经存着的英文会"又变回中文"。
   * 更老的 `folioframe.locale.<scope>.<tpl>` 同样只作为一次性迁移来源。 */
  const LOCALE_KEYS = { editor: 'folioframe.locale.editor', public: 'folioframe.locale.public' };
  const LEGACY_GLOBAL_KEY = 'folioframe.locale';
  const LEGACY_PREFIX = 'folioframe.locale.';
  const normal = value => (LANGS.some(l => l.id === value) ? value : SOURCE);
  /* 「本窗口**已经按哪个语言画过 DOM**」。
   * ⚠ 不能用 getLocale() 当判据：localStorage 是同源共享的，别的 frame 刚写完，
   *   本窗口 getLocale() 立刻就是新值了 —— 拿它比会得出"没变"而漏掉整次同步。
   *   所以单独记一份"本窗口的状态"。 */
  let _applied = '';

  /* 本窗口属于哪个 scope？由 html/body 上的 data-ff-locale-scope 决定：
   *   editor —— Studio 外壳 / 文本编辑 / 排版编辑的界面
   *   public —— 作品集页面（含排版编辑里那个画布 iframe）
   * 单开 /portfolio/ 时没有 body 属性，靠 __PUBLIC_VIEWER__ 兜底。 */
  function scope() {
    try {
      const pick = el => (el && el.dataset && el.dataset.ffLocaleScope) || '';
      const v = pick(document && document.body) || pick(document && document.documentElement);
      if (v) return v === 'public' ? 'public' : 'editor';
    } catch (_) {}
    return global.__PUBLIC_VIEWER__ ? 'public' : 'editor';
  }
  const myKey = () => LOCALE_KEYS[scope()] || LOCALE_KEYS.editor;
  const tpl = () => new URLSearchParams(location.search).get('tpl') || 'main';

  function readStored() {
    const key = myKey();
    try {
      const v = localStorage.getItem(key);
      if (v && LANGS.some(l => l.id === v)) return v;
      // 迁移一：老的一把全局键 → 两个 scope 都拿它当初始值
      const g = localStorage.getItem(LEGACY_GLOBAL_KEY);
      if (g && LANGS.some(l => l.id === g)) { localStorage.setItem(key, g); return g; }
      // 迁移二：更老的 per-scope-per-tpl 键（挑一个非中文的旧值优先，没有就保持源语言）
      let pick = '';
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || k.indexOf(LEGACY_PREFIX) !== 0) continue;
        if (k === key || k === LOCALE_KEYS.editor || k === LOCALE_KEYS.public) continue;
        const val = normal(localStorage.getItem(k));
        if (!val) continue;
        if (val !== SOURCE) { pick = val; break; }
        if (!pick) pick = val;
      }
      if (pick) { localStorage.setItem(key, pick); return pick; }
    } catch (_) {}
    return '';
  }
  /* ——— 发行配置：单语言 / 多语言 ———
   * 由 dist-config.js（必须在 i18n.js 之前加载）写入 window.__FF_DIST__。
   *   langMode: 'single' → 锁定 defaultLang，隐藏所有语言切换入口
   *                          （编辑器顶部 / 作品集页面 / 排版编辑三处共用同一套组件）
   *   langMode: 'multi'  → 完整 i18n，可自由切换（默认）
   * 这样无需改动任何多语言资源，就能出「单语言版」发行物（FolioFold-ZH / FolioFold-EN）。 */
  const _FF_DIST = (typeof window !== 'undefined' && window.__FF_DIST__) || {};
  const _FF_LANG_MODE = _FF_DIST.langMode === 'single' ? 'single' : 'multi';
  const _FF_DEFAULT_LANG = (_FF_DIST.defaultLang || 'zh-CN');

  function getLocale() {
    // 单语言发行：恒为 defaultLang，不读 localStorage、不随切换改变。
    if (_FF_LANG_MODE === 'single') return _FF_DEFAULT_LANG;
    // 「无语言系统」的版本恒为中文 —— 绝不能出现"界面翻了一半"的样子。
    if (!capable()) return SOURCE;
    return normal(readStored());
  }

  /* ————————————————————————— 字典层 ————————————————————————— */
  /* 生成物长这样：
   *   window.FF_ZH_I18N = { en:{ "主题":"Theme", ... }, ja:{...}, ko:{...} };
   *   window.FF_ZH_PATTERNS_I18N = { en:[[re,repl],...], ja:[...], ko:[...] };
   * 旧名字 FF_ZH_EN / FF_ZH_PATTERNS 仍保留，方便外部脚本单独取英文表。 */
  const _tbl = {};
  function tableFor(lang) {
    if (_tbl[lang]) return _tbl[lang];
    const all = global.FF_ZH_I18N || {};
    const patsAll = global.FF_ZH_PATTERNS_I18N || {};
    const fbId = FALLBACK[lang];
    const exact = Object.assign({}, fbId ? (all[fbId] || {}) : {}, all[lang] || {});
    const patterns = (patsAll[lang] && patsAll[lang].length) ? patsAll[lang] : (fbId ? (patsAll[fbId] || []) : []);
    return (_tbl[lang] = { exact, patterns });
  }
  // 用户内容的整篇翻译表（服务端下发）。键是中文原文，值是目标语言译文。
  const _ctbl = {};
  function contentTableFor(lang) {
    if (_ctbl[lang]) return _ctbl[lang];
    const all = global.FF_CONTENT_I18N || {};
    const fbId = FALLBACK[lang];
    const merged = Object.assign({}, fbId ? (all[fbId] || {}) : {}, all[lang] || {});
    return (_ctbl[lang] = merged);
  }
  function setContentDict(lang, map) {
    const id = normal(lang);
    global.FF_CONTENT_I18N = global.FF_CONTENT_I18N || {};
    global.FF_CONTENT_I18N[id] = (map && typeof map === 'object') ? map : {};
    Object.keys(_ctbl).forEach(k => { delete _ctbl[k]; });   // 作废合并缓存（含 ja/ko 的英文回退）
    applyAll();
  }
  function translateWith(text, tbl) {
    const s = String(text);
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
    if (!m) return text;
    const core = m[2];
    if (!core) return text;
    if (Object.prototype.hasOwnProperty.call(tbl.exact, core)) {
      const v = tbl.exact[core];
      if (v) return m[1] + v + m[3];
    }
    const P = tbl.patterns || [];
    for (let i = 0; i < P.length; i++) {
      try { if (P[i][0].test(core)) return m[1] + core.replace(P[i][0], P[i][1]) + m[3]; } catch (_) {}
    }
    return text;
  }
  // 翻一个字符串（toast / confirm / prompt 这种"拼出来才知道"的文案用）。
  // 首尾空白原样保留 —— DOM 文本节点常带缩进换行。
  function z(text) {
    if (text == null) return text;
    const lang = getLocale();
    if (lang === SOURCE) return String(text);
    return translateWith(String(text), tableFor(lang));
  }
  // 用户内容版：只有"整篇翻译"表里有这条才翻。
  function zc(text) {
    if (text == null) return text;
    const lang = getLocale();
    if (lang === SOURCE) return String(text);
    return translateWith(String(text), { exact: contentTableFor(lang), patterns: [] });
  }
  function hasTranslation(key) {
    const lang = getLocale();
    if (lang === SOURCE) return false;
    const t = tableFor(lang);
    return typeof key === 'string' && !!t.exact[key];
  }

  /* ————————————————————————— 键值对层 ————————————————————————— */
  function t(key, fallback) {
    const lang = getLocale();
    const zh = UI[SOURCE][key];
    if (lang === SOURCE) return zh != null ? zh : (fallback != null ? fallback : key);
    // 仅中 / 英两语言：英文直接用英文键值表；其它语言（理论上不会再有）退中文原文。
    if (UI[lang] && UI[lang][key] != null) return UI[lang][key];
    return zh != null ? zh : (fallback != null ? fallback : key);
  }
  function langName(id) { return (byId[normal(id)] || byId[SOURCE]).name; }
  function langShort(id) { return (byId[normal(id)] || byId[SOURCE]).short; }

  /* —— 区块标题 / 实体摘要的显示名解析 —— */
  function resolveSectionLabel(content, stableId, locale) {
    const lang = normal(locale || getLocale());
    const original = content && content.sectionTitles && content.sectionTitles[stableId];
    const trans = content && content.sectionTitleTranslations && content.sectionTitleTranslations[lang] && content.sectionTitleTranslations[lang][stableId];
    if (lang !== SOURCE && typeof trans === 'string' && trans.trim()) return trans.trim();
    if (typeof original === 'string' && original.trim()) return original.trim();
    // 没设过标题：源语言用英文默认名（历史行为），其它语言交给内容字典翻。
    const base = DEFAULT_SECTION_LABELS[stableId] || stableId;
    return lang === SOURCE ? base : z(base);
  }
  function resolveLocalizedSummary(content, kind, entity, fallback, locale) {
    const source = fallback == null ? '' : String(fallback);
    const lang = normal(locale || getLocale());
    if (lang === SOURCE || !entity || !entity.localeKey) return source;
    const record = content && content.localizedContent && content.localizedContent[lang] &&
      content.localizedContent[lang][kind] && content.localizedContent[lang][kind][entity.localeKey] &&
      content.localizedContent[lang][kind][entity.localeKey].summary;
    // 只有用户明确审核过的当前译文才允许替换展示文本（不造假）。
    return record && record.status === 'reviewed' && typeof record.reviewed === 'string' && record.reviewed.trim()
      ? record.reviewed.trim() : source;
  }

  /* ————————————————————————— 原地翻译 ————————————————————————— */
  /* 一个节点/属性记两份状态：
   *   orig —— 源语言原文（切回中文时用它还原）
   *   last —— 上一次由我们写下去的值（用来判断"是不是被外部改了"，改了就把 orig 更新成新原文）
   * 这样：切语言 = 按新语言把 orig 重算一遍，天然双向，且外部改内容后不会翻错。 */
  const TEXT_STATE = new WeakMap();
  const ATTR_STATE = new WeakMap();
  const UI_TOUCHED = new WeakSet();

  /* 界面层不翻的容器。
   * ⚠ `select` / `option` 不在这里 —— 它们恰恰是英文模式下最容易漏掉的中文（下拉选项）。
   *   `<option>` 没有显式 value 时，**`select.value` 就是它的文本**，翻了等于把英文写进数据；
   *   所以规则是「只翻带了 value 属性的 option」（数据由 value 承载，文本纯展示），
   *   由下面的 isSkippedEl() 精确判断，而不是整类排除。
   *   （2026-09-23：之前把 select,option 整类排除，于是「作品集导向 / 名称前 / 标题后 /
   *    — 选择已有项目 —」这些下拉选项在英文界面里一直是中文，用户直接看到了。） */
  const SKIP_SEL = 'script,style,textarea,input,code,pre,[contenteditable],[data-locale],.ff-locale-switch,.ff-no-i18n,[data-ff-pin]';
  /* 属性层（title / placeholder / aria-label）**单独一份**跳过表。
   * ⚠⚠ 不能复用 SKIP_SEL！那里面排除了 `input` / `textarea` / `[contenteditable]`，
   *   本意是"别翻用户敲进去的内容"——但 `placeholder` 是**产品文案**，不是用户数据。
   *   复用之后，`isSkippedEl(input, SKIP_SEL)` 恒为真 → **所有输入框的提示语在英文界面里
   *   一直是中文**（2026-09-24 实测：`标签（如 邮箱 / 微信）`、`值（如 xxx@example.com）`、
   *   `留空恢复默认：Selected works` 全都没翻，正是用户说的"还有部分是中文"）。
   *   文本节点那一遍**仍然**用 SKIP_SEL —— 那才是用户内容真正待的地方（textarea 的正文）。
   *   `[data-ff-pin]` 这里也跳过：字段被用户钉住"不跟随语言"，它的提示语跟着一起不动才一致。 */
  const ATTR_SKIP_SEL = 'script,style,code,pre,[data-locale],.ff-locale-switch,.ff-no-i18n,[data-ff-pin]';
  const ATTRS = ['title', 'placeholder', 'aria-label'];

  /* 这个元素该不该被界面字典跳过？ */
  function isSkippedEl(el, skip) {
    if (!el || !el.closest) return false;
    if (el.closest(skip)) return true;
    // 没有显式 value 的 <option>：文本即数据，翻了会把英文写回 content/design。
    const op = el.closest('option');
    if (op && !op.hasAttribute('value')) return true;
    return false;
  }

  function applyTextNode(node, tbl, source) {
    let st = TEXT_STATE.get(node);
    const cur = node.nodeValue;
    if (!st) { st = { orig: cur, last: cur }; }
    else if (cur !== st.last) { st.orig = cur; st.last = cur; }   // 外部重写了 → 以新值为原文
    // 这段文本 UI 字典（中文当 key 那张表）认不认得？认得=界面文案，必须由 UI 层独占，
    // 内容层（整篇翻译表）不可再来一遍，否则空的内容表会把「Expand」翻回「展开」。
    const core = String(st.orig == null ? '' : st.orig);
    const claimed = Object.prototype.hasOwnProperty.call(tbl.exact, core) ||
      !!(tbl.patterns && tbl.patterns.length && tbl.patterns.some(p => { try { return p[0].test(core); } catch (_) { return false; } }));
    if (source) {
      if (cur !== st.orig) { node.nodeValue = st.orig; st.last = st.orig; }
    } else {
      const next = translateWith(st.orig, tbl);
      if (cur !== next) { node.nodeValue = next; st.last = next; }
    }
    TEXT_STATE.set(node, st);
    return claimed;
  }
  function applyAttr(el, attr, tbl, source) {
    const cur = el.getAttribute(attr);
    if (cur == null) return;
    let store = ATTR_STATE.get(el);
    if (!store) { store = {}; ATTR_STATE.set(el, store); }
    let st = store[attr];
    if (!st) { st = { orig: cur, last: cur }; }
    else if (cur !== st.last) { st.orig = cur; st.last = cur; }
    if (source) {
      if (cur !== st.orig) { el.setAttribute(attr, st.orig); st.last = st.orig; }
    } else {
      const next = translateWith(st.orig, tbl);
      if (cur !== next) { el.setAttribute(attr, next); st.last = next; }
    }
    store[attr] = st;
  }

  /* kind='ui'      —— 界面文案：整棵树都看，但跳过用户内容区（opts.skip）与表单控件
   * kind='content' —— 用户内容：只看界面层没碰过的节点，且必须以内容字典里真有这条为准 */
  function pass(root, opts, kind) {
    const base = (root && root.nodeType === 1) ? root : document.body;
    if (!base) return;
    const lang = getLocale();
    const source = lang === SOURCE;
    const isContent = kind === 'content';
    if (isContent && source) { /* 还原也走下面的统一逻辑，不早退 */ }
    const tbl = isContent ? { exact: contentTableFor(lang), patterns: [] } : tableFor(lang);
    const skip = isContent
      ? SKIP_SEL
      : SKIP_SEL + ((opts && opts.skip) ? ',' + opts.skip : '');

    // 属性（title / placeholder / aria-label）永远是产品自己的文案 —— 只受 SKIP_SEL 约束，
    // 不受 opts.skip 影响，否则画布上"悬停说明"会跟着用户内容的排除范围一起被跳掉。
    if (!isContent) {
      const scanAttrs = (el) => {
        if (!el.getAttribute) return;
        if (isSkippedEl(el, ATTR_SKIP_SEL)) return;   // ⚠ 用属性层自己的跳过表，见上面的说明
        ATTRS.forEach(a => applyAttr(el, a, tbl, source));
      };
      scanAttrs(base);
      base.querySelectorAll && base.querySelectorAll('[title],[placeholder],[aria-label]').forEach(scanAttrs);
    }

    const walk = (node) => {
      if (!node) return;
      if (node.nodeType === 3) {
        const parent = node.parentNode;
        if (!parent) return;
        if (isContent) {
          if (UI_TOUCHED.has(node)) return;                 // 界面层已经处理过，别再动
          if (isSkippedEl(parent, SKIP_SEL)) return;
        } else {
          if (isSkippedEl(parent, skip)) return;
        }
        const claimed = applyTextNode(node, tbl, source);
        if (!isContent) {
          // 界面字典没翻到（= 这不是界面文案，多半是用户内容）→ 不能占坑，
          // 留给内容字典那一遍，否则画布上用户内容会一直显示中文。
          if (claimed) UI_TOUCHED.add(node); else UI_TOUCHED.delete(node);
        }
        return;
      }
      if (node.nodeType !== 1) return;
      if (isSkippedEl(node, isContent ? SKIP_SEL : skip)) return;
      let child = node.firstChild;
      while (child) { const nx = child.nextSibling; walk(child); child = nx; }
    };
    walk(base);
  }

  function apply(root) {
    const base = root || document;
    document.documentElement.lang = getLocale();
    base.querySelectorAll && base.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n, el.dataset.i18nFallback || el.textContent); });
    base.querySelectorAll && base.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle, el.title); });
    base.querySelectorAll && base.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.dataset.i18nPlaceholder, el.placeholder); });
    base.querySelectorAll && base.querySelectorAll('[data-locale]').forEach(el => {
      const active = normal(el.dataset.locale) === getLocale();
      el.classList.toggle('on', active);
      el.setAttribute('aria-pressed', String(active));
    });
  }
  // 每个用 autoTranslate 注册过的根，切语言时都要重翻一遍。
  const ROOTS = [];
  function autoTranslate(root, opts) {
    const base = (root && root.nodeType === 1) ? root : document.body;
    if (!base) return null;
    if (ROOTS.some(r => r.root === base)) return null;
    const entry = { root: base, opts: opts || {} };
    ROOTS.push(entry);
    pass(base, entry.opts, 'ui');
    if (entry.opts.content) pass(base, entry.opts, 'content');
    if (typeof MutationObserver !== 'function') return null;
    let timer = null; const dirty = new Set();
    const flush = () => {
      timer = null;
      if (getLocale() === SOURCE && !entry.opts.content) { dirty.clear(); return; }
      const nodes = [...dirty]; dirty.clear();
      nodes.forEach(n => {
        try {
          const target = (n.nodeType === 1) ? n : n.parentNode;
          if (!target) return;
          pass(target, entry.opts, 'ui');
          if (entry.opts.content) pass(target, entry.opts, 'content');
        } catch (_) {}
      });
    };
    const obs = new MutationObserver(muts => {
      for (const m of muts) {
        if (m.type === 'childList') { m.addedNodes && m.addedNodes.forEach(n => dirty.add(n)); if (m.target) dirty.add(m.target); }
        else dirty.add(m.target);
      }
      if (timer) return;
      timer = setTimeout(flush, 30);
    });
    obs.observe(base, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    return obs;
  }
  // 切语言 / 收到内容字典后：把当前 DOM 全部按新语言重算一遍（原地，不重载）。
  function applyAll() {
    try { apply(document); } catch (_) {}
    if (!ROOTS.length) {
      pass(document.body, {}, 'ui');
      return;
    }
    ROOTS.forEach(entry => {
      try {
        pass(entry.root, entry.opts, 'ui');
        if (entry.opts.content) pass(entry.root, entry.opts, 'content');
      } catch (_) {}
    });
  }

  /* ————————————————————————— 切换 ————————————————————————— */
  function setLocale(next, options) {
    // 单语言发行：任何切换请求都被强制回落到 defaultLang（入口本就不显示，这里双保险，
    // 防止来自 postMessage / storage 事件的跨 frame 同步把语言带偏）。
    if (_FF_LANG_MODE === 'single') {
      const d = _FF_DEFAULT_LANG;
      if (_applied !== d) {
        _applied = d;
        try { localStorage.setItem(LOCALE_KEYS[scope()] || LOCALE_KEYS.editor, d); } catch (_) {}
        applyAll();
      }
      return d;
    }
    // 「无语言系统」的版本：切换请求直接忽略（按钮本来也不存在，这里是双保险）。
    if (!capable()) return SOURCE;
    const lang = normal(next);
    const before = _applied || getLocale();
    const mine = scope();
    try {
      localStorage.setItem(LOCALE_KEYS[mine] || LOCALE_KEYS.editor, lang);
      // ★ 单向跟随：在**编辑器**里换语言 → 作品集的展示语言一起改（用户要的）。
      //   反过来**不成立**：作品集页面里换语言只写自己那把键，编辑器的语言设置纹丝不动。
      if (mine === 'editor') localStorage.setItem(LOCALE_KEYS.public, lang);
    } catch (_) {}
    _applied = lang;
    applyAll();
    // 语言真的变了 → 广播，让各面板重画 JS 生成的界面（列表/状态/主题色预览…）。
    // force=1 用于"跨 frame 同步"：外壳把语言写进同一把全局键之后，面板读到的
    // before 已经是新值，但它 DOM 里还是旧语言，所以必须照样走一遍。
    if (lang === before && !(options && options.force)) return lang;
    global.dispatchEvent(new CustomEvent('ff-locale-change', {
      detail: { locale: lang, from: before, scope: scope(), tpl: tpl(), remote: !!(options && options.remote) }
    }));
    // 切到非源语言 → 顺手确认这个模板这个语言是否翻齐；没翻齐就自动翻，不需要用户做任何事。
    // 已经翻齐时只多一次 status 请求（最常见的路径）。iframe 里会因"不是顶层窗口"直接返回，
    // 整篇翻译由外壳统一做，翻完再广播回来。
    if (lang !== SOURCE) autoTranslateContent({ lang });
    return lang;
  }

  /* 语言下拉：一个紧凑的小方块（显示当前语言）+ 展开菜单。
   * 以前是一排「中文 | English」按钮，加日韩之后会横向铺满顶栏，所以改成下拉。 */
  let openMenu = null;
  const SWITCHER_PAINT = new WeakMap();
  function closeMenu() { if (openMenu) { openMenu.hidden = true; openMenu = null; } }
  // 首次切到某语言要整篇翻译，用户需要知道"要等一会儿"（原话：「我希望那边会有说明，
  //   就是第一次切换的时候可能会有要翻译，就是说需要配置一段时间，需要等待」）。
  // ⚠ 这段文案不能用 data-i18n（键值层只有中/英），也不能靠 DOM 扫描 ——
  //   `.ff-locale-switch` 整个子树在 SKIP_SEL 里。所以走 z()（中文当 key 的字典层，含日韩），
  //   并且在 paint() 里**每次重画都重设一遍**，换语言时它才会跟着变。
  const TIP_ZH = '首次切换到某个语言时，会自动翻译这个模板里的内容，可能需要等一会儿；之后就随切随显示。';
  // 找不到翻译服务时（"有语言系统"但此刻不可用）如实说，别让用户以为点坏了。
  const TIP_NOSVC_ZH = '当前没有可用的翻译服务：已翻译过的内容照常显示，新内容会先按原文显示。';

  function paintSwitcher(base, opts) {
    const cur = getLocale();
    // 面板每次重画都会重新 mount（编辑器 render() 就是整块 innerHTML 重建），
    // 而 target 是同一个宿主元素 —— 旧的 paint 监听器必须先摘掉，否则越积越多。
    const prev = SWITCHER_PAINT.get(base);
    if (prev) { try { global.removeEventListener('ff-locale-change', prev); } catch (_) {} }
    base.hidden = false;
    base.className = 'ff-locale-switch';
    base.innerHTML =
      '<button type="button" class="ff-locale-current" aria-haspopup="listbox" aria-expanded="false">' +
        '<span class="ff-locale-cur">' + (opts.label === 'name' ? langName(cur) : langShort(cur)) + '</span>' +
        '<span class="ff-locale-caret" aria-hidden="true"></span>' +
      '</button>' +
      '<div class="ff-locale-menu" role="listbox" hidden>' +
        LANGS.map(l => '<button type="button" role="option" data-locale="' + l.id + '"' +
          (l.id === cur ? ' class="on" aria-selected="true"' : '') + '>' +
          '<span class="ff-locale-name">' + l.name + '</span>' +
          '<span class="ff-locale-tick" aria-hidden="true">✓</span>' +
        '</button>').join('') +
        '<p class="ff-locale-tip"></p>' +
      '</div>';
    const btn = base.querySelector('.ff-locale-current');
    const menu = base.querySelector('.ff-locale-menu');
    const label = base.querySelector('.ff-locale-cur');
    const tip = base.querySelector('.ff-locale-tip');
    const paint = () => {
      const lang = getLocale();
      label.textContent = opts.label === 'name' ? langName(lang) : langShort(lang);
      base.title = t('label.language', '语言') + ' · ' + langName(lang);
      btn.setAttribute('aria-label', base.title);
      if (tip) tip.textContent = z(_svcOk === false ? TIP_NOSVC_ZH : TIP_ZH);
      menu.querySelectorAll('[data-locale]').forEach(b => {
        const on = b.dataset.locale === lang;
        b.classList.toggle('on', on);
        b.setAttribute('aria-selected', String(on));
      });
    };
    paint();
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const willOpen = menu.hidden;
      closeMenu();
      if (willOpen) { menu.hidden = false; openMenu = menu; base.classList.add('open'); btn.setAttribute('aria-expanded', 'true'); }
      else { base.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); }
      if (opts.afterToggle) setTimeout(opts.afterToggle, 0);
    });
    menu.addEventListener('click', e => {
      const b = e.target.closest && e.target.closest('[data-locale]');
      if (!b) return;
      e.stopPropagation();
      setLocale(b.dataset.locale, { force: true });
      closeMenu();
      base.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
      paint();
      if (opts.afterToggle) setTimeout(opts.afterToggle, 0);
    });
    // 不用"每个切换器各挂一个监听"：面板重画时切换器元素是新建的，旧元素上的监听
    // 会把已脱离 DOM 的节点一直吊住（内存泄漏）。改成元素自带 paint 函数 + 一条全局监听。
    base.__ffPaint = paint;
    return { repaint: paint };
  }
  // 收起：按 NO_SYS_UI 决定"整个不出现"还是"留一个点不动的 中"。
  function teardownSwitcher(base) {
    const prev = SWITCHER_PAINT.get(base);
    if (prev) { try { global.removeEventListener('ff-locale-change', prev); } catch (_) {} SWITCHER_PAINT.delete(base); }
    try { base.__ffPaint = null; } catch (_) {}
    if (NO_SYS_UI === 'locked') {
      base.hidden = false;
      base.className = 'ff-locale-switch is-locked';
      base.innerHTML = '<button type="button" class="ff-locale-current" disabled aria-disabled="true" title="' +
        t('label.language', '语言') + '"><span class="ff-locale-cur">中</span></button>';
      return;
    }
    base.className = '';
    base.innerHTML = '';
    base.hidden = true;      // 宿主元素本身也别占位（否则顶栏会空出一块）
  }
  /* 探测本机有没有可用的翻译服务。判据只有一个：`state === 'ready'`。
   *   · provider = 'none' / code = 'translation_provider_unconfigured' → 没装 / 没配 Ollama
   *   · code = 'translation_provider_unavailable' → Ollama 没在跑
   *   · code = 'translation_model_missing'        → 模型没下载
   *   以上都算"这个包没有语言系统"，MODE='auto' 时就把入口收起来。
   * ⚠ 只探一次；服务端那次探测本身有 3s 超时 —— 所以这里绝不 await 它去拖首屏，
   *   探测结果回来才可能改变界面（先乐观显示，再收敛）。 */
  let _svcOk = null;             // 翻译服务此刻可用吗（null = 还没探出来；决定菜单里那句提示怎么写）
  let _capProbing = false;
  function repaintSwitchers() {
    _mounts.forEach(m => { try { if (m.target.__ffPaint) m.target.__ffPaint(); } catch (_) {} });
  }
  function setCapable(v) {
    v = !!v;
    const before = capable();
    _capable = v;
    try { localStorage.setItem(CAP_KEY, v ? '1' : '0'); } catch (_) {}
    if (before === v) { repaintSwitchers(); return v; }
    if (v) _mounts.forEach(m => { try { paintSwitcher(m.target, m.options || {}); } catch (_) {} });
    else _mounts.forEach(m => { try { teardownSwitcher(m.target); } catch (_) {} });
    // 能力变了 → 语言也可能跟着变（有→无：一律回到中文；无→有：恢复到上次选的语言）→ 整屏重画
    const now = getLocale();
    try { document.documentElement.lang = now; } catch (_) {}
    if (_applied !== now) { _applied = now; try { applyAll(); } catch (_) {} }
    try { global.dispatchEvent(new CustomEvent('ff-i18n-capability', { detail: { capable: v, mode: MODE } })); } catch (_) {}
    return v;
  }
  function probeCapability() {
    if (MODE === 'off') return Promise.resolve(false);
    // 发布出去的静态页：界面字典与内容译文已内联，本地没有 /api —— 直接算"有"。
    if (global.__FF_STATIC_BUILD__) {
      _svcOk = true;
      if (MODE === 'auto') setCapable(true);
      return Promise.resolve(capable());
    }
    if (_capProbing) return Promise.resolve(capable());
    _capProbing = true;
    return Promise.resolve()
      .then(() => fetch('/api/translation/status', { cache: 'no-store' }))
      .then(r => r.json())
      .then(j => {
        const ok = !!(j && j.ok && j.state === 'ready');
        _svcOk = ok;
        if (MODE === 'auto') setCapable(ok); else repaintSwitchers();
        return capable();
      })
      // 网络错误不动结论：宁可保持现状，也不要把"服务没起来"误判成"这个包没有语言系统"。
      .catch(() => capable())
      .then(v => { _capProbing = false; return v; });
  }

  /* 语言入口：唯一挂载点。所有面板（外壳顶栏 / 作品集 / 排版编辑 / 文本编辑）都从这里进出，
   * 所以"有 / 无语言系统"只要在这里判一次就全站一致 —— 不会出现某个面板还有按钮的情况。 */
  function mountSwitcher(target, options) {
    if (!target) return;
    const opts = options || {};
    // 单语言发行：彻底不渲染任何语言切换入口（编辑器顶部 / 作品集页面 / 排版编辑三处共用此组件）。
    if (_FF_LANG_MODE === 'single') {
      try { target.hidden = true; target.innerHTML = ''; target.className = ''; } catch (_) {}
      return;
    }
    // 记住宿主：能力探测回来（有→无 / 无→有）时要能重挂或收起。顺带清掉已脱离 DOM 的旧宿主，
    // 否则编辑器每次 render() 重建 DOM，这张表会越攒越长。
    for (let i = _mounts.length - 1; i >= 0; i--) if (!_mounts[i].target.isConnected) _mounts.splice(i, 1);
    const hit = _mounts.filter(m => m.target === target)[0];
    if (hit) hit.options = opts; else _mounts.push({ target: target, options: opts });
    if (!capable()) { teardownSwitcher(target); probeCapability(); return; }
    const r = paintSwitcher(target, opts);
    probeCapability();       // 首次挂载顺手探一次（一个页面只探一次）
    return r;
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('click', closeMenu);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
    // 唯一的一条"语言变了 → 所有切换器重画标签"监听。
    global.addEventListener('ff-locale-change', () => {
      document.querySelectorAll('.ff-locale-switch').forEach(el => {
        try { if (el.__ffPaint) el.__ffPaint(); } catch (_) {}
      });
    });
  }

  // 面板 ↔ 外壳：外壳往 iframe 里 postMessage 当前语言。
  // force=1：外壳写的是同一把全局键，面板读到的"旧值"其实已经是新值，
  // 但面板自己的 DOM 还是旧语言，必须强制重翻 + 重画。
  global.addEventListener('message', event => {
    const m = event && event.data;
    if (m && m.type === 'ff-locale' && m.locale) setLocale(m.locale, { remote: true, force: true });
  });

  // 面板 ↔ 外壳，反方向：在 iframe 面板里切语言时，外壳顶栏也得跟着变
  // （用户原话：「现在正在英文模式，但是这一个最上方的编辑器，总编辑器，它是中文」）。
  // ⚠ 只认**自己这个 scope 的那把键**：
  //   · 编辑器窗口只跟 `folioframe.locale.editor` 走 —— 作品集里换语言不影响它；
  //   · 作品集窗口只跟 `folioframe.locale.public` 走。
  // 另外必须用「本窗口已画过的语言」(_applied) 判重，不能用 getLocale()：localStorage 同源共享，
  // 这里读到的永远是新值，会判成"没变"直接跳过；而不判重又会 A 写→B 收到→B 写→A 收到 无限循环。
  global.addEventListener('storage', event => {
    if (!event) return;
    if (event.key !== myKey()) return;
    const next = normal(event.newValue || '');
    if (!next || next === (_applied || getLocale())) return;
    setLocale(next, { remote: true, force: true });
  });

  /* ————————————————— 自动整篇翻译（不依赖人工预先翻好）———————————————————
   * 用户原话：「我更希望是本身这个系统搭建完成了，然后根据 Ollama 或者是什么插件什么模型
   *   自动识别的……我希望的是使用者他不需要任何的编程操作或者是沟通操作，他就可以在
   *   FolioFold 里面根据系统自带的这个语言切换而将这个简历切换为别的语言。」
   *
   * 所以这件事**不能只挂在画布上**。用户切语言可能发生在：Studio 外壳顶栏、文本编辑面板
   * 右侧、排版编辑面板、或者直接打开作品集 —— 无论哪个入口切，整篇翻译都得跟上。
   * i18n.js 是四个入口都加载的唯一公共文件，逻辑放这里，谁切都算数。
   *
   * ⚠ 只在**顶层窗口**真正干活。Studio 里同时存在「外壳 + 3 个 iframe」，切一次语言四个
   *   window 都会跑到这里 —— 一起打本地 Ollama 就是同一份活干四遍，模型直接卡死。
   *   iframe 只等结果：顶层翻完会 postMessage 通知，app-v3.js 收到后重取字典原地重刷。
   *   （单独打开 /portfolio/ 时它自己就是顶层窗口，照常干活。）
   * ⚠ 每个「模板 + 语言」在一个页面生命周期里只自动试一次，避免来回切语言反复打模型；
   *   失败会把标记清回去（模型还在加载、服务刚起来都可能失败，不能一失败就永久放弃）。 */
  // （Phase 3 后已无 _autoTried：切换只拉「已审核」表，本地 JSON 请求很便宜，无需记「试过」状态）
  const _autoInflight = Object.create(null);     // 'tpl|lang' -> Promise（同一页面内并发去重）
  function autoHint(message, ttlMs){
    try {
      if (!document.body) return;
      let el = document.getElementById('ff-auto-i18n-hint');
      if (!el) {
        el = document.createElement('div');
        el.id = 'ff-auto-i18n-hint';
        el.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483000;max-width:340px;'
          + 'background:#161616;color:#fff;font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans SC",sans-serif;'
          + 'padding:10px 14px;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.28);opacity:0;transition:opacity .18s';
        document.body.appendChild(el);
      }
      el.textContent = z(message);       // 系统提示跟随界面语言
      el.style.opacity = '1';
      clearTimeout(el.__ffTtl);
      if (ttlMs) el.__ffTtl = setTimeout(() => { el.style.opacity = '0'; }, ttlMs);
    } catch (_) {}
  }
  function isTopWindow(){ try { return !(global.top && global.top !== global); } catch (_) { return false; } }
  // 翻完通知「所有需要重刷字典的地方」：本窗口的事件 + 一层 iframe（外壳 → 三个面板）。
  // iframe 之间从不互相转播，避免环形广播。
  function broadcastContentUpdated(lang, count){
    try { global.dispatchEvent(new CustomEvent('ff-i18n-updated', { detail: { lang, count, remote: false } })); } catch (_) {}
    try {
      const fr = global.frames || [];
      for (let i = 0; i < fr.length; i++) {
        try { fr[i].postMessage({ type: 'ff-i18n-updated', lang, count }, '*'); } catch (_) {}
      }
    } catch (_) {}
  }
  async function autoTranslateContent(options){
    const opts = options || {};
    const lang = normal(opts.lang || getLocale());
    if (!lang || lang === SOURCE) return { ok: false, skipped: 'source' };
    // 发布出去的静态页（__FF_STATIC_BUILD__）：界面字典与内容译文表已经**整体内联**，
    // 本地也没有 /api/* 翻译接口 —— 静静跳过即可，绝不能弹「自动翻译没成功」的提示。
    if (global.__FF_STATIC_BUILD__) return { ok: true, skipped: 'static' };
    const tplId = opts.tpl || tpl();
    const key = tplId + '|' + lang;
    if (_autoInflight[key]) return _autoInflight[key];
    if (!isTopWindow()) {
      // 在 iframe 面板里切的语言：iframe 不自己拉字典，把请求交回外壳统一处理
      //（外壳拉完会广播 ff-i18n-updated，各面板重取字典原地重刷）。
      try {
        if (global.parent && global.parent !== global) global.parent.postMessage({ type: 'ff-auto-translate', lang, tpl: tplId }, '*');
      } catch (_) {}
      return { ok: false, skipped: 'delegated' };
    }
    // ⚠ Phase 3（2026-09-26）语义变更：语言切换**只应用「已审核」的内容译文表**，
    //   绝不在切换/观看路径上现场调机翻（Ollama）—— 那正是「Portfolio 一直卡在
    //   翻译中」的根因，也违背「观看者不依赖 Ollama」的发布原则。
    //   生成与审核都是创作者端显式动作：文本编辑 → 设置 → 语言设置。
    //   URL 带 ?i18ndraft=1 时（创作端「预览未审核译文」入口）才拿草稿表。
    const q = '?tpl=' + encodeURIComponent(tplId);
    const draftPreview = /[?&]i18ndraft=1/.test(String(global.location && global.location.search || ''));
    const run = (async () => {
      let j = null;
      try {
        j = await fetch('/api/i18n/content' + q + '&lang=' + encodeURIComponent(lang) + (draftPreview ? '&draft=1' : ''), { cache: 'no-store' }).then(x => x.json());
      } catch (_) { return { ok: false, skipped: 'offline' }; }
      if (!j || !j.ok) return { ok: false, skipped: 'status' };
      if (j.reviewedOnly && !j.count) {
        // 没有已审核译文：如实提示一次，按原文显示。UI 本地化照常，不打断切换。
        // 提示走 z() + patterns（带语言名变量），非中文界面下是外语，不算「汉字残留」。
        autoHint(z('「' + langName(lang) + '」的翻译还没有生成，或者还没有确认，暂时显示原文。可在 文本编辑 → 设置 → 语言设置 里生成或确认翻译。'), 6000);
        return { ok: true, skipped: 'not-reviewed' };
      }
      setContentDict(lang, j.map || {});
      broadcastContentUpdated(lang, j.count);
      return { ok: true, count: j.count };
    })();
    _autoInflight[key] = run;
    try { return await run; } finally { delete _autoInflight[key]; }
  }

  global.FF_I18N = {
    UI, DEFAULT_SECTION_LABELS, LANGS,
    getLocale, setLocale, t, z, zc, apply, applyAll, mountSwitcher,
    resolveSectionLabel, resolveLocalizedSummary, templateId: tpl,
    langName, langShort, normal,
    translateDom: (root, opts) => pass((root && root.nodeType === 1) ? root : document.body, opts || {}, 'ui'),
    translateContentDom: (root, opts) => pass((root && root.nodeType === 1) ? root : document.body, opts || {}, 'content'),
    autoTranslate, setContentDict, contentDict: contentTableFor,
    autoTranslateContent, autoHint,
    hasTranslation,
    // 「有 / 无语言系统」这套开关的状态，供各面板自己决定要不要渲染语言相关 UI
    capable: capable, mode: MODE, noSysUi: NO_SYS_UI, probeCapability: probeCapability,
    LANGS_ALL: LANGS.slice()
  };

  // 页面（作品集 / 文本编辑 / 排版编辑，无论哪种入口）加载时，按当前 locale 先把
  // <html lang> 与初始界面文案翻一遍。否则纯刷新打开、没触发过 setLocale / setContentDict
  // 的页面，<html lang> 会一直停在源语言（zh-CN），而界面内容其实已经是目标语言了
  // —— 文本编辑里就出现过「内容已是英文、但 <html lang> 仍是 zh-CN」的不一致。
  if (typeof document !== 'undefined') {
    const initApply = () => {
      if (!_applied) _applied = getLocale();     // 记下"本窗口首次画 DOM 时用的语言"，供 storage 判重
      try { applyAll(); } catch (_) {}
      // 先按缓存决定"有没有语言系统"，再后台探一次收敛（探到了会自己 setCapable → 重画）。
      // ⚠ 顺序不能反：先 applyAll 再探，页面绝不会因为等接口而白屏。
      try { probeCapability(); } catch (_) {}
      // 用户带着英文的 localStorage 直接刷新页面（没点过切换器）也要触发一次对账：
      // 否则"上次翻了半截就关掉"的模板会一直停在中文，用户只会觉得"翻译又坏了"。
      try { if (getLocale() !== SOURCE) autoTranslateContent({ lang: getLocale() }); } catch (_) {}
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initApply);
    else initApply();
  }
})(window);
