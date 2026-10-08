/* FolioFold —— 统一工作台
 *
 * 一个链接里切换三个板块：作品集预览 / 文本编辑 / 排版编辑。
 * 三个面板都读写同一份草稿，所以外壳做三件事：
 *   1. 懒加载面板（首次切到才启动，避免三个编辑器同时开机）
 *   2. 同步 —— 轮询 /api/version，谁保存了就把其余面板刷新成最新，保证三个板块内容永远一致
 *   3. 多模板 —— 顶栏可切换 / 新建 / 重命名 / 删除模板。每个模板是一套【完全独立】的数据：
 *      地址栏的 ?tpl=<id> 是唯一事实来源，它会一路带到三个面板的 URL 上，
 *      面板内再用 fetch 拦截器自动附加到所有 /api 请求（见各面板 index.html）。
 *      'main' = 模板一 = 升级前就存在的那套数据（原文件不动）。
 */
(function () {
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];

  // 中文当 key 的字典层（i18n.js 的 z）。toast / confirm / prompt 里那种"拼出来才知道"
  // 的文案靠它翻；由 innerHTML 现画出来的界面文案由 autoTranslate 观察器自动接住。
  const I18N = (typeof window === 'object' && window.FF_I18N) ? window.FF_I18N : null;
  const z = s => I18N ? I18N.z(s) : s;

  const PANEL_PATHS = { portfolio: '/portfolio/', editor: '/editor/', visual: '/visual-editor/' };
  const TABS = ['portfolio', 'editor', 'visual'];
  const LEGACY = 'main';

  const qs0 = new URLSearchParams(location.search);
  // 地址栏是唯一事实来源：可以直接收藏 / 分享「某个模板」的入口
  let tpl = qs0.get('tpl') || LEGACY;
  const requestedTab = qs0.get('tab');
  let active = TABS.includes(requestedTab) ? requestedTab : 'portfolio';

  let templates = [];           // [{id,name,legacy,createdAt}]
  let sig = null;               // 当前数据指纹
  const loaded = {};            // panel -> 载入时的数据指纹
  const booting = {};
  let settleTimer = null;

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // 面板地址：同一个 studio=1，外加当前模板
  const panelUrl = panel => PANEL_PATHS[panel] + '?studio=1&tpl=' + encodeURIComponent(tpl);
  const tplQuery = () => (tpl === LEGACY ? '' : '&tpl=' + encodeURIComponent(tpl));
  const tplName = id => { const t = templates.find(x => x.id === id); return t ? t.name : id; };
  // 模板名是程序自动起的（模板一 / 模板2），不是用户写的作品内容 → 界面里按语言显示。
  const tplLabel = id => z(tplName(id));

  // Phase 1：语言是工作台 UI 状态，不写 Draft；2026-09-22 起改成**全局一把键**
  // （i18n.js 的 folioframe.locale），三个面板 + 外壳 + 画布共用，不再各存各的。
  function applyStudioLocale(){
    const I=window.FF_I18N; if(!I)return;
    // 三个导航标签的文字由 index.html 的 data-i18n 负责（这样能保住前面的 ① ② ③ 序号，
    // 以前整块 textContent 覆盖会把序号吃掉，中英切换时序号忽有忽无）。
    const text={
      '#st-tpl-new':'action.new','#st-tpl-import':'action.import','#st-tpl-rename':'action.rename','#st-tpl-del':'action.delete',
      '#st-reload':'action.refresh','#st-publish-options':'action.publish'
    };
    Object.keys(text).forEach(sel=>{const el=$(sel);if(el)el.textContent=I.t(text[sel]);});
    // 三个面板 iframe 的 title（给读屏软件的"这个框叫什么"，视觉上不显示）也跟着语言走，
    // 不然英文界面里辅助技术读出来的还是中文。键复用导航那三条。
    const frameTitle={'portfolio':'nav.portfolio','editor':'nav.editor','visual':'nav.visual'};
    document.querySelectorAll('.st-frame').forEach(f=>{const k=frameTitle[f.dataset.panel];if(k)f.title=I.t(k);});
    const status=$('#st-status'); if(status && (!status.textContent || /读取中|Loading/.test(status.textContent)))status.textContent=I.t('status.loading');
    // 把语言推给面板：它们收到后**原地重翻**（i18n.js 的 applyAll），不会重载页面。
    // ⚠ 2026-09-23：**不推给作品集面板**。作品集是「展示语言」，和编辑器的「界面语言」是
    //   两把独立的键（见 i18n.js 的 LOCALE_KEYS）。顶栏换语言时 setLocale 已经顺手写了
    //   作品集那把键，作品集面板会通过 storage 事件自己跟上；但如果这里每次都硬推，
    //   用户手动把作品集设成英文后再刷新 Studio，就又会被顶栏的中文覆盖回去 ——
    //   「中文编辑器 + 英文简历」直接失效（用户明确要求允许两者不一致）。
    // ⚠ 2026-10-03：以前每次 iframe load 都无条件推一遍语言。而「保存 → 重载另外两个面板」
    //   会让这条推送落到**正在打字的编辑器**上 → i18n setLocale → ff-locale-change →
    //   编辑器整页 render() → 输入框被销毁、拼音被强制上屏。
    //   面板自己是新文档时会从 localStorage 读到同一把语言键，所以语言没变就别推。
    const loc = I.getLocale();
    document.querySelectorAll('.st-frame').forEach(f=>{
      if (f.dataset.panel === 'portfolio') return;
      if (f.dataset.ffLocalePushed === loc) return;
      try{f.contentWindow.postMessage({type:'ff-locale',locale:loc},'*');f.dataset.ffLocalePushed=loc;}catch(_){}
    });
  }
  function mountStudioLocale(){
    const holder=$('#st-locale'),I=window.FF_I18N;if(!holder||!I)return;
    I.mountSwitcher(holder,{compact:false}); applyStudioLocale();
    // 语言一变：重画外壳自己的文案 + 把新语言推给面板。
    // （以前是"监听切换器容器的 click + setTimeout"，换了下拉控件之后那种写法很脆。）
    window.addEventListener('ff-locale-change', () => applyStudioLocale());
    // 面板里切语言（文本编辑 → 设置 → 语言设置）时，面板不能自己打本地模型：
    // 外壳 + 3 个 iframe 一起打会把 Ollama 压死。面板 postMessage 上来，由外壳统一翻，
    // 翻完 i18n.js 会广播 ff-i18n-updated，各面板重取字典原地重刷。
    // 模板 id 用外壳的（地址栏是唯一事实来源），不信 iframe 传上来的值。
    window.addEventListener('message', e => {
      const m = e && e.data;
      if (!m || m.type !== 'ff-auto-translate') return;
      try { const I2=window.FF_I18N; if (I2 && I2.autoTranslateContent) I2.autoTranslateContent({ lang: m.lang, tpl }); } catch (_) {}
    });
  }

  /* 顶栏跟随当前模板的主题。
   * 用户原话：「最上面那一栏……做成白底，或者跟随我选的这个系统样式，比主题样式稍微深一点点，
   * 要不然感觉是两个系统非常割裂。」—— 外壳以前写死一套米色 --st-*，作品集用主题色，
   * 两套并排就是割裂感。这里把 --st-* 直接映射到当前主题调色板：
   *   顶栏底 = 主题卡片色（白底）    分组容器 = 主题的 soft（比主题底色再深一档）
   * 主题来自 design.json（模板级），跟作品集/排版编辑看到的是同一份。 */
  async function applyStudioTheme(){
    try {
      const THEMES=(window.THEMES||{});
      const d=await fetch('/api/design?tpl='+encodeURIComponent(tpl),{cache:'no-store'}).then(r=>r.json());
      const id=(d&&d.theme&&d.theme.preset)||'light-01';
      const th=THEMES[id]||THEMES['light-01'];
      if(!th)return;
      const s=document.documentElement.style;
      s.setProperty('--st-paper',th.paper);
      s.setProperty('--st-card',th.card||th.surface||'#fff');
      s.setProperty('--st-soft',th.soft);
      s.setProperty('--st-line',th.line);
      s.setProperty('--st-ink',th.ink);
      s.setProperty('--st-muted',th.muted);
      s.setProperty('--st-accent',th.accent);
      document.documentElement.setAttribute('data-st-theme',th.mode||'light');
    } catch(_){}
  }

  const toast = msg => {
    const t = $('#st-toast');
    if (!t) return;
    t.textContent = z(msg);
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 2400);
  };

  const frameOf = panel => document.querySelector(`.st-frame[data-panel="${panel}"]`);

  function writeUrl() {
    try {
      const url = new URL(location.href);
      if (active === 'portfolio') url.searchParams.delete('tab'); else url.searchParams.set('tab', active);
      if (tpl === LEGACY) url.searchParams.delete('tpl'); else url.searchParams.set('tpl', tpl);
      history.replaceState(null, '', url.pathname + url.search);
    } catch (_) {}
  }

  function ensureLoaded(panel) {
    const f = frameOf(panel);
    if (!f || booting[panel]) return;
    if (!f.getAttribute('src')) {
      booting[panel] = true;
      f.addEventListener('load', () => { booting[panel] = false; loaded[panel] = sig; applyStudioLocale(); }, { once: true });
      f.onerror = () => { booting[panel] = false; };
      f.src = panelUrl(panel) + '&t=' + Date.now();
    }
  }

  function reload(panel, opts) {
    const f = frameOf(panel);
    if (!f) return;
    if (!f.getAttribute('src')) { ensureLoaded(panel); return; }
    booting[panel] = true;
    f.addEventListener('load', () => { booting[panel] = false; loaded[panel] = sig; applyStudioLocale(); }, { once: true });
    // 统一用 t= 破坏缓存，确保拿到最新草稿
    f.src = panelUrl(panel) + '&t=' + Date.now();
    if (opts && opts.toast) toast('已刷新');
  }

  // 刷新「非当前」面板：但用户正在当前面板里打字时不要刷新 ——
  // 2026-10-03：作品集/排版两个面板都很重（视频 + 整块画布），每次自动保存后连带重载
  // 会把主线程拖住，编辑器 iframe 跟着卡，拼音输入直接被打断。判断依据：焦点在不在
  // 当前面板的 iframe 里（焦点在 iframe 内时，父文档的 activeElement 就是这个 iframe）。
  function scheduleSiblingReload(delay) {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      const f = frameOf(active);
      if (f && document.activeElement === f) { scheduleSiblingReload(2500); return; }
      TABS.forEach(p => {
        if (p === active) return;
        if (!frameOf(p).getAttribute('src')) return;
        reload(p);
      });
    }, delay);
  }

  function activate(panel, opts) {
    if (!PANEL_PATHS[panel]) return;
    active = panel;
    $$('.st-tab').forEach(b => b.classList.toggle('on', b.dataset.tab === panel));
    $$('.st-pane').forEach(p => p.classList.toggle('on', p.dataset.pane === panel));
    const f = frameOf(panel);
    if (!f.getAttribute('src')) { ensureLoaded(panel); writeUrl(); return; }
    // 切回来时如果数据在别处动过，先刷新再显示，避免看到旧内容
    if (sig && loaded[panel] !== sig && !booting[panel]) reload(panel);
    try { f.focus(); } catch (_) {}
    if (opts && opts.toast) toast(opts.toast);
    writeUrl();
  }

  async function fetchVersion() {
    try {
      const v = await fetch('/api/version?tpl=' + encodeURIComponent(tpl), { cache: 'no-store' }).then(r => r.json());
      return [v.content, v.design, v.published, v.designPublished].join('|');
    } catch (_) { return null; }
  }

  async function poll() {
    const next = await fetchVersion();
    if (!next) return;
    if (sig === null) { sig = next; return; }
    if (next === sig) return;
    sig = next;
    // 数据变了：当前面板自己就是来源（它刚保存完），不刷新它；其余面板等"手停下来"再刷新，
    // 避免打字过程中反复重载隐藏面板。
    loaded[active] = sig;
    applyStudioTheme();                 // 可能改的是主题，顶栏配色跟着走
    scheduleSiblingReload(1100);
    refreshStatus();
  }

  async function refreshStatus() {
    const el = $('#st-status');
    if (!el) return;
    try {
      const s = await fetch('/api/publish/status?tpl=' + encodeURIComponent(tpl), { cache: 'no-store' }).then(r => r.json());
      // 顶栏改成单行后空间有限：状态只留结论，完整说明放 title（悬停可见）。
      // 注意区分两件事：排版类改动（间距/图片尺寸/媒体位置）保存即生效、也会自动同步到最新版本；
      // 只有「内容」还没更新到最新版本时才需要用户主动点一下。
      const tag = '【' + tplLabel(tpl) + '】';
      // ⚠ 状态文案必须**按整句**交给 z() 翻：`<b>` 里面的字和后面的说明是两个独立文本节点，
      // 字典是整串精确匹配，把半句单独丢进去是永远查不到的（英文界面上就会留下中文）。
      // 所以这里把整句拼好再用 z() 翻、再 esc() 塞回去。
      if (s && s.contentDirty) {
        stDeployedAt = 0; stDeployedProvider = null;
        if (PUBUI.phase === 'ok') PUBUI.phase = 'idle';   // 又有未发布改动 → 绿色「✓ 已更新」回退成常规按钮
        el.innerHTML = esc(z(tag)) + '<b>' + esc(z('内容待更新')) + '</b>';
        // ⚠ 不要再把接口返回的 s.detail 拼进来：它是服务端写死的中文
        //   （'内容（文字/项目/章节） 有改动'），拼到英文句子里就是中英混排。
        //   这里改成按 contentDirty / designDirty 二选一整句，整句查表。
        el.title = z(s.designDirty
          ? '内容（文字/项目/章节）与排版（布局/主题）都有改动还未更新到最新版本。排版调整（间距/图片尺寸）已自动生效，不需要再点更新。'
          : '内容（文字/项目/章节）有改动还未更新到最新版本。排版调整（间距/图片尺寸）已自动生效，不需要再点更新。');
      } else if (s && s.dirty) {
        stDeployedAt = 0; stDeployedProvider = null;
        if (PUBUI.phase === 'ok') PUBUI.phase = 'idle';
        el.innerHTML = esc(z(tag)) + '<b>' + esc(z('排版待更新')) + '</b>';
        el.title = z('排版（布局/主题）有改动还未更新到最新版本。');
      } else {
        el.textContent = tag + z('已同步');
        el.title = z('当前草稿已与最新版本一致');
      }
    } catch (_) { el.textContent = ''; }
  }

  // ———————————— 模板管理 ————————————

  async function loadTemplates() {
    try {
      const r = await fetch('/api/templates', { cache: 'no-store' }).then(x => x.json());
      templates = (Array.isArray(r.items) && r.items.length) ? r.items : [{ id: LEGACY, name: '模板一', legacy: true }];
    } catch (_) {
      templates = [{ id: LEGACY, name: '模板一', legacy: true }];
    }
    // 地址里的模板已被删掉（或在别处删了）→ 回到模板一
    if (!templates.some(t => t.id === tpl)) tpl = LEGACY;
    window.__stTplList = templates;   // 供「改发布内容」弹窗列出可选模板
    renderTplSelect();
    mountStudioLocale();
  }

  function renderTplSelect() {
    const sel = $('#st-tpl');
    if (sel) {
      sel.innerHTML = templates.map(t =>
        `<option value="${esc(t.id)}"${t.id === tpl ? ' selected' : ''}>${esc(z(t.name))}</option>`).join('');
    }
    const cur = templates.find(t => t.id === tpl);
    const del = $('#st-tpl-del');
    if (del) del.disabled = !!(cur && cur.legacy);
    renderTplLinks();
  }

  function renderTplLinks() {
    const q = tplQuery();
    const set = (id, href) => { const el = document.getElementById(id); if (el) el.setAttribute('href', href); };
    set('st-open-published', '/portfolio/?mode=published' + q);
    set('st-dlg-published', '/portfolio/?mode=published' + q);
    set('st-dlg-print', '/portfolio/?mode=published&print=1' + q);
  }

  // 清空三个面板 → 让它们按新的 tpl 惰性重载
  function resetPanels() {
    sig = null;
    TABS.forEach(p => {
      const f = frameOf(p);
      if (!f) return;
      loaded[p] = null; booting[p] = false;
      f.removeAttribute('src');
    });
    ensureLoaded(active);
  }

  function applyTemplate(id, opts) {
    tpl = id;
    renderTplSelect();
    applyStudioTheme();          // 换模板 = 换主题：顶栏配色立刻跟上（不再停留在写死的米色）
    writeUrl();
    resetPanels();
    refreshStatus();
    if (opts && opts.toast) toast(opts.toast);
  }

  function switchTemplate(id) {
    if (id === tpl) return;
    applyTemplate(id, { toast: '已切换到「' + tplName(id) + '」' });
  }

  async function post(url, body) {
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(x => x.json());
    if (r && r.error) throw Error(r.error);
    return r;
  }

  // ———————————— 顶栏按钮 ————————————
  $('#st-tabs').addEventListener('click', e => {
    const b = e.target.closest('.st-tab');
    if (b) activate(b.dataset.tab);
  });
  $('#st-reload').onclick = () => reload(active, { toast: true });
  $('#st-publish-options').onclick = () => {
    const dialog = $('#st-publish-dialog');
    if (dialog && typeof dialog.showModal === 'function') dialog.showModal();
  };
  $('#st-publish-close').onclick = () => $('#st-publish-dialog')?.close();
  $('#st-publish').onclick = async () => {
    const btn = $('#st-publish');
    btn.disabled = true; btn.textContent = '更新中…';
    try {
      const r = await fetch('/api/publish?tpl=' + encodeURIComponent(tpl), { method: 'POST' }).then(x => x.json());
      if (r && r.error) throw Error(r.error);
      sig = await fetchVersion();
      TABS.forEach(p => { loaded[p] = null; });
      reload(active);
      toast('「' + tplName(tpl) + '」已更新到最新版本');
      refreshStatus();
    } catch (e) {
      toast('更新失败：' + e.message);
    } finally {
      btn.disabled = false; btn.textContent = '更新到最新版本';
    }
  };

  // —— 模板：切换 / 新建 / 重命名 / 删除 ——
  $('#st-tpl').addEventListener('change', e => switchTemplate(e.target.value));

  $('#st-tpl-new').onclick = async () => {
    const name = prompt(z('新模板的名称：'), z('模板') + (templates.length + 1));
    if (name === null) return;
    try {
      const r = await post('/api/templates/create', { name: (name || '').trim() || undefined });
      await loadTemplates();
      applyTemplate(r.id, { toast: '已新建空白模板「' + r.name + '」' });
    } catch (e) { toast('新建失败：' + e.message); }
  };

  $('#st-tpl-rename').onclick = async () => {
    const cur = templates.find(t => t.id === tpl);
    const name = prompt(z('模板名称：'), cur ? cur.name : '');
    if (name === null) return;
    try {
      const r = await post('/api/templates/rename', { id: tpl, name: (name || '').trim() });
      await loadTemplates();
      renderTplSelect();
      refreshStatus();
      toast('已重命名为「' + r.name + '」');
    } catch (e) { toast('重命名失败：' + e.message); }
  };

  $('#st-tpl-del').onclick = async () => {
    const cur = templates.find(t => t.id === tpl);
    if (!cur) return;
    if (cur.legacy) { toast('模板一是当前作品集本体，不能删除'); return; }
    if (!confirm(z('确定删除「' + cur.name + '」？\n\n这个模板的内容和排版会一并删除，且无法撤销。\n作品集本体「模板一」和其他模板不受影响。'))) return;
    try {
      await post('/api/templates/delete', { id: tpl });
      tpl = LEGACY;
      await loadTemplates();
      applyTemplate(LEGACY, { toast: '已删除「' + cur.name + '」，已回到「模板一」' });
    } catch (e) { toast('删除失败：' + e.message); }
  };

  // ———————————— 模板导出 / 导入（Template 与 Personal Content 分离）————————————
  // 导出：只抽 design.json（版式），绝不碰 portfolio.json（个人内容）
  // 导入：只把 design 合进当前 design.json，同样绝不写 portfolio.json
  // 两种码：短码（几十字符，只带核心版式）/ 完整码（几百字符，连逐项微调一起带走）。
  // 默认给短码——用户要的是能随口发给别人的东西。
  let stExportCodes = { short: '', full: '' };
  let stCodeTab = 'short';
  const renderShareCode = () => {
    const inp = $('#st-code-input');
    const hint = document.getElementById('st-code-hint');
    const v = stExportCodes[stCodeTab] || '';
    if (inp) inp.value = v;
    const bS = $('#st-code-tab-short'), bF = $('#st-code-tab-full');
    if (bS) bS.classList.toggle('on', stCodeTab === 'short');
    if (bF) bF.classList.toggle('on', stCodeTab === 'full');
    if (hint) {
      const COPY_NOTE = ' 复制请用左侧「复制」按钮，或点输入框后 Ctrl/⌘+A 全选——整段原样粘贴，别漏掉结尾。';
      hint.textContent = stCodeTab === 'short'
        ? '共 ' + v.length + ' 个字符：主题 / 明暗 / 区块顺序 / 间距 / 展示区 / 像素形象。' +
          '逐项微调（某条标题的字号、某张媒体的栏宽）不带——那些绑在你的具体条目上，换到别人作品集上本来就对不上号；要带走就切到「完整码」。' + COPY_NOTE
        : '共 ' + v.length + ' 个字符：整份版式都在里面，包括逐项微调。长是正常的——要短就切回「短码」。' + COPY_NOTE;
    }
  };
  $('#st-code-tab-short').onclick = () => { stCodeTab = 'short'; renderShareCode(); };
  $('#st-code-tab-full').onclick = () => { stCodeTab = 'full'; renderShareCode(); };

  $('#st-tpl-gen').onclick = async () => {
    try {
      const r = await post('/api/templates/export', { tpl });
      stExportCodes = { short: r.code || '', full: r.fullCode || r.code || '' };
      stCodeTab = 'short';
      const box = $('#st-share-code');
      if (box) box.hidden = false;
      renderShareCode();
      toast('模板已打包：短码 ' + stExportCodes.short.length + ' 字符 / 完整码 ' + stExportCodes.full.length + ' 字符');
    } catch (e) { toast('生成模板失败：' + e.message); }
  };

  $('#st-tpl-gen-file').onclick = () => {
    // 走服务端导出，文件名 folioframe-template-<id>.json，内容只有版式
    const a = document.createElement('a');
    a.href = '/api/export/template' + (tpl === LEGACY ? '' : '?tpl=' + encodeURIComponent(tpl));
    a.download = '';
    document.body.appendChild(a); a.click(); a.remove();
    toast('模板文件已开始下载（只含版式，不含个人内容）');
  };

  $('#st-code-copy').onclick = async () => {
    const inp = $('#st-code-input');
    if (!inp || !inp.value) return;
    try { await navigator.clipboard.writeText(inp.value); toast('分享码已复制'); }
    catch (_) { inp.select(); document.execCommand && document.execCommand('copy'); toast('分享码已复制'); }
  };
  // 点一下输入框就全选：手动复制(Ctrl/Cmd+A 也行)时不会漏掉 76 字符码的结尾。
  const codeInp = $('#st-code-input');
  if (codeInp) {
    codeInp.addEventListener('focus', () => codeInp.select());
    codeInp.addEventListener('click', () => codeInp.select());
  }

  const importDlg = () => document.getElementById('st-import-dialog');
  const openImport = () => {
    const d = importDlg(); if (!d) return;
    const c = $('#st-import-code'); if (c) c.value = '';
    const j = $('#st-import-json'); if (j) j.value = '';
    const f = $('#st-import-file'); if (f) f.value = '';
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
  };
  const closeImport = () => {
    const d = importDlg(); if (!d) return;
    if (typeof d.close === 'function') d.close(); else d.removeAttribute('open');
  };
  $('#st-tpl-import').onclick = openImport;
  $('#st-import-cancel').onclick = closeImport;
  $('#st-import-close').onclick = closeImport;

  $('#st-import-go').onclick = async () => {
    const code = ($('#st-import-code') || {}).value || '';
    const json = ($('#st-import-json') || {}).value || '';
    const name = (($('#st-import-name') || {}).value || '').trim();
    const fileEl = $('#st-import-file');
    const file = fileEl && fileEl.files && fileEl.files[0];
    if (!code.trim() && !json.trim() && !file) { toast('请先粘贴模板码、选择文件或粘贴模板内容'); return; }
    // 先命名再导入：导入一律新建一个以用户命名的新模板（只带版式、内容为空），
    // 绝不改动当前正在编辑的模板，也绝不让导入的模板与现有模板撞名后混在一起导致误删。
    if (!name) { toast('请先给导入的模板起个名字'); const ne = document.getElementById('st-import-name'); if (ne) ne.focus(); return; }
    let template = null;
    if (file) {
      try { template = JSON.parse(await file.text()); }
      catch (e) { toast('文件不是合法 JSON：' + e.message); return; }
    } else if (json.trim()) {
      try { template = JSON.parse(json); }
      catch (e) { toast('粘贴的内容不是合法 JSON：' + e.message); return; }
    }
    try {
      const body = { tpl, mode: 'new', name };
      if (template) body.template = template; else body.code = code.trim();
      const r = await post('/api/templates/import', body);
      closeImport();
      await loadTemplates();
      if (r && r.created && r.tpl) {
        applyTemplate(r.tpl, { toast: '已导入为「' + (r.name || r.tpl) + '」：版式来自模板，内容为空，你可以在新模板里继续编辑' });
        return;
      }
      renderTplSelect();
      resetPanels();
      refreshStatus();
      toast('模板已导入：已作为新模板「' + name + '」创建');
    } catch (e) { toast('导入失败：' + e.message); }
  };

  // —— 公开链接（Public Link）：Studio 外壳内的「发布到公网」入口 ——
  const stPublinkDialog = () => document.getElementById('st-publink-dialog');
  let __stPubProvider = null;
  let __stProbeRetry = 0;   // 能力探测后台刷新后自动重渲一次的计数
  let __stMediaRetry = 0;   // 大媒体后台上传进行中时的自动重渲计数
  let stDeployedAt = 0;          // 最近一次成功发布的时刻（部署按钮显示「✓ 已更新」用）
  let stDeployedProvider = null; // 对应的 provider（github / cloudbase）
  let __stGhPoll = null;

  // ⚠⚠ 发布状态机（模块级，必须活在 DOM 之外）—— 2026-09-18 真实故障修复。
  // 为什么：这个面板为了自愈（GitHub 能力结论陈旧、大媒体后台进度）会**整体重渲** provider 区，
  // 重渲会把按钮 / 进度条 / 错误行这些节点整个换掉。状态若只挂在 DOM 或点击闭包里就会被一起抹掉，
  // 用户看到的是「点一下闪一下、什么也没发生」，于是反复点击；第二次点击还会真的再发一次发布请求，
  // 两次发布并发互相覆盖（历史上出过线上空站点事故）。
  // 放进模块级后：无论重渲多少次，第一下点击就立刻进入「发布中…」，并一直显示到出结果。
  // 状态：idle → starting（已点击，正在提交请求）→ running（服务端已在传）→ ok / error
  // tpl：这次发布属于哪个模板。⚠ 必须记：状态机活在 DOM 之外（故意的，为了扛住重渲），
  //   也就意味着它**不会随切模板自动清空** —— 不记模板的话，A 正在发布时切到 B，
  //   B 的面板会显示 A 的进度条和 A 的报错（连带「配置腾讯云」之类的引导按钮），
  //   是典型的「状态不属于当前 templateId」。渲染时按 tpl 过滤。
  const PUBUI = { phase: 'idle', provider: '', detail: '', total: 0, sent: 0, pct: 0,
                  elapsed: 0, error: '', warnings: [], since: 0, tpl: '' };
  const stPubuiMine = () => !PUBUI.tpl || PUBUI.tpl === tpl;   // 当前这次发布是不是属于当前模板
  let __stPubPollTimer = null;
  let __stSetupOpen = false; // 凭证表单打开时禁止自愈重渲，否则用户填到一半的输入会被清空

  const stPubuiBusy = () => PUBUI.phase === 'starting' || PUBUI.phase === 'running';

  // 进度块：starting 阶段也要立刻显示（「正在提交发布请求…」），第一下点击永远有反馈。
  const stPubuiProgressHtml = () => {
    if (!stPubuiBusy() || !stPubuiMine()) return '';   // 别把别的模板的发布进度画到当前模板上
    const stage = PUBUI.detail || '正在提交发布请求…';
    const t = PUBUI.elapsed ? '（已用 ' + Math.round(PUBUI.elapsed) + ' 秒）' : '';
    const bar = PUBUI.total
      ? `<div class="st-pub-prog-bar"><i style="width:${PUBUI.pct}%"></i></div><div class="st-pub-prog-pct">${PUBUI.pct}%</div>`
      : '';
    return `<div class="st-pub-progress" id="st-pub-progress"><div class="st-pub-prog-stage">${esc(stage)}${t}</div>${bar}</div>`;
  };
  // 失败原因常驻显示（不再只靠一闪而过的 toast），且能扛住重渲。
  // ⚠ 关键修复 2026-09-19：用**红色醒目卡片**呈现，并插到面板**最顶部**，
  // 否则失败信息沉在「发布与分享」长面板底部，会被「公开链接」区视觉盖住、用户根本看不到。
  // ⚠ 2026-09-19 二次修复（真实故障）：整块（标题 + 正文 + 修复引导 + 操作按钮）
  // 必须包在**同一个容器**里。旧版把引导段落放在容器**外面**，清理时只按 id 删掉了
  // 标题卡片，后面跟随的段落成了孤儿节点留在页面上，每重渲一次就多留一份
  // → 用户看到「能读取环境但没有写权限…」「改用导出 ZIP…」整段重复两遍。
  // 另外：失败后必须当场给出下一步按钮，不能让用户自己去找（真实反馈）。
  const stPubuiErrorHtml = () => {
    if (stPubuiBusy() || !stPubuiMine() || PUBUI.phase !== 'error' || !PUBUI.error) return '';
    const err = String(PUBUI.error);
    const shown = /^发布失败[：:]/.test(err) ? err : ('发布失败：' + err);
    let h = `<div class="st-pub-err-box" id="st-publink-err">`
      + `<div class="st-pub-err-title">✗ 发布失败</div>`
      + `<div class="st-pub-err-body">${esc(shown)}</div>`;
    if (PUBUI.provider === 'cloudbase') {
      // 权限类失败：给出可直接照做的修复路径，而不是让用户对着英文报错发呆。
      if (/Access Denied|权限|403/i.test(err)) {
        h += `<div class="st-pub-err-fix">你当前的密钥能读取 CloudBase 环境，但<b>没有对象存储的写权限</b>——`
          + `上传文件底层就是往对象存储（COS）里写对象，所以每个文件都被拒。`
          + `这不是"没授权"，而是<b>策略挂错了层</b>：只挂 CloudBase 自身的策略不够。`
          + `到 <a href="https://console.cloud.tencent.com/cam" target="_blank" rel="noopener">访问管理 CAM ↗</a>`
          + ` → 左侧「用户」→「<b>用户列表</b>」→ 找到这把密钥对应的<b>子账号所在的那一行</b>，`
          + `点该行右侧操作列的「<b>授权</b>」（入口在列表行上；主账号行没有这个入口，也不必点进用户详情里找）`
          + ` → 在「关联策略」窗口搜 <b>QcloudCOSFullAccess</b> → 勾选 → 确定`
          + `（QcloudCOSFullAccess＝对象存储 COS 全读写访问权限，上传文件靠它，必须挂在这个子账号上）。</div>`;
      }
      if (/node'?(')? is not recognized|找不到 node|not recognized/i.test(err)) {
        h += `<div class="st-pub-err-fix">这是运行环境问题：CloudBase CLI 需要 Node.js 才能跑。`
          + `请先<b>重启 FolioFold 服务</b>（双击启动脚本），本机已自带 Node.js 会自动修复。</div>`;
      }
    }
    // 下一步按钮就在错误块里 —— 修好权限后直接点「更新发布」，不必再去别处找入口。
    h += `<div class="st-pub-err-actions">`
      + `<button class="st-btn primary" id="st-publink-err-retry">⟳ 更新发布</button>`
      + `<button class="st-btn" id="st-publink-err-permcheck">🔍 权限体检</button>`
      + (PUBUI.provider === 'cloudbase' ? `<button class="st-btn" id="st-publink-err-reconfig">配置腾讯云</button>` : '')
      + `<button class="st-btn" id="st-publink-err-zip">改用「导出 ZIP」</button>`
      + `</div>`
      + `<div class="st-pub-err-report" id="st-publink-err-report" hidden></div>`
      + `</div>`;
    return h;
  };
  // 权限体检结果渲染（数据来自 /api/cloudbase/permcheck）。
  // ⚠ 目的：让用户一眼看懂"我是谁 / 缺哪一层权限 / 去哪开"，而不是对着 `Access Denied` 发呆。
  const stPubPermReportHtml = (res) => {
    if (!res || res.error) return `<div class="st-pub-err-report-line">体检失败：${esc((res && res.error) || '没有返回内容')}</div>`;
    let h = `<div class="st-pub-err-report-line"><b>权限体检结果</b></div>`;
    (res.checks || []).forEach((c) => {
      h += `<div class="st-pub-err-report-line">${c.ok ? '✓' : '✗'} ${esc(c.name || '')}：${esc(c.detail || '')}</div>`;
    });
    if (res.verdict) h += `<div class="st-pub-err-report-line"><b>${esc(res.verdict).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}</b></div>`;
    if (res.fix && res.fix.length) {
      h += `<div class="st-pub-err-report-line">怎么修：<ol>${res.fix.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></div>`;
    }
    if (res.canDeploy) h += `<div class="st-pub-err-report-line">✓ 权限已就绪，点上面的「⟳ 更新发布」即可。</div>`;
    return h;
  };
  // 失败/进度块该插到哪：**发布渠道内容容器**（#st-publink-body 内部）。
  // ⚠ 绝不能用 document.querySelector('.st-publish-section')：
  // index.html 里「发布与分享」对话框的模板区用的是同一个类名，而且文档顺序更靠前，
  // 于是错误块被插进了那个对话框 —— 用户明明在「公开链接」对话框里点的发布，
  // 错误却显示在另一个被 showModal() 顶层遮住的对话框里，怎么找都看不见（真实故障 2026-09-19）。
  const stPubuiHost = () => {
    const body = document.getElementById('st-publink-body');
    if (!body) return null;
    return body.querySelector('.st-publish-section') || body;
  };
  // 清理必须按**类名全量**清理（不能按 id 只删标题卡片，否则段落孤儿会累积成重复内容）。
  const stPubuiClean = () => {
    document.querySelectorAll('.st-pub-err-box, .st-pub-progress').forEach(n => n.remove());
  };
  const stPubuiMount = () => {
    stPubuiClean();
    const host = stPubuiHost();
    if (!host) return;
    const h = stPubuiProgressHtml() + stPubuiErrorHtml();
    if (!h) return;
    // 插到容器最前面，并滚进视野：用户点完发布就应当立刻看到结果。
    host.insertAdjacentHTML('afterbegin', h);
    const box = document.getElementById('st-publink-err');
    if (!box) return;
    const retry = document.getElementById('st-publink-err-retry');
    if (retry) retry.onclick = () => { const b = document.getElementById('st-publink-deploy'); if (b) b.click(); };
    const rc = document.getElementById('st-publink-err-reconfig');
    if (rc) rc.onclick = () => { const pv = document.getElementById('st-publink-prov'); if (pv) stRenderCloudBaseSetup(pv); };
    const z = document.getElementById('st-publink-err-zip');
    if (z) z.onclick = () => { __stPubProvider = 'zip'; stRenderPublink(); };
    // 权限体检：直接问后端"这把密钥到底缺哪一层权限"，把结论摆到卡片里。
    const pc = document.getElementById('st-publink-err-permcheck');
    if (pc) pc.onclick = async () => {
      const rep = document.getElementById('st-publink-err-report');
      if (!rep) return;
      rep.hidden = false;
      rep.innerHTML = `<div class="st-pub-err-report-line">正在体检…（读取环境 + 一次 0 字节写入自检，自检文件立即删除）</div>`;
      pc.disabled = true;
      try {
        const res = await fetch('/api/cloudbase/permcheck', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
        }).then((r) => r.json());
        rep.innerHTML = stPubPermReportHtml(res);
      } catch (e) {
        rep.innerHTML = `<div class="st-pub-err-report-line">体检请求失败：${esc(String((e && e.message) || e))}</div>`;
      } finally { pc.disabled = false; }
    };
    try { box.scrollIntoView({ block: 'nearest' }); } catch (_) {}
  };
  // 只更新进度块的文字/百分比（不动其它 DOM）——1.5 秒一次的轮询不能重渲整个面板，
  // 否则会闪、会丢滚动位置、会丢用户正在输入的凭证。
  const stPubuiPaint = () => {
    let el = document.getElementById('st-pub-progress');
    // 不属于当前模板的发布：把（可能残留的）进度块藏起来，绝不让别的模板的进度继续显示
    if (!stPubuiBusy() || !stPubuiMine()) { if (el) el.style.display = 'none'; return; }
    const sec = stPubuiHost();
    if (!el) {
      if (!sec) return;
      sec.insertAdjacentHTML('beforeend', '<div class="st-pub-progress" id="st-pub-progress"></div>');
      el = document.getElementById('st-pub-progress');
    }
    if (!el) return;
    // 进度条必须写明**发布到哪个渠道**：否则用户切到 GitHub 页签时看到"正在上传到 CloudBase"
    // 会一头雾水，也不知道此时点别的按钮为什么没反应。
    const pl = PUBUI.provider === 'cloudbase' ? 'CloudBase' : (PUBUI.provider === 'github' ? 'GitHub Pages' : '');
    const stage = (pl ? '发布到 ' + pl + '：' : '') + (PUBUI.detail || '正在提交发布请求…');
    const t = PUBUI.elapsed ? '（已用 ' + Math.round(PUBUI.elapsed) + ' 秒）' : '';
    const bar = PUBUI.total
      ? `<div class="st-pub-prog-bar"><i style="width:${PUBUI.pct}%"></i></div><div class="st-pub-prog-pct">${PUBUI.pct}%</div>`
      : '';
    el.style.display = 'block';
    el.innerHTML = `<div class="st-pub-prog-stage">${esc(stage)}${t}</div>${bar}`;
  };
  const stPubuiStopPoll = () => { if (__stPubPollTimer) { clearInterval(__stPubPollTimer); __stPubPollTimer = null; } };
  const stPubuiStartPoll = () => {
    stPubuiStopPoll();
    const tick = async () => {
      if (!stPubuiBusy()) return;
      // 客户端兜底：20 分钟仍无结果就收敛为失败，避免按钮永远卡在「发布中…」
      // （服务端另有 15 分钟看门狗；这里只防请求本身断掉却没有回调的情况）。
      if (Date.now() - PUBUI.since > 20 * 60 * 1000) {
        PUBUI.phase = 'error';
        PUBUI.error = '发布超过 20 分钟仍没有结果，已停止等待。请先打开公开网址确认页面是否已经更新：如果页面已经是新的，就不需要再更新了。';
        stPubuiStopPoll(); stPubuiPaint(); toast('✗ 发布超时，详情见面板红色提示'); return;
      }
      let s = { publish: {} };
      try { s = await (await fetch('/api/deploy/status', { cache: 'no-store' })).json(); } catch (e) {}
      const p = s.publish || {};
      // ⚠ 只信任"本次"发布：只有服务端 running 时才读它的阶段。
      // 旧实现直接读 p.phase / p.ok，会显示**上一次**发布的遗留文案（甚至因它 ok:true 而误判）。
      if (p.running) {
        PUBUI.phase = 'running';
        PUBUI.detail = p.detail || p.phase || '发布中…';
        PUBUI.total = p.total || 0;
        PUBUI.sent = (p.sent != null) ? p.sent : 0;
        PUBUI.pct = (p.total && p.sent != null) ? Math.max(0, Math.min(100, Math.round(p.sent / p.total * 100))) : 0;
        PUBUI.elapsed = p.elapsed || 0;
      } else if (PUBUI.phase === 'starting') {
        PUBUI.detail = '正在提交发布请求…';
      }
      stPubuiPaint();
    };
    __stPubPollTimer = setInterval(tick, 1500);
    tick();
  };

  // —— Device Flow：一键授权。只用公开 client_id，没有 client_secret。——
  const stStopGhPoll = () => { if (__stGhPoll) { clearTimeout(__stGhPoll); __stGhPoll = null; } };
  const stStartGhDevice = async () => {
    const box = document.getElementById('st-publink-gh-device'); if (!box) return;
    stStopGhPoll();
    box.innerHTML = `<p class="st-publish-note">正在向 GitHub 申请授权码…</p>`;
    let d = { ok: false };
    try { d = await post('/api/github/device/start', {}); } catch (e) { d = { ok: false, error: e.message }; }
    if (!d.ok) {
      box.innerHTML = `<p class="st-publish-note">申请失败：${esc(d.error || '未知错误')}</p>
        <div class="st-publish-actions"><button class="st-btn" id="st-gh-retry">重试</button></div>`;
      const rt = document.getElementById('st-gh-retry'); if (rt) rt.onclick = () => stStartGhDevice();
      return;
    }
    const code = esc(d.user_code || '');
    const openUri = esc(d.verification_uri_complete || d.verification_uri || 'https://github.com/login/device');
    box.innerHTML = `<p class="st-publish-note">在 GitHub 页面输入下面的代码（已自动复制，可直接粘贴）：</p>
      <div style="display:flex;align-items:center;gap:10px;margin:8px 0 12px">
        <span style="font:700 26px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:3px;padding:10px 16px;border:1px dashed #b9b9c6;border-radius:10px;background:#fafafb;user-select:all">${code}</span>
        <button class="st-btn" id="st-gh-copycode">复制代码</button>
      </div>
      <div class="st-publish-actions">
        <a class="st-btn primary" href="${openUri}" target="_blank" rel="noopener">打开 GitHub 授权页 ↗</a>
        <button class="st-btn" id="st-gh-cancel">取消</button>
      </div>
      <p class="st-publish-note" id="st-gh-wait">等待你在 GitHub 上完成授权…</p>`;
    try { await navigator.clipboard.writeText(d.user_code || ''); } catch (_) {}
    const cc = document.getElementById('st-gh-copycode');
    if (cc) cc.onclick = async () => { try { await navigator.clipboard.writeText(d.user_code || ''); } catch (_) {} toast('已复制授权码'); };
    const cx = document.getElementById('st-gh-cancel');
    if (cx) cx.onclick = () => { stStopGhPoll(); box.innerHTML = ''; };
    let delay = 5000;
    const t0 = Date.now();
    const tick = async () => {
      if (Date.now() - t0 > 15 * 60 * 1000) { const w = document.getElementById('st-gh-wait'); if (w) w.textContent = '授权码已过期，请重新点击「连接 GitHub」。'; return; }
      let r = { ok: false };
      try { r = await post('/api/github/device/poll', {}); } catch (e) { __stGhPoll = setTimeout(tick, delay); return; }
      if (r.ok && r.status === 'connected') {
        __stPubProvider = 'github';
        // 连接成功 ≠ 能发布：服务端已用真实 API 探过建仓权限，这里如实转达。
        if (r.canCreateRepo === false) toast('已连接，但该授权无法新建仓库，请看面板提示');
        else toast('GitHub 已连接 ✓');
        await stRenderPublink();
        return;
      }
      if (r.ok && r.status === 'denied') { const w = document.getElementById('st-gh-wait'); if (w) w.textContent = '你在 GitHub 上拒绝了授权。'; return; }
      if (r.ok && r.status === 'expired') { const w = document.getElementById('st-gh-wait'); if (w) w.textContent = '授权码已过期，请重新点击「连接 GitHub」。'; return; }
      if (r.ok && r.slowDown) delay = Math.min(delay + 5000, 15000);
      __stGhPoll = setTimeout(tick, delay);
    };
    __stGhPoll = setTimeout(tick, delay);
  };
  // —— 导出 ZIP：不是发布平台，而是把当前站点打包下载到本地 ——
  // 与发布走同一条打包链路（build_public_bundle），所以"导出能看的，发布就能看"。
  // 刻意不做成"又一个渠道"：不触网、不需要账号、不产生任何外部依赖、不含任何密钥。
  const stRenderZipSection = (pv) => {
    if (!pv) return;
    pv.innerHTML = `<div class="st-publish-section">
      <p class="st-publish-note">把当前作品集导出为一个<b>完整静态网站 ZIP</b>，下载到本机。</p>
      <div class="st-publish-note" style="line-height:1.7">
        <p><b>它是什么：</b>不是发布平台，而是一个「万能出口」。导出的包不需要 FolioFold、不需要联网，解压后双击 <b>index.html</b> 就能离线浏览。</p>
        <p><b>能用来做什么：</b>想放到国内平台（如腾讯云 EdgeOne Pages、CloudBase）时，把导出的 ZIP 直接拖到平台的上传页即可，<b>不需要填任何密钥</b>。</p>
        <p><b>包里有什么：</b>index.html（样式脚本已内联）、media/ 媒体，以及一份 <b>folioframe-export.json</b> 导出清单。</p>
        <p><b>包里绝不会有什么：</b>GitHub 令牌、腾讯云 SecretKey 等任何账号凭证 —— 一分都不会进包。</p>
        <p style="color:#9a6700"><b>关于大文件：</b>默认<b>不打包超过 90MB 的单个媒体</b>（避免 ZIP 过大），这些文件会在清单和 README 里<b>逐条列出</b>，你可以单独压缩后补传。已打进包里但超过 25MB 的文件也会在 README 里标出 —— 离线看不受影响，但部分平台上传时有单文件上限。</p>
      </div>
      <div class="st-publish-actions">
        <button class="st-btn primary" id="st-publink-zip">导出网站 ZIP</button>
        <button class="st-btn" id="st-publink-zip-all">导出完整版（含大媒体）</button>
      </div>
      <p class="st-publish-note" id="st-publink-zip-note" style="display:none"></p></div>`;
    const __q = (tpl && tpl !== LEGACY) ? '?tpl=' + encodeURIComponent(tpl) + '&' : '?';
    const __wireZipBtn = (id, extra, hint) => {
      const b = document.getElementById(id); if (!b) return;
      b.onclick = () => {
        const note = document.getElementById('st-publink-zip-note');
        if (note) { note.style.display = 'block'; note.textContent = hint || '正在打包…（媒体较多时需要十几秒到几分钟，请勿关闭）'; }
        window.location.href = '/api/export/site-zip' + __q + extra;
      };
    };
    __wireZipBtn('st-publink-zip', '', '正在打包…（媒体较多时需要十几秒到几分钟，请勿关闭）');
    __wireZipBtn('st-publink-zip-all', 'include=all', '正在打包完整版（含所有大媒体），耗时更长…');
  };

  // —— CloudBase：腾讯云静态网站托管（国内部署）——
  // 文案统一为官方口径：不写死任何易变的配额 / 价格 / 套餐数字，规格一律指向官方文档。
  // ⚠ 改这里必须同步 app-v3.js 的 renderCloudBaseSection / renderSetupForm。
  const CB_OFFICIAL_LINKS = '<a href="https://cloud.tencent.com/document/product/876/46900" target="_blank" rel="noopener">静态网站托管 ↗</a>　'
    + '<a href="https://cloudbase.net/pricing" target="_blank" rel="noopener">定价与套餐说明 ↗</a>　'
    + '<a href="https://cloud.tencent.com/document/buy-guide/876/127357" target="_blank" rel="noopener">免费额度与续期规则 ↗</a>　'
    + '<a href="https://docs.cloudbase.net/service/alias" target="_blank" rel="noopener">默认域名中间页说明 ↗</a>';
  // 腾讯云控制台**直达**链接（2026-09-18 逐个 curl 校验；未登录时会 302 到腾讯云登录页，登录后直达目标页）。
  // ⚠ 改这里必须同步 app-v3.js 的 CB_CONSOLE_LINKS。
  const CB_CONSOLE_LINKS = {
    home:    'https://cloud.tencent.com/login',                 // 登录腾讯云（未登录时直达登录页）
    env:     'https://console.cloud.tencent.com/tcb',           // CloudBase 控制台根：首次在此「开通云开发」+「新建环境」
    envList: 'https://console.cloud.tencent.com/tcb/env/index', // 环境列表（已有环境时在此复制环境 ID）
    hosting: 'https://console.cloud.tencent.com/tcb/hosting',   // 静态网站托管（需在环境里开通）
    cam:     'https://console.cloud.tencent.com/cam/capi',      // 访问管理 → API 密钥管理
    verify:  'https://console.cloud.tencent.com/developer',     // 账号信息 → 实名认证
  };
  const cbLink = (url, text) => `<a href="${url}" target="_blank" rel="noopener">${text}</a>`;

  // ⚠ 改这里必须同步 app-v3.js（两份内容保持一致）。
  const cbPromptGeneric = () => [
    '【任务】',
    '帮我把 FolioFold 作品集站点部署到腾讯云 CloudBase 静态网站托管。',
    '⚠ 终点不是「腾讯云上有个站点」，而是「回到 FolioFold 发布面板，点一下发布，就能在 FolioFold 里看到并打开这个站点的访问链接」。没在 FolioFold 里拿到能打开的链接，这个任务就不算完成。',
    '全程遵守：能代做的直接代做；只能我本人在网页上做的，先把页面打开、停在那里等我做完，再继续下一步，不要丢给我一份教程就结束。',
    '',
    '【执行前必须先探测现状（不要跳过）】',
    '先只读查询，判断哪些步骤已经完成，已完成的一律跳过：',
    '· 云开发是否已开通、名下是否已有环境（列出环境 ID）；',
    '· 目标环境的静态网站托管是否已开通、默认访问域名是什么；',
    '· 是否已有可用密钥。',
    '如果你连不上我的腾讯云账号（没有凭证），就先告诉我需要哪些凭证，再去问我要。',
    '⚠ 不要假设环境不存在、也不要假设托管没开通——先查再问。',
    '',
    '【需要我本人确认的事，先讲清楚再动手】',
    '任何要在这台电脑上安装软件、或要下载/保存密钥的操作，动手前先告诉我三件事：装/存什么、干什么用、放在哪个路径、之后能不能迁移。我同意后再执行。如果当前会话已经是「允许完全访问」状态，可以直接做，但要在最后汇报里说明装了什么、在哪、用途是什么、可否迁移。',
    '',
    '【步骤】',
    '1. 账号与实名：未登录先登录 https://cloud.tencent.com/ ；未实名先实名（控制台右上角头像 → 账号信息 → 实名认证，或 https://console.cloud.tencent.com/developer ）。',
    '2. 开通云开发：打开 https://console.cloud.tencent.com/tcb ，首次需勾选《服务条款》并完成「云开发服务角色权限授权」。只有开通后「新建环境」入口才会出现。',
    '3. 创建环境：⚠ 免费体验版环境只能在控制台网页创建，API / 命令行下单走的是付费套餐，不要用 API 创建。把 https://console.cloud.tencent.com/tcb 打开给我，告诉我点哪个按钮，表单按下面选：',
    '   · 套餐：免费体验版（0 元/月，单账号限 1 个，每月 3000 资源点）。不要选个人版。',
    '   · 地域：上海（或就近）。',
    '   · 数据库：默认的「云数据库」（文档型）。不要选 PostgreSQL。',
    '   · 标签：留空。备案说明：跳过（用平台默认域名免备案）。购买时长：免费试用 6 个月（0 元）。',
    '   建好后我会把「环境 ID」（形如 folioframe-site-d4f57yrt27bf927f）发给你。你在这里停下等我，不要继续往下做。',
    '4. 开通静态网站托管：收到环境 ID 后，先查这个环境的托管是否已开通；已开通就直接跳过，没开通再带我去开通（环境 → 左侧「静态网站托管」→ 开通）。默认域名形如 <envId>-<随机串>.tcloudbaseapp.com，从控制台或接口读实际值，不要猜。',
    '5. 准备 API 密钥（必须最小权限）：',
    '   · 用主账号密钥也能部署，但它是全权限密钥，泄露风险大，只在应急时用，用完就删。',
    '   · 推荐用「子账号 + 仅两条策略」的密钥部署（最小权限）。能否**代你挂策略**取决于你给我的密钥本身有没有 CAM 管理权限：',
    '     - 情况 A：给我的是主账号密钥、或带 CAM 管理权限（QcloudCamFullAccess）的子账号密钥 → 我直接调用 AttachUserPolicy 把两条策略挂到指定子账号，真正一键部署，不用你手动开权限。',
    '     - 情况 B：只给现在这把受限子账号密钥（它自己无 CAM 权限）→ 我没法让它自己提权（腾讯云禁止自增权），必须你（或主账号持有人）先在 CAM 控制台手动补挂 QcloudCOSFullAccess，之后我才能部署。这种情况我会**一开始就告诉你缺哪个权限、去哪开**，不等到上传失败才说。',
    '   · 你目前的情况（子账号已建好、但上传 Access Denied）：不用新建用户，直接给那把子账号在 CAM 补挂 QcloudCOSFullAccess 即可。我手上有情况 A 的凭证就直接帮你补挂；没有就带你在 https://console.cloud.tencent.com/cam 里点、停在要点处等你做完。',
    '   · 给**已存在的子账号**补挂策略的精确路径（情况 B 要手动做）：打开 https://console.cloud.tencent.com/cam → 左侧「用户」→「用户列表」→ 找到那把子账号所在的**那一行**，点该行右侧操作列的「授权」（入口在列表行上：主账号行没有这个入口，也不要去找用户详情里的按钮）→ 在弹出的「关联策略」窗口搜索 `QcloudCOSFullAccess` → 勾选 → 确定；再同法搜 `QcloudTCBFullAccess` 确认两条都在。两条都挂上后，上传即不再 Access Denied。',
    '   · ⚠ 你能代做就别只念路径给我听：手里有 CAM 管理权限凭证时，直接调用 AttachUserPolicy 把这两条策略挂到目标子账号上——**创建子账号时就一并挂好，不要留到后面再补**；挂完再继续部署，不要停下来等我去点。',
    '   · ⚠ 必须关联**两条**策略，缺一个上传必失败：QcloudTCBFullAccess（CloudBase 环境读写）＋ QcloudCOSFullAccess（对象存储 COS 全读写访问权限，含上传动作，命令行上传文件靠它）。只挂前者会出现「能读环境、但每个文件都 Access Denied」。',
    '   · 控制台里「用户列表 → 新建用户」有两条路径，差别是：快速创建＝只填用户名，默认自动带 AdministratorAccess（全权限）；自定义创建＝可选用户类型、访问方式、逐条指定策略。我们要最小权限，所以选「自定义创建」，用户类型选「可访问资源并接收消息」，访问方式勾「编程访问」，权限策略勾上面那两条。',
    '   · 「仅用于接收消息」那种账号没有编程访问能力，不能用于部署，不要选。',
    '   · SecretKey 只在创建弹窗里显示一次，必须当场保存。',
    '   · 不要把密钥写进任何会进 Git 的文件。',
    '   · ⚠ 部署前先做写入体检，别等传完才发现：DescribeEnvs 能读**不代表**能上传（两者权限互相独立）。用 DescribeStaticStore 取到存储桶名，确认对该桶有写入权限；只读通、写入被拒 = 缺 QcloudCOSFullAccess。若你手上的密钥没有 CAM 管理权限，就无法代我挂策略，请把 CAM 页面打开停在那里告诉我点哪里，等我做完再继续——不要只说一句"没有权限"就把问题丢回给我。',
    '6. 汇总输出（这是交付终点，不是中间步骤）：我拿到结果后，按下面格式整段发我，我会**粘回 FolioFold 发布面板**自动填入。填入后点「发布」，FolioFold 会把站点上传到该环境，并在面板里直接显示访问链接。所以这一步之后必须确认：我能在 FolioFold 里看到并打开站点链接，而不是只知道腾讯云上有个环境。',
    '',
    '===== FolioFold CloudBase 配置 =====',
    'EnvId: <环境 ID>',
    'SecretId: <SecretId>',
    'SecretKey: <SecretKey>',
    '默认访问域名: <实际域名>',
    '===== 结束 =====',
    '',
    '请明确告诉我：把这段粘回 FolioFold 面板 → 点发布 → 即可得到站点访问链接（形如 https://<默认访问域名>）。并在最后说明：环境 ID、密钥存放在你那里的什么位置、是否可迁移、以及这个免费环境的到期时间和剩余额度（如果查得到）。',
    '7. 发布后交付物与限制（这些必须由你了解并向我说清，不要等出问题才讲）：',
    '   · 存储：站点文件存在该环境绑定的**对象存储 COS** 里，静态托管只是它的对外入口；所以上传动作校验的是 COS 写权限，而不是 CloudBase 自己的读权限。这就是为什么必须同时挂 QcloudCOSFullAccess。',
    '   · 配额原因：免费体验版按「资源点」计量（每月 3000 点）、容量与流量都有上限，且**单账号限 1 个环境**。站点里的大媒体（例如超过 50MB 的视频）会显著消耗配额，建议先本地压缩再上传。',
    '   · 中间页：平台默认域名（*.tcloudbaseapp.com 等）**仅供开发测试**。访客用浏览器直接打开时会先看到「访问提示中间页」，点了「确定访问」才进得去；该中间页无法关闭，**唯一合规的去除方式是绑定一个已完成 ICP 备案的自定义域名**。默认域名还有访问频率限制，异常流量可能被限制访问。官方说明见 https://docs.cloudbase.net/service/alias 。',
    '   · 单文件上限：腾讯云官方对静态托管单文件大小的说明在不同渠道并不完全一致（网页通道与命令行通道的上限差异较大）。不要引用未经官方确认的数字；命令行通道对大文件更友好，大媒体优先走命令行上传。',
    '   · 部署完成后，请把我回填 FolioFold 后应当看到的实际访问地址告诉我，并如实说明它当前用的是默认域名还是自定义域名、中间页是否会出现。',
    '   · ⚠ 再强调一次交付标准：这个任务的成果要落到 **FolioFold 里可见可点的站点链接**。如果我把配置粘回面板、点了发布，却没有拿到链接，请继续排查（密钥/环境/托管/上传权限哪一环断了），直到 FolioFold 里出现可访问链接为止；不要停在「腾讯云上已经部署好了」就算完。',
    '',
    '任何一步失败，直接说清楚卡在哪、什么原因、我下一步该点哪里；不要反复重试同一个已失败的操作，也不要凭猜测下结论。',
  ].join('\n');
  const cbPromptWorkBuddy = () => [
    '【任务】',
    '帮我把 FolioFold 作品集站点真实部署到腾讯云 CloudBase 静态网站托管。',
    '⚠ 终点不是「腾讯云上有个站点」，而是「回到 FolioFold 发布面板，点一下发布，就能在 FolioFold 里看到并打开这个站点的访问链接」。没在 FolioFold 里拿到能打开的链接，这个任务就不算完成。',
    '你具备腾讯云 API 与命令行能力，请尽量代替我执行，只在平台硬限制处（免费环境的创建）停下来引导我。全程遵守：能代做的直接代做，不要写成教程丢给我。',
    '',
    '【执行前先探测现状（不要跳过）】',
    '先只读查询，再决定做什么：',
    '· CheckTcbService / DescribeEnvs：云开发是否开通、已有哪些环境；',
    '· DescribeStaticStore：目标环境静态托管是否已开通、默认域名是什么；',
    '· 是否已有可用密钥。',
    '已完成的步骤一律跳过，不要重复询问我、更不要重复下单。',
    '⚠ 常见错误：环境其实已经创建好了，却还让我再去建一个。先查再说。',
    '',
    '【需要我确认的事】',
    '安装 tccli（或其它命令行工具）是代操作的前提，可以装；但动手前先告诉我：装什么、干什么用、装到哪个路径、能否迁移。若当前会话已是「允许完全访问」，可直接装，最后汇报时说明清楚。',
    '',
    '【步骤】',
    '1. 账号与实名：未登录先登录 https://cloud.tencent.com/ ，未实名先实名。已能用 tccli 成功调用腾讯云接口的，说明这两步已就绪，直接跳过。',
    '2. 开通云开发：打开 https://console.cloud.tencent.com/tcb ，首次需勾选《服务条款》并完成「云开发服务角色权限授权」。若 CheckTcbService 显示已开通，跳过。',
    '3. 创建环境：⚠ 这一步只能我做。免费体验版是控制台网页端活动，API / tccli 的 CreateEnv 下单走的是付费套餐（余额不足会报「账户余额不足」），不要尝试用 API 创建，也不要重试。若 DescribeEnvs 显示已有环境，直接跳到第 4 步。',
    '   需要我建时，请把 https://console.cloud.tencent.com/tcb 打开、停在那里等我，并告诉我点哪里、表单怎么选：',
    '   · 套餐：免费体验版（0 元/月，单账号限 1 个，每月 3000 资源点）。不要选个人版。',
    '   · 地域：上海（或就近）。数据库：默认「云数据库」（文档型）。标签留空。备案说明跳过。购买时长：免费试用 6 个月（0 元）。',
    '   建好后我把「环境 ID」发你，你在这里停下等我，不要自己往下做。',
    '4. 开通静态网站托管：拿到环境 ID 后，先用 DescribeStaticStore 查是否已开通——**已经开通就直接跳过，不要再让我去点开通**。未开通才带我去开。默认域名从接口读实际值，不要猜 <envId>.tcloudbaseapp.com 这种拼法。',
    '5. 创建 API 密钥（最小权限，你来做）：',
    '   · 能否代挂策略取决于你给我的凭证本身有没有 CAM 管理权限（QcloudCamFullAccess / cam:AttachUserPolicy）：',
    '     - 有 CAM 管理权限（主账号密钥，或带 QcloudCamFullAccess 的子账号密钥）→ 直接调用 AttachUserPolicy 把两条策略挂到目标子账号上，包括给你**现有的**那把子账号补挂 QcloudCOSFullAccess，真正一键部署；优先用子账号密钥，主账号全密钥只在应急时用、用完即删。',
    '     - 只给现在这把受限子账号密钥（它自己无 CAM 权限）→ 它不能自己提权（腾讯云禁止），必须你或主账号先在 CAM 控制台手动补挂；我会一开始就说明缺哪个权限、去哪开，不等到上传失败才讲。',
    '   · 你目前的情况（子账号已建好、上传 Access Denied）：无需新建用户，直接给那把子账号补挂 QcloudCOSFullAccess 即可；我手上有 CAM 管理凭证就直接代挂，没有就带你在 https://console.cloud.tencent.com/cam 里点、停在要点处等你做完。',
    '   · 若无法代建，就带我在 https://console.cloud.tencent.com/cam 里点，并说清两条路径的区别：快速创建＝只填用户名、默认自动带 AdministratorAccess（全权限）；自定义创建＝可选用户类型与访问方式、逐条指定策略。我们要最小权限，选「自定义创建」→ 用户类型「可访问资源并接收消息」→ 访问方式勾「编程访问」→ 策略勾上面那两条。「仅用于接收消息」的账号没有编程访问能力，不能部署，不要选。',
    '   · 生成密钥时，SecretKey 只显示一次，请立刻保存；同时告诉我你把它存在哪里、是否可迁移。不要把密钥写进任何会进 Git 的文件。',
    '   · ⚠ 必须两条都挂，只挂 QcloudTCBFullAccess 不够：会出现「DescribeEnvs 能读、但上传每个文件都 Access Denied」——因为上传底层是往对象存储（COS）写对象，需要 QcloudCOSFullAccess 那层的权限。',
    '   · ⚠ 部署前先做写入体检再上传：用 DescribeStaticStore 取到存储桶名，确认对该桶有写入权限（先 PUT 一个 0 字节自检对象、成功即删）。若你手上的密钥没有 CAM 管理权限、挂不了策略，就把 CAM 页面打开停在那里告诉我点哪里，等我做完再继续——不要只说一句"没权限"就把问题丢回给我。',
    '',
    '6. 汇总输出（这是交付终点，不是中间步骤）：按下面格式整段发我，我会**粘回 FolioFold 发布面板**自动填入。填入后点「发布」，FolioFold 会把站点上传到该环境，并在面板里直接显示访问链接。所以必须确认：我能在 FolioFold 里看到并打开站点链接，而不是只知道腾讯云上有个环境。',
    '',
    '===== FolioFold CloudBase 配置 =====',
    'EnvId: <环境 ID>',
    'SecretId: <SecretId>',
    'SecretKey: <SecretKey>',
    '默认访问域名: <实际域名>',
    '===== 结束 =====',
    '',
    '⚠ 默认域名不要凭格式猜：它的实际形态是 <envId>-<随机数字串>.tcloudbaseapp.com，随机串由平台分配，只能从 DescribeStaticStore 的 CdnDomain 字段读，拼不出来。',
    '',
    '请明确告诉我：把这段粘回 FolioFold 面板 → 点发布 → 即可得到站点访问链接（形如 https://<默认访问域名>）。并附一段状态说明：这个免费环境的到期时间、剩余资源点（查得到就写）、密钥存放位置与是否可迁移、这轮安装了什么工具及用途。',
    '',
    '7. 发布后交付物与限制（你必须主动核实并向我说明，不要等我问）：',
    '   · 存储原理：静态托管的文件实际存在该环境绑定的**对象存储 COS** 里，托管只是对外访问入口。因此上传动作走的是 COS 写权限——只挂 QcloudTCBFullAccess 会出现「DescribeEnvs 读得到、上传全 Access Denied」。',
    '   · 配额原因：免费体验版按「资源点」计量（每月 3000 点），容量与流量有上限，且**单账号限 1 个环境**；大媒体（如 >50MB 视频）会明显消耗配额，先本地压缩再传。',
    '   · 中间页：平台默认域名（*.tcloudbaseapp.com 等）**仅供开发测试**。访客浏览器直接导航访问时会先出现「访问提示中间页」（非导航请求会返回 attachment 下载而非内联播放），需点「确定访问」方可进入；该中间页无法通过配置关闭，**唯一合规的去除方式是绑定一个已完成 ICP 备案的自定义域名**。默认域名另有访问频率限制，异常流量可能被禁止访问。官方说明见 https://docs.cloudbase.net/service/alias 。',
    '   · 单文件上限：官方对静态托管单文件大小的说明在不同渠道并不一致，**不要引用未经官方确认的数字**；命令行通道对大文件更友好，大媒体优先走命令行上传。',
    '   · 部署完成后，请把我回填 FolioFold 后应当看到的实际访问地址给我，并如实说明当前是默认域名还是自定义域名、访问时是否会出现中间页。',
    '   · ⚠ 再强调一次交付标准：这个任务的成果要落到 **FolioFold 里可见可点的站点链接**。如果我把配置粘回面板、点了发布，却没有拿到链接，请继续排查（密钥/环境/托管/上传权限哪一环断了），直到 FolioFold 里出现可访问链接为止；不要停在「腾讯云上已经部署好了」就算完。',
    '',
    '任何一步失败，直接说清楚卡在哪、什么原因、我下一步该点哪里；不要反复重试已失败的操作，也不要凭猜测下结论。',
  ].join('\n');
  // 从 Agent 返回的汇总文本里解析出三个值（容错中英文冒号、大小写、前后引号，以及整段对话粘贴）。
  const cbParseConfig = (text) => {
    const t = String(text || '');
    const g = (re) => { const m = t.match(re); return m ? m[1].trim().replace(/^["'\u201c\u201d\s]+|["'\u201c\u201d\s]+$/g, '') : ''; };
    let envId     = g(/env\s*id\s*[:：]\s*([A-Za-z0-9_\-.]+)/i);
    let secretId  = g(/secret\s*id\s*[:：]\s*([A-Za-z0-9_\-.]+)/i);
    let secretKey = g(/secret\s*key\s*[:：]\s*([A-Za-z0-9_\-.]+)/i);
    // 兜底：粘贴的是整段对话（带前后文、代码块、没有 key: 前缀）时也要认出来。
    if (!secretId) secretId = g(/\b(AKID[A-Za-z0-9]{12,40})\b/);
    if (!envId) {
      const m = t.match(/\b([a-z0-9][a-z0-9-]{1,40}-[a-z0-9]{8,24})\b/);
      if (m) envId = m[1];
    }
    if (!secretKey) {
      const m = t.match(/\b([A-Za-z0-9]{32,64})\b/g) || [];
      const cand = m.find(x => /[A-Z]/.test(x) && /[a-z]/.test(x) && /\d/.test(x) && !/^AKID/i.test(x));
      if (cand) secretKey = cand;
    }
    return { envId, secretId, secretKey };
  };
  // 复制提示词到剪贴板（带 execCommand 兜底），并临时改按钮文字反馈。
  // kind: 'generic'（通用，任意 Agent 可用）| 'workbuddy'（WorkBuddy 专用，可代操作）
  const cbCopyPrompt = async (btn, kind) => {
    const text = (kind === 'workbuddy') ? cbPromptWorkBuddy() : cbPromptGeneric();
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (e) {}
    if (!ok) {
      const ta = document.createElement('textarea'); ta.value = text;
      ta.style.position = 'fixed'; ta.style.left = '-9999px';
      document.body.appendChild(ta); ta.select();
      try { ok = document.execCommand('copy'); } catch (e) {}
      ta.remove();
    }
    if (!ok) { toast('复制失败，请展开「查看提示词全文」手动复制。'); return; }
    const old = btn.textContent;
    btn.textContent = '✓ 已复制，去粘贴给 Agent';
    setTimeout(() => { btn.textContent = old; }, 3500);
  };
  // 「访问须知（默认域名的中间页）」：CloudBase 默认域名（*.tcloudbaseapp.com）仅供开发测试，
  // 浏览器直接访问（导航请求）会先展示「访问提示中间页」，访客点「确定访问」才能进入；
  // 且默认域名有访问频率限制。唯一合规的去除方式 = 绑定已完成 ICP 备案的自定义域名。
  // 官方依据：https://docs.cloudbase.net/service/alias（默认域名访问限制及中间页）。
  // ⚠ 改这里必须同步 app-v3.js 的 cbAccessNoteHtml（两份文案逐字一致）。
  const stCbAccessNoteHtml = () => `<p class="st-publish-note" style="margin-top:10px;font-size:12px;opacity:.72"><b>访问须知（默认域名的中间页）：</b>平台默认域名（<code>*.tcloudbaseapp.com</code>）仅供开发测试使用。访客用浏览器直接打开时，会先看到一个「<b>访问提示中间页</b>」——提示当前环境仅供开发测试、内容未经合规审核，点「<b>确定访问</b>」后即可进入；同一访客在 Cookie 有效期内不会重复出现。该中间页无法关闭，<b>唯一合规的去除方式是绑定一个已完成 ICP 备案的自定义域名</b>。此外默认域名存在访问频率限制，访问量异常时平台可能限制访问，面向正式用户请使用自定义域名。详见 ${cbLink('https://docs.cloudbase.net/service/alias','官方说明 ↗')}。</p>`;
  const cbDocsHtml = () => `<p><b>用途：</b>把当前作品集部署到腾讯云 CloudBase 静态网站托管（国内节点）。</p>
        <p><b>需要：</b>腾讯云账号 + 实名认证 + 一个 CloudBase 环境（免费体验版即可）。</p>
        <p><b>去哪配置：</b>${cbLink(CB_CONSOLE_LINKS.env, 'CloudBase 控制台 ↗')}　${cbLink(CB_CONSOLE_LINKS.cam, 'API 密钥管理 ↗')}</p>
        <p><b>官方文档：</b>${CB_OFFICIAL_LINKS}</p>
        <p class="st-publish-note" style="font-size:12px;opacity:.75">配额、计费、单文件大小限制等均以官方文档为准；大媒体建议用 CloudBase CLI 部署。</p>
        ${stCbAccessNoteHtml()}`;
  // 尚未接通真实云 API，必须如实标注，不能让用户以为是"点一下就能发"。
  const cbNotVerified = `<p class="st-publish-note" style="color:#9a6700"><b>当前状态：</b>部署代码已接入真实 CloudBase CLI 链路（密钥登录 + 静态托管上传），填入你自己的腾讯云凭证后即可真实发布；尚未用真实账号完成端到端发布验证。</p>`;
  // —— 站点有效期 / 额度提醒 ——
  // 数据来自 /api/cloudbase/quota（只读 DescribeBillingInfo）。
  // ⚠ 拿不到就显示「未知」，绝不猜天数；免费额度规则一律指向官方文档。
  const stCbRenderQuota = async () => {
    const box = document.getElementById('st-cb-quota-box');
    if (!box) return;
    box.style.display = 'block';
    box.innerHTML = '<p class="st-publish-note">正在读取该环境的套餐与到期信息…</p>';
    let r = null;
    try { r = await post('/api/cloudbase/quota', {}); } catch (e) {}
    if (!r || !r.ok) {
      box.innerHTML = '<p class="st-publish-note" style="color:#9a6700"><b>站点有效期：</b>暂时读不到（' +
        esc((r && r.error) || '网络不可用') + '）。可在 ' + cbLink(CB_CONSOLE_LINKS.envList, 'CloudBase 控制台 ↗') +
        ' 的「套餐用量」查看到期时间与剩余资源点。</p>';
      return;
    }
    const lines = [];
    const isFree = /trial|free/i.test(r.packageId || '') || r.isAlwaysFree;
    lines.push('<b>套餐：</b>' + esc(r.packageId || '未知') + (isFree ? '（免费体验版）' : '') +
      (r.autoRenew ? '　自动续费：已开启' : '　自动续费：未开启（免费版不支持自动续费）'));
    const exp = (r.expireTime || '').trim();
    let days = null;
    if (exp) {
      const t = Date.parse(exp.replace(/-/g, '/'));
      if (!isNaN(t)) days = Math.ceil((t - Date.now()) / 86400000);
    }
    if (exp) {
      let tail = '';
      if (days !== null) {
        if (days < 0) tail = '　<span style="color:#c0392b;font-weight:600">已到期</span>';
        else if (days <= 30) tail = '　<span style="color:#c0392b;font-weight:600">仅剩 ' + days + ' 天，建议尽快续期</span>';
        else if (days <= 60) tail = '　<span style="color:#9a6700;font-weight:600">剩余 ' + days + ' 天</span>';
        else tail = '　<span style="color:#0a7d33;font-weight:600">剩余 ' + days + ' 天</span>';
      }
      lines.push('<b>到期时间：</b>' + esc(exp) + tail);
    } else {
      lines.push('<b>到期时间：</b>未知（接口未返回，请在控制台「套餐用量」查看）');
    }
    if (r.status) lines.push('<b>环境状态：</b>' + esc(r.status) + (r.status !== 'NORMAL' ? '（非正常，可能已隔离或停服）' : ''));
    if (r.freeQuota) lines.push('<b>免费配额：</b>' + esc(r.freeQuota));
    lines.push('<span style="font-size:12px;opacity:.8">免费体验版：3000 资源点/月，单次 6 个月，到期前 1 个月内可 0 元续 6 个月；资源点用尽会停服。' +
      '规则以' + cbLink('https://cloud.tencent.com/document/buy-guide/876/127357', '官方文档 ↗') + '为准；去 ' +
      cbLink(CB_CONSOLE_LINKS.envList, '控制台套餐用量 ↗') + ' 续期或查看剩余额度。</span>');
    box.innerHTML = '<p class="st-publish-note" style="line-height:1.9">' + lines.join('<br>') + '</p>';
  };
  const stRenderCloudBaseSection = (pv, cb, deployBtnHtml, fresh) => {
    if (!pv) return;
    const btn = typeof deployBtnHtml === 'function' ? deployBtnHtml : ((l) => `<button class="st-btn primary" id="st-publink-deploy">${l}</button>`);
    // ⚠ 已发布链接不依赖当前 CloudBase 配置：只要有记录就照常列出（历史事实），
    // 配置丢失只是"无法更新/更新发布"，已有的公网链接仍可正常访问。
    // ⚠⚠ 必须按「当前模板」过滤：旧实现用 cb.publicUrl / deployments[0].url，导致切到任何模板
    //   都显示成"已发布"并挂着别人的链接（测试模板一打开就显示"该模板已有链接"）。
    //   现在只用本模板自己的最后一条发布记录（stLastDeployOf 已按 tpl 过滤）。
    const cbLast = stLastDeployOf(cb.deployments, tpl);
    const cbUrl = cbLast ? (cbLast.url || '') : '';
    if (cbLast) {
      const cbConnBanner = (!cb.configured)
        ? `<p class="st-publish-note" style="color:#9a6700">⚠ CloudBase 当前未配置 / 配置已失效。<b>你已有的发布链接仍可正常访问</b>；只有「更新当前发布 / 更新发布 / 改发布内容」需要先重新配置 CloudBase 才能操作。</p>`
        : '';
      pv.innerHTML = `<div class="st-publish-section">
        <p>平台：<b>CloudBase 静态网站托管</b> · 环境：<b>${esc(cb.envId || '')}</b> · 状态：<b>已发布</b></p>
        ${stLastDeployHtml((stLastDeployOf(cb.deployments, tpl) || {}).deployedAt, fresh, '更新当前发布')}
        <div id="st-cb-quota-box" class="st-publish-note" style="display:none;border-left:3px solid #0a7d33"></div>
        <p class="st-publish-note">公开地址（任何人无需安装 FolioFold 即可浏览）：</p>
        <div class="st-code-row"><input class="st-code-input" id="st-publink-url" readonly value="${esc(cbUrl)}"></div>
        <div class="st-publish-actions">
          <a class="st-btn" href="${esc(cbUrl)}" target="_blank" rel="noopener">打开 FolioFold ↗</a>
          <button class="st-btn" id="st-publink-copy">复制</button>
          ${cb.configured ? btn('更新当前发布') : `<button class="st-btn" disabled title="先重新配置 CloudBase 才能更新">更新当前发布</button>`}
          <span style="margin-left:auto;font-size:12px;opacity:.7;align-self:center">仅更新 CloudBase 下本模板的当前公开地址，其它模板的链接不受影响</span>
          <button class="st-btn" id="st-publink-reconfig">重新配置</button>
        </div>
        ${cbConnBanner}
        ${stDepListHtml(cb.deployments, tpl, '这个平台下还没有任何发布记录。')}
        ${cb.configured ? stNewDeployHtml('cloudbase', tpl, (cb.deployments||[]).map(d=>d.path).filter(Boolean)) : ''}
        <p class="st-publish-note" style="opacity:.7">官方文档：${CB_OFFICIAL_LINKS}</p>
        ${stCbAccessNoteHtml()}
        <p class="st-publish-note">「更新当前发布」只覆盖本模板现在这个地址，同一环境下其它模板的地址不受影响。也可以改用「导出 ZIP」，把包上传到静态网站托管，无需密钥。</p></div>`;
      stCbRenderQuota();
      stWireDepList(pv, cb.deployments, () => stRenderPublink(), 'cloudbase');
      if (cb.configured) {
        stWireNewDeploy(pv, 'cloudbase', tpl, stHostingBaseOf(cbUrl), (path, tplSel) => {
          if (path && !/^[A-Za-z0-9_-]+$/.test(path)) { toast('路径名只能用字母、数字、- 和 _'); const b=document.getElementById('st-publink-newdep-go'); if(b) delete b.dataset.busy; return; }
          stRunDeploy('cloudbase', 'new', path, document.getElementById('st-publink-newdep-go'), tplSel);
        });
      }
    } else if (cb.configured) {
      pv.innerHTML = `<div class="st-publish-section">
        <p>平台：<b>CloudBase 静态网站托管</b> · 环境：<b>${esc(cb.envId || '')}</b> · 状态：<b>已配置（尚未发布）</b></p>
        <div id="st-cb-quota-box" class="st-publish-note" style="display:none;border-left:3px solid #0a7d33"></div>
        ${cbNotVerified}
        <div class="st-publish-actions">
          ${btn('发布到 CloudBase')}
          <button class="st-btn" id="st-publink-reconfig">重新配置</button>
        </div>
        <p class="st-publish-note" style="opacity:.7">官方文档：${CB_OFFICIAL_LINKS}</p>
        ${stCbAccessNoteHtml()}</div>`;
      stCbRenderQuota();
      // 失败原因必须**常驻**贴回面板：否则后端返回的 `发布失败：xxx`
      // 会被这里整体重渲抹掉，用户只看到「已配置（尚未发布）」，误以为点了没反应。
      stPubuiMount();
    } else {
      pv.innerHTML = `<div class="st-publish-section">
        <div class="st-publish-note" style="line-height:1.7">${cbDocsHtml()}</div>
        ${cbNotVerified}
        <div class="st-publish-actions">
          <button class="st-btn primary" id="st-publink-setup">配置腾讯云</button>
          <button class="st-btn" id="st-publink-tozip">改用「导出 ZIP」（无需配置）</button>
        </div>
        <p class="st-publish-note" style="font-size:12px;opacity:.72">配置步骤、指令、密钥填写都在「配置腾讯云」里。</p></div>`;
      const z = document.getElementById('st-publink-tozip');
      if (z) z.onclick = () => { __stPubProvider = 'zip'; stRenderPublink(); };
    }
    const setup = document.getElementById('st-publink-setup');
    if (setup) setup.onclick = () => stRenderCloudBaseSetup(pv);
    const recfg = document.getElementById('st-publink-reconfig');
    if (recfg) recfg.onclick = () => stRenderCloudBaseSetup(pv);
  };

  // CloudBase 凭证表单。SecretKey 用 password 输入，且保存成功后服务端不回显，
  // 页面上永远看不到明文。
  const stRenderCloudBaseSetup = (pv) => {
    if (!pv) return;
    __stSetupOpen = true;   // 表单开着期间禁止自愈重渲，否则用户填到一半的内容会被清空
    pv.innerHTML = `<div class="st-publish-section">
      <p class="st-publish-note"><b>配置腾讯云（只需做一次）</b>　可以按下面 6 步手动做，也可以复制指令让 Agent 代做。凭证只保存在本机，不会进入作品集数据或导出的 ZIP。</p>
      <div class="st-publish-note" style="border-left:3px solid #0a7d33;line-height:1.7">
        <p><b>已有环境？先检测</b>　填入 SecretId / SecretKey 后只读查询（不改动任何资源，密钥不出本机）。</p>
        <div class="st-publish-actions">
          <button class="st-btn primary" id="st-cb-probe-btn">🔍 检测我的 CloudBase 环境</button>
          <button class="st-btn" id="st-cb-permcheck-btn">🔐 权限体检（能否上传）</button>
        </div>
        <div id="st-cb-probe-out" style="display:none;margin-top:8px"></div>
        <p style="font-size:12.5px;margin:10px 0 4px"><b>把 Agent 的回复整段粘到这里，会自动识别填入：</b></p>
        <textarea class="st-code-input" id="st-cb-parse-text" rows="4" placeholder="粘贴包含 EnvId / SecretId / SecretKey 的整段内容…"></textarea>
        <div id="st-cb-parse-msg" style="font-size:12px;margin-top:4px"></div>
      </div>
      <p style="margin:14px 0 6px"><b>让 Agent 代做（推荐）</b>　复制任一版指令粘给 Agent：</p>
      <div class="st-publish-actions">
        <button class="st-btn primary" id="st-cb-copy-prompt">📋 通用指令</button>
        <button class="st-btn" id="st-cb-copy-prompt-wb">📋 WorkBuddy 增强版</button>
      </div>
      <p class="st-publish-note" style="font-size:12px;opacity:.75">
        <b>通用指令</b>：任意 Agent（Codex、DeepSeek 等）都能用，由它逐步引导你在网页操作。<br>
        <b>WorkBuddy 增强版</b>：额外授权 Agent 直接调用腾讯云接口代执行（读环境与托管状态、代建最小权限子账号并签发密钥），只有「创建免费环境」因平台限制需你本人操作。用 WorkBuddy 优先选这版。
      </p>
      <details style="margin-top:6px"><summary style="cursor:pointer;font-size:12px;opacity:.8">查看指令全文</summary>
        <p style="font-size:12px;opacity:.7;margin:6px 0 2px"><b>通用指令</b></p>
        <pre style="white-space:pre-wrap;font-size:12px;line-height:1.5;background:#fff;border:1px solid #e5e5e5;border-radius:6px;padding:10px">${esc(cbPromptGeneric())}</pre>
        <p style="font-size:12px;opacity:.7;margin:10px 0 2px"><b>WorkBuddy 增强版</b></p>
        <pre style="white-space:pre-wrap;font-size:12px;line-height:1.5;background:#fff;border:1px solid #e5e5e5;border-radius:6px;padding:10px">${esc(cbPromptWorkBuddy())}</pre>
      </details>
      <p style="margin:16px 0 4px"><b>手动配置 6 步</b></p>
      <div class="st-publish-note" style="line-height:1.7">
        <p><b>① 登录并实名</b>　打开 ${cbLink('https://cloud.tencent.com/', '腾讯云官网 ↗')} 登录；未实名点右上角头像 → <b>账号信息 → 实名认证</b>（个人实名即可）。</p>
        <p><b>② 开通云开发</b>　打开 ${cbLink(CB_CONSOLE_LINKS.env, 'CloudBase 控制台 ↗')}（注意是 CloudBase 控制台，不是腾讯云首页）。首次需按指引「<b>开通云开发</b>」（同意服务条款 + 授权服务角色），<b>开通后「新建环境」入口才会出现</b>。</p>
        <p><b>③ 新建环境，拿到环境 ID</b>　点「新建环境」，套餐选「<b>免费体验版</b>」（0 元/月，限 1 个，3000 资源点/月），地域就近，其余用默认值。建好后复制<b>环境 ID</b>。<br><span style="color:#0a7d33;font-weight:600">→ 填到本页底部「EnvId」框</span></p>
        <p style="margin:0 0 6px 0;color:#9a6700;font-size:12.5px">⚠ 免费体验版是<b>控制台网页端</b>活动，用 API / 命令行下单会走正价，所以这一步只能你在网页上点。规则以 ${cbLink('https://cloud.tencent.com/document/buy-guide/876/127357','官方文档 ↗')} 为准（单次 6 个月，到期前 1 个月内可 0 元续 6 个月，不会自动续费，资源点用尽会停服）。</p>
        <p><b>④ 开通静态网站托管</b>　进入该环境的「<b>静态网站托管</b>」并开通，会得到一个默认域名。<b>不开通发布会失败。</b>去 ${cbLink(CB_CONSOLE_LINKS.hosting, '静态网站托管 ↗')}。<br><span style="color:#0a7d33;font-weight:600">已开通就不用再点——上面的「检测我的 CloudBase 环境」会直接告诉你状态和域名。</span></p>
        <p><b>⑤ 新建 API 密钥</b>　推荐在 ${cbLink('https://console.cloud.tencent.com/cam', '访问管理 CAM ↗')} →「<b>用户列表 → 新建用户</b>」选「<b>自定义创建</b>」：用户类型选「<b>可访问资源并接收消息</b>」，访问方式勾「<b>编程访问</b>」，在「设置用户策略」这一步就把 <b>两条</b>策略勾上：<b>QcloudTCBFullAccess</b> + <b>QcloudCOSFullAccess</b>——<b>创建时就挂好</b>，不要留到后面再补。<br><b>两条缺一不可</b>：只有前者时能读到环境，但上传每个文件都会 <b>Access Denied</b>——因为上传底层是往对象存储（COS）写对象，靠的是后者那层权限（QcloudCOSFullAccess＝对象存储 COS 全读写访问权限，含上传动作）。<br><b>已有子账号要补权限？</b>在「<b>用户列表</b>」里点该子账号<b>那一行</b>右侧操作列的「<b>授权</b>」→ 在「关联策略」窗口搜上面两个策略名 → 勾选 → 确定。注意：授权入口在<b>列表行</b>上，主账号行没有这个入口。<br>（<b>不要</b>选「快速创建」——它默认带 AdministratorAccess 全权限；「仅用于接收消息」不能编程访问，不能部署。）<br><span style="color:#0a7d33;font-weight:600">→ SecretId / SecretKey 填到本页底部；SecretKey 只在创建时显示一次，立刻保存</span></p>
        <p><b>⑥ 保存并发布</b>　填好三个值 → 点「保存配置」→ 关闭本面板 → 在发布面板点「<b>发布到 CloudBase</b>」。之后每次更新只需再点一次发布。</p>
        <p style="color:#9a6700"><b>安全：</b>SecretKey 相当于账号密码，勿截图分享、勿提交 Git；密钥存放于本机 <code>.folioframe/cloudbase.json</code>。</p>
        <p><b>官方文档：</b>${CB_OFFICIAL_LINKS}</p>
      </div>
      <label class="st-field-label" for="st-cb-env">EnvId（环境 ID）</label>
      <input class="st-code-input" id="st-cb-env" placeholder="如 my-env-1a2b3c" autocomplete="off">
      <label class="st-field-label" for="st-cb-sid">SecretId</label>
      <input class="st-code-input" id="st-cb-sid" placeholder="AKIDxxxxxxxxxxxxxxxx" autocomplete="off">
      <label class="st-field-label" for="st-cb-skey">SecretKey</label>
      <input class="st-code-input" id="st-cb-skey" type="password" placeholder="只保存在本机，不会显示在页面上" autocomplete="new-password">
      <label class="st-field-label" for="st-cb-path">部署子目录（可选，留空为站点根目录）</label>
      <input class="st-code-input" id="st-cb-path" placeholder="如 portfolio">
      <div class="st-publish-actions">
        <button class="st-btn" id="st-publink-cfg-cancel">取消</button>
        <button class="st-btn primary" id="st-publink-cfg-save">保存配置</button>
      </div></div>`;
    // 配置字段必须在打开面板时立刻可见：原来 6 步说明把真正的输入框推到了文档底部。
    // 这里只重排刚刚创建的 DOM，不改任何字段 id 或保存/体检状态机。
    const setupRoot = pv.querySelector('.st-publish-section');
    const configCard = document.createElement('section');
    configCard.className = 'st-cb-config-card';
    configCard.innerHTML = '<h3>填写配置</h3><p>填写后可直接保存；下面的说明与帮助链接仍可展开查看。</p>';
    const configNodes = ['st-cb-env','st-cb-sid','st-cb-skey','st-cb-path'].flatMap(id => {
      const input = document.getElementById(id);
      const label = input ? document.querySelector('label[for="' + id + '"]') : null;
      return [label, input].filter(Boolean);
    });
    const configActions = document.getElementById('st-publink-cfg-save')?.closest('.st-publish-actions');
    if (setupRoot && configNodes.length) {
      setupRoot.insertBefore(configCard, setupRoot.children[1] || null);
      configNodes.forEach(node => configCard.appendChild(node));
      if (configActions) configCard.appendChild(configActions);
    }
    const cpb = document.getElementById('st-cb-copy-prompt');
    if (cpb) cpb.onclick = () => cbCopyPrompt(cpb, 'generic');
    const cpbw = document.getElementById('st-cb-copy-prompt-wb');
    if (cpbw) cpbw.onclick = () => cbCopyPrompt(cpbw, 'workbuddy');
    // 自动识别：粘贴/输入即解析（不再依赖"解析"按钮），并明确回报识别结果。
    const stApplyParsed = () => {
      const ta = document.getElementById('st-cb-parse-text');
      const msg = document.getElementById('st-cb-parse-msg');
      if (!ta) return 0;
      const cfg = cbParseConfig(ta.value || '');
      let n = 0;
      if (cfg.envId) { const e = document.getElementById('st-cb-env'); if (e) { e.value = cfg.envId; n++; } }
      if (cfg.secretId) { const e = document.getElementById('st-cb-sid'); if (e) { e.value = cfg.secretId; n++; } }
      if (cfg.secretKey) { const e = document.getElementById('st-cb-skey'); if (e) { e.value = cfg.secretKey; n++; } }
      if (msg) {
        if (!(ta.value || '').trim()) msg.textContent = '';
        else if (n === 0) msg.innerHTML = '<span style="color:#9a6700">还没识别出可用的配置值。请粘贴包含 EnvId / SecretId / SecretKey 的整段内容（带不带标签都能识别）。</span>';
        else msg.innerHTML = '<span style="color:#0a7d33">✓ 已自动识别并填入 ' + n + ' 个字段：' +
          [cfg.envId ? 'EnvId' : '', cfg.secretId ? 'SecretId' : '', cfg.secretKey ? 'SecretKey' : ''].filter(Boolean).join(' / ') +
          '。确认无误后点「保存配置」。</span>';
      }
      return n;
    };
    const stPta = document.getElementById('st-cb-parse-text');
    if (stPta) {
      stPta.addEventListener('input', stApplyParsed);
      stPta.addEventListener('paste', () => setTimeout(stApplyParsed, 30));
    }
    // 「权限体检」：回答"这把密钥到底能不能上传"。
    // ⚠ 必须在**配置阶段**就能点，而不是等发布失败了才知道权限不够（真实故障 2026-09-19）：
    //   静态托管上传底层是往对象存储（COS）写对象，读得到环境不等于写得进去。
    //   这里只读探测 + 一次 0 字节写入自检（成功即刻删除），不改动任何业务数据。
    const pkbtn2 = document.getElementById('st-cb-permcheck-btn');
    if (pkbtn2) pkbtn2.onclick = async () => {
      const out = document.getElementById('st-cb-probe-out');
      const sid = (document.getElementById('st-cb-sid').value || '').trim();
      const skey = (document.getElementById('st-cb-skey').value || '').trim();
      const envEl = document.getElementById('st-cb-env');
      const envid = envEl ? (envEl.value || '').trim() : '';
      if (!sid || !skey) {
        if (out) { out.style.display = 'block'; out.innerHTML = '<p class="st-publish-warn">请先在页面底部填写 <b>SecretId / SecretKey</b>，再点体检（需要凭证）。</p>'; }
        return;
      }
      pkbtn2.disabled = true; const oldTxt = pkbtn2.textContent; pkbtn2.textContent = '体检中…';
      if (out) { out.style.display = 'block'; out.innerHTML = '<p class="st-publish-note">正在体检：读取环境 + 一次 0 字节写入自检（自检文件立即删除）…</p>'; }
      try {
        const r = await fetch('/api/cloudbase/permcheck', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ secretId: sid, secretKey: skey, envId: envid })
        }).then((x) => x.json());
        if (out) out.innerHTML = stPubPermReportHtml(r);
      } catch (e) {
        if (out) out.innerHTML = '<p class="st-publish-warn">体检请求失败：' + esc(String((e && e.message) || e)) + '</p>';
      } finally { pkbtn2.disabled = false; pkbtn2.textContent = oldTxt; }
    };
    // 「检测我的 CloudBase 环境」：只读查询，列出环境并支持一键填入 EnvId
    const pbtn2 = document.getElementById('st-cb-probe-btn');
    if (pbtn2) pbtn2.onclick = async () => {
      const out = document.getElementById('st-cb-probe-out');
      const sid = (document.getElementById('st-cb-sid').value || '').trim();
      const skey = (document.getElementById('st-cb-skey').value || '').trim();
      if (!sid || !skey) {
        if (out) { out.style.display = 'block'; out.innerHTML = '<p class="st-publish-note" style="color:#9a6700">请先在页面底部填写 <b>SecretId / SecretKey</b>，再点检测（只读查询需要凭证）。</p>'; }
        return;
      }
      pbtn2.disabled = true; const old = pbtn2.textContent; pbtn2.textContent = '查询中…';
      if (out) { out.style.display = 'block'; out.innerHTML = '<p class="st-publish-note">正在只读查询你的 CloudBase 环境…</p>'; }
      try {
        const r = await post('/api/cloudbase/probe', { secretId: sid, secretKey: skey });
        if (!r.ok) {
          out.innerHTML = '<p class="st-publish-note" style="color:#c0392b">查询失败：' + esc(r.error || '未知错误') + '</p>';
        } else if (!(r.environments || []).length) {
          out.innerHTML = '<p class="st-publish-note" style="color:#9a6700">你的账号下还没有 CloudBase 环境。请到 ' + cbLink(CB_CONSOLE_LINKS.env, 'CloudBase 控制台 ↗') + ' 新建一个（免费体验版，只能在网页创建）。</p>';
        } else {
          const rows = r.environments.map(e => {
            const st = e.staticOpened
              ? '<span style="color:#0a7d33">静态托管已开通' + (e.staticDomain ? '：' + esc(e.staticDomain) : '') + '</span>'
              : '<span style="color:#9a6700">静态托管未开通</span>';
            return '<div style="padding:8px 10px;border:1px solid #e5e5e5;border-radius:6px;margin:6px 0;background:#fff">' +
              '<div><b>' + esc(e.envId) + '</b>' + (e.alias ? '（' + esc(e.alias) + '）' : '') + '</div>' +
              '<div style="font-size:12px;opacity:.8">套餐：' + esc(e.packageName || '未知') + '　地域：' + esc(e.region || '未知') + '　状态：' + esc(e.status || '未知') + '</div>' +
              '<div style="font-size:12px;margin-top:2px">' + st + '</div>' +
              '<button class="st-btn" data-use-env="' + esc(e.envId) + '" style="margin-top:6px">用这个环境 ID</button>' +
              '</div>';
          }).join('');
          out.innerHTML = '<p class="st-publish-note">共 ' + r.environments.length + ' 个环境（只读查询，未改动任何资源）：</p>' + rows;
          out.querySelectorAll('[data-use-env]').forEach(b => {
            b.onclick = () => {
              const v = b.getAttribute('data-use-env');
              const e = document.getElementById('st-cb-env');
              if (e) { e.value = v; e.scrollIntoView({ block: 'center' }); }
              b.textContent = '✓ 已填入';
            };
          });
        }
      } catch (e) {
        if (out) out.innerHTML = '<p class="st-publish-note" style="color:#c0392b">查询请求失败：' + esc(e.message) + '</p>';
      }
      pbtn2.disabled = false; pbtn2.textContent = old;
    };
    const cancel = document.getElementById('st-publink-cfg-cancel');
    if (cancel) cancel.onclick = () => { __stSetupOpen = false; __stPubProvider = 'cloudbase'; stRenderPublink(); };
    const save = document.getElementById('st-publink-cfg-save');
    if (save) save.onclick = async () => {
      const envId = (document.getElementById('st-cb-env').value || '').trim();
      const sid = (document.getElementById('st-cb-sid').value || '').trim();
      const skey = (document.getElementById('st-cb-skey').value || '').trim();
      const path = (document.getElementById('st-cb-path').value || '').trim();
      if (!envId || !sid || !skey) { toast('EnvId、SecretId、SecretKey 都必须填写'); return; }
      save.disabled = true; save.textContent = '保存中…';
      try {
        await post('/api/deploy/config', { provider: 'cloudbase', envId: envId, secretId: sid, secretKey: skey, path: path });
        __stSetupOpen = false;
        __stPubProvider = 'cloudbase';
        await stRenderPublink();
        toast('CloudBase 配置已保存 ✓');
      } catch (e) { toast('保存失败：' + e.message); save.disabled = false; save.textContent = '保存配置'; }
    };
  };

  // 「访问须知」：只陈述访问稳定性可能存在差异，不断言任何地区一定无法访问。
  // ⚠ 改这里必须同步 app-v3.js 的 ghAccessNoteHtml()。
  const ghAccessNoteHtml = () => `<p class="st-publish-note" style="opacity:.7"><b>访问须知：</b>GitHub Pages 的公开链接在不同网络环境下的访问稳定性可能存在差异。如在你所在环境打开不畅，可改用「导出 ZIP」或 CloudBase，按实际访问环境选择合适的发布方式。</p>`
    + `<p class="st-publish-note" style="opacity:.7;margin-top:6px"><b>⚠ 仓库维护：</b>这个用来发布的仓库建好后，<b>建议不要改名、也不要设为私有</b>——改名会让旧 Pages 链接直接失效（GitHub 不对项目站点做重定向），设为私有会让 Pages 返回 404。若确需改名，改名后重新发布一次并更新已分享的链接即可。</p>`;
  /* —— 上次发布时间 + 「公开版是不是最新」判据（用户原话：想知道上一次更新发布是什么时间，
   *    这样才知道当前是不是最新、需不需要再次点击更新）——
   * 时间来自 /api/deploy/status 的发布记录（deployedAt）；
   * 「是否最新」来自 /api/version：Draft 的内容/排版 hash 与已发布 hash 一致 → 公开版就是最新的。
   * freshness 参数由 stRenderPublink 预先取好传进来（null = 没取到，就只显示时间不 judging）。 */
  const stLastDeployHtml = (deployedAt, freshness, btnLabel) => {
    if (!deployedAt) return '';
    let t = '';
    try { t = new Date(deployedAt).toLocaleString('zh-CN', { hour12: false }); } catch (_) { t = String(deployedAt); }
    const state = (freshness == null) ? ''
      : freshness ? `<span style="color:#0a7d33;font-weight:600">✓ 公开版与当前草稿一致（就是最新）</span>`
      : `<span style="color:#9a6700;font-weight:600">⚠ 公开版落后于当前草稿 —— 改过内容后要点「${esc(btnLabel || '更新当前发布')}」才会更新到线上</span>`;
    return `<p class="st-publish-note"><b>上次发布：</b>${esc(t)}　${state}</p>`;
  };
  // 取「Draft vs 已发布」新鲜度。true=一致（最新）；false=有未发布改动；null=取不到。
  const stFetchFreshness = async () => {
    try {
      const v = await (await fetch('/api/version?tpl=' + encodeURIComponent(tpl), { cache: 'no-store' })).json();
      if (!v || !v.content) return null;
      return (v.content === v.published) && (v.design === v.designPublished);
    } catch (_) { return null; }
  };
  // 一个模板在同一平台下可以有多条记录，「当前」= 最近发布的那条（与服务端的 find_deployment、
  // 也就是「更新当前发布」真正覆盖的目标同口径）。
  // ⚠ 2026-10-06 修复：/api/deploy/status 的列表是按 (path, tpl) 排序后才下发的，**位置≠时间**，
  //   老逻辑取「该模板最后出现的一条」当“当前”，真实数据上标到了最旧那条
  //   （2026-10-03 那条被标"当前"，而 2026-10-05 那条反而是"历史"）。
  //   现在以服务端裁定的 current 为准；老数据没有该字段时按 deployedAt 兜底。
  const stDepCurMap = (list) => {
    const items = (list || []).filter(d => d && d.url);
    const map = {};
    const flagged = items.some(d => typeof d.current === 'boolean');
    items.forEach(d => {
      const t = d.tpl || 'main';
      if (flagged) { if (d.current) map[t] = d; return; }
      const p = map[t];
      if (!p) { map[t] = d; return; }
      const a = Date.parse(p.deployedAt || '') || 0, b = Date.parse(d.deployedAt || '') || 0;
      if (b >= a) map[t] = d;   // 时间相同取后出现的一条（= 服务端写入顺序的最后一条）
    });
    return map;
  };
  // 某渠道发布记录里「某个模板」当前的那条（没有则 null）
  const stLastDeployOf = (list, curTpl) => {
    return stDepCurMap(list)[String(curTpl || 'main')] || null;
  };

  // ============ 多模板多路径：已发布列表 + 「新增发布」（与 app-v3.js 镜像）============
  // 背景：一个仓库 / 一个环境可以挂多套内容，各占一个子路径，链接互相独立。
  // 设计约束（用户明确）：**不做总入口** —— 发给别人哪条链接，他只看得到那套内容。
  // ⚠ 改这里必须同步 app-v3.js 的 depListHtml / wireDepList / newDeployHtml / wireNewDeploy / hostingBaseOf。

  // 已发布链接列表：每行一个地址 + 单独复制按钮；当前模板那条标「当前」。
  // ⚠ 一个模板可以有多条记录（点几次「另外发布一个链接」就有几条）——
  //   只有该模板**最后一条**才算"当前"（「更新当前发布」覆盖的就是它），其余标「历史」。
  // ============ 发布类操作的统一外壳（2026-09-20，与 app-v3.js 镜像）============
  // 起因（用户原话）：「我输入了 tpl-2，没有任何反应。」
  //   ① 用 window.prompt 让人手填模板 ID —— 填什么全靠猜，填错了也没反馈；
  //   ② 按钮只是把文字换成「发布中…」，没接进发布进度状态机，服务端跑没跑界面上一无所知。

  // 通用「选一个模板」弹窗：按**模板名**列出来直接选，不再让人手填 id。
  //
  // ⚠⚠ 2026-09-24 真 bug 修复：调用它的按钮（「改发布内容」）都长在 **`#st-publink-dialog`** 里，
  //   而那个对话框是 `<dialog>.showModal()` 打开的 —— **showModal 会把元素放进浏览器的 top layer，
  //   层级高于页面上任何 z-index**。旧实现是个 `position:fixed;z-index:99999` 的遮罩挂到
  //   `document.body`，于是它**永远被压在发布对话框下面**：用户能看到半截、点不到、也没法关
  //   （用户原话「有一些跳出来的弹窗，它会在面上的这个弹窗之下，让人没有办法点击到」）。
  //   修法：自己也用 `<dialog>.showModal()`。top layer 里**后 showModal 的在更上层**，天然压住前一个，
  //   一个 z-index 都不用写。⚠ 以后凡是在弹窗里再开弹窗，一律用 showModal，别再跟 top layer 比大小。
  const stPickTpl = (opt) => {
    const o = opt || {};
    const list = o.list || [];
    const cur = String(o.current || '');
    return new Promise(resolve => {
      const dlg = document.createElement('dialog');
      dlg.className = 'st-pick-dialog';
      const rows = list.length
        ? list.map(t => {
            const id = String(t.id || '');
            const nm = String(t.name || id);
            const sel = id === cur ? ' checked' : '';
            return '<label class="st-pick-row">'
              + '<input type="radio" name="st-pick-tpl" value="' + esc(id) + '"' + sel + '>'
              + '<span class="st-pick-name">' + esc(nm) + '</span>'
              + '<code>' + esc(id) + '</code></label>';
          }).join('')
        : '<p class="st-pick-empty">没有可选模板</p>';
      dlg.innerHTML = '<h3>' + esc(o.title || '选择模板') + '</h3>'
        + (o.desc ? '<p>' + esc(o.desc) + '</p>' : '')
        + '<div class="st-pick-list">' + rows + '</div>'
        + '<div class="st-pick-actions">'
        + '<button type="button" class="st-btn" data-st-pick-cancel>取消</button>'
        + '<button type="button" class="st-btn primary" data-st-pick-ok>' + esc(o.okText || '确定') + '</button>'
        + '</div>';
      let settled = false;
      const done = v => {
        if (settled) return;
        settled = true;
        try { if (dlg.open) dlg.close(); } catch (_) {}
        try { dlg.remove(); } catch (_) {}
        resolve(v);
      };
      const c = dlg.querySelector('[data-st-pick-cancel]'); if (c) c.onclick = () => done(null);
      const k = dlg.querySelector('[data-st-pick-ok]');
      if (k) k.onclick = () => {
        const r = dlg.querySelector('input[name=st-pick-tpl]:checked');
        done(r ? r.value : null);
      };
      // 点遮罩（= 点 dialog 自身内容区之外）与按 Esc 都算取消 —— 自定义遮罩那版就是这么做的，
      // 换成原生 dialog 后 Esc 只关窗、没人 resolve，Promise 会永远悬着。
      dlg.addEventListener('click', e => { if (e.target === dlg) done(null); });
      dlg.addEventListener('cancel', e => { e.preventDefault(); done(null); });
      dlg.addEventListener('close', () => done(null));
      document.body.appendChild(dlg);
      if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    });
  };

  // 统一的发布类操作执行器：点下去**立刻**出进度，结束必有结论。
  const stRunPubJob = async (provider, label, fn) => {
    if (stPubuiBusy()) { toast('上一个操作还在进行中，请等它结束再点。'); return false; }
    PUBUI.phase = 'starting'; PUBUI.provider = provider; PUBUI.detail = label; PUBUI.tpl = tpl;
    PUBUI.error = ''; PUBUI.total = 0; PUBUI.sent = 0; PUBUI.pct = 0; PUBUI.elapsed = 0;
    PUBUI.warnings = []; PUBUI.since = Date.now();
    stPubuiMount(); stPubuiPaint(); stPubuiStartPoll();
    let ok = false, res = null;
    try {
      res = await fn();
      ok = !!(res && res.ok);
      if (!ok) throw new Error((res && (res.error || res.message)) || '操作失败');
      PUBUI.phase = 'ok'; PUBUI.since = Date.now();
      PUBUI.detail = (res && (res.message || res.detail)) ? String(res.message || res.detail) : '已完成';
    } catch (e) {
      PUBUI.phase = 'error'; PUBUI.error = String((e && e.message) || e);
      toast('✗ ' + String((e && e.message) || e).split('\n')[0].slice(0, 90));
    } finally {
      stPubuiStopPoll(); stPubuiPaint();
      try { await stRenderPublink(); } catch (_) {}
    }
    if (ok) toast('✓ ' + String(PUBUI.detail || '已完成'));
    return ok;
  };

  // 「发布到新地址」的模板下拉项：必须显式选，不默认、不猜。
  const stNewDepTplOptions = (curTpl) => {
    const list = (window.__stTplList || []);
    const cur = String(curTpl || 'main');
    if (!list.length) return '<option value="' + esc(cur) + '">' + esc(cur) + '</option>';
    return list.map(t => {
      const id = String(t.id || '');
      return '<option value="' + esc(id) + '"' + (id === cur ? ' selected' : '') + '>' + esc(t.name || id) + '</option>';
    }).join('');
  };

  const stDepListHtml = (list, curTpl, emptyHint) => {
    const items = (list || []).filter(d => d && d.url);
    if (!items.length) return emptyHint ? `<p class="st-publish-note" style="font-size:12px;opacity:.72">${esc(emptyHint)}</p>` : '';
    const cur = String(curTpl || 'main');
    const curMap = stDepCurMap(items);
    // ⚠ 2026-10-06：只有**当前模板自己**的记录才允许出现「当前 / 历史」标记。
    //   别的模板的记录照常列出（那是真实存在的链接，还要能复制 / 删除），
    //   但绝不许标成任何形式的"当前" —— 以前会给它们打「该模板当前」，于是人在
    //   FolioFold 模板里却看到 Main 摆着一个"当前"，看着就是当前模板串台了。
    const hasMine = items.some(d => (d.tpl || 'main') === cur);
    const notice = hasMine ? ''
      : `<p class="st-publish-note" style="font-size:12px;opacity:.72;margin:0 0 4px 0">本模板在这个平台下还没有发布记录。</p>`;
    const rows = items.map((d, i) => {
      const t = d.tpl || 'main';
      const isThisTpl = t === cur;
      const isCur = isThisTpl && curMap[t] === d;
      const name = d.tplName || t;
      const tag = isThisTpl ? (isCur ? ' · 当前' : ' · 历史') : ' · 其他模板';
      const sub = d.path ? '/' + esc(d.path) + '/' : '/';
      let depT = '';
      try { depT = d.deployedAt ? new Date(d.deployedAt).toLocaleString('zh-CN', { hour12: false }) : ''; } catch (_) {}
      return `<div class="st-dep-item">
      <div class="st-code-row" style="margin-top:6px">
        <span style="font:12px ui-monospace,monospace;opacity:${isThisTpl && isCur ? '.95' : '.65'};font-weight:${isThisTpl && isCur ? '600' : '400'};min-width:7em">${esc(name)}${tag}</span>
        <input class="st-code-input" id="st-publink-dep-${i}" readonly value="${esc(d.url)}">
        <button class="st-btn" data-dep-copy="${i}">复制</button>
      </div>
      <p class="st-publish-note" style="font-size:12px;opacity:.7;margin:2px 0 0 0">路径 <code>${sub}</code>${depT ? ' · 发布于 ' + esc(depT) : ''}
        <button class="st-btn" data-dep-repub="${i}" style="padding:2px 8px;margin-left:8px;font-size:11px" title="把这个网址上的内容重新上传一次（内容没变也会刷一遍）。线上内容和你选的模板对不上时，点这个强制纠正">更新发布</button>
        <button class="st-btn" data-dep-retarget="${i}" style="padding:2px 8px;margin-left:6px;font-size:11px" title="网址不动，把里面的内容换成另一个模板再发布一次">改发布内容</button>
        <button class="st-btn" data-dep-del="${i}" style="padding:2px 8px;margin-left:6px;font-size:11px" title="删除这条发布：本机记录与线上路径一起删除">删除</button>
      </p>
      </div>`;
    }).join('');
    return `<div style="margin-top:8px">
      <p class="st-publish-note" style="margin-bottom:2px"><b>这个平台下已发布的链接</b>（每条互相独立；你把哪条发给别人，他就只看到那一条的内容）：</p>
      ${notice}
      ${rows}
    </div>`;
  };

  const stWireDepList = (host, list, rerender, provider) => {
    // provider = 这一组记录属于哪个渠道（'github' / 'cloudbase'），由调用方传入。
    // ⚠ 必须显式带上（2026-09-28 修复）：老版本 /api/deploy/status 组装记录时漏了 provider 字段，
    // 下面三个按钮把它原样塞进请求体 → undefined 被 JSON.stringify 丢掉 →
    // 后端判空 → 一律「不支持的平台：(空)」，列表里的按钮就成了摆设。
    const items = (list || []).filter(d => d && d.url);
    (host || document).querySelectorAll('[data-dep-copy]').forEach(b => {
      b.onclick = async () => {
        const i = b.getAttribute('data-dep-copy');
        const inp = document.getElementById('st-publink-dep-' + i);
        if (!inp || !inp.value) return;
        try { await navigator.clipboard.writeText(inp.value); }
        catch (_) { inp.select(); document.execCommand && document.execCommand('copy'); }
        toast('已复制');
      };
    });
    // —— 删除：本机记录 + 线上路径一起删（与 app-v3.js 镜像）——
    (host || document).querySelectorAll('[data-dep-del]').forEach(b => {
      b.onclick = async () => {
        const i = +b.getAttribute('data-dep-del');
        const d = items[i];
        if (!d) return;
        const name = d.tplName || d.tpl || 'main';
        const sub = d.path ? '/' + d.path + '/' : '/';
        if (!window.confirm(z('删除这条发布？\n\n· 模板：' + name + '\n· 路径：' + sub + '\n\n会同时删除线上对应的页面（GitHub Pages / CloudBase 上该路径将无法访问），此操作不可撤销。'))) return;
        await stRunPubJob(d.provider || provider || 'github', '正在提交删除请求…', async () => {
          const r = await fetch('/api/deploy/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: (d.provider || provider || ''), tpl: d.tpl || 'main', path: d.path || '', remote: true }) }).then(x => x.json());
          // 线上没能删掉：如实把"去哪儿手动删"摆出来，而不是假装删干净了。
          if (r && r.ok && r.remoteOk === false && r.manualUrl) {
            toast('⚠ 线上没能自动删除，已打开手动删除页面');
            try { window.open(r.manualUrl, '_blank'); } catch (_) {}
          }
          return r;
        });
      };
    });
    // —— 更新发布：把这个地址的内容强制刷成它自己那个模板（修"线上内容和模板对不上"）——
    (host || document).querySelectorAll('[data-dep-repub]').forEach(b => {
      b.onclick = async () => {
        const i = +b.getAttribute('data-dep-repub');
        const d = items[i];
        if (!d) return;
        const tpl = d.tpl || 'main';
        const nm = d.tplName || tpl;
        const sub = d.path ? '/' + d.path + '/' : '/';
        if (!window.confirm(z('把 ' + sub + ' 更新一遍？\n\n· 模板：' + nm + '\n· 路径：' + sub +
          '\n\n会用「' + nm + '」当前的内容覆盖这个网址上的页面。网址不变。'))) return;
        await stRunPubJob(d.provider || provider || 'github', '正在准备更新 ' + sub + ' …', async () => {
          const r = await fetch('/api/deploy/retarget', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: (d.provider || provider || ''), tpl: tpl, path: d.path || '', newTpl: tpl }) }).then(x => x.json());
          if (r && r.ok) r.message = '已把 ' + sub + ' 更新为「' + nm + '」';
          return r;
        });
      };
    });
    // —— 改发布内容：保留网址，把内容换成另一个模板更新发布 ——
    (host || document).querySelectorAll('[data-dep-retarget]').forEach(b => {
      b.onclick = async () => {
        const i = +b.getAttribute('data-dep-retarget');
        const d = items[i];
        if (!d) return;
        const tpls = (window.__stTplList || []);
        const sub = d.path ? '/' + d.path + '/' : '/';
        const target = await stPickTpl({
          list: tpls.length ? tpls : [{ id: d.tpl || 'main', name: d.tplName || (d.tpl || 'main') }],
          current: d.tpl || 'main',
          title: '把 ' + sub + ' 发布成哪个模板？',
          desc: '网址保持不变，只把这个网址上的内容换成所选模板的内容。选同一个模板 = 原样重新上传一遍。',
          okText: '开始发布'
        });
        if (!target) return;
        const nm = ((tpls.find(t => t.id === target) || {}).name) || target;
        await stRunPubJob(d.provider || provider || 'github', '正在发布「' + nm + '」到 ' + sub + ' …', async () => {
          const r = await fetch('/api/deploy/retarget', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: (d.provider || provider || ''), tpl: d.tpl || 'main', path: d.path || '', newTpl: target }) }).then(x => x.json());
          if (r && r.ok) r.message = sub + ' 已发布为「' + nm + '」';
          return r;
        });
      };
    });
  };

  // 「新增发布」：不覆盖当前链接，另开一个子路径挂同一套内容。
  const stNewDeployHtml = (provider, curTpl, existingPaths) => {
    if (provider === 'zip') return '';
    const taken = (existingPaths || []).join('、');
    return `<details id="st-publink-newdep-box" style="margin-top:12px">
      <summary style="cursor:pointer;font-size:13px;opacity:.85">另外发布一个链接（不覆盖当前地址）</summary>
      <div class="st-publish-note" style="margin-top:8px;line-height:1.7">
        <p><b>用途：</b>同一套内容再挂一个独立地址。比如你给不同岗位各做一版简历，可以每版发一个链接，
          互不影响 —— 你发哪条，对方就只看到哪条。<b>不会新建仓库或环境</b>，只是同一站点下的另一个子路径。</p>
        <p><b>路径名：</b>就是地址最后那一段。已自动填好一个不冲突的名字，可改成你喜欢的（只支持字母、数字、<code>-</code>、<code>_</code>）。</p>
        ${taken ? `<p style="font-size:12px;opacity:.75">已被占用的路径：<code>${esc(taken)}</code></p>` : ''}
      </div>
      <p style="font-size:12px;opacity:.85;margin:10px 0 0"><b>① 发布哪一个模板？</b>（必选 —— 不默认、不猜）</p>
      <div class="st-code-row" style="margin-top:6px">
        <select id="st-publink-newdep-tpl" class="st-code-input" style="flex:1">${stNewDepTplOptions(curTpl)}</select>
      </div>
      <p style="font-size:12px;opacity:.85;margin:10px 0 0"><b>② 路径名</b>（地址最后那一段）</p>
      <div class="st-code-row" style="margin-top:6px">
        <input class="st-code-input" id="st-publink-newdep-path" placeholder="自动生成" value="">
        <button class="st-btn primary" id="st-publink-newdep-go">发布到新地址</button>
      </div>
      <p class="st-publish-note" id="st-publink-newdep-preview" style="font-size:12px;opacity:.75;margin-top:6px"></p>
    </details>`;
  };

  const stWireNewDeploy = (host, provider, curTpl, hostingBase, onGo) => {
    const box = document.getElementById('st-publink-newdep-box');
    if (!box) return;
    const inp = document.getElementById('st-publink-newdep-path');
    const prev = document.getElementById('st-publink-newdep-preview');
    const go = document.getElementById('st-publink-newdep-go');
    let suggested = '';
    const paint = () => {
      if (!prev) return;
      const v = (inp && inp.value || '').trim().replace(/^\/+|\/+$/g, '');
      prev.textContent = v
        ? ('将发布到：' + (hostingBase || '') + v + '/')
        : (suggested ? ('留空将使用自动生成的名字：' + suggested) : '');
    };
    box.addEventListener('toggle', async () => {
      if (!box.open || suggested) { paint(); return; }
      try {
        const q = '?provider=' + encodeURIComponent(provider) + '&tpl=' + encodeURIComponent(curTpl || 'main');
        const r = await (await fetch('/api/deploy/suggest-path' + q, { cache: 'no-store' })).json();
        if (r && r.ok && r.suggested) { suggested = r.suggested; if (inp) inp.placeholder = r.suggested; }
      } catch (e) {}
      paint();
    });
    if (inp) inp.addEventListener('input', paint);
    if (go) go.onclick = () => {
      const v = (inp && inp.value || '').trim().replace(/^\/+|\/+$/g, '');
      const sel = document.getElementById('st-publink-newdep-tpl');
      const tplSel = sel ? String(sel.value || '').trim() : '';
      if (!tplSel) { toast('请先选择要发布哪个模板'); return; }
      if (go.dataset.busy) return; go.dataset.busy = '1';
      onGo(v, tplSel);
    };
    paint();
  };

  // 平台站点根地址（用于「新增发布」的地址预览）：取 URL 的协议+域名段。
  const stHostingBaseOf = (url) => {
    const u = String(url || '');
    if (!u) return '';
    const m = u.match(/^(https?:\/\/[^/]+\/)/);
    return m ? m[1] : u;
  };

  // 统一的发布执行器：mode='update'（更新当前发布）/ 'new'（新增子发布，path 指定路径名）。
  // 抽出来是因为两个按钮走同一条链路，只有 mode 与 path 不同 ——
  // 避免两份几乎一样的代码各自演化（本项目已在"两发布面板必须镜像"上踩够坑）。
  // ⚠ 改这里必须同步 app-v3.js 的 runDeploy。
  // tplOverride：由「发布到新地址」的模板下拉显式指定（用户自己点选的那个）。
  const stRunDeploy = async (provider, mode, path, btnEl, tplOverride) => {
    // 已经在发布中：直接忽略（按钮本身也是 disabled 的，这里是双保险）。
    // 绝不能再发一次 —— 两次发布并发会互相覆盖，历史上出过"线上变空站点"的事故。
    // ⚠ 但绝不能**静默**忽略：用户点按钮没任何反馈，只会以为功能坏了（2026-09-23 实测反馈
    //   「发布 FolioFold 我点击了没有任何反应」——当时 CloudBase 的发布还在后台跑）。
    if (stPubuiBusy()) {
      toast('上一次发布还在进行中（' + (PUBUI.provider === 'cloudbase' ? 'CloudBase' : 'GitHub Pages') +
        '），等它结束（进度条消失）再点。两次发布并发会互相覆盖。');
      return;
    }
    // ① 立刻进入"发布中"，同步渲染，不依赖任何异步 —— 第一下点击就必须有反馈。
    PUBUI.phase = 'starting'; PUBUI.provider = provider; PUBUI.detail = '正在提交发布请求…';
    PUBUI.error = ''; PUBUI.total = 0; PUBUI.sent = 0; PUBUI.pct = 0; PUBUI.elapsed = 0;
    PUBUI.warnings = []; PUBUI.since = Date.now();
    if (btnEl) { btnEl.disabled = true; btnEl.textContent = '发布中…'; }
    stPubuiMount(); stPubuiPaint();
    stPubuiStartPoll();
    try {
      // ⚠ 必须显式带上 tpl：服务端 /api/deploy/public 在拿不到 payload.tpl 时会用
      // self._tpl()（只认 URL query）回落 'main'。Studio 面板以前压根没传 tpl，
      // 于是「发模板二」实际发的永远是模板一 —— 这正是用户看到的现象。
      // 「发布到新地址」时以用户下拉里选的为准，不再默默用"当前模板"。
      // ⚠ 2026-10-06：没有 tplOverride（＝「更新当前发布」）时必须用**本工作台当前的 tpl**。
      //   以前这里回落到 window.__tpl —— 全项目从没给它赋过值，恒为 undefined → 恒为 'main'，
      //   于是在 FolioFold / Starter 下点「更新当前发布」，实际刷上去的是 Main 的内容，
      //   URL 还不变，看着像"发布成功但内容没变"。
      const tplId = String(tplOverride || '').trim() || tpl || 'main';
      const body = { provider, mode, tpl: tplId };
      if (mode === 'new' && path) body.path = path;
      const r = await fetch('/api/deploy/public?tpl=' + encodeURIComponent(tplId), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(x => x.json());
      if (!r.ok) {
        if (r.busy) throw Error(r.error || '上一次发布还在进行中，请等它结束再点（避免两次发布互相覆盖）。');
        if (r.setupRequired) throw Error(r.error || '尚未配置');
        if (r.mediaBlocked) throw Error(r.error || '媒体文件过大');
        throw Error(r.error || '发布失败');
      }
      PUBUI.phase = 'ok'; PUBUI.detail = ''; PUBUI.since = Date.now(); PUBUI.warnings = (r.warnings || []);
      stDeployedAt = PUBUI.since; stDeployedProvider = provider; // 兼容旧标记
      if (mode === 'new') {
        const nm = r.subPath ? ('新地址 /' + r.subPath + '/') : '新地址';
        PUBUI.detail = '已发布到' + nm;
        toast('✓ ' + nm + ' 已上线');
      }
    } catch (e) {
      PUBUI.phase = 'error'; PUBUI.error = String(e.message || e);
      toast('✗ 发布失败：' + String(e.message || e).split('\n')[0].slice(0, 80) + '（详情见面板红色提示）');
    } finally {
      stPubuiStopPoll();
      await stRenderPublink();   // 按最终状态重渲：成功→绿色按钮；失败→红色原因常驻
      // 发布成功但大媒体没传上去：站点已经上线，必须如实告诉用户"哪个文件暂时是空的"，
      // 而不是让整次发布看起来失败（旧行为：release 上传超时 → 整条发布报失败，网址也不显示）。
      (PUBUI.warnings || []).forEach(w => {
        const wn = document.createElement('p'); wn.className = 'st-publish-note'; wn.style.color = '#9a6700'; wn.textContent = '⚠ ' + w;
        const sec = stPubuiHost(); if (sec) sec.appendChild(wn);
      });
    }
  };

  // ===== 发布面板「用户正在输入」守卫（修复自愈重渲清空输入 / 打断拼音）=====
  // 探针陈旧 / 大媒体上传时，发布面板会整面板重渲（自愈刷新）。若用户当时正在输入框打字
  // （尤其中文拼音组合输入），整面板重渲会清空已输入内容、打断拼音。
  // 这里在 document 全局记录「最后一次输入 / 键盘活动的时间戳」，并提供判定函数，
  // 让自愈重渲在用户正在输入时自动延后，而不是硬重渲。
  window.__ffPubLastInputTs = window.__ffPubLastInputTs || 0;
  (function __ffPubInputGuard(){
    if (window.__ffPubInputGuardReady) return;
    window.__ffPubInputGuardReady = true;
    const mark = (e) => {
      const t = e && e.target; if (!t || !t.tagName) return;
      const tag = t.tagName.toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) {
        window.__ffPubLastInputTs = Date.now();
      }
    };
    document.addEventListener('input', mark, true);
    document.addEventListener('keydown', mark, true);
    document.addEventListener('compositionstart', mark, true);
    document.addEventListener('compositionend', mark, true);
  })();
  // 用户是否正在发布面板里输入（焦点在输入框且近期有键盘 / 输入活动）。
  function __ffPubUserTyping(){
    const el = document.activeElement;
    if (el && el.tagName) {
      const tag = el.tagName.toUpperCase();
      if ((tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable)
          && (Date.now() - (window.__ffPubLastInputTs || 0) < 3000)) {
        return true;
      }
    }
    return false;
  }

  const stRenderPublink = async () => {
    const body = document.getElementById('st-publink-body'); if (!body) return;
    __stSetupOpen = false;   // 能走到完整重渲，说明凭证表单已关闭
    // 打开发布面板即触发一次自愈：从历史找回可能因异常写入丢失的发布记录（幂等，无丢失则不写盘）。
    try { await fetch('/api/deploy/heal', { method: 'POST', cache: 'no-store' }); } catch (e) {}
    let st = { provider: 'github', providers: { cloudbase: { configured: false, envId: '' }, github: { configured: false, login: '' } }, publicUrl: '' };
    try { st = await (await fetch('/api/deploy/status', { cache: 'no-store' })).json(); } catch (e) {}
    if (!__stPubProvider) __stPubProvider = st.provider || 'github';
    const prov = __stPubProvider === 'cloudbase' ? 'cloudbase' : (__stPubProvider === 'zip' ? 'zip' : 'github');
    const cb = (st.providers && st.providers.cloudbase) || { configured: false, envId: '', publicUrl: '' };
    const gh = (st.providers && st.providers.github) || { configured: false, login: '', publicUrl: '' };
    // ③「上次发布是什么时间 / 现在线上的是不是最新」：一次取好，两个渠道分支共用
    const fresh = await stFetchFreshness();
    const cbLast = stLastDeployOf(cb.deployments, tpl);
    const ghLast = stLastDeployOf(gh.deployments, tpl);
    // 部署按钮：① 本次发布进行中 → 常驻「发布中…」+ 禁用（重渲也不会丢、也就无法重复点击）；
    // ② 刚成功 → 绿色「✓ 已更新 时:分」；③ 否则常规「更新/发布」。
    // app-v3.js 的浏览页发布面板是同一套逻辑，改这里记得同步改那边。
    window.__ffStDeployBtnHtml = (baseLabel) => {
      // 另一个渠道还在发布中：这个渠道的按钮必须**可见地禁用**，不能摆一个能点但没反应的按钮。
      if (stPubuiBusy() && PUBUI.provider !== prov) {
        return `<button class="st-btn" disabled title="另一个渠道正在发布中，结束后才能发布这个渠道（两次并发会互相覆盖）">⏳ ${PUBUI.provider === 'cloudbase' ? 'CloudBase' : 'GitHub Pages'} 发布中…</button>`;
      }
      if (stPubuiBusy() && PUBUI.provider === prov) {
        return `<button class="st-btn primary" id="st-publink-deploy" disabled>发布中…</button>`;
      }
      const muFailed = (st.mediaUpload && (st.mediaUpload.failed || []).filter(Boolean).length) || 0;
      if (PUBUI.phase === 'ok' && PUBUI.provider === prov && !muFailed) {
        return `<button class="st-btn primary st-done" id="st-publink-deploy">✓ 已更新 ${new Date(PUBUI.since).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</button>`;
      }
      return `<button class="st-btn primary" id="st-publink-deploy">${baseLabel}</button>`;
    };
    const deployBtnHtml = window.__ffStDeployBtnHtml;
    // 出网方式（2026-09-25 加）：系统代理可能"开着但已经没在跑"，那会让 GitHub / CloudBase
    // 同时全线发布失败。以前界面完全看不出来，用户只能被误导去重新授权。现在如实显示。
    const nw = st.network || {};
    const netLine = nw.note
      ? `<div class="st-pub-net${nw.downgraded ? ' warn' : ''}">出网方式：${nw.mode === 'proxy' ? '系统代理' : '直连'} — ${esc(nw.note)}</div>`
      : '';
    body.innerHTML = `<div class="st-publink-tabs">
        <button class="st-publink-tab ${prov==='github'?'active':''}" data-p="github">GitHub Pages</button>
        <button class="st-publink-tab ${prov==='cloudbase'?'active':''}" data-p="cloudbase">CloudBase（需腾讯云配置）</button>
        <button class="st-publink-tab ${prov==='zip'?'active':''}" data-p="zip">导出 ZIP</button>
      </div>${netLine}<div id="st-publink-prov"></div>`;
    body.querySelectorAll('.st-publink-tab').forEach(b => { b.onclick = () => { __stPubProvider = b.dataset.p; stRenderPublink(); }; });
    const pv = document.getElementById('st-publink-prov');
    if (prov === 'github') {
      // 「已发布 / 更新 / 发布」这些文案指的是**当前模板**，不能写死成某一个模板的名字。
      // ⚠ 2026-10-06：以前这里一律写"FolioFold"，于是人在 Main 模板下照样看到
      //   「✓ FolioFold 已发布」+「更新 FolioFold」—— 和用户报的那个 bug 正好是镜像方向。
      const pubNm = tplName(tpl) || tpl;
      let ghapp = { appConfigured: false }, ghstat = { connected: false, login: '' };
      try { ghapp = await (await fetch('/api/github/app', { cache: 'no-store' })).json(); } catch (e) {}
      try { ghstat = await (await fetch('/api/github/status', { cache: 'no-store' })).json(); } catch (e) {}
      // 服务端的能力结论是本地缓存、后台刷新。若标记为陈旧，就稍后自动重渲染一次，
      // 让用户不用手动刷新就能看到真实结论。
      if (ghstat.probeStale) {
        if (__stProbeRetry < 4) {
          __stProbeRetry++;
          // 自愈重渲只在"用户没有正在操作"时做：凭证表单开着、发布进行中、或用户正在输入框打字都不重渲，
          // 否则用户填到一半的输入会被清空、进度/按钮会闪一下，中文拼音输入也会被强行打断（真实反馈 2026-09-18）。
          // 用户正在打字时，本次延后至其停手后再重渲（最多延后 30 秒）。
          if (!__stSetupOpen && !stPubuiBusy()) {
            setTimeout(function __stProbeHeal(){
              const d = stPublinkDialog();
              if (!(d && d.open)) return;
              if (__ffPubUserTyping()) {
                if ((window.__stProbeDefer||0) < 30) { window.__stProbeDefer = (window.__stProbeDefer||0) + 1; setTimeout(__stProbeHeal, 1000); }
                return;
              }
              stRenderPublink();
            }, 2500);
          }
        }
      } else { __stProbeRetry = 0; window.__stProbeDefer = 0; }
      // 警告判据来自服务端的**真实 API 探测**（/api/github/status 的 canCreateRepo），
      // 不再靠令牌前缀猜。授权失效 / 权限不足分开说，且都给出下一步怎么做。
      const capWarn = (ghstat.connected && ghstat.canCreateRepo === false)
        ? `<p class="st-publish-note" style="color:#9a6700">⚠ ${esc(ghstat.warning || '当前 GitHub 授权没有在你账号下新建仓库的权限，发布到 GitHub Pages 会失败。')}</p>`
        : '';
      const reauthWarn = (ghstat.needsReauth || ghstat.expired)
        ? `<p class="st-publish-note" style="color:#c0392b">${esc(ghstat.detail || 'GitHub 授权已失效或过期，请点「连接 GitHub」重新授权一次。')}</p>`
        : '';
      const kindWarn = '';
      // 大媒体（100MB+）改为**后台上传**：站点早就上线了，只有视频等大文件还在传。
      // 这里如实显示进度，并在上传期间每 5 秒自动重渲一次（用户不用手动刷新）。
      const mu = st.mediaUpload || {};
      let mediaNote = '';
      if (mu.running) {
        const total = mu.total || 0, done = mu.done || 0;
        const pct = total ? Math.round(done / total * 100) : 0;
        mediaNote = `<p class="st-publish-note" style="color:#9a6700">⏳ 大媒体后台上传中：${done}/${total}（${pct}%）${mu.current ? ' · 正在传 ' + esc(mu.current) : ''}。站点已经可以访问，上传完成后视频即可播放，不用再更新。</p>`;
        if (__stMediaRetry < 240) {
          __stMediaRetry++;
          // 同 probeStale：用户正在操作 / 正在发布时不重渲，避免清空输入与画面闪动。
          // 用户正在打字时延后重渲（最多延后 240 秒）。
          if (!__stSetupOpen && !stPubuiBusy()) {
            setTimeout(function __stMediaHeal(){
              const d = stPublinkDialog();
              if (!(d && d.open)) return;
              if (__ffPubUserTyping()) { if ((window.__stMediaDefer||0) < 240) { window.__stMediaDefer = (window.__stMediaDefer||0) + 1; setTimeout(__stMediaHeal, 1000); } return; }
              stRenderPublink();
            }, 5000);
          }
        }
      } else {
        __stMediaRetry = 0;
        const fails = (mu.failed || []).filter(Boolean);
        if (fails.length) {
          mediaNote = `<p class="st-publish-note" style="color:#9a6700">⚠ 大媒体上传未完成：${esc(fails.map(f => f.file + (f.sizeMB ? '（' + f.sizeMB + 'MB）' : '')).join('、'))}。站点其余部分已正常上线；稍后再点「更新 ${esc(pubNm)}」会继续上传（已经传成功的会自动跳过）。</p>`;
        }
      }
      // deployBtnHtml 已在 stRenderPublink 顶部统一定义（刚发布成功显示「✓ 已更新 时:分」）。
      // ⚠ 已发布链接不再依赖当前授权/连接状态：只要有发布记录就照常列出（历史事实），
      // 连接失效只是"无法更新/更新发布"，已有的公网链接仍可正常访问（防止"久不用就找不着链接"）。
      // ⚠ 按「当前模板」过滤：只有本模板自己有发布记录才显示"已发布"+链接；
      //   新模板（没有任何发布记录）应落到下面"还没有发布过"分支，要求重新发布，
      //   而不是挂着别人的链接（旧实现用 gh.publicUrl / deployments[0].url 会串模板）。
      if (ghLast) {
        const ghUrl = ghLast.url || '';
        const ghLogin = ghstat.login || (ghLast.meta && ghLast.meta.owner) || '';
        const connBanner = (!ghstat.connected)
          ? `<p class="st-publish-note" style="color:#9a6700">⚠ GitHub 当前未连接 / 授权已失效。<b>你已有的发布链接仍可正常访问</b>；只有「更新当前发布 / 更新发布 / 改发布内容」需要先重新连接 GitHub 才能操作（点下面「连接 GitHub」即可）。</p>`
          : '';
        pv.innerHTML = `<div class="st-publish-section">
          <p>状态：<b>✓ ${esc(pubNm)} 已发布</b>${ghstat.connected ? ' · 账号：<b>' + esc(ghLogin) + '</b>' : ' · <span style="color:#9a6700">GitHub 当前未连接</span>'}</p>
          ${stLastDeployHtml(ghLast && ghLast.deployedAt, fresh, '更新 ' + pubNm)}
          <p class="st-publish-note">公网地址（任何人无需安装 FolioFold、无需 GitHub 账号即可浏览）：</p>
          <div class="st-code-row"><input class="st-code-input" id="st-publink-url" readonly value="${esc(ghUrl)}"></div>
          <div class="st-publish-actions">
            <a class="st-btn" href="${esc(ghUrl)}" target="_blank" rel="noopener">打开 FolioFold ↗</a>
            <button class="st-btn" id="st-publink-copy">复制</button>
            ${ghstat.connected ? deployBtnHtml('更新 ' + pubNm) : `<button class="st-btn" disabled title="先重新连接 GitHub 才能更新">更新 ${esc(pubNm)}</button>`}
            <button class="st-btn" id="st-publink-gh-connect">连接 GitHub</button>
            <button class="st-btn" id="st-publink-gh-disc">断开 GitHub</button>
            <span style="margin-left:auto;font-size:12px;opacity:.7;align-self:center">仅更新 GitHub 下本模板的当前公开地址，其它模板的链接不受影响</span>
          </div>
          ${connBanner}${reauthWarn}${capWarn}${mediaNote}
          ${stDepListHtml(gh.deployments, tpl, '这个平台下还没有任何发布记录。')}
          ${ghstat.connected ? stNewDeployHtml('github', tpl, (gh.deployments||[]).map(d=>d.path).filter(Boolean)) : ''}
          ${ghAccessNoteHtml()}
          <p class="st-publish-note">「更新 ${esc(pubNm)}」会覆盖本模板现在这个地址，链接保持不变；其它模板的地址不受影响。大视频自动走 Release Assets。</p>
          <p class="st-publish-note" style="opacity:.75">更新节奏与 CloudBase <b>一样是手动更新</b>：内容改过后要点一次「更新 ${esc(pubNm)}」才会上线（发布完成即刻生效，没有额外缓存等待）。首次发布之后也可以用下面的「发布到新地址」给每个模板各发一条独立链接。</p></div>`;
        stWireDepList(pv, gh.deployments, () => stRenderPublink(), 'github');
        if (ghstat.connected) {
          stWireNewDeploy(pv, 'github', tpl, stHostingBaseOf(ghUrl), (path, tplSel) => {
            if (path && !/^[A-Za-z0-9_-]+$/.test(path)) { toast('路径名只能用字母、数字、- 和 _'); const b=document.getElementById('st-publink-newdep-go'); if(b) delete b.dataset.busy; return; }
            stRunDeploy('github', 'new', path, document.getElementById('st-publink-newdep-go'), tplSel);
          });
        }
      } else if (ghstat.connected) {
        pv.innerHTML = `<div class="st-publish-section">
          <p>状态：<b>✓ GitHub 已连接</b> · 账号：<b>${esc(ghstat.login)}</b></p>
          <p class="st-publish-note"><b>还没有发布过</b> —— 所以这里暂时没有可打开的链接（连接 ≠ 发布）。点上面「发布 ${esc(pubNm)}」完成首次发布：会自动建仓库并启用 GitHub Pages，完成后这里会出现公网地址、「上次发布」时间和「更新 ${esc(pubNm)}」按钮。</p>
          ${reauthWarn}${capWarn}${mediaNote}
          <div class="st-publish-actions">${deployBtnHtml('发布 ' + pubNm)}
          <button class="st-btn" id="st-publink-gh-adv">开发者选项</button>
          <button class="st-btn" id="st-publink-gh-disc">断开 GitHub</button></div>
          <p class="st-publish-note">首次发布会在你的账号下自动创建仓库并启用 GitHub Pages，无需手动配置。</p>
          <p class="st-publish-note" style="opacity:.75">更新节奏与 CloudBase <b>一样是手动更新</b>（点一次按钮更新一次，不是自动同步）。首次发布后，也能像 CloudBase 那样用「发布到新地址」给每个模板各发一条独立链接 —— 入口会出现在首次发布之后。</p>
          <p class="st-publish-note" style="opacity:.7">「开发者选项」仅用于自建 OAuth App 的调试，普通用户不需要。</p>
          ${ghAccessNoteHtml()}
          <div id="st-publink-gh-device"></div>
          <div id="st-publink-gh-appform"></div></div>`;
      } else {
        pv.innerHTML = `<div class="st-publish-section">
          <p>状态：<b>未连接</b></p>
          <p class="st-publish-note">点「连接 GitHub」后，在 GitHub 页面输入一个 8 位代码即可完成授权。FolioFold 不需要你的密码、不需要你创建任何 GitHub 应用，也不会要求任何 Client Secret。</p>
          ${ghstat.detail ? `<p class="st-publish-note" style="color:#c0392b">${esc(ghstat.detail)}</p>` : ''}
          <div class="st-publish-actions">
            <button class="st-btn primary" id="st-publink-gh-connect">连接 GitHub</button>
          </div>
          <p class="st-publish-note" style="opacity:.7"><a href="#" id="st-publink-gh-adv">开发者选项</a>（自建 OAuth App 调试用，普通用户不需要）</p>
          ${ghAccessNoteHtml()}
          <div id="st-publink-gh-device"></div>
          <div id="st-publink-gh-appform"></div></div>`;
      }
      const ghc = document.getElementById('st-publink-gh-connect');
      if (ghc) ghc.onclick = () => stStartGhDevice();
      const ghd = document.getElementById('st-publink-gh-disc');
      if (ghd) ghd.onclick = async () => { try { await post('/api/github/disconnect', {}); } catch (e) {} __stPubProvider = 'github'; stRenderPublink(); toast('已断开 GitHub'); };
      const gha = document.getElementById('st-publink-gh-adv');
      if (gha) gha.onclick = () => {
        const f = document.getElementById('st-publink-gh-appform');
        const dv = document.getElementById('st-publink-gh-device'); if (dv) dv.innerHTML = '';
        // ⚠ 已在用内置授权时必须先说明"不需要填"：之前表单一展开就是两个空输入框，
        //   用户以为自己之前配置的丢了、被要求重填（2026-09-23 用户原话）。
        const builtinNote = ghapp.usingBuiltinClient
          ? `<p class="st-publish-note" style="color:#0a7d33"><b>当前正在使用 FolioFold 内置授权（已经配置好，不需要你填任何 ID / Secret）。</b>你之前连 GitHub 走的是设备码授权，凭证已保存在本机 —— 下面这项只是给想换成自己注册的 OAuth App 的开发者准备的，普通使用请直接关闭这块去点上面的「发布」按钮。</p>`
          : '';
        f.innerHTML = `${builtinNote}<p class="st-publish-note"><b>仅开发者需要</b>：想让 FolioFold 用你自己注册的 OAuth App 身份授权时才填。普通用户请直接用上面的「连接 GitHub」，不需要看这一项。<br>注册方式：<a href="https://github.com/settings/developers" target="_blank" rel="noopener">github.com/settings/developers</a> → <b>New OAuth App</b>，Homepage URL 与 Authorization callback URL 都填 <code>http://127.0.0.1:3000/api/github/callback</code>，并在设置里勾上 <b>Enable device flow</b>（不勾设备码授权用不了）。<b>只填 Client ID 即可</b>，Client Secret 不是必需的。</p>
          <label class="st-field-label" for="st-gh-cid">Client ID</label>
          <input class="st-code-input" id="st-gh-cid" placeholder="OAuth App Client ID" value="${esc(ghapp.client_id || '')}">
          <label class="st-field-label" for="st-gh-csec">Client Secret（可留空 → 走设备码授权）</label>
          <input class="st-code-input" id="st-gh-csec" type="password" placeholder="留空也可以：只填 Client ID 即可授权">
          <div class="st-publish-actions">
            <button class="st-btn" id="st-gh-clear">清除自带 App</button>
            <button class="st-btn primary" id="st-gh-save">保存</button></div>`;
        const clr = document.getElementById('st-gh-clear');
        if (clr) clr.onclick = async () => { try { await post('/api/github/app', { client_id: '', client_secret: '' }); } catch (e) {} __stPubProvider = 'github'; stRenderPublink(); toast('已恢复默认授权方式'); };
        document.getElementById('st-gh-save').onclick = async () => {
          const cid = (document.getElementById('st-gh-cid').value || '').trim();
          const csec = (document.getElementById('st-gh-csec').value || '').trim();
          if (!cid) { toast('请填写你自己的 OAuth App Client ID'); return; }
          try { await post('/api/github/app', { client_id: cid, client_secret: csec }); }
          catch (e) { toast('保存失败：' + e.message); return; }
          // 填了 secret → 回环授权；只填 Client ID → 设备码授权（用你自己的 App，不依赖 3000 端口回调）
          if (csec) { window.location.href = '/api/github/connect?method=oauth'; return; }
          toast('Client ID 已保存 ✓ 点「连接 GitHub」用你自己的 App 授权');
          __stPubProvider = 'github';
          await stRenderPublink();
        };
      };
    } else if (prov === 'zip') {
      stRenderZipSection(pv);
    } else {
      stRenderCloudBaseSection(pv, cb, deployBtnHtml, fresh);
    }
    const copy = document.getElementById('st-publink-copy');
    if (copy) copy.onclick = async () => { const i = document.getElementById('st-publink-url'); if (i && i.value) { try { await navigator.clipboard.writeText(i.value); } catch (_) { i.select(); document.execCommand && document.execCommand('copy'); } toast('已复制'); } };
    const deploy = document.getElementById('st-publink-deploy');
    if (deploy) deploy.onclick = () => {
      const provider = __stPubProvider === 'cloudbase' ? 'cloudbase' : 'github';
      stRunDeploy(provider, 'update', '', deploy);
    };
    // 每次完整重渲后，按 PUBUI 当前状态把进度/失败块挂回面板（能扛住自愈重渲，不会丢）。
    stPubuiMount();
  };
  const stOpenPublink = document.getElementById('st-open-publink');
  if (stOpenPublink) stOpenPublink.onclick = async () => { const d = stPublinkDialog(); if (!d) return; await stRenderPublink(); if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', ''); };
  const stClosePublink = document.getElementById('st-publink-close');
  if (stClosePublink) stClosePublink.onclick = () => { const d = stPublinkDialog(); if (!d) return; if (typeof d.close === 'function') d.close(); else d.removeAttribute('open'); };

  // —— 面板内的按钮通过 postMessage 请求切换 ——
  window.addEventListener('message', ev => {
    const m = ev && ev.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'studio-switch' && PANEL_PATHS[m.tab]) activate(m.tab);
    else if (m.type === 'studio-saved') {
      // 面板刚保存：立刻让别的面板"过一会儿"刷新
      refreshStatus();
      scheduleSiblingReload(600);
    } else if (m.type === 'studio-toast' && m.msg) {
      toast(m.msg);
    }
  });

  // —— 启动 ——
  (async () => {
    await loadTemplates();              // 先拿到模板列表（必要时把 tpl 回落到 main）
    await applyStudioTheme();           // 顶栏配色首次加载就跟随当前模板主题（修「一进来永远是肉色」）
    sig = await fetchVersion();
    loaded[active] = sig;
    renderTplSelect();
    writeUrl();
    activate(active);
    refreshStatus();
    // 外壳里所有界面文案自动跟随语言（顶栏 / 状态条 / 发布面板 / 各种弹窗）。
    if (I18N && I18N.autoTranslate) I18N.autoTranslate(document.body);
    setInterval(poll, 1500);
    // —— GitHub OAuth 回调返回（/?github=connected）——
    const ghFlag = new URLSearchParams(location.search).get('github');
    if (ghFlag === 'connected') {
      const u = new URL(location.href); u.searchParams.delete('github');
      history.replaceState(null, '', u.pathname + (u.search ? u.search : ''));
      setTimeout(async () => {
        toast('GitHub 已连接 ✓');
        const d = stPublinkDialog();
        if (d) { __stPubProvider = 'github'; await stRenderPublink(); if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', ''); }
      }, 350);
    }
  })();
})();
