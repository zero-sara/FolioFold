// Visual Editor — iframe 模式（所见即所得）
// 画布 = /?mode=draft&ve=1（嵌入真实 Portfolio，隐藏版本条与顶部按钮）
// 左侧 = 区块顺序（拖拽 / 上下移）+ 主题选择
// 右侧 = 当前选中区块的表单编辑器（数据写入 portfolio.json，iframe 自动刷新）
// 保存按钮 = 把当前草稿内容与视觉设计一并写入；区块结构只保存在草稿内容中。
//
// 与 Content Editor 的关系：
//  - Content Editor 适合「批量 / 复杂的结构化编辑」（AI 整理、批量改项目等）
//  - Visual Editor 适合「边看边改」：你在画布里看到的就是最终作品集，所见即所得
//  - 两边写同一个 portfolio.json，互相可见；Visual Editor 的保存按钮是冗余的
//    （Content Editor 的自动保存和 Visual Editor 的表单提交都已能保证数据持久化），
//    这里保留它是给用户一个明确的"我刚刚修改已落地"反馈。

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const I18N=(typeof window==='object'&&window.FF_I18N)?window.FF_I18N:null;
const ui=(key,fallback)=>I18N?I18N.t(key,fallback):fallback;
// 中文当 key 的字典层（i18n.js 里的 z / translateDom）。用它接住"拼出来才知道"的文案
// （toast 里的 “已删除「XX」” 之类），以及所有由 innerHTML 现画出来的界面文案。
const z=(s)=>I18N?I18N.z(s):s;

const SECTION_LABELS = {
  about: 'About', experience: 'Experience', works: 'Works', showreel: 'Showreel', aiVoices: 'AI Project',
  contact: 'Contact', skills: 'Skills'
};

// 多模板：所有 API 请求都必须带上当前 tpl，否则读写会落到模板一 ——
// 这是 2026-09-19 数据丢失事故的根因之一（详见 server.py 里 content_blank 的注释）。
const veTpl = () => new URLSearchParams(location.search).get('tpl') || 'main';
const veUrl = u => u + ((u.indexOf('?') >= 0) ? '&' : '?') + 'tpl=' + encodeURIComponent(veTpl());
const api = (url, o = {}) => fetch(veUrl(url), { cache: 'no-store', ...o }).then(async r => {
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(j.error || ('请求失败 ' + r.status));
  return j;
});

// —— 统一工作台（Studio）协作 ——
// 根路径就是工作台外壳，作品集本体在 /portfolio/。这里判断自己是不是被外壳嵌着，
// 是的话"返回作品集 / 文本编辑"就交给外壳切标签页（保持一个链接三个面板），
// 并在每次保存后通知外壳，好让另外两个面板拿到最新草稿。
const IN_STUDIO = new URLSearchParams(location.search).get('studio') === '1';
// 多模板：画布 iframe 必须带上同一个 tpl，否则画布里渲染的是另一个模板的数据。
const TPL_ID = new URLSearchParams(location.search).get('tpl') || 'main';
const PORTFOLIO_CANVAS = '/portfolio/?mode=draft&ve=1' + (IN_STUDIO ? '&studio=1' : '') + '&tpl=' + encodeURIComponent(TPL_ID);
// 画布编辑模式跨重载保留（2026-09-22）：
// 保存、面板同步、切模板、以及画布高度重排都会把 <iframe> 重新加载一次，旧的画布
// 只能从 URL 读模式 → 每次重载都回到「元素」模式。用户正在「↕ 挪间距」里拖到一半，
// 画布刷一下就被踢回元素模式，看起来就像"杆自己不见了"。现在把模式记下来并按模板分键，
// 重载时通过 URL 直接恢复，连闪一下都不会。
//
// 用 sessionStorage 而不是 localStorage（2026-09-22 修订）：要活过的是"同一个标签页里的
// 画布重载"，不是"关掉浏览器下次打开"。用 localStorage 会让新标签页一进来就停在「挪间距」，
// 用户点正文选不中字，只会觉得坏了（visual-editor-smoke 就是这么挂的）。
const CANVAS_MODE_KEY = 'folioframe.ve-canvas-mode.' + TPL_ID;
function loadCanvasMode() {
  try {
    const m = sessionStorage.getItem(CANVAS_MODE_KEY) || 'select';
    // 「🖼 添加图片」是一次性状态（依赖刚上传的那个文件），重载后没有意义，不恢复。
    return m === 'addimg' ? 'select' : m;
  } catch (_) { return 'select'; }
}
let canvasMode = loadCanvasMode();
function setCanvasMode(mode) {
  canvasMode = (mode === 'addimg') ? 'select' : mode;
  try { sessionStorage.setItem(CANVAS_MODE_KEY, canvasMode); } catch (_) {}
  paintCanvasModeButtons();
}
function paintCanvasModeButtons() {
  document.querySelectorAll('[data-canvas-mode]').forEach(item => {
    item.classList.toggle('primary', item.dataset.canvasMode === canvasMode);
  });
}

// —— 界面文案（i18n）——
// 顶栏 / 左栏的静态文案在 boot() 里一次性拼进 HTML，所以语言一切就得重新铺一遍。
// 这里刻意【不用 location.reload()】：重载会把整个面板连画布一起重来，
// 用户看到的是"刷了两三下"，还以为是没生效或者卡了（2026-09-22 用户报的）。
// 只改界面文案 + 重画左右两栏，画布 iframe 一个字节都不碰。
const VE_CHROME_TEXT = [
  ['#ve-subtitle', 've.subtitle', '直接调整版式和常用内容。'],
  ['#ve-collapse', 've.collapseAll', '全部收起'],
  ['#ve-expand', 've.expandAll', '全部展开'],
  ['#ve-texteditor', 'nav.editor', '文本编辑'],
  ['#ve-cv-mobile', 've.canvasMobile', '📱 手机'],
  ['#ve-cv-desktop', 've.canvasDesktop', '🖥 电脑'],
  ['#ve-back', 've.backToPortfolio', '← 返回作品集'],
  ['#ve-save', 've.keep', '保留'],
  ['#ve-h-sections', 've.panelSections', '页面区块'],
  ['#ve-hint-sections', 've.panelSectionsHint', '拖动排序，或用上下按钮。'],
  ['#ve-h-themes', 've.panelThemes', '主题'],
  ['#ve-h-status', 've.panelStatus', '设计状态'],
];
const VE_CHROME_TITLE = [
  ['#ve-collapse', 've.collapseAllTitle', '收起画布里所有展开的项目/分类'],
  ['#ve-expand', 've.expandAllTitle', '展开画布里所有项目/分类'],
  ['#ve-cv-mobile', 've.canvasMobileTitle', '把画布切换到手机宽度（390px），便于查看手机浏览下的样子'],
  ['#ve-cv-desktop', 've.canvasDesktopTitle', '把画布切换到实际电脑浏览器的尺寸（与发布版一致）'],
  ['#ve-save', 've.keepTitle', '把画布上的调整存下来（内容 + 版式）'],
];
function applyVeChromeText() {
  VE_CHROME_TEXT.forEach(([sel, key, fb]) => { const el = $(sel); if (el) el.textContent = ui(key, fb); });
  VE_CHROME_TITLE.forEach(([sel, key, fb]) => { const el = $(sel); if (el) el.setAttribute('title', ui(key, fb)); });
  if (typeof document !== 'undefined') document.title = ui('ve.documentTitle', 'Visual Editor — FolioFold');
}
function rerenderVeUI() {
  applyVeChromeText();
  // 左右两栏都是"按当前数据现画"的，重跑一遍就等于换了语言，不需要重载文档。
  try { renderSectionsList(); } catch (_) {}
  try { renderThemeList(); } catch (_) {}
  try { renderEditPanel(); } catch (_) {}
  try { refreshStatusDetail(); } catch (_) {}
}
function syncCanvasLocale() {
  // 画布是独立文档，它的语言要单独通知。消息类型沿用 i18n 自己的握手协议
  // （画布里的 FF_I18N 监听 {type:'ff-locale'}）；语言没变时那边是空操作，不会引起重载。
  if (I18N) postToCanvas({ type: 'ff-locale', locale: I18N.getLocale() });
}
// 画布地址：初始挂载（renderApp 里的 <iframe src>）和每次重载都必须走这里，
// 否则会漏掉 &ve-mode= —— 表现就是"刷新后进了元素模式，我明明还在挪间距"。
function canvasUrl(extra) {
  return PORTFOLIO_CANVAS
    + (canvasMode && canvasMode !== 'select' ? '&ve-mode=' + encodeURIComponent(canvasMode) : '')
    + (extra || '');
}
function gotoPanel(tab, fallback) {
  if (IN_STUDIO) { try { window.parent.postMessage({ type: 'studio-switch', tab }, '*'); return; } catch (_) {} }
  location.href = fallback;
}
function notifyStudioSaved() {
  try { if (window.parent !== window) window.parent.postMessage({ type: 'studio-saved' }, '*'); } catch (_) {}
}

const toast = (msg) => {
  const t = $('#ve-toast');
  if (!t) return;
  t.textContent = z(msg);
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
};

// 向 iframe 画布发送指令
function postToCanvas(msg) {
  try {
    const f = $('#ve-canvas');
    if (f && f.contentWindow) f.contentWindow.postMessage(msg, '*');
  } catch (_) {}
}

// 从 iframe 画布里读取 VE 直接编辑层的当前状态（spacing / imgSizes / textStyles）
function readDirect(method){
  try {
    const f = $('#ve-canvas');
    const ve = f && f.contentWindow && f.contentWindow.__veDirect;
    if (ve && typeof ve[method] === 'function') return ve[method]();
  } catch (_) {}
  return {};
}

// —— 数据层 ——
let draft = {};       // portfolio.json 草稿
let design = {};      // design.json 设计
let selectedSection = 'about';  // 当前右侧面板编辑哪个区块
let canvasSection = '';         // 画布里「实际点选」的区块（只由画布选中消息驱动；'' = 未选中）
let pendingUpload = null;       // 已上传但还没放到画布上的图片（画布重载后由 ve-ready 自动补发）

async function loadAll() {
  draft = await api('/api/data?mode=draft');
  try { design = await api('/api/design'); } catch (e) { design = {}; }
  draft.sectionTitles = draft.sectionTitles || {};
  // 区块级 Logo 点缀图（Content 层）：{<sectionId>:{url,pos}}，与文本编辑「页面结构」共用
  draft.sectionLogos = (draft.sectionLogos && typeof draft.sectionLogos === 'object') ? draft.sectionLogos : {};
  draft.settings = draft.settings || {};
  draft.aiVoices = draft.aiVoices || {};
  draft.aiVoices.projects = Array.isArray(draft.aiVoices.projects) ? draft.aiVoices.projects : [];
  // 同步主题：design.theme 优先，回落到 draft.theme
  if (design && design.theme) draft.theme = design.theme;
  syncPanelTheme();                     // 首屏就把面板染成当前模板主题，不要等先切一次主题
}

// —— 保存 ——
function getDeep(obj, path) {
  let o = obj;
  for (const k of path) {
    if (o == null) return undefined;
    o = o[k];
  }
  return o;
}

// 服务端 normalize 是以 structuredContent 为权威源往回覆盖 keyWork / highlights 的，
// experience 还会把 responsibilities 合并回 highlights。只删主数组的话，
// 保存时旧值会被回填，出现「删了又冒出来」。所以这些冗余副本必须一起清掉。
function removeRedundantCopies(draft, segs, removed) {
  if (segs.length !== 3) return;                 // 形如 ['projects', 5, 'keyWork']
  const [coll, i, field] = segs;
  if (coll !== 'projects' && coll !== 'experience') return;

  const alts = [[coll, i, 'structuredContent', field]];
  if (coll === 'projects') alts.push([coll, i, 'aiDraft', field]);
  // experience.normalize 会把 responsibilities 合并进 highlights，必须一并清除
  if (coll === 'experience' && field === 'highlights') {
    alts.push([coll, i, 'structuredContent', 'responsibilities']);
  }

  // 比较时忽略空白（normalize 的去重也是忽略空白的）
  const norm = v => String(v == null ? '' : v).replace(/\s+/g, '');
  const target = norm(removed);
  alts.forEach(p => {
    const a = getDeep(draft, p);
    if (!Array.isArray(a)) return;
    const k = a.findIndex(v => norm(v) === target);
    if (k >= 0) a.splice(k, 1);
  });
}

async function saveDraft(silent) {
  try {
    await api('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) });
    if (!silent) toast('已保存并同步到作品集');
    notifyStudioSaved();
    return true;
  } catch (e) {
    toast('保存失败：' + e.message);
    return false;
  }
}

async function saveDesign(silent) {
  try {
    const payload = { theme: draft.theme || null };
    if (design.mediaLayout) payload.mediaLayout = design.mediaLayout;
    await api('/api/design/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!silent) toast('设计已保存（主题 / 区块顺序）');
    notifyStudioSaved();
    return true;
  } catch (e) {
    toast('设计保存失败：' + e.message);
    return false;
  }
}

async function saveAll() {
  // 一次性保存：内容写到 portfolio.json，主题 / 间距 / 图片尺寸写到 design.json。
  // 区块顺序（Template 的一部分）在拖动时已即时写入 design.json，这里不再重复写。
  // 直接编辑（文字/间距/图片）已在每次改动时即时写入，这里作为「统一落盘 + 发布前确认」。
  //
  // ⚠️ 顺序很重要：先把画布里的最新值读出来，再去写盘。
  // 反过来（先写盘再读）时，写盘会引起面板同步 / 画布重载，等读的时候画布已经
  // 从服务器把旧值加载回来了，"保留"这个动作反而会把刚拖好的间距覆盖回旧值。
  const sp = readDirect('getSpacing');
  const isz = readDirect('getImgSizes');
  const ok1 = await saveDraft(true);
  const ok2 = await saveDesign(true);
  // 把 iframe 里最新的间距/图片尺寸也一并落盘（防止最后一次拖动还没触发 commit）
  try {
    if (sp && Object.keys(sp).length) await api('/api/design/save', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ spacing: sp, theme: draft.theme || null }) });
    if (isz && Object.keys(isz).length) await api('/api/design/save', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ imgSizes: isz, theme: draft.theme || null }) });
  } catch (_) {}
  if (ok1 && ok2) toast('已保留');
  refreshStatusDetail();
}

// —— 画布控制 ——
// ⚠ 2026-09-25：排版编辑**自己的左右面板**也要跟随模板主题。
//   原先只有 Studio 顶栏（studio.js 映射 --st-*）和画布 iframe 跟随，面板本身写死浅色
//   —— 用户原话：「调到 Dark 模板的时候，只有最顶上的总编辑栏跟随，还有画布内的东西跟随了，
//   但实际上……两旁的面板也需要一起跟随这个主题」。
//   themes.js 的 applyTheme 会把 token 写到**当前 document** 的 :root，而面板 CSS 已经
//   全部改成带原色 fallback 的 var(--…)，所以这里只要把当前模板的主题应用到自己头上即可。
//   对**所有模板**一视同仁：主题来自 design.theme / draft.theme，不针对任何具体模板。
function syncPanelTheme() {
  try {
    const src = (draft && draft.theme) || (design && design.theme) || null;
    const th = window.resolveTheme ? window.resolveTheme({ theme: src }) : null;
    if (th && window.applyTheme) window.applyTheme(th);
  } catch (_) { /* 主题应用失败不能影响编辑器本身 */ }
}

async function reloadCanvas(restoreScroll) {
  syncPanelTheme();                     // 画布每次重载都顺带把面板主题对齐（含换模板/换主题）
  const f = $('#ve-canvas');
  if (!f) return;
  // 排序后需要按新数据重渲染画布（拖动时只是显示参考线，并未真移 DOM），
  // 但重渲染会跳回顶部，故按需保留当前滚动位置。
  if (restoreScroll && f.contentWindow) {
    let y = 0;
    try { y = f.contentWindow.scrollY || f.contentWindow.pageYOffset || 0; } catch (_) {}
    const onLoad = () => {
      try { f.contentWindow.scrollTo(0, y); } catch (_) {}
      f.removeEventListener('load', onLoad);
    };
    f.addEventListener('load', onLoad);
  }
  // 等当前 iframe load（如果有）完再切 src，避免旧加载覆盖新加载的 DOM
  if (f.contentDocument && f.contentDocument.readyState !== 'complete'){
    await new Promise(res => { const h = () => { f.removeEventListener('load', h); res(); }; f.addEventListener('load', h); });
  }
  f.src = canvasUrl('&t=' + Date.now());
  // 等待 iframe 重新加载完成，确保后续操作（如查询 DOM）能拿到新数据
  await new Promise(resolve => {
    const onLoad = () => { f.removeEventListener('load', onLoad); resolve(); };
    f.addEventListener('load', onLoad);
    setTimeout(() => { f.removeEventListener('load', onLoad); resolve(); }, 5000);
  });
}

function expandAllInCanvas() {
  const f = $('#ve-canvas');
  if (f && f.contentWindow) f.contentWindow.postMessage({ type: 've-expand-all' }, '*');
}
// 「展开所选内容」只操作当前画布的选中目标：项目 → 项目详情，分类 → 分类，
// Section → Section。顶部的“全部展开 / 全部收起”才负责全局操作，两个概念不能混用。
function expandSelectedInCanvas() {
  const f = $('#ve-canvas');
  if (!f || !f.contentWindow) return;
  const section = canvasSection || (veSelection && veSelection.section) || '';
  const itemPath = (veSelection && (veSelection.itemPath || veSelection.path)) || '';
  const groupId = (veSelection && veSelection.groupId) || '';
  if (!section && !itemPath && !groupId) {
    toast('请先在画布中选中要展开的区块、分类或项目；全部展开请使用顶部按钮');
    return;
  }
  f.contentWindow.postMessage({ type: 've-expand-target', section, itemPath, groupId }, '*');
  const selectedName = (veSelection && veSelection.text) || sectionLabel(section) || '所选内容';
  toast('已展开「' + selectedName + '」');
}
function collapseAllInCanvas() {
  const f = $('#ve-canvas');
  if (f && f.contentWindow) f.contentWindow.postMessage({ type: 've-collapse-all' }, '*');
}
function highlightInCanvas(section) {
  const f = $('#ve-canvas');
  if (!f || !f.contentWindow) return;
  f.contentWindow.postMessage({ type: 've-scroll-to-section', section }, '*');
  // 高亮：向 iframe 注入样式（ve-section-active 由 iframe 自己的 CSS 命中）
  try {
    const doc = f.contentDocument;
    if (!doc) return;
    doc.querySelectorAll('.entry.ve-section-active').forEach(e => e.classList.remove('ve-section-active'));
    const el = doc.querySelector(`.entry[data-section="${section}"]`);
    if (el) el.classList.add('ve-section-active');
  } catch (_) {}
}

// —— 左侧：区块顺序（拖拽 + 上下移） ——
// 区块顺序属于 Template（design.json），不属于 Personal Content（portfolio.json）：
// 拖动顺序只写 design.json，portfolio.json 一个字节都不动（导入别人的模板时顺序才会被替换）。
function currentSections() {
  if (Array.isArray(design.sectionOrder) && design.sectionOrder.length) return design.sectionOrder.slice();
  if (Array.isArray(draft.sections) && draft.sections.length) return draft.sections.slice();
  return ['about', 'experience', 'works', 'showreel', 'aiVoices'];
}
function sectionLabel(key) {
  return I18N?I18N.resolveSectionLabel(draft,key):((draft.sectionTitles && draft.sectionTitles[key]) || SECTION_LABELS[key] || key);
}
// 顺序落在 design.json（Template）：只要在 /api/design/save 的白名单里发 sectionOrder 即可，
// 刻意不 saveDraft —— portfolio.json 保持绝对不变。
async function persistStructure() {
  try {
    await api('/api/design/save', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sectionOrder: currentSections(), theme: draft.theme || null }) });
    notifyStudioSaved();
  } catch (e) { toast('区块顺序保存失败：' + e.message); }
  await reloadCanvas(true);
  refreshStatusDetail();
}
function renderSectionsList() {
  const list = $('#ve-sections');
  if (!list) return;
  const order = currentSections();
  list.innerHTML = order.map((k, i) =>
    `<li class="ve-section-row" draggable="true" data-key="${esc(k)}" data-i="${i}">
       <span class="ve-section-handle" title="拖动排序">≡</span>
       <span class="ve-section-title">${esc(sectionLabel(k))}</span>
       <span class="ve-section-actions">
         <button class="ve-btn ve-btn-icon" data-act="up" data-i="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
         <button class="ve-btn ve-btn-icon" data-act="down" data-i="${i}" ${i === order.length - 1 ? 'disabled' : ''}>↓</button>
       </span>
     </li>`).join('');
  // 高亮当前选中
  list.querySelectorAll('.ve-section-row').forEach(r => {
    r.classList.toggle('active', r.dataset.key === selectedSection);
    r.onclick = (e) => {
      if (e.target.closest('.ve-btn')) return;  // 按钮不触发选中
      selectedSection = r.dataset.key;
      // 切区块 = 换层级上下文：清掉上一次选中的分类，避免"加到别的分类里"
      veContext.section = selectedSection; veContext.addSection = selectedSection; veContext.groupId = ''; veContext.groupIndex = -1; veContext.itemPath = ''; veContext.mediaPath = '';
      renderSectionsList(); renderEditPanel();
      highlightInCanvas(selectedSection);
    };
  });
  // 上下移按钮
  list.querySelectorAll('[data-act="up"],[data-act="down"]').forEach(b => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const i = +b.dataset.i;
      const d = b.dataset.act === 'up' ? -1 : 1;
      const arr = currentSections();
      const n = i + d;
      if (n < 0 || n >= arr.length) return;
      [arr[i], arr[n]] = [arr[n], arr[i]];
      design.sectionOrder = arr;
      renderSectionsList();
      await persistStructure();
    };
  });
  // 拖拽排序
  list.querySelectorAll('.ve-section-row').forEach(row => {
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', row.dataset.key);
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
    row.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; row.classList.add('drag-over'); });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', async (e) => {
      e.preventDefault();
      row.classList.remove('drag-over');
      const dragged = e.dataTransfer.getData('text/plain');
      if (!dragged || dragged === row.dataset.key) return;
      const arr = currentSections();
      const fromIdx = arr.indexOf(dragged);
      const toIdx = arr.indexOf(row.dataset.key);
      if (fromIdx < 0 || toIdx < 0) return;
      arr.splice(fromIdx, 1);
      arr.splice(toIdx, 0, dragged);
      design.sectionOrder = arr;
      renderSectionsList();
      await persistStructure();
    });
  });
}

// —— 左侧：主题选择 ——
function renderThemeList() {
  const t = $('#ve-themes');
  if (!t) return;
  const presets = window.THEME_PRESETS || [];
  const cur = (draft.theme && draft.theme.preset) || 'light-01';
  t.innerHTML = presets.map(p =>
    `<button class="ve-theme-card ${cur === p.id ? 'selected' : ''}" data-id="${esc(p.id)}">
       <span class="ve-theme-swatch" style="--sw-ink:${window.THEMES[p.id].ink};--sw-paper:${window.THEMES[p.id].paper};--sw-accent:${window.THEMES[p.id].accent};--sw-line:${window.THEMES[p.id].line}"></span>
       <span class="ve-theme-label">${esc(p.label)}</span>
     </button>`).join('');
  t.querySelectorAll('.ve-theme-card').forEach(c => {
    c.onclick = async () => {
      const id = c.dataset.id;
      const th = window.THEMES[id];
      if (!th) return;
      draft.theme = { mode: th.mode, preset: id };
      syncPanelTheme();               // 面板立刻变色，不等落盘往返（画布那边仍要等保存完再重载）
      renderThemeList();
      // ⚠️ 必须先等主题**真的落盘**再重载画布：saveDesign 是 async，之前没 await 就 reloadCanvas，
      // 画布会在新主题写进 design.json 之前把 /api/design 读走 → 拿到旧主题，
      // 表现为「点了主题、提示已切换，但画布颜色一点没变，只有手动刷新才对」。
      const ok = await saveDesign(true);
      await reloadCanvas();
      toast(ok ? '主题已应用到画布；发布后对外正式生效' : '主题保存失败，请重试');
    };
  });
}

// —— 右侧：工具箱 ——
// 画布上直接点选内容改文字/删除；右侧放「选中元素的属性工具」+ 间距等统筹工具，
// 不再按 about / experience 这类区块分表单。
let veSelection = null;   // 画布当前选中的元素（由 iframe 的 ve-select 推送）

// 画布选中 → 推断「添加内容」的目标层级。选集里的项目时，同时记下它属于哪个分类，
// 这样点「+ 添加」加进去的项目就和它同级、同分类。
function applyCanvasContext(M) {
  const path = M.itemPath || '';
  const seg = path.split('.')[0];
  const sectionOfPath = {
    projects: 'works', projectGroups: 'works', experience: 'experience',
    showreel: 'showreel', aiVoices: 'aiVoices', profile: 'about',
  }[seg];
  if (sectionOfPath) { veContext.section = sectionOfPath; veContext.addSection = sectionOfPath; selectedSection = sectionOfPath; }
  if (/^sectionTitles\./.test(path)) { const k = path.split('.')[1]; if (k) { veContext.section = k; veContext.addSection = k; selectedSection = k; } }
  veContext.itemPath = path;
  veContext.kind = M.kind || '';
  veContext.groupId = M.groupId || '';
  veContext.groupIndex = (M.groupIndex == null || isNaN(M.groupIndex)) ? -1 : Number(M.groupIndex);
  veContext.mediaPath = /^projects\.\d+\.media$/.test(path) ? path : '';
  if (veContext.mediaPath) {
    const p = (draft.projects || [])[Number(path.split('.')[1])];
    if (p && p.groupId) veContext.groupId = p.groupId;
  }
}

// 选中项目的媒体（图片 / 视频 / 音频）时右侧给出的「位置 + 尺寸」控制。
// 尺寸 = 媒体栏占整行的百分比（Design.imgSizes）；位置 = 左 / 右（Design.mediaLayout）。
// 两者都存在 Design 里，画布与真实作品集共用，所以调完就是最终效果。
function renderMediaControls() {
  const candidates = (draft.projects || []).map((project, index) => {
    const media = project.media || {};
    const hasMedia = media.mainVisual || (media.processImages || []).length || media.video || media.audio;
    return hasMedia ? { path: 'projects.' + index + '.media', project } : null;
  }).filter(Boolean);
  if (!candidates.length) return `<section class="ve-tb-card ve-tb-media"><h4>媒体的位置与尺寸</h4><p class="ve-hint">当前没有可调整的项目媒体。请先在文本编辑上传图片、视频或音频；上传后这里会自动出现对应项目。</p></section>`;
  const selected = candidates.find(x => x.path === veContext.mediaPath) || candidates[0];
  const path = selected.path;
  veContext.mediaPath = path;
  const idx = Number(path.split('.')[1]);
  const proj = (draft.projects || [])[idx] || {};
  const size = Math.round(((design.imgSizes || {})[path] || {}).widthPct || 38);
  const side = ((design.mediaLayout || {})[path] || {}).side || 'right';
  const m = proj.media || {};
  const parts = [];
  if (m.mainVisual && (m.mainVisual.url || typeof m.mainVisual === 'string')) parts.push('图片');
  if ((m.processImages || []).length) parts.push('过程图 ' + m.processImages.length + ' 张');
  const videoUrl = (m.video && (m.video.url || m.video)) || '';
  if (videoUrl) parts.push(/\.(mp4|webm|ogv|m4v)(\?|$)/i.test(String(videoUrl)) ? '视频' : '视频（MOV / ProRes 浏览器播不了，需转 MP4）');
  if (m.audio) parts.push('音频');
  const projectOptions = candidates.map(x => `<option value="${x.path}" ${x.path === path ? 'selected' : ''}>${esc(x.project.name || '未命名项目')}</option>`).join('');
  return `<section class="ve-tb-card ve-tb-media">
    <h4>媒体的位置与尺寸</h4>
    <label class="ve-tl"><span>项目</span><select id="ve-media-target">${projectOptions}</select></label>
    <p class="ve-hint" style="margin-top:0">当前包含：${esc(parts.join(' / ') || '无媒体')}</p>
    <label class="ve-tl"><span>宽度</span>
      <input type="range" id="ve-media-width" min="18" max="70" step="1" value="${size}">
      <b id="ve-media-width-v">${size}%</b></label>
    <div class="ve-block"><span class="ve-block-label">位置</span>
      <div class="ve-canvas-row">
        <button class="ve-btn ve-btn-sm ${side === 'left' ? 'primary' : ''}" data-media-side="left">放左边</button>
        <button class="ve-btn ve-btn-sm ${side === 'right' ? 'primary' : ''}" data-media-side="right">放右边</button>
      </div>
    </div>
    <p class="ve-hint">宽度是「媒体栏占整行的比例」，图片和视频共用这一栏，所以电脑 / 手机 / 画布算出来的比例完全一致。</p>
  </section>`;
}

const SPACING_KEYS = [
  ['topSpace',    '页面顶部留白',   75],
  ['heroNameGap', '眉标到姓名',      0],
  ['heroPad',     '姓名简介到横线', 48],
  ['metaTop',     '横线到下方内容', 40],
  ['dirGap',      '内容与目录间距', 42],
  ['entryGap',    '区块之间的间距',  0],
  ['footerTop',   '目录与页脚间距', 40],
];
const VE_SPACE_MAX = 1000;

function canvasMetrics(){
  const m = readDirect('getCanvasMetrics');
  return (m && typeof m === 'object') ? m : { contentHeight: 0, minimumCanvasHeight: 0, canvasHeight: 0, footerBottom: 0 };
}
function renderCanvasSizingTools(){
  const m = canvasMetrics();
  const h = Math.max(0, Math.round(Number(m.canvasHeight) || 0));
  const min = Math.max(0, Math.round(Number(m.minimumCanvasHeight) || 0));
  const bottom = Math.max(0, Math.round(Number(m.footerBottom) || 0));
  return `<section class="ve-tb-card ve-tb-page-size">
    <h4>页面高度与底部留白</h4>
    <p class="ve-hint">底部留白是内容结束到页面画布底边的距离，不会修改文字或项目的 margin。</p>
    <label class="ve-field"><span>页面高度（px）</span><input id="ve-canvas-height" type="number" min="${min}" step="1" value="${h}" inputmode="numeric"></label>
    <p class="ve-hint" id="ve-canvas-height-note">最低安全高度：${min}px（由当前内容实际高度计算）</p>
    <label class="ve-field"><span>页面底部留白（px）</span><input id="ve-footer-bottom" type="number" min="0" max="${VE_SPACE_MAX}" step="1" value="${bottom}" inputmode="numeric"></label>
  </section>`;
}
// Phase 4（2026-09-26）：clamp 后的提示不再只靠 ~2s Toast——记成「未处理完」的行内警示
// （.ve-warn 高亮），画布后续自动刷新不会把它冲掉；下一次成功设置（done:true）才清除。
let _veSizeNoteSticky = '';
function refreshCanvasSizingTools(message, opts){
  const m = canvasMetrics();
  const h = $('#ve-canvas-height'), b = $('#ve-footer-bottom'), note = $('#ve-canvas-height-note');
  if (h) h.value = String(Math.round(Number(m.canvasHeight) || 0));
  if (b) b.value = String(Math.max(0, Math.round(Number(m.footerBottom) || 0)));
  if (opts && opts.done) _veSizeNoteSticky = '';
  else if (message !== undefined) _veSizeNoteSticky = String(message);
  const text = (message !== undefined) ? message
    : (_veSizeNoteSticky || ('最低安全高度：' + Math.max(0, Math.round(Number(m.minimumCanvasHeight) || 0)) + 'px（由当前内容实际高度计算）'));
  if (note){ note.textContent = text; note.classList.toggle('ve-warn', !!_veSizeNoteSticky); }
}

// rgb()/rgba() → #rrggbb，供 <input type="color"> 使用
function toHexInput(c) {
  if (!c) return '#000000';
  const m = String(c).match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (!m) return /^#[0-9a-f]{6}$/i.test(c) ? c : '#000000';
  return '#' + [1, 2, 3].map(i => (+m[i]).toString(16).padStart(2, '0')).join('');
}

// —— 像素形象预设（4 个原创 SVG，无版权风险）——
function gridToSvg(grid, palette, name, cell){
  const rows = grid.trim().split('\n');
  const w = rows[0].length, h = rows.length, c = cell || 8;
  const rects = [];
  for (let y=0;y<h;y++) for (let x=0;x<w;x++){
    const ch = rows[y][x];
    if (palette[ch]) rects.push(`<rect x="${x*c}" y="${y*c}" width="${c}" height="${c}" fill="${palette[ch]}"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w*c} ${h*c}" width="${w*c}" height="${h*c}" role="img" aria-label="${esc(name)}">${rects.join('')}</svg>`;
}
function svgToDataUri(svg){ return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg); }
const AVATAR_PRESETS = [
  { id:'headphone', label:'耳机小子',
    grid: '.bbbbbbbb.\n.b......b.\n.b......b.\n.bkkkkkkb.\n.bksssskb.\n.bkessekb.\n.bksssskb.\n.bksmmskb.\n..kssssk..\n..kssssk..',
    palette:{k:'#1c2433',s:'#e8c39a',e:'#1c2433',m:'#7a3a30',b:'#3a4a6a'} },
  { id:'cat', label:'猫耳少女',
    grid: '..k....k..\n.kak..kak.\n..kkkkkk..\n..kssssk..\n..kessek..\n..kssssk..\n..ksmmsk..\n..kssssk..\n..kssssk..\n..........',
    palette:{k:'#1c2433',s:'#e8c39a',e:'#1c2433',m:'#7a3a30',a:'#f4a8b8'} },
  { id:'visor', label:'未来面罩',
    grid: '..........\n..........\n..kkkkkk..\n..kssssk..\n..kvvvvk..\n..kvvvvk..\n..kssssk..\n..ksmmsk..\n..kssssk..\n..........',
    palette:{k:'#1c2433',s:'#e8c39a',m:'#7a3a30',v:'#5fe0c8'} },
  { id:'bolt', label:'电光小子',
    grid: '....aa....\n...aa.....\n..aa......\n..kkkkkk..\n..kssssk..\n..kessek..\n..kssssk..\n..ksmmsk..\n..kssssk..\n..kssssk..',
    palette:{k:'#1c2433',s:'#e8c39a',e:'#1c2433',m:'#7a3a30',a:'#f0d050'} },
  { id:'spaceman', label:'太空人',
    grid: '...kk.....\n..kkkk....\n.kvvvvk...\n.kvvvvk...\n.kksssk...\n..ksssk...\n..ksmmsk..\n..kbbbbk..\n...kbbk...\n..........',
    palette:{k:'#1c2433',s:'#e8c39a',v:'#5fe0c8',m:'#7a3a30',b:'#3a4a6a'} },
  { id:'dino', label:'小恐龙',
    // ⚠ 2026-09-25 修：原来这一行末尾是 `.ksssskttt` + palette 里的 `t:'#f4f4f4'`，
    //   尾巴上挂着 3 个**近白色**方块（浅色主题下看不出来，暗色主题下就是 3 个刺眼的白点）。
    //   用户原话：「它在暗色模板下它为什么这个小恐龙的形象还会有三个白的像素点啊？
    //   按道理这个形象应该不能包括包围的白像素点。」→ 去掉那 3 格与对应色板项。
    //   已有数据里存的是生成的 SVG 快照，那边由 tools/migrate 的幂等迁移一并清掉。
    grid: '..kkkk....\n.kssssk...\n.ksessek..\n.kssssk...\n.kssssk...\nksssssk...\nkssssssk..\n.kmmmmk...\n.kk..kk...\n..........',
    palette:{k:'#1c2433',s:'#bfe3a0',e:'#1c2433',m:'#7a3a30'} },
  { id:'robot', label:'机器人',
    grid: '..........\n.kkkkkk...\n.kvvvvk...\n.kvwwvk...\n.kvvvvk...\n.kssssk...\n.kbbbbk...\n.kbbbbk...\n..k..k....\n..........',
    palette:{k:'#1c2433',s:'#c9d2dd',v:'#3aa0ff',w:'#ffffff',b:'#9aa6b5'} },
  { id:'ghost', label:'小幽灵',
    grid: '...kk.....\n..kkkk....\n.kkkkkk...\n.kwwwwk...\n.kwkkwk...\n.kwwwwk...\n.kkkkkk...\n.kkkkkk...\nkk.kk.kk..\n..........',
    palette:{k:'#1c2433',w:'#eef1f6'} },
  // 用户提供的 FolioFold 应用图标，作为「形象」的一个可选选项。
  // ⚠ 只出现在这个选择器里，不会自动放进画布（用户不点就不会出现在作品集上）。
  // 自带 src（位图而非像素网格），所以下面 map 里要保留已有 src。
  { id:'folioframe', label:'FolioFold 标志', src:'/media/brand/folioframe-icon-256.png' },
].map(p => Object.assign({}, p, { src: p.src || svgToDataUri(gridToSvg(p.grid, p.palette, p.label)) }));

function renderEditPanel() { renderToolbox(); }

// 绑定 Pixel 形象控件（区域 / 动画 / 显隐 / 重置位置）。size 滑块与移除按钮在 wireToolbox 里处理。
function wirePixelAvatarControls() {
  const savePix = async (patch, opts) => {
    pushHistory();
    design.pixel = Object.assign({}, design.pixel || {}, patch);
    await api('/api/design/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pixel: design.pixel, theme: draft.theme || null }) });
    postToCanvas({ type: 've-pixel-update', pixel: design.pixel });
    renderToolbox();
  };
  // —— 活动轨迹设定：进入画布画线模式 ——
  const drawPath = $('#ve-pixel-drawpath');
  if (drawPath) drawPath.onclick = () => {
    postToCanvas({ type: 've-pixel-set-mode', mode: 'drawpath' });
    toast('进入画轨迹模式：在画布上用鼠标画一条连续的自由线，画完点「✓ 完成轨迹」。');
  };
  const clearPath = $('#ve-pixel-clearpath');
  if (clearPath) clearPath.onclick = async () => {
    const px = Object.assign({}, design.pixel || {});
    delete px.path; delete px.onPath; px.drawX = undefined; px.drawY = undefined;
    await savePix(px); toast('已清除活动轨迹');
  };
  const onPath = $('#ve-pixel-onpath');
  if (onPath) onPath.onchange = async () => {
    await savePix({ onPath: onPath.checked });
    toast(onPath.checked ? '已启用固定活动路线：形象只在 Hero 下方横线附近活动' : '已关闭活动路线：可自由放置，角色不会走路');
  };
  const animation = $('#ve-pixel-animation');
  if (animation) animation.onchange = async () => {
    await savePix({ animation: animation.checked });
    toast(animation.checked ? 'Pixel 动画已开启' : 'Pixel 动画已关闭：角色完全静止');
  };
  const vis = $('#ve-pixel-visible');
  if (vis) vis.onchange = async () => {
    await savePix({ visible: vis.checked });
    toast(vis.checked ? 'Pixel 已显示' : 'Pixel 已隐藏');
  };
  const resetPos = $('#ve-pixel-resetpos');
  if (resetPos) resetPos.onclick = async () => {
    const px = Object.assign({}, design.pixel || {});
    delete px.x; delete px.y; delete px.drawX; delete px.drawY; delete px.area;
    await savePix(px); toast('已复位到初始位置');
  };
}

// —— 右侧工具箱：始终可见，随「画布选中什么」自动切换上下文 ——
// 无选中 → Canvas 通用（删间距杆切换 / 添加图片 / 添加内容 / Pixel 形象）
// 选中文字 → WPS 文字工具；选中图片 → 图片工具；选中 Pixel → 位置/大小/区域/显隐/动画；选中静态元素 → 说明 + 删除
//
// 「添加内容」按层级工作：画布上选中什么，就加到哪一层。
//   Works 区块上点添加   → 新增「作品分类」（与 Original Production 同级）
//   某个分类里点添加     → 在分类里新增「项目」（与《示例作品》同级）
//   Experience / Showreel / AI Project → 各自层级的条目
// 所有新增都写进 portfolio.json（内容），因此文本编辑与最终作品集立刻看到同一份数据。
let veContext = { section: 'about', addSection: 'about', groupId: '', groupIndex: -1, itemPath: '', kind: '' };

function contextTarget(section) {
  const s = section || veContext.section;
  if (s === 'works') {
    const g = (draft.projectGroups || []).find(x => x.id === veContext.groupId);
    return g ? { level: 'project', group: g } : { level: 'category' };
  }
  return { level: s };
}

function renderContextActions() {
  const groups = draft.projectGroups || [];
  const addSection = veContext.addSection || veContext.section || 'about';
  const groupOptions = groups.map(g => `<option value="${esc(g.id)}" ${g.id === veContext.groupId ? 'selected' : ''}>${esc(g.title || '未命名分类')}</option>`).join('');
  const target = addSection === 'works' ? contextTarget(addSection) : { level: addSection };
  const secLabel = sectionLabel(addSection);

  // 每种层级：可加什么 / 加在哪 / 说明
  let choices = [], hint = '', crumb = esc(secLabel), needGroup = false, showGroupSelect = false;
  if (addSection === 'about') {
    choices = [['contact', '联系方式'], ['skill', '技能'], ['highlight', '个人亮点']];
    hint = '加到 About 区块。新增后直接在画布上点它改文字。';
  } else if (addSection === 'experience') {
    choices = [['experience', '工作经历']];
    hint = '新增一条经历：这里只放「公司 / 职位 / 时间」三个空位，展开后的介绍与 Highlights 请到「文本编辑 → 经历」补充（排版编辑不做长文表单）。';
  } else if (addSection === 'showreel') {
    choices = [['showreel-project', 'Showreel 项目（自带视频位 + 章节位）']];
    hint = '在 Showreel 栏目下新增一个 Showreel 项目（与已有项目同级），它自带视频位与章节位；视频、外部链接和章节时间请到「文本编辑 → Showreel」里编辑。';
  } else if (addSection === 'aiVoices') {
    choices = [['ai-project', 'AI 项目']];
    hint = '新增独立 AI 项目，与已有 AI Voices 卡片使用同一套模板：名称 / 简介可直接在画布上改；项目定位、我的角色、我的贡献、技术栈、亮点、GitHub 链接和多张截图请在「文本编辑 → AI Project」补充。';
  } else { // works
    if (target.level === 'project') {
      crumb = esc(secLabel) + ' › <b>' + esc(target.group.title || '未命名分类') + '</b>';
      choices = [['work-project', '在这个分类里新增项目'], ['work-category', '新建作品分类']];
      showGroupSelect = true; needGroup = true;
      hint = '新增项目与《示例作品》《示例短片》同级，只带「名称 / 时间 / 类型 / 角色」几个空位，其余内容请到「文本编辑 → 项目」补充。想看别的分类的项目，先在上面选分类。';
    } else {
      choices = [['work-category', '新建作品分类'], ['work-project', '在某个分类里新增项目']];
      showGroupSelect = true; needGroup = true;
      hint = 'Works 这一层放的是分类（Original Production / Film Sound Re-design …）。在目录里点进某个分类再点添加，就是往那个分类里加项目。';
    }
  }
  const options = choices.map(([v, l], i) => `<option value="${v}" ${i === 0 ? 'selected' : ''}>${l}</option>`).join('');
  const groupSelect = (showGroupSelect && groups.length)
    ? `<label class="ve-tl" id="ve-add-group-wrap"><span>分类</span><select id="ve-add-group">${groupOptions}</select></label>`
    : '';

  const sectionOptions = currentSections().map(key => `<option value="${key}" ${key === addSection ? 'selected' : ''}>${esc(sectionLabel(key))}</option>`).join('');
  return `<section class="ve-tb-card ve-tb-add">
    <h4>添加内容</h4>
    <p class="ve-ctx">添加到：${crumb}</p>
    <label class="ve-tl"><span>目标区块</span><select id="ve-add-target">${sectionOptions}</select></label>
    <label class="ve-tl"><span>类型</span><select id="ve-add-kind" data-need-group="${needGroup ? 1 : 0}">${options}</select></label>
    ${groupSelect}
    <button class="ve-btn" id="ve-add-content">+ 添加</button>
    <p class="ve-hint" style="margin:8px 0 0">${hint}</p>
    <p class="ve-hint" style="margin:6px 0 0">工具始终可用；点画布区块会自动预选目标，也可以直接在上面切换目标区块。</p>
  </section>`;
}
// —— 已添加媒体「统筹区」：列出所有自由图片（缩略图 + 所属区块 + 类型 + 一键删除）——
function imgTypeLabel(src){
  if (!src) return '图片';
  return /\.(mp4|webm|ogg|mov|m4v|avi)(\?|$)/i.test(src) ? '视频' : '图片';
}
/* 锚点路径（aiVoices.projects.0）→ { sec:'aiVoices', idx:0 }。
 * ⚠ 位置文案必须**按结构派生**，绝不能直接返回 design 里存的 aLabel ——
 *   那是插入图片那一刻写死的中文（'整页' / 'Hero（形象位）' / '目录与脚页之间'），
 *   一旦存进 design.json，用户把界面切成英文时这些中文会原样冒出来。
 *   （2026-09-23 用户反复反馈的「自由放置的图片还是中文」就是这个。）
 *   结构字段 aKind / aSection / aItem 本来就是语言中立的，渲染时再翻译才安全。 */
function anchorSecOf(aItem, fallback){
  const p = String(aItem || '');
  const m = p.match(/^([A-Za-z][\w-]*)\./);
  return fallback || (m ? m[1] : '');
}
function anchorIndexOf(aItem){
  const m = String(aItem || '').match(/\.(\d+)(?:$|\.)/);
  return m ? Number(m[1]) : null;
}
function imgLocationLabel(it){
  const k = it && it.aKind;
  // 只有 v1 老数据才完全没有 aKind；那种情况才退回存的 aLabel。
  if (!k) return (it && it.aLabel) || z('整页（自由浮层）');
  if (k === 'hero') return z('顶部形象区');
  if (k === 'tail') return z('目录与脚页之间');
  if (k === 'section') return sectionLabel(it.aSection || '') || it.aSection || z('区块');
  if (k === 'item'){
    const sec = anchorSecOf(it.aItem, it.aSection);
    const idx = anchorIndexOf(it.aItem);
    const nm = sec ? sectionLabel(sec) : '';
    if (nm) return idx == null ? nm : nm + ' · ' + (idx + 1);
    return it.aItem || z('子项');
  }
  return z('整页（自由浮层）');
}
// 缩略图用 CSS background-image（而非 <img src>）：资源 404 时不会触发 window 的 error 事件，
// 也就不会误触看门狗；缺失时自然退化为灰底占位块。
function thumbBgStyle(src){
  const u = String(src || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '%27');
  return u ? ` style="background-image:url('${u}')"` : '';
}
// 统筹区的第二个数据源：个人内容里的媒体（文本编辑 / 画布上传加进去的那些）。
// 口径与画布渲染保持一致：images = [mainVisual, ...processImages]
function mediaUrlOf(v){ if (!v) return ''; return typeof v === 'string' ? v : (v.url || ''); }
/* 项目名称旁的「Logo 点缀图」（content 里的 p.logo）。
 * ⚠ 2026-09-23 之前它**只出现在画布里，不出现在任何名单里** —— 用户在画布上看到
 *   多出来一个小小的 logo 图，翻遍所有下拉栏都找不到它是什么、更没法删。
 *   `locate` 给的是画布 DOM 上真正的锚点属性值（项目卡片路径，如 aiVoices.projects.0），
 *   与画布 logoPair() 打的 data-ve-logo-path 一致，这样「定位」才能命中。 */
function projectLogoEntry(p, P, nm){
  const raw = typeof p.logo === 'string' ? p.logo : (p.logo && (p.logo.url || p.logo.src)) || '';
  if (!raw) return null;
  return { key: P + '.logo', locate: P, type: '图片', loc: nm + ' · ' + z('Logo 点缀图'), src: raw };
}
function collectContentMedia(){
  const out = [];
  (draft.projects || []).forEach((p, i) => {
    const md = p.media || {};
    // ⚠ 未命名条目的兜底名必须是**界面串**，不能写死中文：原来这里是 `('项目 ' + (i+1))`，
    //   于是用户没填项目名时，英文界面的统筹区就冒出「项目 1 · Logo mark」这种中英混排。
    const name = p.name || (z('未命名项目') + ' ' + (i + 1));
    const images = [];
    if (md.mainVisual) images.push(md.mainVisual);
    (Array.isArray(md.processImages) ? md.processImages : []).forEach(x => { if (x) images.push(x); });
    images.forEach((im, k) => out.push({ key: 'projects.' + i + '.media#image' + k, type: '图片', loc: name, src: mediaUrlOf(im) }));
    if (md.video) out.push({ key: 'projects.' + i + '.media#video', type: '视频', loc: name, src: mediaUrlOf(md.video) });
    if (md.audio) out.push({ key: 'projects.' + i + '.media#audio', type: '音频', loc: name, src: mediaUrlOf(md.audio) });
    const lg = projectLogoEntry(p, 'projects.' + i, name); if (lg) out.push(lg);
  });
  const sr = (draft.showreel || {}).media;
  if (mediaUrlOf(sr)) out.push({ key: 'showreel.media', type: '视频', loc: 'Showreel', src: mediaUrlOf(sr) });
  ((draft.aiVoices || {}).projects || []).forEach((p, i) => {
    const md = p.media || {};
    const nm = p.name || (z('未命名 AI 项目') + ' ' + (i + 1));
    const P = 'aiVoices.projects.' + i;
    if (md.image) out.push({ key: P + '.media.image', type: '图片', loc: nm, src: mediaUrlOf(md.image) });
    (md.screenshots || []).forEach((s, si) => { if (s) out.push({ key: P + '.media.screenshots.' + si, type: '图片', loc: nm, src: mediaUrlOf(s) }); });
    const lg = projectLogoEntry(p, P, nm); if (lg) out.push(lg);
  });
  return out;
}
function renderImagesOverview(){
  const imgs = Array.isArray(design.images) ? design.images : [];
  // 「原地自由摆放」（inplace）和「克隆式自由图」必须分开列 —— 2026-09-23 用户第 ⑤ 项之后
  // 自由摆放用的就是内容里那张原图本身，如果还混在「自由放置的图片」里显示，
  // 用户会以为同一张图被复制成了两份（他原话：「它重新生成一个图」）。
  const own = imgs.filter(it => it && it.inplace);
  const free = imgs.filter(it => it && !it.inplace);
  const one = (it, delBtn) => {
    const id = it.id || '';
    const src = it.src || '';
    const type = z(imgTypeLabel(src));
    const loc = z(imgLocationLabel(it));
    // 整行可点 = 「在画布上把它找出来」（滑到可见处 + 高亮 + 选中）。
    // 用户原话：「我希望点击这个图片，它可以自动定位出这个图片在哪……方便删除、整理和确认」。
    return `<div class="ve-ov-item ve-ov-click" data-ov-id="${esc(id)}" data-locate-id="${esc(id)}"
        title="${esc(z('在画布上定位这张图片（会滚到它那里并高亮）'))}">
      <span class="ve-ov-thumb"${thumbBgStyle(src)} title="${esc(type)}"></span>
      <div class="ve-ov-meta">
        <div class="ve-ov-type">${esc(type)}</div>
        <div class="ve-ov-loc" title="${esc(loc)}">${esc(loc)}</div>
      </div>
      <span class="ve-ov-find" aria-hidden="true">⌖</span>
      ${delBtn}
    </div>`;
  };
  const freeItems = free.map(it => one(it, `<button class="ve-ov-del" data-del-img="${esc(it.id || '')}" title="${esc(z('删除这张图片'))}">🗑</button>`)).join('');
  // 原图自由摆放：那个元素就是内容里的图，所以这里的「删除」实际是「取消自由摆放、回到普通排版」。
  const ownItems = own.map(it => one(it, `<button class="ve-ov-del" data-del-img="${esc(it.id || '')}" title="${esc(z('取消自由摆放，这张图回到内容里的普通排版（不会删掉图片）'))}">↺</button>`)).join('');
  // 内容媒体：文本编辑里加的项目图片 / 视频 / 音频，以及 Showreel、AI 项目媒体、项目 Logo
  const cm = collectContentMedia();
  const cmItems = cm.map(m => `<div class="ve-ov-item ve-ov-click" data-ov-key="${esc(m.key)}"
      data-locate-key="${esc(m.key)}" data-locate-path="${esc(m.locate || '')}"
      title="${esc(z('在画布上定位这一项（会滚到它那里并高亮）'))}">
      <span class="ve-ov-thumb"${thumbBgStyle(m.src)} title="${esc(z(m.type))}"></span>
      <div class="ve-ov-meta">
        <div class="ve-ov-type">${esc(z(m.type))}</div>
        <div class="ve-ov-loc" title="${esc(m.loc)}">${esc(m.loc)}</div>
      </div>
      <span class="ve-ov-find" aria-hidden="true">⌖</span>
      <button class="ve-ov-del" data-del-media="${esc(m.key)}" title="${esc(z('删除这一项媒体'))}">🗑</button>
    </div>`).join('');
  const total = imgs.length + cm.length;
  const head = total
    ? `<p class="ve-hint" style="margin:0 0 8px">${esc(z('共 ' + total + ' 项。点任意一项可以直接在画布上找到它。删哪一项都不影响其他项。'))}</p>`
    : `<p class="ve-hint" style="margin:0 0 8px">${esc(z('还没有媒体。点「🖼 添加图片」在画布放置，或在「文本编辑」里给项目加图 / 视频。'))}</p>`;
  const freeBlock = free.length
    ? `<div class="ve-ov-group">${esc(z('自由放置的图片（' + free.length + '）'))}</div><div class="ve-ov-list">${freeItems}</div>` : '';
  const ownBlock = own.length
    ? `<div class="ve-ov-group" title="${esc(z('这些是内容里本来就有的图，只是被你转成了自由摆放 —— 它们仍然在「内容里的媒体」名单里，不是复制品'))}">${esc(z('自由摆放的原图（' + own.length + '）'))}</div><div class="ve-ov-list">${ownItems}</div>` : '';
  const cmBlock = cm.length
    ? `<div class="ve-ov-group">${esc(z('内容里的媒体（' + cm.length + '）'))}</div><div class="ve-ov-list">${cmItems}</div>` : '';
  return `<section class="ve-tb-card ve-tb-images" id="ve-images-overview">
    <h4>${esc(z('已添加的媒体（统筹区）'))}</h4>
    ${head}
    ${ownBlock}${freeBlock}${cmBlock}
  </section>`;
}
function refreshImagesOverview(){
  const el = $('#ve-images-overview');
  if (el) el.outerHTML = renderImagesOverview();
}
function deleteFreeImageById(id){
  if (!id) return;
  design.images = (Array.isArray(design.images) ? design.images : []).filter(i => i.id !== id);
  refreshImagesOverview();
  postToCanvas({ type:'ve-delete-free-image', id });
}

/* 2026-09-23：右侧「已添加的媒体（统筹区）」点一整行 → 让画布把这张图找出来
 * （滚到可见处 + 描边高亮 + 选中，于是 8 向手柄/工具条立刻可用）。
 * 用户原话：「我希望点击这个图片，它可以自动定位出这个图片在哪。然后这样子方便编辑，
 *   因为现在这两张图，说实话我不知道它的具体位置，这样子我删的话我就不好删」。
 * 三把钥匙都带上，让画布按顺序试：
 *   id   —— 自由摆放记录 id（画布上 [data-ve-img="id"]）
 *   path —— 画布 DOM 锚点（data-ve-media-path / data-ve-media-item / data-ve-logo-path）
 *   key  —— 内容路径 / 媒体项 key（projects.0.media#image1、aiVoices.projects.0.media.image …） */
function locateMediaInCanvas(row){
  if (!row) return;
  const id   = row.getAttribute('data-locate-id')   || '';
  const path = row.getAttribute('data-locate-path') || '';
  const key  = row.getAttribute('data-locate-key')  || '';
  if (!id && !path && !key) return;
  postToCanvas({ type:'ve-locate', id, path, key });
}

/* 画布回报「定位结果」：把画布外层滚动容器（.ve-canvas-wrap）滚到这张图那里。
 * ⚠ 不能让画布 iframe 自己 scrollIntoView —— 画布 iframe 是**整页高**、内部不滚动，
 *   真正滚动的是父窗口的 .ve-canvas-wrap（实测：在画布内 scrollIntoView 完全没反应，
 *   元素 getBoundingClientRect().top 始终是页面坐标 3724）。 */
function handleLocateResult(M){
  if (!M || !M.ok){ toast(z('画布上找不到这一项（可能已被删除，或它属于当前没渲染的那一版）')); return; }
  try {
    const wrap = document.querySelector('.ve-canvas-wrap');
    const stage = document.querySelector('#ve-canvas-stage');
    const frame = document.querySelector('#ve-canvas');
    if (!wrap || !stage || !frame) return;
    const scale = Number(frame.dataset.veScale || 1) || 1;
    const stageTop = stage.getBoundingClientRect().top - wrap.getBoundingClientRect().top;
    const inner = (Number(M.y) || 0) * scale;
    const want = wrap.scrollTop + stageTop + inner - wrap.clientHeight / 2;
    if (typeof wrap.scrollTo === 'function') wrap.scrollTo({ top: Math.max(0, want), behavior: 'smooth' });
    else wrap.scrollTop = Math.max(0, want);
  } catch (_) {}
}
/* 内容里的某张媒体被删掉时，顺手把它在 Design 里留下的自由摆放痕迹一起清掉。
 * 为什么必须清：2026-09-23 起「自由摆放」是把**原图本身**变成自由摆放（design.images 里记
 * inplace:true + imgPos[key].place='free'）。原图没了，这条记录就成了孤儿 ——
 * 画布上什么都不显示，但右侧「已添加的媒体（统筹区）」里还留着一项删不掉的东西。
 * key 可以是「媒体项 key」（projects.0.media#image1）或内容路径。 */
async function dropFreeRecordsForKey(key){
  if (!key) return;
  const imgs = Array.isArray(design.images) ? design.images : [];
  const had = imgs.some(i => i && i.sourcePath === key) || (design.imgPos && design.imgPos[key]);
  if (!had) return;
  design.images = imgs.filter(i => !(i && i.sourcePath === key));
  if (design.imgPos && design.imgPos[key]) delete design.imgPos[key];
  try {
    await api('/api/design/save', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ images: design.images, imgPos: design.imgPos || {}, theme: draft.theme || null }) });
  } catch (_) {}
}
// 清空整个项目媒体时用：把该项目名下所有媒体项 key 的自由摆放痕迹一起删掉。
async function dropFreeRecordsForPrefix(prefix){
  if (!prefix) return;
  const imgs = Array.isArray(design.images) ? design.images : [];
  const hit = k => k === prefix || k.indexOf(prefix + '#') === 0;
  const kept = imgs.filter(i => !(i && hit(i.sourcePath || '')));
  const pos = Object.assign({}, design.imgPos || {});
  let changed = kept.length !== imgs.length;
  Object.keys(pos).forEach(k => { if (hit(k)){ delete pos[k]; changed = true; } });
  if (!changed) return;
  design.images = kept; design.imgPos = pos;
  try {
    await api('/api/design/save', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ images: design.images, imgPos: design.imgPos, theme: draft.theme || null }) });
  } catch (_) {}
}
// 删除「一项」内容媒体：key 形如 projects.N.media#imageK / #video / #audio
async function removeMediaItemByKey(key){
  const mk = /^projects\.(\d+)\.media#(.+)$/.exec(String(key || ''));
  if (!mk) return false;
  const idx = Number(mk[1]); const tail = mk[2];
  const project = (draft.projects || [])[idx];
  if (!project) return false;
  project.media = project.media || { mainVisual: null, processImages: [], video: null, audio: null, externalVideoUrl: '', externalLink: '' };
  const md = project.media;
  if (tail === 'video') md.video = null;
  else if (tail === 'audio') md.audio = null;
  else {
    const k = Number((/^image(\d+)$/.exec(tail) || [])[1]);
    if (!isFinite(k)) return false;
    const images = [];
    if (md.mainVisual) images.push(md.mainVisual);
    (Array.isArray(md.processImages) ? md.processImages : []).forEach(x => { if (x) images.push(x); });
    if (k < 0 || k >= images.length) return false;
    images.splice(k, 1);
    md.mainVisual = images.length ? images[0] : null;
    md.processImages = images.slice(1);
  }
  if (design.mediaItems && design.mediaItems[key]) {
    delete design.mediaItems[key];
    await api('/api/design/save', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ mediaItems: design.mediaItems, theme: draft.theme||null }) });
  }
  // 这张图如果之前被「自由摆放」过，它的设计侧记录也要一起走，别留孤儿
  await dropFreeRecordsForKey(key);
  return await saveDraft(true);
}
// 按内容路径删除一张媒体（AI 项目封面 / 截图 / Showreel 等）
async function removeByContentPath(pathStr){
  const path = String(pathStr || '').split('.');
  if (path.length < 2) return false;
  const last = path[path.length - 1];
  if (/^\d+$/.test(last)) {
    const arr = getDeep(draft, path.slice(0, -1));
    if (!Array.isArray(arr)) return false;
    arr.splice(Number(last), 1);
  } else {
    setDeep(draft, path, '');
  }
  return await saveDraft(true);
}
// 统筹区删除：自由图片走 data-del-img，内容媒体走 data-del-media
async function deleteMediaByKey(key){
  if (!key) return;
  const isItem = /^projects\.\d+\.media#/.test(key);
  const ok = isItem ? await removeMediaItemByKey(key) : await removeByContentPath(key);
  if (ok) { await reloadCanvas(true); renderToolbox(); toast('已删除这一项媒体，其他项不受影响'); }
  else { refreshImagesOverview(); toast('删除失败，请刷新后重试'); }
}
// —— 区块级 Logo 点缀图（2026-09-19）——
// 用途：一个作品集可能只有 About / Experience / Works 三个大区、不再细分项目，
// 用户也想在大区块标题旁放可视化点缀 —— 之前只有子项目能放，大区块没地方放。
// 数据落在 Content 的 sectionLogos[key]（key = 区块 id），与文本编辑的「页面结构」共用同一份数据。
// 这里直接读写 draft.sectionLogos，走 saveDraft()，和项目级 logo 完全一致。
function renderSectionLogoCard() {
  const key = selectedSection || 'about';
  const label = sectionLabel(key);
  const lg = (draft.sectionLogos || {})[key];
  const u = lg && (typeof lg === 'string' ? lg : (lg.url || lg.src)) || '';
  const before = !!(lg && lg.pos === 'before');
  return `
      <section class="ve-tb-card ve-tb-seclogo">
        <h4>区块 Logo 点缀图</h4>
        <p class="ve-hint" style="margin-top:0">作用对象：<b>${esc(label)}</b> 这个区块的标题（左侧「页面区块」里选中的那个）。图片锁在标题行高度内，不会撑开区块或改变行距。任何模板 / 任何区块顺序都自动生效。</p>
        <div class="ve-tl-row">
          <label class="ve-btn ve-btn-sm" style="cursor:pointer">📎 选择图片（≤2MB）
            <input type="file" id="ve-seclogo-file" accept="image/*" data-key="${esc(key)}" style="display:none">
          </label>
          ${u ? `<select class="ve-btn ve-btn-sm" id="ve-seclogo-pos" data-key="${esc(key)}">
            <option value="before"${before ? ' selected' : ''}>标题前</option>
            <option value="after"${!before ? ' selected' : ''}>标题后</option>
          </select>
          <button class="ve-btn ve-btn-sm" id="ve-seclogo-del" data-key="${esc(key)}">🗑 删除</button>` : ''}
        </div>
        ${u ? `<img src="${esc(u)}" alt="" style="max-height:48px;max-width:200px;object-fit:contain;border:1px solid var(--line);border-radius:4px;background:#fff;padding:2px;margin-top:8px">` : ''}
      </section>`;
}

// 区块 Logo 的上传 / 位置 / 删除（在 wireToolbox 里调用）
function wireSectionLogoCard() {
  const f = $('#ve-seclogo-file');
  if (f) f.onchange = async () => {
    const file = f.files && f.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { toast('Logo 不能超过 2MB（当前 ' + (file.size / 1048576).toFixed(1) + 'MB）'); f.value = ''; return; }
    const key = f.dataset.key;
    try {
      const fd = new FormData(); fd.append('file', file); fd.append('kind', 'ai-voices');
      // 必须带 tpl（veUrl），否则会上传到 main 模板的媒体目录之外
      const r = await fetch(veUrl('/api/upload'), { method: 'POST', body: fd });
      const j = await r.json();
      if (!r.ok || j.error || !j.url) throw new Error(j.error || '上传失败');
      pushHistory();
      draft.sectionLogos = draft.sectionLogos || {};
      const old = draft.sectionLogos[key] || {};
      draft.sectionLogos[key] = { url: j.url, pos: old.pos === 'before' ? 'before' : 'after' };
      const ok = await saveDraft(true);
      if (ok) { await reloadCanvas(true); renderToolbox(); toast('区块 Logo 已添加并保存'); }
    } catch (e) { toast('Logo 上传失败：' + e.message); }
  };
  const p = $('#ve-seclogo-pos');
  if (p) p.onchange = async () => {
    const key = p.dataset.key;
    pushHistory();
    draft.sectionLogos = draft.sectionLogos || {};
    const cur = draft.sectionLogos[key] || {};
    const u = typeof cur === 'string' ? cur : (cur.url || cur.src || '');
    draft.sectionLogos[key] = { url: u, pos: p.value === 'before' ? 'before' : 'after' };
    const ok = await saveDraft(true);
    if (ok) { await reloadCanvas(true); renderToolbox(); toast('区块 Logo 位置已更新'); }
  };
  const d = $('#ve-seclogo-del');
  if (d) d.onclick = async () => {
    const key = d.dataset.key;
    pushHistory();
    if (draft.sectionLogos) delete draft.sectionLogos[key];
    const ok = await saveDraft(true);
    if (ok) { await reloadCanvas(true); renderToolbox(); toast('区块 Logo 已删除'); }
  };
}

function renderToolbox() {  const root = $('#ve-edit');
  if (!root) return;
  const sel = veSelection;
  const kind = sel && sel.kind ? sel.kind : 'none';
  const currentAvatar = (draft.profile && draft.profile.avatar && draft.profile.avatar.preset) || '';
  root.innerHTML = `
    <div class="ve-toolbox">
      ${renderImagesOverview()}
      <section class="ve-tb-card ve-tb-canvas">
        <h4>画布</h4>
        <div class="ve-canvas-row">
          <button class="ve-btn ve-btn-sm" id="ve-undo" title="撤销上一步（最多 20 步）。可撤销：调字体/颜色/对齐、加图片、挪间距等所有画布操作">↶ 撤销</button>
          <button class="ve-btn ve-btn-sm" id="ve-redo" title="重做：把当前元素最近一组改动还原成没改之前；不影响其他元素">↷ 重做</button>
          <button class="ve-btn ve-btn-sm" id="ve-expand-sel" title="只展开当前选中的区块、分类或项目；全部展开请使用顶部按钮">⌄ 展开所选内容</button>
        </div>
        <div class="ve-hint ve-hint-list">
          <p><b>文字</b>：直接在画布上点文字，选中后即可修改。</p>
          <p><b>图片大小 / 位置</b>：切到「▣ 图片尺寸与位置」，点一下某个图片或视频选中它（只有选中的那个才有手柄，其余只是虚线轮廓）；拖角柄改大小，拖顶部 ⠿ 换位置。把图片拖到正文下方即可多张并排，「每行 1 2 3 4」决定一行放几个。</p>
          <p><b>添加图片</b>：点「🖼 添加图片」选好文件，再在画布上点任意位置放下（点项目媒体区 = 并进该项目）。</p>
          <p><b>取消选中</b>：点画布空白处。</p>
        </div>
        <div class="ve-canvas-modes" aria-label="画布编辑模式">
          <button class="ve-btn ve-btn-sm primary" data-canvas-mode="select" title="元素模式：点选任意内容（文字 / 图片 / 整个板块），选中后可改字或删除">✥ 元素</button>
          <button class="ve-btn ve-btn-sm" data-canvas-mode="space" title="挪间距模式：拖动画布中的间距控制线">↕ 挪间距</button>
          <button class="ve-btn ve-btn-sm" data-canvas-mode="image" title="图片尺寸模式：每个图片 / 视频各自独立，点一下选中它，再拖角柄调大小；拖顶部 ⠿ 换位置；拖媒体栏旁的竖条调分栏比例">▣ 图片尺寸与位置</button>
          <button class="ve-btn ve-btn-sm" id="ve-addimg-btn" title="先选图片文件，再在画布上点击放置（点项目媒体栏 = 并入该栏目；点空白 = 自由浮层）">🖼 添加图片</button>
        </div>
        <input type="file" id="ve-img-file" accept="image/*" style="display:none">
        <!-- 官方口径的差异说明：用户明确要求在「添加图片 / 改图片位置」下面写一句小标注。 -->
        <p class="ve-note-official">说明：编辑器画布按当前窗口宽度等比渲染，用于排版与预览；最终作品集在实际设备、浏览器与缩放比例下的排版宽度可能略有差异，图片的绝对位置与尺寸因此可能出现细微偏移。建议发布后在实际设备上复核，并按需微调。</p>
      </section>

      ${renderCanvasSizingTools()}

      ${renderContextActions()}
      ${renderSectionLogoCard()}
      <section class="ve-tb-card ve-tb-text">
        <h4>文本工具</h4>
        <p class="ve-hint" style="margin-top:0">选择文字后可修改字号、颜色和对齐。</p>
        ${renderTextTools(sel)}
      </section>

      ${kind === 'pixel-character' ? `
      <section class="ve-tb-card">
        <h4>Pixel 元素（已选中）</h4>
        <p class="ve-hint">可直接拖动位置，或在下方调整。</p>
      </section>` : ''}
      ${kind === 'image' ? `
      <section class="ve-tb-card">
        <h4>图片工具</h4>
        <p class="ve-hint">选中的是画布上的自由图片（浮层）。拖动可移动（出现居中/对齐辅助线），右下角手柄可缩放；要删除请点画布上该图片旁的「🗑 删除图片」，或按 Delete。</p>
      </section>` : ''}
      ${kind === 'media-box' || kind === 'media-image' || kind === 'media-video' || kind === 'media-audio' ? `
      <section class="ve-tb-card">
        <h4>媒体（画布直接调）</h4>
        <p class="ve-hint">图片 / 视频都收在同一个媒体栏里：<strong>拖右下角手柄</strong>改宽度，<strong>拖媒体本体</strong>可换到左边/右边，媒体栏上还有「＋ 加图片 / 加视频」「🗑 删除」。</p>
      </section>` : ''}
      ${kind === 'divider' ? `
      <section class="ve-tb-card">
        <h4>分割线</h4>
        <p class="ve-hint">这是一条无数据的分割线（布局元素）。你可以删除它；删除后刷新依然保持删除（记录在 design，不影响正文内容）。要删除请点画布上它旁的「🗑 删除」。</p>
      </section>` : ''}

      <section class="ve-tb-card ve-tb-pixel">
        <h4>Pixel 形象</h4>
        <p class="ve-hint">可在 Hero 横线右侧活动，不遮挡文字。</p>
        <div class="ve-avatar-grid">
          ${AVATAR_PRESETS.map(p => `
            <button class="ve-avatar-card ${currentAvatar===p.id?'on':''}" data-avatar="${p.id}" title="${esc(p.label)}">
              <img src="${p.src}" alt="${esc(p.label)}"><span>${esc(p.label)}</span>
            </button>`).join('')}
        </div>
        ${(currentAvatar || (draft.profile && draft.profile.avatar)) ? renderPixelAvatarControls() : ''}
      </section>
    </div>`;
  wireToolbox();
  wirePixelAvatarControls();
}

// 已有 Pixel 形象时的控件：位置/区域 + 大小 + 显隐 + 动画
function renderPixelAvatarControls() {
  const px = design.pixel || {};
  const size = Math.round(px.size || (draft.profile && draft.profile.avatar && draft.profile.avatar.size) || 72);
  const visible = px.visible !== false;
  const onPath = px.onPath !== false;
  const animation = px.animation !== false;
  return `
    <label class="ve-tl"><span>大小</span>
      <input type="range" id="ve-pixel-size" min="32" max="260" step="2" value="${size}">
      <b id="ve-pixel-size-v">${size}px</b></label>
    <div class="ve-block"><span class="ve-block-label">活动路线</span>
      <p class="ve-hint" style="margin:2px 0 6px">限制在 Hero 横线右侧活动。</p>
      <label class="ve-tl-row-sw"><span>活动轨迹</span><label class="ve-switch"><input type="checkbox" id="ve-pixel-onpath" ${onPath?'checked':''}><span class="ve-sw-slider"></span></label></label>
    </div>
    <div class="ve-block"><span class="ve-block-label">动画</span>
      <p class="ve-hint" style="margin:2px 0 6px">开启互动动作；关闭时保持静止。</p>
      <label class="ve-tl-row-sw"><span>动画</span><label class="ve-switch"><input type="checkbox" id="ve-pixel-animation" ${animation?'checked':''}><span class="ve-sw-slider"></span></label></label>
    </div>
    <label class="ve-tl-row-sw"><span>可见</span>
      <label class="ve-switch"><input type="checkbox" id="ve-pixel-visible" ${visible?'checked':''}><span class="ve-sw-slider"></span></label></label>
    <button class="ve-btn ve-btn-sm ve-btn-danger" id="ve-pixel-resetpos" title="把形象放回最初位置并停在原地">复位到初始位置</button>
    <button class="ve-btn ve-btn-sm ve-btn-danger" id="ve-avatar-remove" style="margin-top:6px">移除 Pixel 形象（删除元素）</button>`;
}

// 画布全局历史（轻量撤销/重做：快照 draft + design 关键项 + 当前选区 path）
// 限制：最多 20 条快照（用户规格），每条记一个 tag（用于「重做只针对当前元素」语义）。
let _history = [], _histIdx = -1;
const cloneState = value => JSON.parse(JSON.stringify(value == null ? {} : value));
let _historyPending = false;
function recordHistory(){
  try {
    _history = _history.slice(0, _histIdx + 1);
    const selPath = (veSelection && (veSelection.path || veSelection.itemPath)) || '';
    _history.push({
      // 设计数据（包含 textStyles / inlineStyles / 图片尺寸等）必须整体深拷贝。
      // 过去只存了部分 design，文字样式既不会撤销，也会被后续对象引用污染。
      draft: cloneState(draft),
      design: cloneState(design),
      selPath,
      t: Date.now(),
    });
    if (_history.length > 20) _history.shift();   // 最多 20 步（按用户规格）
    _histIdx = _history.length - 1;
  } catch (_) {}
}
function pushHistory(immediate){
  // 各编辑入口都在改数据前调用 pushHistory。延迟到当前同步操作结束后再取快照，
  // 才能记录“修改后”的状态，进而让 redo 回到正确内容。
  if (immediate) { recordHistory(); return; }
  if (_historyPending) return;
  _historyPending = true;
  queueMicrotask(() => { _historyPending = false; recordHistory(); });
}
function undo(){
  if (_histIdx <= 0) { toast('没有可撤销的上一步'); return; }
  _histIdx--;
  restoreHist(_history[_histIdx]);
}
function redo(){
  if (_histIdx >= _history.length - 1) { toast('没有可重做的下一步'); return; }
  _histIdx++;
  restoreHist(_history[_histIdx]);
}
async function restoreHist(h){
  if (!h) return;
  const nextDraft = cloneState(h.draft);
  const nextDesign = cloneState(h.design);
  const contentChanged = JSON.stringify(draft) !== JSON.stringify(nextDraft);
  draft = nextDraft;
  design = nextDesign;
  if (design.theme) draft.theme = design.theme;
  // 只在历史项确实改变内容时写 portfolio.json；纯视觉撤销不得覆盖内容草稿。
  if (contentChanged) await saveDraft(true);
  const body = Object.assign({}, design, { theme: draft.theme || design.theme || null });
  await api('/api/design/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  await reloadCanvas(true);
  toast('已恢复'); renderToolbox();
}

function renderTextTools(sel) {
  const c = (sel && sel.computed) || {};
  const inl = (sel && sel.inline) || {};
  const fs = Math.round(parseFloat(inl.fontSize || c.fontSize) || 16);
  // on 状态优先看 inline 标记（基于 innerHTML+selection 范围判定），其次才看 computed。
  // 因为 execCommand('bold') 包裹的是内层 <b>，外层 h1 的 computed fontWeight 不变。
  const isBold = !!(inl.bold || inl.isBoldByWeight || (+(c.fontWeight || 0) >= 600));
  const isItalic = !!(inl.italic || inl.isItalicByStyle || c.fontStyle === 'italic');
  const isUnder = !!(inl.underline || inl.isUnderByDeco || /underline/.test(c.textDecoration || ''));
  const ta = String(c.textAlign || 'left');
  const isAl = ta === 'left' || ta === 'start';
  const isAc = ta === 'center';
  const isAr = ta === 'right' || ta === 'end';
  const colorHex = toHexInput(inl.color || c.color);
  const bgHex = toHexInput(inl.backgroundColor || c.backgroundColor) || '#fff4a8';
  const pathText = (sel && sel.path) ? esc(sel.path) : '<span class="ve-sel-none">' + esc(z('（未选中文字）')) + '</span>';
  return `
    <div class="ve-sel-info">
      <code>${pathText}</code>
      ${(sel && sel.text) ? `<div class="ve-sel-text">${esc(sel.text)}</div>` : ''}
    </div>
    <div class="ve-tb-iconrow">
      <button data-act="fs-down" class="ve-ibtn" title="字号缩小 A−（每按 −2px，下限 8px）">A−</button>
      <span class="ve-ifs" id="tl-fs-v">${fs}px</span>
      <button data-act="fs-up" class="ve-ibtn" title="字号加大 A+（每按 +2px，上限 200px）">A+</button>
      <span class="ve-isep"></span>
      <button data-act="bold" class="ve-ibtn ${isBold?'on':''}" title="加粗 B（再按一次取消）"><b>B</b></button>
      <button data-act="italic" class="ve-ibtn ${isItalic?'on':''}" title="斜体 I"><i>I</i></button>
      <button data-act="underline" class="ve-ibtn ${isUnder?'on':''}" title="下划线 U"><u>U</u></button>
      <span class="ve-isep"></span>
      <label class="ve-color-control" title="文字颜色">
        <span class="ve-icolor-A">A</span><input type="color" id="tl-color" value="${esc(colorHex)}" aria-label="文字颜色">
      </label>
      <label class="ve-color-control ve-color-control-bg" title="背景颜色；选择透明色可清除背景">
        <span class="ve-icolor-bg"></span><input type="color" id="tl-bgcolor" value="${esc(bgHex)}" aria-label="背景颜色"><button type="button" class="ve-color-clear" data-act="clear-bg" title="清除背景色">×</button>
      </label>
      <span class="ve-isep"></span>
      <button data-act="al" class="ve-ibtn ${isAl?'on':''}" title="左对齐">左</button>
      <button data-act="ac" class="ve-ibtn ${isAc?'on':''}" title="居中">中</button>
      <button data-act="ar" class="ve-ibtn ${isAr?'on':''}" title="右对齐">右</button>
      <span class="ve-isep"></span>
      <button data-act="reset" class="ve-ibtn" title="清除该元素的所有自定义样式">清除</button>
    </div>`;
}

// 字体、颜色等「确认修改」必须立即进入同一个顺序写入队列。
// 之前的 350ms 防抖在切换选区/刷新画布时可能被后续操作覆盖，导致画布已变色但磁盘仍是旧值。
let _textStyleSaveQueue = Promise.resolve();
function saveTextStyles(textStyles, inlineStyles) {
  const ts = cloneState(textStyles || design.textStyles || {});
  const ins = cloneState(inlineStyles || design.inlineStyles || {});
  _textStyleSaveQueue = _textStyleSaveQueue.catch(() => {}).then(() => api('/api/design/save', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ textStyles: ts, inlineStyles: ins, theme: draft.theme || design.theme || null }),
  }));
  _textStyleSaveQueue.catch(error => toast('文字样式保存失败：' + error.message));
  return _textStyleSaveQueue;
}

// 局部文字 HTML / 自由图片层：读回画布当前状态并落盘到 design.json
//
// —— 关键修复（2026-09-08）—— 颜色工具的 B+/颜色+/对齐 等高频触发时，每条 ve-commit-inline
// 都会立刻调 saveInlineStyles → POST /api/design/save。在 Windows 上并发写同一份 .tmp 文件
// 会触发 PermissionError，整个 visual-editor 会挂掉报「数据没取回来」。
// 现在加了 _saveInlineTimer（250ms 防抖）+ _saveInlineBusy（互斥锁）：
//   - 防抖：连续多笔修改合并为一次保存
//   - 互斥：前一笔还在请求中时，下一笔的 payload 会被合并，等请求返回后再触发下一次
let _saveInlineTimer = null;
let _saveInlinePending = null; // 待保存的最新 payload（被防抖覆盖）
let _saveInlineBusy = false;   // 是否正在请求中
function saveInlineStyles(){
  try {
    const data = readDirect('getInlineStyles') || {};
    // 把最新数据合并进 pending；定时器到期或当前请求完成后再真正发
    _saveInlinePending = { inlineStyles: data, theme: draft.theme||null };
    if (_saveInlineTimer) clearTimeout(_saveInlineTimer);
    _saveInlineTimer = setTimeout(_flushInlineSave, 250);
  } catch(_){}
}
async function _flushInlineSave(){
  _saveInlineTimer = null;
  if (_saveInlineBusy) return;       // 还在上一次请求中：数据已合并进 _saveInlinePending，等请求完成时再触发
  const payload = _saveInlinePending; _saveInlinePending = null;
  if (!payload) return;
  _saveInlineBusy = true;
  try {
    await api('/api/design/save', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
  } catch(e) {
    console.warn('[saveInlineStyles]', e);
  } finally {
    _saveInlineBusy = false;
    // 如果防抖窗口内又累积了新改动，再排一次 flush
    if (_saveInlinePending) {
      if (_saveInlineTimer) clearTimeout(_saveInlineTimer);
      _saveInlineTimer = setTimeout(_flushInlineSave, 50);
    }
  }
}
function saveImages(){
  try {
    const imgs = readDirect('getImages') || [];
    api('/api/design/save', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ images: imgs, theme: draft.theme||null }) });
  } catch(_){}
}

function wireToolbox() {
  // —— 统筹区删除：用事件委托（#ve-edit 容器在多次 innerHTML 重建中始终存在）——
  const ovRoot = $('#ve-edit');
  if (ovRoot && !ovRoot.__ovWired){
    ovRoot.addEventListener('click', (e) => {
      const bImg = e.target.closest && e.target.closest('[data-del-img]');
      if (bImg){ e.preventDefault(); e.stopPropagation(); deleteFreeImageById(bImg.getAttribute('data-del-img')); return; }
      const bMed = e.target.closest && e.target.closest('[data-del-media]');
      if (bMed){
        e.preventDefault(); e.stopPropagation();
        const k = bMed.getAttribute('data-del-media');
        if (window.confirm(z('删除这一项媒体？同项目里的其他媒体不受影响。'))) deleteMediaByKey(k);
        return;
      }
      // —— 2026-09-23：点整行 = 「在画布上定位」——
      // 用户的真实痛点：画布上有图，但不知道它在页面哪个位置，更没法判断哪张是哪张，
      // 于是「删也不好删」。这里把「找」这件事变成一次点击。
      const row = e.target.closest && e.target.closest('[data-locate-id],[data-locate-key]');
      if (row){ e.preventDefault(); e.stopPropagation(); locateMediaInCanvas(row); }
    });
    ovRoot.__ovWired = true;
  }
  // —— 始终可见的画布操作行：撤销 / 重做 / 展开 ——
  const undoB = $('#ve-undo'); if (undoB) undoB.onclick = undo;
  const redoB = $('#ve-redo'); if (redoB) redoB.onclick = redo;
  const expandB = $('#ve-expand-sel'); if (expandB) expandB.onclick = expandSelectedInCanvas;
  // 页面高度不是第二份“固定高度”数据：根据画布当前自然内容高度反算唯一的
  // design.spacing.footerBottom。项目展开后自然高度上升，画布会自动变高且不会裁切。
  const canvasHeight = $('#ve-canvas-height');
  if (canvasHeight) canvasHeight.onchange = () => {
    const raw = String(canvasHeight.value || '').trim();
    const m = canvasMetrics();
    const min = Math.max(0, Math.round(Number(m.minimumCanvasHeight) || 0));
    const wanted = Number(raw);
    if (!raw || !Number.isFinite(wanted)) {
      refreshCanvasSizingTools('请输入有效的页面高度；当前画布未修改。');
      toast('请输入有效的页面高度');
      return;
    }
    const finalHeight = Math.max(min, Math.round(wanted));
    const bottom = Math.max(0, finalHeight - Math.max(0, Math.round(Number(m.contentHeight) || 0)));
    postToCanvas({ type:'ve-set-spacing-key', key:'footerBottom', value:bottom });
    setTimeout(() => refreshCanvasSizingTools(finalHeight === Math.round(wanted)
      ? ('页面高度已设为 ' + finalHeight + 'px')
      : ('内容至少需要 ' + min + 'px，已把高度限制到 ' + finalHeight + 'px；画布不会裁切内容，可继续编辑。'),
      { done: finalHeight === Math.round(wanted) }), 80);
    if (finalHeight !== Math.round(wanted)) toast('高度低于当前内容，已限制到 ' + min + 'px');
    else toast('页面高度已更新');
  };
  const footerBottom = $('#ve-footer-bottom');
  if (footerBottom) footerBottom.onchange = () => {
    const raw = String(footerBottom.value || '').trim();
    const wanted = Number(raw);
    if (!raw || !Number.isFinite(wanted)) {
      refreshCanvasSizingTools('请输入 0 或更大的底部留白。');
      toast('请输入有效的底部留白');
      return;
    }
    const next = Math.max(0, Math.min(VE_SPACE_MAX, Math.round(wanted)));
    postToCanvas({ type:'ve-set-spacing-key', key:'footerBottom', value:next });
    setTimeout(() => refreshCanvasSizingTools(next === Math.round(wanted)
      ? ('底部留白已设为 ' + next + 'px')
      : ('底部留白已限制在 0–' + VE_SPACE_MAX + 'px。'), { done: next === Math.round(wanted) }), 80);
  };

  // 画布编辑模式属于编辑器界面，而不是作品集 iframe。
  // 桌面与手机画布都不会被一块固定浮层遮挡。元素选择与改文字已是默认行为（点哪改哪），
  // 这里只保留「挪间距」这种需要显式进入的模式。
  document.querySelectorAll('[data-canvas-mode]').forEach(button => {
    button.onclick = () => {
      const mode = button.dataset.canvasMode || 'select';
      setCanvasMode(mode);   // 记到本地：画布重载后自动回到这个模式，不用再点一次
      postToCanvas({ type: 've-set-mode', mode });
      toast({
        select: '元素模式：点击内容即可选择',
        text: '改文字模式：点击文字后可直接编辑',
        space: '挪间距模式：拖动画布中的间距控制线（虚线就是缝，左侧小把手可输入数值）',
        image: '图片尺寸与位置模式：点选某个图片/视频→拖角柄单独调它的大小；拖顶部 ⠿ 换位置；拖媒体栏旁的竖条调分栏比例',
        addimg: '添加图片：先选择文件，再在画布点击放置',
      }[mode] || '已切换画布模式');
    };
  });
  paintCanvasModeButtons();
  // 模式是从本地恢复的：画布 URL 里已经带了 &ve-mode=，正常情况它自己就进对了；
  // 这里在画布每次 ve-ready 时再对齐一次（ve-sync-mode 在模式一致时是空操作，
  // 不会重建间距杆，所以不会打断正在进行的拖动）。
  window.addEventListener('message', ev => {
    const m = ev && ev.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 've-ready' && canvasMode && canvasMode !== 'select') {
      postToCanvas({ type: 've-sync-mode', mode: canvasMode });
    }
  });
  // 添加图片：选文件 → 上传到 /media → 交给画布进入「点击放置」（点任意位置=自由浮层；点项目媒体区=并入）
  const addimgBtn = $('#ve-addimg-btn');
  const imgFile = $('#ve-img-file');
  if (addimgBtn && imgFile) addimgBtn.onclick = () => imgFile.click();
  if (imgFile) imgFile.onchange = async () => {
    const f = imgFile.files && imgFile.files[0];
    if (!f) return;
    imgFile.value = '';
    try {
      const fd = new FormData(); fd.append('file', f); fd.append('kind', 'uploads');
      const r = await fetch('/api/upload', { method: 'POST', body: fd });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || '上传失败');
      // 记住这张"待放置"的图片：画布 iframe 若因保存/同步而重载，下面 ve-ready 时会自动补发，
      // 避免"选完文件后画布刷了一下，再点就没反应"（用户实际遇到的症状）。
      pendingUpload = { src: j.url, url: j.url, name: j.name || f.name };
      postToCanvas({ type: 've-add-image-pending', src: j.url, url: j.url, name: j.name || f.name });
      document.querySelectorAll('[data-canvas-mode]').forEach(item => item.classList.toggle('primary', item.dataset.canvasMode === 'addimg'));
      toast('图片已上传：在画布上点任意位置放下它（点项目的媒体区则并进那个项目）');
    } catch (e) { toast('图片上传失败：' + e.message); }
  };

  // 添加内容默认会跟随画布选区，但不依赖选区：用户可始终在右侧明确选择目标区块。
  const addTarget = $('#ve-add-target');
  if (addTarget) addTarget.onchange = () => {
    veContext.addSection = addTarget.value || 'about';
    veContext.section = veContext.addSection;
    veContext.groupId = '';
    renderToolbox();
  };
  const mediaTarget = $('#ve-media-target');
  if (mediaTarget) mediaTarget.onchange = () => {
    veContext.mediaPath = mediaTarget.value || '';
    renderToolbox();
  };
  // 区块级 Logo 控件（上传 / 位置 / 删除）
  wireSectionLogoCard();

  // 添加内容：按右侧目标区块决定加什么，加完刷新画布与右侧面板。
  // 新增的内容只带最基本的空位（名称/时间/类型/角色…），详细正文留给「文本编辑」，
  // 这样排版编辑保持"所见即所得改版式"，长文本编辑回到文本编辑里做。
  const addContent = $('#ve-add-content');
  if (addContent) {
    addContent.onclick = async () => {
      pushHistory();
      const kind = $('#ve-add-kind')?.value || 'contact';
      veContext.addSection = $('#ve-add-target')?.value || veContext.addSection || 'about';
      const groups = draft.projectGroups || [];
      const pickedGroup = $('#ve-add-group') ? $('#ve-add-group').value : '';
      let message = '已添加，可在画布上点选修改';
      const insertProjectForGroup = (project, gid) => {
        draft.projects = draft.projects || [];
        let at = -1;
        draft.projects.forEach((p, i) => { if (p && p.groupId === gid) at = i; });
        if (at < 0) { draft.projects.push(project); return draft.projects.length - 1; }
        draft.projects.splice(at + 1, 0, project);
        return at + 1;   // 修复：必须返回「插入位置」，否则 Showreel 章节的 projectId 会指向别的项目
      };
      const newProject = (name, gid) => ({
        name, groupId: gid || ((groups[0] || {}).id || ''),
        date: '', role: '', type: '', rawMaterial: '',
        structuredContent: { summary: '', keyWork: [], highlights: [] },
        summary: '', keyWork: [], highlights: [],
        media: { mainVisual: null, processImages: [], video: null, audio: null, externalVideoUrl: '', externalLink: '' },
      });
      // AI 项目模板：字段与「文本编辑 → AI Project」以及 Portfolio 的 AI Voices 卡片一一对应，
      // 保证新加的项目和已有内容长得一样（名称 / 简介 / 角色 / 技术栈 / 亮点 / GitHub / 多张截图）。
      /* ⚠ 新建条目一律写**空字符串**，绝不写中文占位值。
       *   2026-09-23 用户反馈：英文界面的 Capabilities 区块下赫然一条「新经历」。
       *   查下来它既不是界面文案、也不是浏览器翻译，而是这里 push 进去的中文默认值
       *   漏进了 content/portfolio.json —— 用户从没改过名，于是它就是「用户内容」，
       *   整篇翻译只会把它当内容翻（译文表里还真出现了 '新经历'→'New experiences'），
       *   只要译文没生成/没重生成，英文界面就会露出中文。
       *   正确口径：占位名属于**界面**，只该在渲染时兜底（见 canvasSide 的 未命名* 兜底），
       *   数据里永远保持空 —— 这样用户自己填什么语言就永远是什么语言（§23 原文语言优先）。 */
      const newAiProject = (name) => ({
        name: name || '',
        summary: '',
        role: '',
        tech: [],
        highlights: [],
        githubUrl: '',
        liveDemoUrl: '',
        media: { image: null, screenshots: [] },
      });

      if (kind === 'contact') (draft.profile.contactLinks = draft.profile.contactLinks || []).push({ label: '', value: '' });
      else if (kind === 'skill') (draft.profile.skills = draft.profile.skills || []).push('');
      else if (kind === 'highlight') (draft.profile.highlights = draft.profile.highlights || []).push('');
      else if (kind === 'work-category') {
        // Works 这一层 = 分类（与 Original Production 同级）
        const id = 'cat-' + Date.now().toString(36);
        (draft.projectGroups = draft.projectGroups || []).push({ id, title: '', description: '' });
        veContext.groupId = id;
        message = '已新建分类：在画布上点它的标题可直接改名，之后再往里加项目';
      } else if (kind === 'work-project') {
        // 分类里的项目（与《示例作品》同级）
        const gid = pickedGroup || veContext.groupId || ((groups[0] || {}).id || '');
        insertProjectForGroup(newProject('', gid), gid);
        const g = groups.find(x => x.id === gid);
        message = '已在「' + ((g && g.title) || '分类') + '」里加上一个新项目：名称/时间/类型/角色可直接在画布上点着改，介绍与媒体请到文本编辑补充';
      } else if (kind === 'showreel-project') {
        // Showreel 是一级栏目，其下是多个 Showreel 项目；新增 = 在 showreel.projects 里加一项（与既有项目同级，不产生新分类层级）
        draft.showreel = draft.showreel || {}; draft.showreel.projects = Array.isArray(draft.showreel.projects) ? draft.showreel.projects : [];
        draft.showreel.projects.push({ id: 'sr_' + Date.now().toString(36), name: '', role: '', media: null, externalVideoUrl: '', chapters: [] });
        message = '已在 Showreel 栏目下新增一个 Showreel 项目（与已有项目同级）。视频 / 外部链接 / 章节请到「文本编辑 → Showreel」编辑。';
      } else if (kind === 'ai-project') {
        draft.aiVoices = draft.aiVoices || {}; draft.aiVoices.projects = draft.aiVoices.projects || [];
        draft.aiVoices.projects.push(newAiProject(''));
        message = '已新增 AI 项目（与已有 AI Voices 卡片同一套模板）：名称 / 简介可直接在画布上改，角色 / 技术栈 / 亮点 / GitHub / 截图请到「文本编辑 → AI Project」补充';
      } else if (kind === 'experience') {
        // 经历：排版编辑只建"简略"的壳（公司/职位/时间），展开内容留给文本编辑
        (draft.experience = draft.experience || []).push({
          company: '', position: '', date: '', rawMaterial: '',
          structuredContent: { summary: '', responsibilities: [], highlights: [] },
          summary: '', highlights: [],
        });
        message = '已新增一条经历（公司/职位/时间可直接在画布上点着改）；介绍与 Highlights 请到「文本编辑 → 经历」补充';
      }
      const ok = await saveDraft(true);
      if (ok) {
        await reloadCanvas(true);
        renderToolbox();
        toast(message);
      }
    };
  }

  // 个人形象：点选预设
  document.querySelectorAll('[data-avatar]').forEach(b => {
    b.onclick = async () => {
      const id = b.dataset.avatar;
      const p = AVATAR_PRESETS.find(x => x.id === id);
      if (!p) return;
      pushHistory();
      draft.profile = draft.profile || {};
      draft.profile.avatar = { preset: p.id, src: p.src, size: 72 };
      const ok = await saveDraft(true);
      if (ok) { reloadCanvas(); toast('已加上「' + p.label + '」'); }
    };
  });
  const rmAvatar = $('#ve-avatar-remove');
  if (rmAvatar) rmAvatar.onclick = async () => {
    pushHistory();
    design.pixel = {};
    if (draft.profile) delete draft.profile.avatar;
    const ok1 = await saveDraft(true);
    await api('/api/design/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pixel: {}, removedStatic: design.removedStatic, theme: draft.theme || null }) });
    if (ok1) { reloadCanvas(true); renderToolbox(); toast('已移除 Pixel 形象'); }
  };
  // Pixel 形象：位置/大小/区域/动画/显隐（独立 Canvas Element → 全部存 design.pixel，不碰 Content）
  const applyPixel = async (patch, opts) => {
    pushHistory();
    design.pixel = Object.assign({}, design.pixel || {}, patch);
    const ok = await api('/api/design/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pixel: design.pixel, theme: draft.theme || null }) });
    if (ok) { if (opts && opts.reload) reloadCanvas(true); else postToCanvas({ type: 've-pixel-update', pixel: design.pixel }); }
  };
  // 大小滑块（oninput 实时预览于 design，onchange 落盘）
  const pixSize = $('#ve-pixel-size');
  if (pixSize) {
    const out = $('#ve-pixel-size-v');
    pixSize.oninput = () => { if (out) out.textContent = pixSize.value + 'px'; design.pixel = Object.assign({}, design.pixel || {}, { size: +pixSize.value }); postToCanvas({ type: 've-pixel-update', pixel: design.pixel }); };
    pixSize.onchange = () => applyPixel({ size: +pixSize.value });
  }
  // 移除形象按钮（由 renderPixelAvatarControls 渲染出的唯一 #ve-avatar-remove 已在上面绑定）
  wirePixelAvatarControls();

  // 注意：媒体宽度 / 左右位置 / 上传图片已经全部搬到「画布内嵌」：
  //   选中画布上的项目媒体栏 → 拖右下角手柄改宽度、横向拖动换边、栏上按钮加图片/视频。
  // 因此右侧不再需要「媒体的位置与尺寸 / 添加图片」这两个面板。

  const path = veSelection && veSelection.path;
  // 文本工具统一走 ve-apply-inline：作用于「当前选区」(局部) 或「整元素」(scope=field)
  //
  // 预览消息只改 iframe 的当前视觉状态，不能触发 ve-select / renderToolbox。
  // 原生颜色面板在拖动期间必须一直挂载在同一个 DOM 节点上。
  const applyTextLive = (prop, value) => {
    const scope = (veSelection && veSelection.scope) || 'field';
    if (!veSelection || !veSelection.path){
      // 用户实时拖动时 selection 可能丢了，只提示一次
      toast('请先在画布「✎ 改文字」或「元素」模式选中要改的文字');
      return;
    }
    postToCanvas({ type: 've-preview-textstyle', prop, value, scope, path: veSelection.path });
  };
  const applyText = (prop, value) => {
    const scope = (veSelection && veSelection.scope) || 'field';
    if (!veSelection || !veSelection.path){
      toast('请先在画布「✎ 改文字」或「元素」模式选中要改的文字');
      return;
    }
    // 注意：pushHistory 由画布返回的 ve-commit-inline 消息统一调（避免双重计数）。
    postToCanvas({ type: 've-apply-inline', prop, value, scope });
  };

  // 字号 A+/A−
  const fsV = $('#tl-fs-v');
  const getFs = () => Math.round(parseFloat(((veSelection && veSelection.inline && veSelection.inline.fontSize) || (veSelection && veSelection.computed && veSelection.computed.fontSize) || '16')));
  document.querySelectorAll('[data-act="fs-up"],[data-act="fs-down"]').forEach(b => {
    b.onclick = () => {
      const cur = getFs();
      const next = Math.max(8, Math.min(200, cur + (b.dataset.act === 'fs-up' ? 2 : -2)));
      if (fsV) fsV.textContent = next + 'px';
      if (veSelection){
        veSelection.computed = veSelection.computed || {};
        veSelection.computed.fontSize = next + 'px';
        if (veSelection.inline) veSelection.inline.fontSize = next + 'px';
      }
      applyText('fontSize', next + 'px');
    };
  });

  // B / I / U 切换
  const toggle = (act, prop, onVal, offVal) => {
    const b = document.querySelector('[data-act="' + act + '"]');
    if (!b) return;
    b.onclick = () => {
      const wasOn = b.classList.contains('on');
      b.classList.toggle('on', !wasOn);
      applyText(prop, wasOn ? offVal : onVal);
    };
  };
  toggle('bold', 'fontWeight', '700', '400');
  toggle('italic', 'fontStyle', 'italic', 'normal');
  toggle('underline', 'textDecoration', 'underline', 'none');

  // 颜色 / 高亮：用一个可见按钮触发隐藏的 color input.click()，避免之前的全透明
  // 覆盖在 iframe 缩放模式下被遮罩或被 selectionchange 清掉的问题。
  //
  // input 负责持续预览；change 才写入 design.json 和历史记录一次。
  const colorInp = $('#tl-color');
  if (colorInp){
    colorInp.oninput = () => { applyTextLive('color', colorInp.value); };
    colorInp.onchange = () => { applyText('color', colorInp.value); };
  }
  const bgInp = $('#tl-bgcolor');
  if (bgInp){
    bgInp.oninput = () => { applyTextLive('backgroundColor', bgInp.value); };
    bgInp.onchange = () => { applyText('backgroundColor', bgInp.value); };
  }
  const clearBg = document.querySelector('[data-act="clear-bg"]');
  if (clearBg) clearBg.onclick = event => { event.preventDefault(); applyText('backgroundColor', 'transparent'); };

  // 对齐
  ['al','ac','ar'].forEach(act => {
    const b = document.querySelector('[data-act="' + act + '"]');
    if (!b) return;
    b.onclick = () => {
      document.querySelectorAll('[data-act="al"],[data-act="ac"],[data-act="ar"]').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      const v = act === 'al' ? 'left' : act === 'ac' ? 'center' : 'right';
      applyText('textAlign', v);
    };
  });

  // 清除
  const reset = document.querySelector('[data-act="reset"]');
  if (reset) reset.onclick = () => {
    // 注意：pushHistory 由 ve-commit-inline 消息统一调（避免双重计数）。
    postToCanvas({ type: 've-apply-inline', prop: 'reset', value: '', scope: (veSelection && veSelection.scope) || 'field' });
    veSelection = null; renderToolbox();
    toast('已移除该文字的自定义样式');
  };
}

function field(label, key, value, area) {
  const v = esc(value == null ? '' : value);
  if (area) return `<label class="ve-field"><span>${esc(label)}</span><textarea data-key="${esc(key)}" rows="4">${v}</textarea></label>`;
  return `<label class="ve-field"><span>${esc(label)}</span><input data-key="${esc(key)}" value="${v}"></label>`;
}
function lines(v) { return (v || []).join('\n'); }
function split(v) { return v.split('\n').map(x => x.trim()).filter(Boolean); }

// —— About 表单 ——
// ⚠ 2026-09-19 核实：本函数（及下面 renderExperienceForm / renderWorksForm）是**历史遗留的死代码**，
//   全仓零调用。当前排版编辑的「增删」统一走两条活路径：
//     ① 右侧「添加内容」面板（renderContextActions）→ #ve-add-content，按区块/层级自适应；
//     ② 画布「元素」模式点选任意项 → 浮条上的删除（ve-delete-item / ve-delete-static / ve-delete-media-path）。
//   保留不删只是为避免误伤历史，**不要**把它接回 UI（会造成两套并行表单）。若确需恢复表单式编辑，
//   请先删掉本段并重新设计，不要直接调用。
function renderAboutForm() {
  const p = draft.profile || {};
  const links = p.contactLinks || [];
  const linkRows = links.map((x, i) =>
    `<div class="ve-link-row">
       <input data-key="profile.contactLinks.${i}.label" value="${esc(x.label || '')}" placeholder="标签（如 Email）">
       <input data-key="profile.contactLinks.${i}.value" value="${esc(x.value || '')}" placeholder="值（如 xxx@example.com）">
       <button class="ve-btn ve-btn-icon" data-del-contact="${i}">×</button>
     </div>`).join('');
  return `
    <div class="ve-section-block">
      <h4>个人资料</h4>
      ${field('姓名', 'profile.name', p.name)}
      ${field('定位', 'profile.role', p.role)}
      ${field('一句简介（换行会保留）', 'profile.intro', p.intro, true)}
      ${field('关于我（完整介绍）', 'profile.about', p.about, true)}
    </div>
    <div class="ve-section-block">
      <h4>教育（每行一项）</h4>
      ${field('', 'profile.education', lines(p.education), true)}
    </div>
    <div class="ve-section-block">
      <h4>技能（每行一项）</h4>
      ${field('', 'profile.skills', lines(p.skills), true)}
    </div>
    <div class="ve-section-block">
      <h4>亮点（每行一项）</h4>
      ${field('', 'profile.highlights', lines(p.highlights), true)}
    </div>
    <div class="ve-section-block">
      <h4>Contact / Links</h4>
      ${linkRows || '<p class="ve-hint">还没有联系方式，点下方「+ 添加」新建。</p>'}
      <button class="ve-btn" id="ve-add-contact">+ 添加联系方式</button>
    </div>
  `;
}

// —— Experience 表单 ——（死代码，见 renderAboutForm 上方说明）
function renderExperienceForm() {
  const arr = draft.experience || [];
  const cards = arr.map((e, i) =>
    `<details class="ve-edit-card" open>
       <summary>${esc(e.company || '未命名经历')}</summary>
       ${field('公司', 'experience.' + i + '.company', e.company)}
       ${field('职位', 'experience.' + i + '.position', e.position)}
       ${field('时间', 'experience.' + i + '.date', e.date)}
       ${field('总结', 'experience.' + i + '.summary', e.summary, true)}
       ${field('亮点（每行一项）', 'experience.' + i + '.highlights', lines(e.highlights), true)}
       <div class="ve-edit-row-actions">
         <button class="ve-btn" data-exp-up="${i}" ${i === 0 ? 'disabled' : ''}>↑ 上移</button>
         <button class="ve-btn" data-exp-down="${i}" ${i === arr.length - 1 ? 'disabled' : ''}>↓ 下移</button>
         <button class="ve-btn danger" data-exp-del="${i}">删除</button>
       </div>
     </details>`).join('');
  return `
    <div class="ve-section-block">
      <h4>工作经历</h4>
      ${cards || '<p class="ve-hint">还没有经历，点下方「新建经历」。</p>'}
      <button class="ve-btn" id="ve-add-exp">+ 新建经历</button>
    </div>
  `;
}

// —— Works 表单 ——（死代码，见 renderAboutForm 上方说明）
function renderWorksForm() {
  const groups = draft.projectGroups || [];
  const projects = draft.projects || [];
  const groupCards = groups.map((g, i) => {
    const ps = projects.filter(x => x.groupId === g.id);
    return `<details class="ve-edit-card" open>
       <summary>${esc(g.title)} <span class="ve-count">${ps.length} 个项目</span></summary>
       ${field('分类标题', 'projectGroups.' + i + '.title', g.title)}
       ${field('分类介绍（作品集中显示）', 'projectGroups.' + i + '.description', g.description, true)}
       <div class="ve-edit-row-actions">
         <button class="ve-btn" data-cat-up="${i}" ${i === 0 ? 'disabled' : ''}>↑ 上移</button>
         <button class="ve-btn" data-cat-down="${i}" ${i === groups.length - 1 ? 'disabled' : ''}>↓ 下移</button>
         <button class="ve-btn danger" data-cat-del="${i}">删除分类</button>
       </div>
     </details>`;
  }).join('');

  const projectCards = projects.map((p, i) =>
    `<details class="ve-edit-card">
       <summary>${esc(p.name || '未命名项目')}</summary>
       ${field('项目名', 'projects.' + i + '.name', p.name)}
       <label class="ve-field"><span>分类</span>
         <select data-key="projects.${i}.groupId">
           ${groups.map(g => `<option value="${esc(g.id)}" ${g.id === p.groupId ? 'selected' : ''}>${esc(g.title)}</option>`).join('')}
         </select>
       </label>
       ${field('时间', 'projects.' + i + '.date', p.date)}
       ${field('类型', 'projects.' + i + '.type', p.type)}
       ${field('角色', 'projects.' + i + '.role', p.role)}
       ${field('总结', 'projects.' + i + '.summary', p.summary, true)}
       ${field('Key Work（每行一项）', 'projects.' + i + '.keyWork', lines(p.keyWork), true)}
       ${field('Highlights（每行一项）', 'projects.' + i + '.highlights', lines(p.highlights), true)}
       ${field('外部视频', 'projects.' + i + '.media.externalVideoUrl', (p.media && p.media.externalVideoUrl) || '')}
       ${field('外部链接', 'projects.' + i + '.media.externalLink', (p.media && p.media.externalLink) || '')}
       <div class="ve-edit-row-actions">
         <button class="ve-btn danger" data-proj-del="${i}">删除项目</button>
       </div>
     </details>`).join('');

  return `
    <div class="ve-section-block">
      <h4>分类</h4>
      ${groupCards || '<p class="ve-hint">还没有分类。</p>'}
      <button class="ve-btn" id="ve-add-cat">+ 新建分类</button>
    </div>
    <div class="ve-section-block">
      <h4>项目</h4>
      ${projectCards || '<p class="ve-hint">还没有项目。</p>'}
      <button class="ve-btn" id="ve-add-proj">+ 新建项目</button>
    </div>
  `;
}

// —— 收集表单 → draft ——
function setDeep(obj, path, value) {
  // path 是字符串数组
  let o = obj, cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    if (o[k] == null || typeof o[k] !== 'object') o[k] = /^\d+$/.test(path[i + 1]) ? [] : {};
    o = o[k];
  }
  o[path[path.length - 1]] = value;
}

// —— 启动 ——
async function boot() {
  await loadAll();
  veContext.section = selectedSection;
  veContext.addSection = selectedSection;

  const root = $('#ve-app');
  root.className = 've-root';
  root.innerHTML = `
    <div class="ve-shell">
      <header class="ve-topbar">
        <span class="ve-brand" title="FolioFold">Folio<em>Fold</em></span>
        <span class="ve-title">Visual Editor</span>
        <span class="ve-status" id="ve-subtitle">直接调整版式和常用内容。</span>
        <span class="ve-spacer"></span>
        <span id="ve-locale"></span>
        <button class="ve-btn" id="ve-collapse" title="收起画布里所有展开的项目/分类">全部收起</button>
        <button class="ve-btn" id="ve-expand" title="展开画布里所有项目/分类">全部展开</button>
        <button class="ve-btn" id="ve-texteditor">文本编辑</button>
        <button class="ve-btn" id="ve-cv-mobile" title="把画布切换到手机宽度（390px），便于查看手机浏览下的样子">📱 手机</button>
        <button class="ve-btn" id="ve-cv-desktop" title="把画布切换到实际电脑浏览器的尺寸（与发布版一致）">🖥 电脑</button>
        <button class="ve-btn" id="ve-back">← 返回作品集</button>
        <button class="ve-btn primary" id="ve-save" title="把画布上的调整存下来（内容 + 版式）">保留</button>
      </header>
      <div class="ve-body">
        <aside class="ve-panel ve-panel-left">
          <h3 id="ve-h-sections">页面区块</h3>
          <p class="ve-hint" id="ve-hint-sections">拖动排序，或用上下按钮。</p>
          <ul id="ve-sections"></ul>
          <h3 style="margin-top:20px" id="ve-h-themes">主题</h3>
          <div id="ve-themes" class="ve-theme-grid"></div>
          <h3 style="margin-top:20px" id="ve-h-status">设计状态</h3>
          <p class="ve-hint" id="ve-status-detail">读取中…</p>
        </aside>
        <main class="ve-canvas-wrap">
          <!-- ★ 2026-09-22：stage 外壳必须在这里就先建好。
               以前它是 visual-editor-fix.js 的 ensureStage() 运行时建的，建法是
               「frame.before(stage) 然后 stage.appendChild(frame)」—— 把 iframe 从原位置
               摘下来再塞进新容器。浏览器对 iframe 的「换父节点」一律当成重新加载，于是
               画布刚加载完又被重新加载一次（用户原话："挪完间距会刷新两三下，让人以为
               没生效或卡了"）。CDP 抓到的调用栈是 ensureStage ← fitCanvas ← setMode ← initialize。
               预先建好之后 ensureStage() 直接复用，一次多余的重载都不会发生。 -->
          <div id="ve-canvas-stage">
            <iframe id="ve-canvas" src="${canvasUrl('&t=' + Date.now())}" title="作品集预览"></iframe>
            <!-- ★ 2026-09-22：本地服务没起来时，iframe 里是 Chrome 自己的「拒绝连接」
                 错误页 —— 用户以为模板坏了。这里盖一层说明 + 重试，由下面的
                 checkCanvas() 看门狗决定显示哪一种。默认 hidden，正常情况永远看不到。 -->
            <div id="ve-canvas-offline" hidden>
              <div class="ve-offline-block" data-cv-offline="server-down">
                <p class="ve-offline-title">画布没有连上本地服务</p>
                <p class="ve-offline-note">画布区域现在显示的是浏览器的「127.0.0.1 拒绝连接」页，说明 FolioFold 的本地服务没有在运行 —— 不是模板坏了，内容也没有丢。</p>
                <p class="ve-offline-note">请在桌面双击 <b>FolioFold 修复.bat</b>（它会重启服务并自动打开页面）。服务恢复后这里的画布会自动重连，不用手动刷新。</p>
              </div>
              <div class="ve-offline-block" data-cv-offline="canvas-blank" hidden>
                <p class="ve-offline-title">画布没有渲染出来</p>
                <p class="ve-offline-note">本地服务是通的，但画布内容没有出来。点下面的按钮重新加载；如果一直这样，双击桌面 <b>FolioFold 修复.bat</b> 重启一次服务。</p>
              </div>
              <button type="button" id="ve-canvas-retry">重新加载画布</button>
            </div>
          </div>
        </main>
        <aside class="ve-panel ve-panel-right">
          <div id="ve-edit"></div>
        </aside>
      </div>
      <div class="ve-toast" id="ve-toast"></div>
    </div>
  `;
  // 首屏就按当前语言铺一遍（上面那段 HTML 里的中文只是兜底默认值）。
  applyVeChromeText();
  // 之后每次重画（左右两栏、toast、弹窗）都自动跟随语言。
  // 用观察器而不是在每个渲染函数里插一行：以后新加的渲染入口不会漏翻。
  if (I18N && I18N.autoTranslate) I18N.autoTranslate(root);

  if (I18N) {
    I18N.mountSwitcher($('#ve-locale'), {compact:true});
    // ★ 2026-09-22：以前这里是 location.reload()。外壳每次面板加载完都会广播一次当前语言
    // （握手，不是切换），于是整个排版编辑面板连页带画布重载 2~3 次 —— 用户原话
    // "挪完间距会刷新两三下，让人以为没生效或卡了"。现在改成【原地重渲】：
    // 只把界面文案与左右两栏重画一遍，画布 iframe 连碰都不碰（它的语言自己另说）。
    window.addEventListener('ff-locale-change', () => { rerenderVeUI(); syncCanvasLocale(); });
  }

  // 事件绑定
  $('#ve-back').onclick = () => gotoPanel('portfolio', '/portfolio/');
  $('#ve-texteditor').onclick = () => gotoPanel('editor', '/editor/');
  $('#ve-expand').onclick = expandAllInCanvas;
  $('#ve-collapse').onclick = collapseAllInCanvas;
  $('#ve-save').onclick = saveAll;
  // 画布宽度：手机 / 电脑 切换（关键修复 2026-09-08 vR+）：
  // 电脑模式 iframe width = window.innerWidth（用户真实 viewport 宽），与发布版浏览器尺寸一致。
  // 中部容器用 overflow:auto，剩余宽度横向滚动。这样 iframe 内 .hero 渲染时与真实 Portfolio
  // 完全相同的尺寸比例（之前中部 1fr≈540px 把 .hero 压挤、技能换两行等比例错误全部消失）。
  // 内部 getBoundingClientRect 是真实 px，路径点按 0..1 比例存就自动对齐两边。
  const cvEl = document.getElementById('ve-canvas');

  // ★ 2026-09-22：画布看门狗 —— 服务没起来时给「说人话」的提示，而不是让用户对着
  // Chrome 的「127.0.0.1 拒绝连接」猜是不是模板坏了（用户原话就是这样）。
  //
  // 判据是 2026-09-22 实测出来的，别再凭直觉改：
  //   服务正常：cvEl.contentDocument 有值，能数到 .entry；父窗口 fetch('/api/health') 返回 ok
  //   服务挂掉：cvEl.contentDocument === null，contentWindow.location.href 抛 SecurityError
  //             （Chrome 的网络错误页是不透明源），父窗口 fetch('/api/health') 直接 TypeError
  // ⇒ 先判「iframe 里是不是错误页」（最直接），再用 /api/health 区分两种原因：
  //     服务没起来（server-down） / 服务在但画布没渲染（canvas-blank）。
  //   ⚠️ 不要用 app-v3.js 的 ve-ready 握手做判据：实测在 ?mode=draft&ve=1 这条路径上
  //      它根本不会到达父窗口（父窗口只能收到 ve-select / ve-canvas-metrics），
  //      用它做超时看门狗会对**正常加载**误报，比不提示更糟。
  const CV_OFFLINE_POLL = 4000;
  let cvOfflinePoll = 0, cvFailStreak = 0, cvRecovering = false, cvChecking = false, cvState = 'ok';
  const hideCvOffline = () => { const el = document.getElementById('ve-canvas-offline'); if (el) el.hidden = true; };
  const serverDownNote = '本地服务没有响应（127.0.0.1:3000）—— 保存和发布会失败。请在桌面双击 FolioFold 修复.bat 重启服务，画布会自动恢复。';
  const canvasIsErrorPage = () => {
    const f = document.getElementById('ve-canvas');
    if (!f) return false;
    try { return !f.contentDocument; } catch (_) { return true; }
  };
  const serverAlive = async () => {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 2500);
      const res = await fetch('/api/health', { cache: 'no-store', signal: ctl.signal });
      clearTimeout(t);
      return res.ok;
    } catch (_) { return false; }
  };
  const showCvOffline = kind => {
    const el = document.getElementById('ve-canvas-offline');
    if (!el) return;
    el.querySelectorAll('[data-cv-offline]').forEach(d => { d.hidden = d.dataset.cvOffline !== kind; });
    el.hidden = false;
  };
  // 三种状态只在「变化的那一刻」生效一次，避免每轮轮询都去写状态行、把
  // refreshStatusDetail() 算出来的「有未更新的改动」覆盖掉。
  const applyCvState = next => {
    if (next === cvState) return;
    cvState = next;
    const detail = document.getElementById('ve-status-detail');
    if (next === 'ok') { hideCvOffline(); try { refreshStatusDetail(); } catch (_) {} }
    else if (next === 'overlay') { showCvOffline('server-down'); if (detail) detail.textContent = '画布未连上本地服务（127.0.0.1:3000 没有响应）。'; }
    else if (detail) { detail.textContent = serverDownNote; }
  };
  const checkCanvas = async () => {
    if (cvChecking) return;                       // 上一轮还没回来就别叠
    cvChecking = true;
    try {
      const alive = await serverAlive();
      if (alive) {
        cvFailStreak = 0;
        if (canvasIsErrorPage()) {
          // 服务是通的、画布却是错误页 —— 先自救重载一次，还不行才盖提示
          if (!cvRecovering) { cvRecovering = true; reloadCanvas(true); return; }
          showCvOffline('canvas-blank'); cvState = 'overlay';
          return;
        }
        cvRecovering = false;
        applyCvState('ok');
        return;
      }
      // 服务不可达：连续两次才认，避免一次抖动就打扰用户
      cvRecovering = false;
      cvFailStreak += 1;
      if (cvFailStreak < 2) return;
      // 画布还在显示（错误页之外的情况）就别盖住它 —— 只在状态行提醒，用户还能看
      applyCvState(canvasIsErrorPage() ? 'overlay' : 'warn');
    } finally { cvChecking = false; }
  };
  if (!cvOfflinePoll) cvOfflinePoll = setInterval(checkCanvas, CV_OFFLINE_POLL);
  // 每次 iframe load 后稍等一下再判：刚切 src 的那一瞬间 contentDocument 可能还是 null
  if (cvEl) cvEl.addEventListener('load', () => setTimeout(checkCanvas, 700));
  const cvRetry = document.getElementById('ve-canvas-retry');
  if (cvRetry) cvRetry.onclick = () => { cvState = 'ok'; hideCvOffline(); cvRecovering = false; reloadCanvas(true); };
  const setCvMode = (m) => {
    if (!cvEl) return;
    cvEl.classList.toggle('ve-cv-mobile', m === 'mobile');
    cvEl.classList.toggle('ve-cv-desktop', m !== 'mobile');
    if (m !== 'mobile') {
      // 电脑模式 = 用户视口宽。最小 800（避免缩到极窄），最大不限。
      const w = Math.max(800, window.innerWidth || 1280);
      cvEl.style.width = w + 'px';
    } else {
      cvEl.style.width = '';   // 走 CSS .ve-cv-mobile { width: 390px }
    }
    const mb = $('#ve-cv-mobile'), dk = $('#ve-cv-desktop');
    if (mb) mb.classList.toggle('primary', m === 'mobile');
    if (dk) dk.classList.toggle('primary', m !== 'mobile');
    try { localStorage.setItem('ve-cv-mode', m); } catch(_){}
  };
  const mb = $('#ve-cv-mobile'); if (mb) mb.onclick = () => setCvMode('mobile');
  const dk = $('#ve-cv-desktop'); if (dk) dk.onclick = () => setCvMode('desktop');
  // 默认走 desktop；用户上次选过的记忆读回来
  let _cvInitMode = 'desktop';
  try { _cvInitMode = localStorage.getItem('ve-cv-mode') || 'desktop'; } catch(_){}
  setCvMode(_cvInitMode);

  // 监听 iframe postMessage
  window.addEventListener('message', (e) => {
    if (!e.data || typeof e.data !== 'object') return;
    const M = e.data;
    if (M.type === 've-edit-section') {
      selectedSection = M.section;
      veContext.section = selectedSection; veContext.addSection = selectedSection; veContext.groupId = ''; veContext.groupIndex = -1; veContext.mediaPath = '';
      renderSectionsList(); renderEditPanel();
      highlightInCanvas(selectedSection);
    } else if (M.type === 've-ready') {
      // iframe 已就绪，刷新主题状态等
      $('#ve-status-detail').textContent = '画布已加载。点击内容即可编辑。';
      // iframe 加载完后再次校准电脑模式宽度（确保拿到最新的 window.innerWidth）
      try {
        const m = (localStorage.getItem('ve-cv-mode') || 'desktop');
        if (m !== 'mobile') setCvMode(m);
      } catch(_){}
      // 画布刚重载过：如果有一张图上传好了但还没放下，这里补发，用户就不用重新选文件
      if (pendingUpload){
        const p = pendingUpload;
        setTimeout(() => {
          postToCanvas({ type: 've-add-image-pending', src: p.src, url: p.url, name: p.name });
          document.querySelectorAll('[data-canvas-mode]').forEach(item => item.classList.toggle('primary', item.dataset.canvasMode === 'addimg'));
        }, 400);
      }
    } else if (M.type === 've-add-image-done') {
      // 画布已经把这张图放下了（或用户取消）→ 清掉待放置状态，避免下次重载又冒出来
      pendingUpload = null;
    } else if (M.type === 've-locate-result') {
      // 「统筹区」点了一行 → 画布回报它找到了没、在哪个纵向位置 → 这里把滚动容器滚过去
      handleLocateResult(M);
    } else if (M.type === 've-select') {
      // 画布上选中/取消选中了某个元素 → 右侧工具箱跟着切换，同时更新「添加内容」的层级上下文
      veSelection = (M.path || M.itemPath) ? M : null;
      // 画布实际点选的区块：来自 iframe 消息里的 section 字段（点哪报哪），取消选中时为 ''
      canvasSection = (veSelection && M.section) ? M.section : '';
      if (veSelection) applyCanvasContext(M);
      renderToolbox();
    } else if (M.type === 've-add-here') {
      // 画布上「＋ 在此分类添加」：把添加面板定位到那个分类
      veContext.section = veContext.addSection = selectedSection = 'works';
      veContext.groupId = M.groupId || '';
      veContext.itemPath = '';
      renderSectionsList(); renderToolbox();
      const card = $('.ve-tb-add');
      if (card) { card.classList.add('ve-tb-flash'); try { card.scrollIntoView({ block: 'nearest' }); } catch (_) {} setTimeout(() => card.classList.remove('ve-tb-flash'), 1400); }
      const g = (draft.projectGroups || []).find(x => x.id === veContext.groupId);
      toast('已定位到「' + ((g && g.title) || '分类') + '」：点「+ 添加」就往这个分类里加项目');
    } else if (M.type === 've-attach-image' || M.type === 've-attach-media') {
      // 画布上直接上传 → 并进对应项目的媒体栏（图片和视频共用同一条媒体栏，内容是同一个数据源）
      pendingUpload = null;
      const slot = M.slot || 'image';
      pushHistory();
      (async () => {
        const project = (draft.projects || [])[Number(M.project)];
        if (!project) { toast('找不到对应项目，媒体没有放进去'); return; }
        project.media = project.media || { mainVisual: null, processImages: [], video: null, audio: null, externalVideoUrl: '', externalLink: '' };
        const ref = { url: M.url, name: M.name || '', type: M.type || '' };
        let label = '媒体';
        if (slot === 'video') { project.media.video = ref; label = '视频'; }
        else if (slot === 'audio') { project.media.audio = ref; label = '音频'; }
        else {
          const hasMain = !!(project.media.mainVisual && (project.media.mainVisual.url || typeof project.media.mainVisual === 'string'));
          if (hasMain) { project.media.processImages = Array.isArray(project.media.processImages) ? project.media.processImages : []; project.media.processImages.push(ref); }
          else project.media.mainVisual = ref;
          label = '图片';
        }
        const ok = await saveDraft(true);
        if (ok) {
          await reloadCanvas(true); renderToolbox();
          const warn = M.warn ? '（提示：' + M.warn + '）' : '';
          toast('已把' + label + '放进「' + (project.name || '项目') + '」的媒体栏' + warn);
        }
      })();
    } else if (M.type === 've-clear-media') {
      pushHistory();
      (async () => {
        const idx = Number((/^projects\.(\d+)\.media$/.exec(M.path || '') || [])[1]);
        const project = (draft.projects || [])[idx];
        if (!project) { toast('找不到对应项目'); return; }
        project.media = { mainVisual: null, processImages: [], video: null, audio: null, externalVideoUrl: (project.media && project.media.externalVideoUrl) || '', externalLink: (project.media && project.media.externalLink) || '' };
        const ok = await saveDraft(true);
        if (ok) { await dropFreeRecordsForPrefix(M.path); await reloadCanvas(true); renderToolbox(); toast('已清空「' + (project.name || '项目') + '」的媒体'); }
      })();
    } else if (M.type === 've-delete-media-item') {
      // 画布上「🗑 删除此项」：只删一个项目里的这一项，同项目其他项完全不受影响
      pushHistory();
      (async () => {
        const ok = await removeMediaItemByKey(M.key);
        if (ok) { await reloadCanvas(true); renderToolbox(); toast('已删除该项媒体'); }
        else toast('删除失败：这项媒体已不存在');
      })();
    } else if (M.type === 've-delete-media-path') {
      // 按内容路径删一张图（AI 项目封面 / 截图等）
      pushHistory();
      (async () => {
        const ok = await removeByContentPath(M.path);
        if (ok) { await dropFreeRecordsForKey(M.path); await reloadCanvas(true); renderToolbox(); toast('已删除这张图片'); }
        else toast('删除失败：路径无效');
      })();
    } else if (M.type === 've-reorder') {
      pushHistory();
      // 画布里拖动排序：order 是移动后的完整路径顺序，按它重建数组最可靠。
      try {
        if (!Array.isArray(M.order) || M.order.length < 2) return;
        const arrPath = M.order[0].split('.').slice(0, -1);
        const arr = getDeep(draft, arrPath);
        if (!Array.isArray(arr)) return;
        const items = M.order.map(p => arr[Number(p.split('.').pop())]);
        if (items.some(x => x === undefined)) { toast('排序失败：索引已变化，请刷新画布'); return; }
        arr.length = 0;
        items.forEach(x => arr.push(x));
        saveDraft(true).then(ok => { if (ok) { toast('已调整顺序'); reloadCanvas(true); } });
      } catch (err) { toast('排序失败：' + err.message); }
    } else if (M.type === 've-commit-textstyles') {
      // 字段级样式与 inline 清理由 iframe 原子提交，避免两条异步写入互相覆盖。
      try {
        const nextTextStyles = (M.textStyles && typeof M.textStyles === 'object') ? M.textStyles : (readDirect('getTextStyles') || {});
        const nextInlineStyles = (M.inlineStyles && typeof M.inlineStyles === 'object') ? M.inlineStyles : (design.inlineStyles || {});
        const changed = JSON.stringify(design.textStyles || {}) !== JSON.stringify(nextTextStyles) || JSON.stringify(design.inlineStyles || {}) !== JSON.stringify(nextInlineStyles);
        design.textStyles = cloneState(nextTextStyles);
        design.inlineStyles = cloneState(nextInlineStyles);
        saveTextStyles(design.textStyles, design.inlineStyles);
        // 保存优先于历史记录：即使历史快照因旧数据异常不可用，已经确认的文字样式也不能丢。
        if (changed) { try { pushHistory(); } catch (_) {} }
      } catch (err) { toast('文字样式保存失败：' + err.message); }
    } else if (M.type === 've-commit-text') {
      pushHistory();
      // 画布内点字直改 → 写回 portfolio.json。DOM 已实时显示新文字，故不刷新画布，避免跳回顶部。
      try {
        const path = M.path.split('.');
        if (path.length >= 2) setDeep(draft, path, M.single ? M.value : M.value.split('\n').map(x=>x.trim()).filter(Boolean));
        // 用户在画布里直接重打了文字 → 清掉该字段旧的局部样式标记，避免残留
        if (design.inlineStyles && design.inlineStyles[M.path]) delete design.inlineStyles[M.path];
        // 区块标题 / 分类名称被改名 → 左侧区块列表与「添加内容」里的目标名称必须同步跟着变
        if (/^sectionTitles\./.test(M.path) || /^projectGroups\./.test(M.path)) {
          if (/^sectionTitles\./.test(M.path)) { const k = M.path.split('.')[1]; if (k) { selectedSection = k; veContext.section = k; veContext.addSection = k; } }
          renderSectionsList(); renderToolbox();
        }
        saveDraft(true).then(ok => { if (ok) toast('已保存文字'); });
      } catch (err) { toast('直改保存失败：' + err.message); }
    } else if (M.type === 've-commit-medialayout') {
      pushHistory();
      // 媒体栏的「排版位置」设置（Design，不动内容）：
      //   { "projects.N.media": { side: "left", belowAlign: "center" } }
      //   · side       = 媒体栏在正文左/右
      //   · belowAlign = 「正文下方」整行区的整行对齐（left/'' | center | right）
      const cur = (design.mediaLayout || {})[M.path] || {};
      const patch = M.patch ? Object.assign({}, cur, M.patch) : Object.assign({}, cur, { side: M.side });
      const nextLayout = Object.assign({}, design.mediaLayout || {}, { [M.path]: patch });
      design.mediaLayout = nextLayout;
      postToCanvas({ type: 've-set-medialayout', mediaLayout: nextLayout });
      api('/api/design/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mediaLayout: nextLayout, theme: draft.theme || null }) })
        .then(() => { toast(M.msg || (M.side === 'left' ? '媒体栏已放到左边' : '媒体栏已放到右边')); refreshStatusDetail(); notifyStudioSaved(); })
        .catch(err => toast('位置保存失败：' + err.message));
    } else if (M.type === 've-delete-item') {
      pushHistory();
      // 画布内选中元素 → 删除。DOM 已移除且索引已本地重排，故不刷新画布，避免跳回顶部。
      // 唯一例外：删除的是对象属性（如 profile.avatar），没有本地索引可重排，需要 reload 才能彻底清掉。
      try {
        const segs = M.path.split('.');
        const key = segs.pop();
        const parent = getDeep(draft, segs);
        if (Array.isArray(parent) && /^\d+$/.test(key)) {
          const idx = +key;
          if (idx >= 0 && idx < parent.length) {
            const removed = parent[idx];
            parent.splice(idx, 1);
            removeRedundantCopies(draft, segs, removed);   // 清掉冗余副本，防止删了又回来
            saveDraft(true).then(ok => { if (ok) { toast('已删除'); refreshStatusDetail(); } });
          } else { toast('删除失败：找不到对应数据'); }
        } else if (parent && typeof parent === 'object') {
          // 非数组对象（如 profile.avatar）：直接 delete 末段 key；这类没有冗余副本
          delete parent[key];
          saveDraft(true).then(ok => { if (ok) { toast('已删除'); refreshStatusDetail(); reloadCanvas(true); } });
        } else {
          toast('删除失败：找不到对应数据');
        }
      } catch (err) { toast('删除失败：' + err.message); }
    } else if (M.type === 've-delete-static') {
      pushHistory();
      // 静态布局元素（如 Selected Works 眉标、hero 横线）无数据 backing，只能记录到 design.removedStatic，
      // 渲染端据其隐藏。Content 不涉及，绝不触碰 portfolio.json。
      try {
        design.removedStatic = Array.isArray(design.removedStatic) ? design.removedStatic.slice() : [];
        const id = M.id || '';
        if (id && design.removedStatic.indexOf(id) < 0) design.removedStatic.push(id);
        api('/api/design/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ removedStatic: design.removedStatic, theme: draft.theme || null }) })
          .then(() => { toast('已删除'); refreshStatusDetail(); notifyStudioSaved(); reloadCanvas(true); })
          .catch(err => toast('删除保存失败：' + err.message));
      } catch (err) { toast('删除失败：' + err.message); }
    } else if (M.type === 've-commit-static-text') {
      // 静态元素的可编辑文案（如 Selected works 眉标）：没有 content 数据 backing，
      // 归 Template，存 design.staticText[id]。空字符串 = 恢复默认文案。
      const id = M.id || '';
      if (!id) return;
      try {
        const next = Object.assign({}, design.staticText || {});
        const v = String(M.value == null ? '' : M.value).trim();
        if (v) next[id] = v; else delete next[id];
        design.staticText = next;
        api('/api/design/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ staticText: next, theme: draft.theme || null }) })
          .then(() => { toast(v ? '文字已保存' : '已恢复默认文字'); refreshStatusDetail(); notifyStudioSaved(); reloadCanvas(true); })
          .catch(err => toast('文字保存失败：' + err.message));
      } catch (err) { toast('文字保存失败：' + err.message); }
    } else if (M.type === 've-hide-section') {
      pushHistory();
      // 「元素」模式下整块删除：记进 settings.sectionVisibility，渲染端据此不再输出该区块。
      // 不删除 portfolio.json 里的内容，用户可在「文本编辑 → 页面结构」随时勾回「显示」。
      try {
        const k = M.section || '';
        if (!k) { toast('找不到要删除的区块'); }
        else {
          draft.settings = draft.settings || {};
          draft.settings.sectionVisibility = draft.settings.sectionVisibility || {};
          draft.settings.sectionVisibility[k] = false;
          saveDraft(true).then(ok => {
            if (ok) {
              toast('已删除整块「' + (sectionLabel(k) || k) + '」（可在「文本编辑 → 页面结构」恢复）');
              renderToolbox(); reloadCanvas(true); refreshStatusDetail();
            }
          });
        }
      } catch (err) { toast('删除失败：' + err.message); }
    } else if (M.type === 've-pixel-update') {
      pushHistory();
      // Pixel Character 拖拽定位 / 大小 / 区域 / 显隐 / 动画 → 存 design.pixel（Design，不碰 Content）
      try {
        design.pixel = Object.assign({}, design.pixel || {}, M.pixel || {});
        api('/api/design/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pixel: design.pixel, theme: draft.theme || null }) })
          .then(() => { refreshStatusDetail(); })
          .catch(err => toast('Pixel 保存失败：' + err.message));
      } catch (err) { toast('Pixel 保存失败：' + err.message); }
    } else if (M.type === 've-pixel-path') {
      pushHistory();
      // 活动轨迹：把画好的连续线存到 design.pixel.path（hero-relative 点集）
      try {
        const pts = Array.isArray(M.path) ? M.path.filter(p => p && typeof p.x === 'number') : [];
        if (pts.length < 2){ toast('轨迹点太少'); return; }
        design.pixel = Object.assign({}, design.pixel || {}, { path: pts, onPath: true });
        api('/api/design/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pixel: design.pixel, theme: draft.theme || null }) })
          .then(() => { reloadCanvas(true); renderToolbox(); toast('轨迹已保存，形象已锁定到轨迹上移动'); })
          .catch(err => toast('轨迹保存失败：' + err.message));
      } catch (err) { toast('轨迹保存失败：' + err.message); }
} else if (M.type === 've-commit-inline') {
      // 画布内局部/整元素文字样式 → 存 design.inlineStyles（innerHTML）。DOM 已实时变化，不刷新画布。
      // 频率较高（每次 B/A+/color 都来一条），只有当 HTML 真变化时才进历史，避免 20 步被一行字改光。
      // 这里以 iframe 端传来的 allInlineStyles 为单一真相（防止父端 design 因其它路径被误改）。
      try {
        const data = (M.allInlineStyles && typeof M.allInlineStyles === 'object') ? M.allInlineStyles : ((M.html && /<[a-zA-Z]/.test(M.html)) ? { [M.path]: M.html } : {});
        const prevStr = JSON.stringify(design.inlineStyles || {});
        const nextStr = JSON.stringify(data);
        if (prevStr !== nextStr){
          pushHistory();
        }
        design.inlineStyles = data;
        saveInlineStyles();
      } catch (err) { toast('文字样式保存失败：' + err.message); }
    } else if (M.type === 've-commit-images') {
      pushHistory();
      // 自由图片层增删/移动/缩放 → 存 design.images
      try { design.images = Array.isArray(M.images) ? M.images : []; saveImages(); } catch (err) { toast('图片保存失败：' + err.message); }
      // 列表/数量可能变化（加图、删图），刷新右侧统筹区（位置变化也只是重建这块卡片，开销极小）
      refreshImagesOverview();
    } else if (M.type === 've-commit-bound-media') {
      pushHistory();
      // 内容媒体的自由布局同时影响「自由层克隆」和「原图隐藏」：一次请求原子保存
      // images + imgPos，避免两个并发 design/save 互相用旧快照覆盖。
      design.images = Array.isArray(M.images) ? M.images : [];
      design.imgPos = Object.assign({}, M.imgPos || {});
      api('/api/design/save', { method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({ images:design.images, imgPos:design.imgPos, theme:draft.theme||null }) })
        .then(() => { refreshImagesOverview(); refreshStatusDetail(); notifyStudioSaved(); })
        .catch(err => toast('自由图片位置保存失败：' + err.message));
    } else if (M.type === 've-delete-image') {
      toast('已删除图片');
    } else if (M.type === 've-toast') {
      if (M.msg) toast(M.msg);
    } else if (M.type === 've-canvas-metrics') {
      // 展开/收起项目后画布自然高度会变；只更新数值，不重建工具也不重载画布。
      refreshCanvasSizingTools();
    } else if (M.type === 've-commit-space') {
      pushHistory();
      // 拖动间距杆 → 保存到 design.spacing。不刷新画布（CSS 已实时应用），避免跳回顶部。
      // ⚠️ 优先用画布「随消息带过来」的值：如果这一刻画布刚好被重新加载过
      // （保存/面板同步/切模板都会触发 reloadCanvas），readDirect 读到的是重载后
      // 从服务器回来的旧 spacing，会把用户刚拖出来的结果原地覆盖成旧值。
      const fromMsg = (M.spacing && typeof M.spacing === 'object' && Object.keys(M.spacing).length) ? M.spacing : null;
      const sp = fromMsg || readDirect('getSpacing');
      if (!sp || !Object.keys(sp).length) return;
      api('/api/design/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ spacing: sp, theme: draft.theme || null }) })
        .then(async () => {
          toast('间距已保存'); refreshStatusDetail(); notifyStudioSaved();
          // 回读校验：确认落盘的值就是刚提交的那份。若不一致（历史上出现过"存成旧值"），
          // 用同一份值再写一次并明确提示，而不是静默地留着错的值。
          try {
            const back = await api('/api/design');
            const got = JSON.stringify((back && back.spacing) || {});
            if (got !== JSON.stringify(sp)) {
              console.warn('[VE] spacing 回读不一致，自动纠正', { submitted: sp, server: back && back.spacing });
              await api('/api/design/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ spacing: sp, theme: draft.theme || null }) });
              toast('间距已重新同步到最新值');
            }
          } catch (_) {}
        })
        .catch(err => toast('间距保存失败：' + err.message));
    } else if (M.type === 've-commit-media-item' || M.type === 've-commit-media-items') {
      pushHistory();
      // 单个媒体项（图片 / 视频 / 音频）的尺寸 / 顺序 / 摆放位置 / 对齐 → design.mediaItems。
      // 只写 Design、不碰 Content：怎么挪动都不会动到作品内容本身。
      const next = Object.assign({}, design.mediaItems || {});
      const applyOne = (k, patch) => {
        if (!k) return;
        if (!patch) { delete next[k]; return; }
        next[k] = Object.assign({}, next[k] || {}, patch);
      };
      if (M.type === 've-commit-media-items') Object.entries(M.map || {}).forEach(([k, v]) => applyOne(k, v));
      else applyOne(M.key, M.patch);
      Object.keys(next).forEach(k => { const v = next[k]; if (!v || !Object.keys(v).length) delete next[k]; });
      design.mediaItems = next;
      api('/api/design/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mediaItems: next, imgSizes: design.imgSizes || {}, mediaLayout: design.mediaLayout || {}, theme: draft.theme || null }) })
        .then(() => { toast(M.savedMsg || '媒体设置已保存'); refreshStatusDetail(); notifyStudioSaved(); })
        .catch(err => toast('媒体设置保存失败：' + err.message));
    } else if (M.type === 've-commit-image') {
      pushHistory();
      // 拖动图片/媒体栏手柄 → 保存到 design.imgSizes（占所在行的百分比）。不刷新画布（已实时应用）。
      // M.reset = 双击复位：把这条记录整个删掉，回到默认尺寸。
      const nextSizes = Object.assign({}, design.imgSizes || {});
      if (M.reset) delete nextSizes[M.path]; else nextSizes[M.path] = { widthPct: M.widthPct };
      design.imgSizes = nextSizes;
      // 顺手把间距一起落盘（防止上一次拖杆还没 commit），但只在真读到值时才带上：
      // 带一个空 {} 过去会被服务端当成"清空 spacing"。
      const imgBody = { imgSizes: nextSizes, mediaLayout: design.mediaLayout || {}, theme: draft.theme || null };
      const spNow = readDirect('getSpacing');
      if (spNow && Object.keys(spNow).length) imgBody.spacing = spNow;
        api('/api/design/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(imgBody) })
        .then(() => { toast(M.reset ? '已恢复默认尺寸' : ('宽度已保存（占整行 ' + Math.round(M.widthPct) + '%）')); refreshStatusDetail(); notifyStudioSaved(); })
        .catch(err => toast('图片保存失败：' + err.message));
    } else if (M.type === 've-commit-imgpos') {
      pushHistory();
      // 栏外散落图片的「位置」摆放（默认 / 正文右侧 / 正文左侧 / 独占一行）→ design.imgPos。
      // 与 imgSizes 一样只写 Design，不碰 Content。
      const nextPos = Object.assign({}, design.imgPos || {}, M.imgPos || {});
      Object.keys(nextPos).forEach(k => {
        const v = nextPos[k];
        if (!v || !Object.keys(v).length || v.place === 'inline') delete nextPos[k];
      });
      design.imgPos = nextPos;
      const posBody = { imgPos: nextPos, imgSizes: design.imgSizes || {}, mediaLayout: design.mediaLayout || {}, theme: draft.theme || null };
      const spNow2 = readDirect('getSpacing');
      if (spNow2 && Object.keys(spNow2).length) posBody.spacing = spNow2;
      api('/api/design/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(posBody) })
        .then(() => { toast('图片位置已保存'); refreshStatusDetail(); notifyStudioSaved(); })
        .catch(err => toast('图片位置保存失败：' + err.message));
    }
  });

  renderSectionsList();
  renderThemeList();
  renderEditPanel();
  refreshStatusDetail();
  // 把「当前加载状态」作为第一条历史，让 undo 第一步就能回到刚打开 VE 时的样子
  pushHistory(true);
}

async function refreshStatusDetail() {
  try {
    const s = await api('/api/publish/status');
    const el = $('#ve-status-detail');
    if (!el) return;
    if (s.dirty) {
      // ⚠ 整句必须一起交给 z() 翻：字典是整串精确匹配，`<b>` 里的字和后面的说明
      // 是两个独立文本节点，拆开就永远查不到（英文界面会留下中文尾巴）。
      // ⚠ 2026-09-23 二次修正：这里原来拼的是 `z('：' + s.detail + '。点上方「保留」…')`，
      //   依赖 patterns.json 里带 `(.*)` 捕获组的正则 —— 而 s.detail 是服务端给的**中文**
      //   （'内容（文字/项目/章节） 有改动'），捕获组会把它原样吐回来，
      //   于是英文界面出现「: 内容（文字/项目/章节） 有改动. Click "Keep" above to save」这种中英混排。
      //   现在改成：用接口本来就有的 contentDirty / designDirty 两个布尔量挑一句**完整**的中文，
      //   整句查表，没有任何回显变量 —— 字典里就是 3 条死句子，翻不翻都不会半中半英。
      const both = s.contentDirty && s.designDirty;
      const what = both ? '内容（文字/项目/章节）与排版（布局/主题）都有改动'
                 : s.contentDirty ? '内容（文字/项目/章节）有改动'
                 : '排版（布局/主题）有改动';
      el.innerHTML = `<b style="color:#c0392b">${esc(z('有未更新的改动'))}</b>`
        + esc(z('：' + what + '。点上方「保留」存下画布调整；要更新到公开版请回作品集点右上角「发布」。'));
    } else {
      el.textContent = z('已与发布版同步');
    }
  } catch (e) {}
}

boot().catch(e => {
  $('#ve-app').innerHTML = `<div class="ve-error">Visual Editor 加载失败：${esc(e.message)}</div>`;
});
