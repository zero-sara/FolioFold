// 版本标记：浏览器缓存问题排查用（F12 控制台执行 window.__FF_VERSION 即可确认跑的是哪一版）
const FF_VERSION = '20260927r17';
try { window.__FF_VERSION = FF_VERSION; console.log('[FolioFold] app-v3', FF_VERSION); } catch (_) {}
const FF_I18N = (typeof window !== 'undefined' && window.FF_I18N) ? window.FF_I18N : null;
const ffT = (key, fallback) => FF_I18N ? FF_I18N.t(key, fallback) : fallback;

// ============================================================================
// Visual Editor（父窗口）→ 画布 iframe 的指令通道
// ⚠ 2026-09-24：注册点从「render 末尾」改成「模块加载即注册 + 早到指令入队」。
//   旧写法有两个真实故障：
//     ① 画布还没渲染完就 postMessage（VE 快速连点"展开"、QA 用例）→ 指令被**静默丢弃**，
//        用户看到的就是"点了没反应"；
//     ② render 每跑一次就 addEventListener 一次 → 监听器越积越多（旧 closure 全留在内存里）。
//   现在只注册一次；DOM 还没就绪时先入队，root.innerHTML 落地后按原顺序回放 ——
//   语义与"晚一点发"完全一致，不会吞指令、也不会丢顺序。
// ============================================================================
const FFZ_VE_QUEUE = [];
let FFZ_VE_READY = false;
// 只接管本通道负责的指令类型。`ve-set-spacing / ve-set-imgsizes / ve-set-medialayout / …`
// 由下面另一处监听器（VE 的样式直推通道）处理，**不要**放进队列，免得占满队列把展开指令挤掉。
const FFZ_VE_TYPES = ['ve-expand-all', 've-collapse-all', 've-expand-section', 've-expand-target', 've-scroll-to-section', 've-refresh'];
function FFZ_applyVeMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  const openEntry = (en, open) => {
    if (!en) return;
    const wasOpen = en.classList.contains('open');
    // 先尝试直接调用 iframe 内的 setEntryOpen；拿不到就退回手动切换，保证一定有反应。
    if (typeof window.__veSetEntryOpen === 'function') {
      try { window.__veSetEntryOpen(en, open); } catch (_) {}
    } else {
      en.classList.toggle('open', !!open);
      const t = en.querySelector('.expand-text'); if (t) t.textContent = open ? ffT('public.collapse', '收起') : ffT('public.expand', '展开');
    }
    // 兜底：若目标状态与期望不符（例如旧版渲染器没有 setEntryOpen），强制同步一次
    if (wasOpen === !!open && en.classList.contains('open') !== !!open) {
      en.classList.toggle('open', !!open);
      const t = en.querySelector('.expand-text'); if (t) t.textContent = open ? ffT('public.collapse', '收起') : ffT('public.expand', '展开');
    }
  };
  const openDetails = node => {
    if (!node) return;
    const detail = node.matches && node.matches('details') ? node : node.closest && node.closest('details');
    if (detail) detail.open = true;
  };
  // 项目字段路径（projects.1.name）先归一到项目节点（projects.1）；
  // 分类字段则通过 groupId 找到所属 Works Category。这样画布点到文字、
  // 卡片或媒体栏，右侧"展开所选内容"都能命中同一个实际节点。
  const openSelectedTarget = () => {
    const path = String(msg.itemPath || '');
    const match = path.match(/^(projects\.\d+|experience\.\d+|showreel\.projects\.\d+)/);
    const rootPath = match ? match[1] : path;
    if (rootPath) {
      const safePath = rootPath.replace(/"/g, '\\"');
      const target = document.querySelector(`[data-ve-item="${safePath}"]`);
      openDetails(target);
      const group = target && target.closest && target.closest('details.works-group');
      if (group) group.open = true;
    }
    if (msg.groupId) {
      const safeGroup = String(msg.groupId).replace(/"/g, '\\"');
      const group = document.querySelector(`[data-ve-group="${safeGroup}"]`);
      if (group) group.open = true;
    }
    if (msg.section) openEntry(document.querySelector(`.entry[data-section="${msg.section}"]`), true);
  };
  if (msg.type === 've-expand-all') {
    document.querySelectorAll('.entry').forEach(en => openEntry(en, true));
  } else if (msg.type === 've-collapse-all') {
    document.querySelectorAll('.entry').forEach(en => openEntry(en, false));
  } else if (msg.type === 've-expand-section') {
    openEntry(document.querySelector(`.entry[data-section="${msg.section}"]`), true);
  } else if (msg.type === 've-expand-target') {
    openSelectedTarget();
  } else if (msg.type === 've-scroll-to-section') {
    const en = document.querySelector(`.entry[data-section="${msg.section}"]`);
    if (en) en.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else if (msg.type === 've-refresh') {
    // 数据保存后由父窗口主动 reload iframe；这里留个钩子方便调试
    console.log('[FolioFold] ve-refresh received, parent should reload iframe');
  }
}
try {
  window.addEventListener('message', (e) => {
    const msg = e && e.data;
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
    if (FFZ_VE_TYPES.indexOf(msg.type) < 0) return;
    if (!FFZ_VE_READY) { if (FFZ_VE_QUEUE.length < 16) FFZ_VE_QUEUE.push(msg); return; }
    FFZ_applyVeMessage(msg);
  });
} catch (_) {}
// DOM 落地后调用：开放直通 + 回放早到的指令（顺序不变）
function FFZ_releaseVeQueue() {
  FFZ_VE_READY = true;
  // 给父窗口 / QA 用例一个确定性的「画布可收指令了」信号 ——
  // 靠 sleep 猜时间会偶发误判（section-expand 用例就因此偶发全空）。
  try { window.__ffzVeReady = true; } catch (_) {}
  if (!FFZ_VE_QUEUE.length) return;
  const q = FFZ_VE_QUEUE.splice(0, FFZ_VE_QUEUE.length);
  for (let i = 0; i < q.length; i++) { try { FFZ_applyVeMessage(q[i]); } catch (_) {} }
}
// 中文当 key 的字典层：给「嵌在用户内容里的系统文案」用 —— 那些地方 autoTranslate 会
// 整体跳过 data-ve-item 子树（怕把用户写的简历正文翻掉），只能在这里显式翻一句。
const ffZ = s => FF_I18N ? FF_I18N.z(s) : s;
// 整篇翻译的译文表（{中文原文: 译文}，服务端 /api/i18n/content 下发）。
// 画布不逐字段查译文，而是在渲染完之后整体做一遍「按原文精确匹配」的替换 ——
// 这样新增任何用户内容字段都不必再写一遍翻译逻辑，也不会漏。
async function ffLoadContentDict(){
  if (!FF_I18N || !FF_I18N.setContentDict) return;
  const lang = FF_I18N.getLocale();
  if (lang === 'zh-CN') { FF_I18N.setContentDict('zh-CN', {}); return; }
  // 静态发布构建：内容译文表已整体内联进 window.FF_CONTENT_I18N（见 server.py 的
  // build_public_bundle），直接取用即可，绝不能去 fetch /api/i18n/content ——
  // 发布页脱离本地 server，那个接口不存在，会进 catch 把内联译文表清空 → 永远回中文。
  if (window.__FF_STATIC_BUILD__ && window.FF_CONTENT_I18N) {
    FF_I18N.setContentDict(lang, (window.FF_CONTENT_I18N[lang] || {}));
    return;
  }
  try {
    // Phase 3 门控：默认只拿「已审核」译文；URL 带 ?i18ndraft=1（创作端草稿预览入口）才拿草稿表。
    const draftQ = /[?&]i18ndraft=1/.test(location.search) ? '&draft=1' : '';
    const r = await fetch('/api/i18n/content?lang=' + encodeURIComponent(lang) + draftQ, { cache: 'no-store' }).then(x => x.json());
    FF_I18N.setContentDict(lang, (r && r.ok && r.map) || {});
    ffAutoTranslateContent(lang, r);
  } catch (_) { FF_I18N.setContentDict(lang, {}); }
}
/* ————————————————— 自动整篇翻译（不依赖人工预先翻好）———————————————————
 * 用户原话：「我不希望这个翻译是因为我有需求，所以你帮我翻译完了之后附带上去的，
 *   我更希望是本身这个系统搭建完成了，然后根据 Ollama……自动识别的。因为如果是我帮你
 *   翻译完的话，那就会像模板二一样，它可能随时会有新东西、随时有新模板，整个进度就会很被动。」
 * 所以：画布拿字典时顺手对一次账 ——
 *   ① 这个模板这个语言还没翻过 / 翻了但内容又新增了（count < pending）→ 自动请求整篇翻译；
 *   ② 翻完重新取一次字典并原地重刷，用户不需要刷新页面、不需要点任何按钮；
 *   ③ 已经翻齐的情况（最常见）只多一次 status 请求，没有任何副作用。
 * 每个「模板+语言」在一个页面生命周期里只自动试一次，避免来回切语言时反复打模型。 */
const _ffAutoTried = Object.create(null);
function ffAutoHint(message, ttlMs){
  try {
    let el = document.getElementById('ff-auto-i18n-hint');
    if (!el){
      el = document.createElement('div');
      el.id = 'ff-auto-i18n-hint';
      el.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483000;max-width:340px;'
        + 'background:#161616;color:#fff;font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans SC",sans-serif;'
        + 'padding:10px 14px;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.28);opacity:0;transition:opacity .18s';
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.style.opacity = '1';
    clearTimeout(el.__ffTtl);
    if (ttlMs) el.__ffTtl = setTimeout(() => { el.style.opacity = '0'; }, ttlMs);
  } catch (_) {}
}
/* 2026-09-23：整篇自动翻译的实现搬到了 i18n.js（四个入口都加载它，且做了「只有顶层窗口
 * 真正干活」的单飞保护）。原来的实现只挂在画布上，于是：
 *   · 在 Studio 外壳 / 文本编辑面板切语言 → 完全不触发（用户原话：「模板一有、模板二没有」）；
 *   · 四个 frame 各跑一份 → 同一份活打四遍本地 Ollama。
 * 这里只保留一个转发，别再在这里实现第二份。ffLoadContentDict 仍然留在画布，
 * 负责「取字典 + 原地重刷」。 */
function ffAutoTranslateContent(lang, dictRes){
  try { if (FF_I18N && FF_I18N.autoTranslateContent) return FF_I18N.autoTranslateContent({ lang }); } catch (_) {}
  return Promise.resolve(null);
}
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
// 「正文下方」整行媒体区里，项与项之间的间距（必须与 public-v2.css 的 .project-media-below gap 一致）。
// 用 (100% - 间隙*(N-1))/N 计算每项宽度，才能保证任何窗口宽度下都恰好 N 个一排，不会被间隙挤到换行。
const BELOW_GAP_PX = 16;
// 取「正文下方」整行区的间距（用户可在工具条调节）；没设过就回退到默认 16px，与 CSS 一致。
const belowGapOf = (layout) => {
  const v = layout && Number.isFinite(Number(layout.belowGap)) ? Number(layout.belowGap) : NaN;
  return Number.isFinite(v) ? Math.max(0, Math.min(120, v)) : BELOW_GAP_PX;
};
const secs=t=>{const p=String(t||'0').split(':').map(Number);return p.length===3?p[0]*3600+p[1]*60+p[2]:p[0]*60+(p[1]||0)};
const url=m=>m?.url||'';
/* Links 的 value 允许用户只写 "github.com/xxx"（不带协议）。浏览器会把这种相对形式
   解析成站内路径 → 点击跳到 404。这里补全协议，保证「点击即跳转」始终指向外部站点。 */
const FF_absUrl=v=>{
  const s=String(v==null?'':v).trim();
  if(!s) return '';
  if(/^(https?:|mailto:|tel:)/i.test(s)) return s;
  if(/^\/\//.test(s)) return 'https:'+s;
  return 'https://'+s;
};
const fmt=t=>{const n=Number(t)||0;const h=Math.floor(n/3600),m=Math.floor(n%3600/60),s=Math.floor(n%60);return (h?String(h).padStart(2,'0')+':':'')+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0')};

/* =====================================================================
 * VE 共享：把 saved spacing / imgSizes 渲染成真实 DOM 上的 CSS。
 * 首页（草稿/已发布）与 Visual Editor 画布(?ve=1)共用同一套函数，
 * 保证「画布里调的间距/图片尺寸，保存后回到真实作品集一样生效」。
 * spacing 键 → 页面真实视觉空隙：
 *   topSpace      页面最上方（顶部栏下方）到正文内容之上
 *   heroNameGap   顶部眉标 → 姓名 之间的空隙（≥0，作用在眉标 margin-bottom 上）
 *   heroPad       正文（姓名/简介）到 hero 下方横线
 *   metaTop       横线 → Contact/技能 区块
 *   dirGap        目录(区块列表)上方
 *   entryGap      目录内各区块之间的间隔
 *   footerTop     页脚上方
 * ===================================================================== */
// 间距统一夹到 [0, SPACE_MAX]：负间距会让「下面这块内容往上盖住上面那块」，
// 用户看到的是"内容不见了 / 间距调了没反应"，极容易误判成功能坏了；
// 所以拖动端（startDrag / setSpacing）和渲染端（VE_buildSpacingCss）都兜这一道底。
const SPACE_MAX = 1000;
function VE_clampGap(v, dflt){
  const n = Number(v);
  if (!isFinite(n)) return (dflt == null ? 0 : dflt);
  return Math.max(0, Math.min(SPACE_MAX, Math.round(n)));
}
/* =====================================================================
 * Resume 弹窗：外框固定「吃满视口」（视觉占比要大），内容在框内按文件自身比例自适应。
 *   —— 为什么外框不按文件比例收窄？A4 竖版(1:1.414)在横向屏幕上按比例推宽度只会得到一条窄竖条，
 *      视觉占比小、正文读不动（这是实测反馈）。所以外框只跟视口走，任何文件类型都不被"框死"。
 *
 * 「整页」vs「适应宽度」：横向屏幕上这两个目标**物理上互斥**——
 *   整页看全 → A4 页面宽度只能 = 预览区高度 × 0.707（730px 高时约 490px），字必然小；
 *   字够大   → 页面按宽度铺满（约 1380px），高度就超出，必须上下滚动。
 *   实测（本机 Edge，同一 URL 用【全新 iframe】加载，1380×801）：
 *     地址带 `#view=FitH`  → 适应宽度（页面宽度铺满、字最大，可上下滚动）
 *     地址带 `#view=Fit`   → 整页适配（整个页面居中完整可见，两侧留灰边，不滚动）
 *     （`#zoom=page-fit` 同 `#view=Fit`；不带 fragment 的默认行为在 iframe 里不稳定，故不依赖）
 *   注意：只改 fragment 属"同文档跳转"，PDF 插件不会重新适配，**切模式必须换新 iframe 元素**。
 *   也验证过"收窄 iframe 宽度让查看器重新适配"——实测不生效（页面保持原缩放被裁切）。
 * ===================================================================== */
let ffResumeMode = (() => {        // 记住用户上次的选择：'width' 适应宽度 | 'page' 整页
  try { return localStorage.getItem('ffResumeMode') === 'page' ? 'page' : 'width'; } catch (_) { return 'width'; }
})();
/* 预览地址的 fragment：
 *   view=FitH → 适应宽度（字最大，可滚动）；view=Fit → 整页（一屏看全）
 *   toolbar=0 → 关掉浏览器自带的 PDF 工具条。那条上有「打印」「保存」，
 *               会让「创作者暂未允许下载」形同虚设（浏览者照样能存一份到本地）。
 *   实测（本机 Edge，同一 iframe 尺寸逐像素比对）：加上 &toolbar=0 之后
 *   view=FitH 仍渲染为适应宽度、view=Fit 仍渲染为整页 —— 不会互相干扰。 */
const FF_resumeSrc = (url, mode) => {
  if (!url || url.indexOf('#') >= 0) return url || '';
  const m = mode || ffResumeMode;
  return url + (m === 'page' ? '#view=Fit' : '#view=FitH') + '&toolbar=0';
};
function FF_resumeApplyFit(){
  const card = document.getElementById('resume-modal-card');
  const body = document.getElementById('resume-modal-body');
  if (!card || !body) return;
  const head = card.querySelector('.resume-modal-head');
  // 头部已禁止换行，高度与宽度无关，量到的就是稳定值；留 4px 余量防止 1px 边框挤出滚动条。
  const extra = (head && head.offsetHeight) ? head.offsetHeight : 50;
  const VW = window.innerWidth || 1280, VH = window.innerHeight || 800;
  // 外框：宽度吃满视口（上限 1440），高度吃满视口（扣掉头部）——始终"大"，与文件比例无关
  const w = Math.max(280, Math.min(Math.round(VW * 0.96), 1440));
  const h = Math.max(220, Math.round(VH * 0.95) - extra - 4);
  card.style.width = Math.round(w) + 'px';
  body.style.height = Math.round(h) + 'px';
  // 预览区：iframe 始终铺满（外框大 → 预览大）；「看整页 / 放大看字」由地址 fragment 决定。
  //   适应宽度 → `#view=FitH`（页面铺满宽度，字最大，可上下滚动）
  //   整页     → `#view=Fit`（查看器整页适配，整个页面居中完整可见）—— 两者都是显式 fragment，
  //              实测在 1380×801 的 iframe 里前者页宽铺满、后者两侧留灰边，语义确定。
  //   切模式必须**换一个全新的 iframe 元素**：只改 src 的 fragment 属"同文档跳转"，
  //   PDF 插件不会重新适配缩放（实测切了等于没切）；元素换新才是完整导航。
  const frame = body.querySelector('.resume-frame');
  if (!frame) return;
  const rz = window.__ffResume || {};
  if (!rz.url) return;
  const want = FF_resumeSrc(rz.url);
  if (frame.getAttribute('src') !== want) {
    const fresh = frame.cloneNode(false);
    fresh.setAttribute('src', want);
    frame.parentNode.replaceChild(fresh, frame);
  }
}
/* 下载 Resume 原文件。
 * 走过的三个坑（都实测过）：
 * ① 裸 <a download>：被浏览器的"下载接管"扩展（迅雷下载支持、百度网盘、夸克等）抢走，
 *    在下载目录落一个 .tmp / 半截文件，用户拿到一个打不开的"失败文件"，全程没有任何提示。
 * ② fetch→Blob→objectURL 再点 <a download>：在干净的浏览器里完全正常（实测落盘 364166 字节、
 *    与磁盘文件 md5 一致），但下载接管类扩展连 blob: 下载也会拦，照样留下 .tmp。
 * ③ 所以正路是**压根不走浏览器的下载队列**：优先用 File System Access API
 *    （window.showSaveFilePicker）弹系统"另存为"，拿到文件句柄后把字节直接写进去 ——
 *    扩展拦的是浏览器下载项，拦不到这条路径。不支持该 API 时才退回 ②。
 * 另外：先把文件 fetch 成完整 Blob 并校验（PDF 看 %PDF 头），拿不到完整数据就明确报错，
 * 绝不静默存一个坏文件。 */
async function FF_resumeDownload(url, name, btn){
  const orig = (btn && btn.textContent) ? btn.textContent : '下载文件';
  const say = (t) => { if (btn) btn.textContent = t; };
  const done = (t) => { say(t); setTimeout(() => say(orig), 2600); };
  const isPdf = /\.pdf$/i.test(String(name || url));
  let handle = null;
  try {
    // 第一步就必须弹「另存为」：showSaveFilePicker 要求"用户手势"，
    // 放在 await fetch 之后会因手势过期而抛 NotAllowedError。
    if (window.showSaveFilePicker) {
      try {
        handle = await window.showSaveFilePicker({
          suggestedName: name || 'resume',
          types: isPdf ? [{ description:'PDF 文档', accept:{ 'application/pdf':['.pdf'] } }] : undefined
        });
      } catch (e) {
        if (e && e.name === 'AbortError') { return; }   // 用户自己取消了，不是错误
        handle = null;                                   // 被策略禁用/不支持 → 退回浏览器下载
      }
    }
    say('正在准备…');
    const res = await fetch(url, { cache:'no-store', credentials:'same-origin' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    if (!blob.size) throw new Error('文件为空');
    if (isPdf) {
      // PDF 头校验：半截文件在这里就能发现，不会变成一个"打不开的文件"
      const head = String.fromCharCode.apply(null, new Uint8Array(await blob.slice(0, 5).arrayBuffer()));
      if (head.indexOf('%PDF') !== 0) throw new Error('文件内容不完整');
    }
    if (handle) {
      const w = await handle.createWritable();
      try { await w.write(blob); await w.close(); }
      catch (e) { try { await w.abort(); } catch (_) {} throw e; }
      done('已保存到指定位置');
    } else {
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl; a.download = name || 'resume'; a.style.display = 'none';
      document.body.appendChild(a); a.click(); a.remove();
      // 不立刻 revoke：某些浏览器的"另存为"对话框是异步的，过早释放会让它拿到空文件
      setTimeout(() => { try { URL.revokeObjectURL(objUrl); } catch (_) {} }, 60000);
      done('已开始保存…');
    }
  } catch (err) {
    console.warn('[Resume] 下载失败', err);
    done('下载失败，请重试');
  }
}

function VE_buildSpacingCss(sp){
  if (!sp || typeof sp !== 'object') return '';
  const css = [];
  if (sp.topSpace != null) css.push(`.top{padding-bottom:${VE_clampGap(sp.topSpace,0)}px !important}`);
  // 「眉标 → 姓名」：眉标和姓名算作一体的一块内容，所以这根杆控制的是
  // 眉标自身下方的间距（眉标 margin-bottom），而不是用负 margin 把两块叠在一起。
  // 历史数据里 heroNameGap 可能是负数（用来把眉标往名字上压），这里夹到 ≥0，
  // 保证眉标永远在姓名上方、两者作为一个整体随上方留白一起移动。
  if (sp.heroNameGap != null) css.push(`.hero .hero-text > .eyebrow{margin-bottom:${VE_clampGap(sp.heroNameGap,0)}px !important}`);
  // heroPad 是介绍文字与第一条横线（.hero-rule）之间的真实间距，不能为负。
  if (sp.heroPad != null) css.push(`.hero{padding-bottom:${VE_clampGap(sp.heroPad,0)}px !important}`);
  if (sp.metaTop != null) css.push(`.meta-band{margin-top:${VE_clampGap(sp.metaTop,0)}px !important}`);
  if (sp.dirGap != null) css.push(`.directory{margin-top:${VE_clampGap(sp.dirGap,0)}px !important}`);
  if (sp.entryGap != null) css.push(`.directory > .entry:not(:first-child){margin-top:${VE_clampGap(sp.entryGap,0)}px !important}`);
  // 页脚上方间距：负值会让 .footer 往上盖住 Resume，看起来像"间距调了没反应"，
  // 所以这里和拖动端一起保证 ≥0（老数据里的负值在渲染时被夹回来）。
  if (sp.footerTop != null) css.push(`.footer{margin-top:${VE_clampGap(sp.footerTop,0)}px !important}`);
  // 页脚下方留白 = 内容区域结束到页面画布底边的最小距离。
  // 它由排版编辑右侧的「页面高度与底部留白」控制，数据仍只存 design.spacing.footerBottom。
  const fbVal = (sp.footerBottom != null && Number.isFinite(Number(sp.footerBottom)))
    ? Math.max(0, Math.min(SPACE_MAX, Math.round(Number(sp.footerBottom))))
    : FOOTER_BOTTOM_FIXED;
  css.push(`:root{--ff-page-bottom:${fbVal}px}`);
  return css.join('\n');
}
// 页脚下方留白的**默认**值（px）。仅在用户从未拖过底部杆时使用。
// 与页面顶部留白(topSpace 默认 75)对称，取中等距离。
const FOOTER_BOTTOM_FIXED = 75;
function VE_applySpacingToDom(sp){
  const css = VE_buildSpacingCss(sp);
  if (!css) { document.getElementById('ve-spacing-style')?.remove(); return; }
  let st = document.getElementById('ve-spacing-style');
  if (!st){ st = document.createElement('style'); st.id='ve-spacing-style'; document.head.appendChild(st); }
  st.textContent = css;
  window.dispatchEvent(new CustomEvent('ve-layout-change'));
}
/* —— 文本样式（字号/粗细/颜色/对齐/行高/字距）——
 * 按 data-field 路径存，画布与真实作品集共用同一套应用函数，保证所见即所得。
 * 例：{ "profile.name": { fontSize:"72px", textAlign:"center" } }
 */
const VE_TEXT_PROPS = ['fontSize','fontWeight','color','textAlign','lineHeight','letterSpacing','fontStyle','textTransform','textDecoration','backgroundColor'];
function VE_applyTextStyles(map){
  if (!map || typeof map !== 'object') return;
  Object.entries(map).forEach(([path, st]) => {
    if (!path || !st || typeof st !== 'object') return;
    const els = document.querySelectorAll(`[data-field="${String(path).replace(/"/g, '\\"')}"]`);
    els.forEach(el => {
      VE_TEXT_PROPS.forEach(p => {
        if (st[p] == null || st[p] === '') el.style.removeProperty(p.replace(/[A-Z]/g, m => '-' + m.toLowerCase()));
        else el.style.setProperty(p.replace(/[A-Z]/g, m => '-' + m.toLowerCase()), st[p], 'important');
      });
    });
  });
}

// 把「局部选中文字」产生的内联 HTML 应用到对应字段（data-field[data-single]）。
// design.inlineStyles[path] 存的是该字段编辑后的 innerHTML（含 <b>/<span style> 等），
// 渲染时直接用 innerHTML 注入，避免被 esc() 转义。普通无标记字段仍走 esc(plain)。
function VE_applyInlineHtml(){
  const map = window.__veInlineStyles || {};
  if (!map || typeof map !== 'object') return;
  document.querySelectorAll('[data-field][data-single]').forEach(el => {
    const p = el.getAttribute('data-field');
    if (map[p]) el.innerHTML = map[p];
  });
}

// ================= 自由图片层（Design.images）=================
// 数据模型 v2（带区块锚点，展示页与画布一致，不会再出现「奇怪位置」）：
//   { id, src, section:'works'|'about'|'experience'|'showreel'|'aiVoices'|'hero'|'', xPct, dy, wPct, aspect }
// ===== 自由图片锚点模型（v3，2026-09-14）=====
// 核心改动：自由图片「属于」落点所在的最近容器（区块 / 子项），渲染时作为该容器的子层 ——
// 因此随容器一起展开/收起（折叠态自动隐藏），在作品集展示页也只有「展开到对应层级」后才看得见
// （满足：放在 Experience › 示例公司下 → 展开示例公司才显示）。
// 锚点字段（存 design.images[]）：
//   aKind:   'page' | 'hero' | 'section' | 'item' | 'tail'
//   aSection:顶层区块 key（section/item 用），如 'experience'
//   aItem:   子项 [data-ve-item] 值（item 用），如 'experience.2'
//   aLabel:  人类可读名称（工具条展示）
// 坐标：xPct / yPct 都是「占容器宽度」的比例（横纵都按宽折算，规避画布 1280 缩放导致错位）；
//        wPct 占容器宽；height = w / aspect。画布与展示页算出来是同一相对位置。
// 特殊情形：
//   · hero（形象区）不属于任何层级 → 顶部常显，无需展开
//   · tail（目录与脚页之间）不属于任何区块 → 固定在间隙，AI Project 展开时随目录/脚页下移，不覆盖内容
let __freeMigrated = false;
function cssEsc(s){ return (window.CSS && CSS.escape) ? CSS.escape(String(s||'')) : String(s||'').replace(/"/g,'\\"'); }
function freeSecTitle(k){ const t = document.querySelector('[data-section="' + cssEsc(k) + '"] .entry-title'); return t ? t.textContent.trim() : ''; }
// 自由图片落盘：仅当 VE 父窗口存在（window.__veApi）时才持久化，避免普通展示页误改 design。
function commitFreeImages(){
  if (window.__veApi && window.__veApi.post){ window.__veApi.post({ type:'ve-commit-images', images: window.__veImages }); }
}
// 根据「锚点描述」解析出运行时容器元素
function freeContainerFor(desc){
  const kind = (desc && desc.aKind) || 'page';
  if (kind === 'hero') return document.querySelector('.hero') || document.querySelector('.shell');
  if (kind === 'section'){
    const sel = '[data-section="' + cssEsc(desc.aSection || '') + '"]';
    return document.querySelector(sel + ' .entry-panel') || document.querySelector(sel) || document.querySelector('.shell');
  }
  if (kind === 'item'){
    const el = document.querySelector('[data-ve-item="' + cssEsc(desc.aItem || '') + '"]');
    if (el) return el;
    if (desc.aSection) return freeContainerFor({ aKind:'section', aSection: desc.aSection });
    return document.querySelector('.shell');
  }
  if (kind === 'tail') return ensureTailZone();
  return document.querySelector('.shell');
}
function freeContainerEl(im){ return freeContainerFor({ aKind:(im&&im.aKind)||'page', aSection:(im&&im.aSection)||'', aItem:(im&&im.aItem)||'' }); }
/* ===== 区域身份严格解析（2026-09-26 自由图跳区域修复）=====
 * 用户要求（原文）：「一张自由摆放图片一旦属于某个区域，aKind/aSection/aItem 必须保持；
 * 拖动只改变它在当前所属区域中的位置和尺寸；onMove/onResize/onUp/relayout/refresh/save
 * 都不能偷偷重新判断所属区域；刷新后必须回到保存的所属区域。」
 * ⚠⚠ BUG 根因：freeContainerFor 在锚点元素解析不到时**逐级降级**（item → section → .shell）。
 *   区块被隐藏 / 内容还没渲染出来时，AI 项目 1 的图会被挂到「整页」浮层 —— 视觉上跑到别的
 *   区域；更糟的是此时任何坐标采样都会拿 .shell 当参照系（比 AI 卡片宽得多），把 xPct/yPct
 *   写成一套完全错误的值并落盘，区块恢复可见后图就永远停在错误位置 —— 即用户说的「跳区域」。
 * 修法：渲染 / 采样一律走 freeResolveContainer —— **解析不到就返回 null，绝不降级到别的区域**。
 *   这类图进入「待定区」（隐藏暂存），等锚点元素回到 DOM 再自动挂回原区域（见 freeRetryPending）。 */
function freeResolveContainer(im){
  const kind = (im && im.aKind) || 'page';
  if (kind === 'item'){
    const key = im.aItem || '';
    // ⚠ 锚点子项不在 DOM（所属区块被隐藏 / 内容尚未渲染）→ 不渲染到别处，返回 null。
    return key ? document.querySelector('[data-ve-item="' + cssEsc(key) + '"]') : null;
  }
  if (kind === 'section'){
    const key = im.aSection || '';
    if (!key) return null;
    const sec = document.querySelector('[data-section="' + cssEsc(key) + '"]');
    if (!sec) return null;
    return sec.querySelector('.entry-panel') || sec;
  }
  if (kind === 'hero') return document.querySelector('.hero') || null;
  if (kind === 'tail') return ensureTailZone();
  return document.querySelector('.shell');   // 'page' 是合法归属，整页浮层就是它的家
}
// 锚点暂时解析不到的自由图暂存处：不可见，且**绝不是任何真实区域**（不会污染坐标参照系）。
function freePendingZone(){
  let z = document.querySelector('.ve-free-pending');
  if (!z){
    z = document.createElement('div');
    z.className = 've-free-pending';
    z.style.cssText = 'position:absolute;left:-99999px;top:-99999px;width:0;height:0;overflow:hidden;pointer-events:none';
    const shell = document.querySelector('.shell') || document.body;
    shell.appendChild(z);
  }
  return z;
}
let _freePendingTimer = null;
// 锚点元素回到 DOM（区块恢复可见 / 内容渲染完成）后，把待定图重新挂回原区域。
function freeRetryPending(){
  if (_freePendingTimer) return;
  let n = 0;
  _freePendingTimer = setInterval(() => {
    n += 1;
    const pending = (window.__veImages || []).some(im => im && !im.inplace && !freeResolveContainer(im));
    if (!pending || n > 80){ clearInterval(_freePendingTimer); _freePendingTimer = null; return; }
    VE_renderFreeLayer();
  }, 250);
}
// 整页尾部间隙（目录与脚页之间）的容器：按需创建，置于 .directory 之后、.resume/.footer 之前
function ensureTailZone(){
  let z = document.querySelector('.ve-tail-zone');
  if (z) return z;
  const dir = document.querySelector('.directory');
  if (!dir) return document.querySelector('.shell');
  z = document.createElement('div'); z.className = 've-tail-zone'; z.style.position = 'relative';
  dir.insertAdjacentElement('afterend', z);
  return z;
}
// 量浮层宽度：容器折叠（display:none）或页面还没布局时按 0 处理 —— **绝不兜底成 1**。
function freeLayerWidth(layer){ const r = layer && layer.getBoundingClientRect(); return r && r.width > 1 ? r.width : 0; }
/* 给一张自由图写几何。
 * ⚠ 2026-09-23 修的真 bug（用户：「编辑一半没保存就刷新，排版编辑里再也找不到这张图的痕迹了，
 *   但右侧 Edited Media 总导览里还能看到、还能删」）：
 *   区块折叠时容器宽度是 0，而 freeAnchoredRect 里写了 Math.max(1, lw) 兜底 —— 于是
 *   left/top/width/height 全被写成 0.25px 这种「元素在 DOM 里、用户完全看不见」的值，
 *   并且**再也没有任何代码会重算它**（只有拖拽/缩放才重算）。
 *   现在：量不出来就先按百分比摆（布局一好就是对的），并让容器尺寸一变就回来补像素值。 */
function applyFreeGeom(img, im, layer){
  const lw = freeLayerWidth(layer);
  if (!lw){
    img.dataset.ffUnmeasured = '1';
    // ⚠⚠ BUG-6（2026-09-26 人工回归，实测复现）：容器量不出宽度（区块折叠 / details 未展开 /
    // 容器 display:none）时，旧实现在这里写 **style.top = '0px'** —— 纵向坐标当场归零。
    // 用户看到的就是「鼠标还按着没松手，图片突然自己跳到所属区域的最顶端」；更糟的是这个 0
    // 会被之后每一处按 getBoundingClientRect 反算的逻辑当成既有几何读走，原位置再也回不来
    // （实测：折叠→再展开后，图停在 T=0 且 invisible，data-ff-unmeasured 一直带着）。
    //   现在：已经精确定位过的元素**原样保留行内几何**，等 freeWatchContainer 量到宽度再补
    //   （数据里的 xPct/yPct 才是真相，随时能按百分比重算）；只有从未定位过的元素才落到 0 点。
    if (img.style.left && img.style.top && img.style.width) return null;
    // 挂在浮层里的副本：百分比相对浮层宽度，先按百分比摆，布局一好就补像素。
    // 原地（不搬家）的原图：它的 offsetParent 未必是浮层，百分比没有意义 → 先摆到 0 点，
    // 由 freeWatchContainer 一量到宽度就补成精确像素（绝不会出现 0.25px 的幽灵元素）。
    const direct = img.parentElement === layer;
    img.style.left = direct ? ((im.xPct != null ? im.xPct : 0.3) * 100) + '%' : '0px';
    // yMode:'h' 的记录 top% 相对浮层高（absolute 定位 top% 的原生语义），与精确路径一致。
    img.style.top = (direct && im.yMode === 'h' && freeYModeH(im) && im.yPct != null) ? (im.yPct * 100) + '%' : '0px';
    img.style.width = ((im.wPct != null ? im.wPct : 0.24) * 100) + '%';
    img.style.height = 'auto';
    return null;
  }
  if (img.dataset.ffUnmeasured) delete img.dataset.ffUnmeasured;
  const r = freeAnchoredRect(im);
  freePlaceEl(img, r, layer);
  return r;
}
/* 把「相对所属容器浮层」的目标矩形写成元素的行内几何。
 * 副本（.ve-free-img）本来就是浮层的直接子节点 → 直接用浮层局部坐标。
 * 「原图原地自由摆放」时元素仍留在原处（媒体栏 / 正文 / AI 卡片里），它的 offsetParent
 * 不一定是浮层，所以按「视口坐标」折算：目标视口位置 − offsetParent 视口位置（再扣边框宽）。
 * 这样无论中间隔了多少层 position:relative，落点都精确。 */
function freePlaceEl(el, r, layer){
  el.style.position = 'absolute';
  el.style.margin = '0';
  if (el.parentElement === layer){
    el.style.left = r.left + 'px';
    el.style.top = r.top + 'px';
  } else {
    const off = el.offsetParent;
    if (!off) return;
    const or = off.getBoundingClientRect();
    const cs = getComputedStyle(off);
    const bl = parseFloat(cs.borderLeftWidth) || 0;
    const bt = parseFloat(cs.borderTopWidth) || 0;
    const lr = layer.getBoundingClientRect();
    el.style.left = (lr.left + r.left - or.left - bl) + 'px';
    el.style.top = (lr.top + r.top - or.top - bt) + 'px';
  }
  el.style.width = r.width + 'px';
  el.style.height = r.height + 'px';
}
/* 清掉「原地自由摆放」的行内几何，让这张图回到普通排版。
 * 只在原图（data-ff-free）上调用 —— 副本要整块删掉，不能只清样式。 */
function unfreeElement(el){
  if (!el || !el.removeAttribute) return;
  el.removeAttribute('data-ff-free');
  el.removeAttribute('data-ve-img');
  el.removeAttribute('data-ff-unmeasured');
  if (el.classList) el.classList.remove('ve-free-img', 've-size-target', 've-el-selected');
  ['position', 'left', 'top', 'width', 'height', 'margin'].forEach(p => el.style.removeProperty(p));
}
let _freeLayerObserver = null;
// 容器尺寸一变（区块展开 / 窗口缩放 / 字体加载完）就回来把「没量出来」的那些图补上像素值。
function freeWatchContainer(layer){
  if (!layer || typeof ResizeObserver !== 'function') return;
  if (!_freeLayerObserver){
    _freeLayerObserver = new ResizeObserver(entries => {
      entries.forEach(e => { if (e.contentRect && e.contentRect.width > 1) refitFreeInLayer(e.target); });
    });
  }
  try { _freeLayerObserver.observe(layer); } catch (_) {}
  // ResizeObserver 只在「尺寸变化」时回调；容器可能在我们观察之前就已经有尺寸了，补两次手动重算。
  setTimeout(() => refitFreeInLayer(layer), 60);
  setTimeout(() => refitFreeInLayer(layer), 500);
}
/* 一个自由元素（副本或原图）对应的「记录 + 参照浮层」。
 * 两类元素都带 data-ve-img = 记录 id；原图额外带 data-ff-free 且记录里有 inplace:true。 */
function freeGeomOfEl(el){
  if (!el || !el.getAttribute) return null;
  const id = el.getAttribute('data-ve-img');
  if (!id) return null;
  const im = (window.__veImages || []).find(x => x && x.id === id);
  if (!im) return null;
  // 待定态（所属区域暂时不在 DOM）：没有任何合法参照系 → 不可拖动/缩放/采样。
  if (el.hasAttribute('data-ff-pending')) return null;
  if (el.hasAttribute('data-ff-free')){
    // ⚠ 区域身份：严格解析，解析不到就没有可用参照系（调用方必须放弃采样/拖动）。
    const c = freeResolveContainer(im);
    return c ? { im, layer: ensureFreeLayer(c) } : null;
  }
  const par = el.parentElement;
  return { im, layer: (par && par.classList && par.classList.contains('ve-free-layer')) ? par : el.offsetParent };
}
function refitFreeInLayer(layer){
  if (layer && !freeLayerWidth(layer)) return;
  // 拖拽 / 缩放进行中不动手：否则用户正拖着图，观察器一触发就把图弹回保存值。
  if (typeof _veFreeDragBusy !== 'undefined' && _veFreeDragBusy) return;
  /* 副本和「原地自由摆放的原图」都要补 —— 后者未必在浮层里（它还在媒体栏/正文原来的位置上），
   * 所以按 data 属性全文档扫，而不是只扫某一个浮层的子节点。
   * ⚠ 2026-09-28 穿模修复：只补「没量出来」的（data-ff-unmeasured）已经不够。
   *   C 区项目是 <details>，折叠时浮层**有宽没高**（实测 1239×0）—— 那一帧算出的几何
   *   （旧实现 = 整张图原尺寸，收口后 = 被压成 1×1）在展开后**没有任何东西会重算**，
   *   图就一直停在旧尺寸上。所以只要参照浮层能量出宽度，就按 design 数据整体重算一遍
   *   （数据才是真相，重算是幂等的）。 */
  document.querySelectorAll('.ve-free-img, [data-ff-free]').forEach(el => {
    const g = freeGeomOfEl(el);
    if (g) applyFreeGeom(el, g.im, g.layer);
  });
  // 手柄位置依赖元素的 offsetLeft/Top，补完尺寸要重新接线（画布内才有接线函数）。
  if (typeof window.__veWireFree === 'function') { try { window.__veWireFree(); } catch (_) {} }
}

// 在容器里确保一个绝对定位浮层（覆盖容器 padding box）
function ensureFreeLayer(container){
  if (!container) return document.querySelector('.shell');
  // ⚠⚠ 区域身份（2026-09-26 收尾轮实锤 BUG）：旧写法 container.querySelector('.ve-free-layer')
  //   **会搜到后代里别的区域的浮层**。整页（.shell）容器里若已有 AI 卡片 / 区块的浮层，
  //   整页图就被「吸收」进那张卡片的浮层里 —— 这就是用户看到的「图跑到别的区域」的另一半根因
  //   （区块级图同理：entry-panel 会命中它内部子项的浮层）。
  //   浮层必须是容器的**直接子节点**，每个区域只允许有自己的那一层。
  let l = null;
  for (let i = 0; i < container.children.length; i++){
    const c = container.children[i];
    if (c.classList && c.classList.contains('ve-free-layer')){ l = c; break; }
  }
  if (!l){ l = document.createElement('div'); l.className = 've-free-layer'; container.appendChild(l); }
  container.classList.add('ve-host');
  return l;
}
function freeItemLabel(node){
  if (!node) return '';
  const t = node.querySelector('.exp-company, .project-head h4, .ai-project-card h3, .sr-head, .entry-title');
  return t ? t.textContent.trim().slice(0, 28) : (node.getAttribute('data-ve-item') || '');
}
/* 自由图片工具条上的「所属」文案：按锚点结构派生 + 运行时翻译。
 * ⚠ 绝不返回 it.aLabel —— 那是插入图片那一刻写死并存进 design.json 的中文
 *   （'整页' / 'Hero（形象位）' / '目录与脚页之间'）。用户在英文界面下会看到它原样冒出来。 */
function veFreeAnchorLabel(it){
  const k = it && it.aKind;
  if (!k) return (it && it.aLabel) || ffZ('整页（自由浮层）');
  if (k === 'hero') return ffZ('顶部形象区');
  if (k === 'tail') return ffZ('目录与脚页之间');
  if (k === 'section') return freeSecTitle(it.aSection) || it.aSection || ffZ('区块');
  if (k === 'item'){
    const p = String(it.aItem || '');
    const sm = p.match(/^([A-Za-z][\w-]*)\./);
    const sec = it.aSection || (sm ? sm[1] : '');
    const im = p.match(/\.(\d+)(?:$|\.)/);
    const nm = sec ? freeSecTitle(sec) : '';
    if (nm) return im ? nm + ' · ' + (Number(im[1]) + 1) : nm;
    return p || ffZ('子项');
  }
  return ffZ('整页（自由浮层）');
}
// 给定视口坐标，返回落点所属锚点（最深：item > section > hero；目录之下→tail；其余→page）
function freeAnchorFromClientPoint(cx, cy){
  const stack = document.elementsFromPoint ? (document.elementsFromPoint(cx, cy) || []) : [];
  const hit = stack.find(n => n && n.nodeType === 1 && n.closest && !n.closest('.ve-free-layer'));
  if (!hit) return { aKind:'page', aSection:'', aItem:'', aLabel:'整页' };
  const itemSel = 'details.experience-item, details.project, details.works-group, article.ai-project-card, div.showreel-project';
  const item = hit.closest ? hit.closest(itemSel) : null;
  if (item){
    const secEl = item.closest('[data-section]');
    return { aKind:'item', aItem: item.getAttribute('data-ve-item')||'', aSection: secEl ? secEl.getAttribute('data-section') : '', aLabel: freeItemLabel(item) };
  }
  const sec = hit.closest('[data-section]');
  if (sec) return { aKind:'section', aSection: sec.getAttribute('data-section'), aItem:'', aLabel: (sec.getAttribute('data-section')||'') };
  if (hit.closest('.hero')) return { aKind:'hero', aSection:'', aItem:'', aLabel:'Hero（形象位）' };
  const dir = document.querySelector('.directory');
  if (dir){ const dr = dir.getBoundingClientRect(); if (cy > dr.bottom) return { aKind:'tail', aSection:'', aItem:'', aLabel:'目录与脚页之间' }; }
  return { aKind:'page', aSection:'', aItem:'', aLabel:'整页' };
}
// 旧数据（v1 绝对坐标 / v2 整页锚点）就地迁移成 v3「整页锚点（page）」。
// 旧图在编辑器里是「折叠态」下取的布局，区块 Rect 不可信；统一锚到整页最安全，
// 画布与展示页结构一致、位置不跳变。（⚠ 2026-09-26 起拖动不再按落点重锚 —— 所属区域绑定，
// 拖动只在自己区域内移动；想换区域用媒体项上的「自由摆放」重新定锚。）
function freeMigrate(imgList){
  if (__freeMigrated || !Array.isArray(imgList) || !imgList.length) return false;
  const shell = document.querySelector('.shell');
  if (!shell) return false;
  const sr = shell.getBoundingClientRect();
  const sw = Math.max(1, sr.width), sh = Math.max(1, sr.height);
  let changed = false;
  imgList.forEach(im => {
    if (!im || !im.id) return;
    if (im.aKind) return; // 已是 v3
    const ax = (im.x != null) ? im.x : (im.xPct != null ? im.xPct * sw : sw * 0.4);
    const ay = (im.y != null) ? im.y : (im.yPct != null ? im.yPct * sh : sh * 0.4);
    const w = im.w || 200, h = im.h || w;
    im.aKind = 'page'; im.aSection = ''; im.aItem = ''; im.aLabel = '整页';
    im.xPct = Math.max(-0.2, Math.min(3, ax / sw));
    im.yPct = Math.max(-0.2, Math.min(4, ay / sh));
    im.wPct = Math.max(0.02, Math.min(3, w / sw));
    im.aspect = h > 0 ? w / h : 1;
    delete im.x; delete im.y; delete im.dy; delete im.hPct; delete im.section;
    changed = true;
  });
  if (changed){ __freeMigrated = true; commitFreeImages(); }
  return changed;
}
// 计算自由图片相对其容器浮层的矩形（x/宽按容器宽折算；y 按「yMode」折算，见 freeYModeH）
/* ===== y 轴折算基准（2026-09-27 穿模修复）=====
 * 用户报障：「VE 里放在 AI Project 1 的图，保存后作品集里穿模、位置也不一样。」
 * 实测根因：yPct 旧语义按**容器宽**折算（top = yPct × 宿主宽），但内容卡片的高度
 * 不随宽度线性增长 —— VE 桌面画布宿主 1111px / 作品集面板 1271px（宽 ×1.14），
 * 宿主高反而 417→389px，top=350px 已逼近宿主底 389px，图片下半截悬出卡片、
 * 压住下一个项目；窗口越宽漂得越狠（发布版访客宽屏同样穿模）。
 * 修法：内容类归属（section/item/hero）的 y 改按**宿主高度**折算（记录 yMode:'h'），
 * x/w 保持按宽（横向内容随宽线性缩放成立）；tail（间隙高度由图撑起，按高折算会
 * 循环依赖）与 page（整页锚点、宽度稳定）保持按宽。旧记录在渲染时做「同帧像素
 * 不变」的自动升级（见 VE_renderFreeLayer），拖拽/缩放/新建/自由摆放采样一律按新语义写。 */
function freeYModeH(im){
  const k = (im && im.aKind) || 'page';
  return k === 'section' || k === 'item' || k === 'hero';
}
function freeYBase(im, lw, lh){ return (freeYModeH(im) && im.yMode === 'h') ? lh : lw; }
function freeAnchoredRect(im){
  const c = freeContainerEl(im);
  const layer = ensureFreeLayer(c);
  const lr = layer.getBoundingClientRect();
  const lw = Math.max(1, lr.width);
  const lhRaw = lr.height;
  const lh = Math.max(1, lhRaw);
  const yBase = freeYBase(im, lw, lh);
  let w = (im.wPct != null ? im.wPct : 0.24) * lw;
  let h = im.aspect ? w / im.aspect : w;
  /* ===== 区域收口（2026-09-28 穿模修复）：自由图绝不画到所属区域之外 =====
   * 用户原话：「它既然归属于所属到某一个区域内，那它就不能再穿模延伸到下面去。」
   * 实测根因：排版编辑画布是 1280 固定设计稿（缩放到面板显示），作品集页按**窗口实宽**排版。
   *   同一区域在两端的宽高比不同（AI 项目卡片：画布 1111×390 → 展示页 1271×362）。
   *   而自由图的尺寸按**容器宽**定（w = wPct×lw，h = w/aspect）、纵向位置按**容器高**定，
   *   于是宽窗口下图片会长出区域底部、压住下一个项目 —— 窗口越宽越穿模。
   * 修法：渲染时按区域盒**等比收口**（保住长宽比，整张图仍完整可见），再把位置夹进区域；
   *   只改渲染结果、不改 design 数据，画布与展示页共用同一套规则 → 两端语义一致。
   * ⚠ tail（目录与脚页之间）的高度正是由图本身撑起来的（见 VE_renderFreeLayer 里
   *   tz.style.minHeight = tailBottom），对它收口会循环依赖把图压成 0 —— 必须跳过。 */
  // ⚠ 层高必须是「真量出来的」：C 区项目是 <details>，折叠时浮层**有宽没高**（实测 1239×0），
  //   拿 lh=1 去收口会把图压成 1×1、展开后还停在那个尺寸（见 refitFreeInLayer）。
  //   区域还没真正显示 → 不收口，保持原尺寸，等它显示出来由观察器按新尺寸重算。
  const fitInside = (im.aKind || 'page') !== 'tail' && lhRaw > 1;
  if (fitInside){
    if (w > lw){ const k = lw / w; w = lw; h *= k; }
    if (h > lh){ const k = lh / h; h = lh; w *= k; }
  }
  let left = (im.xPct != null ? im.xPct : 0.3) * lw;
  let top  = (im.yPct != null ? im.yPct : 0.1) * yBase;
  if (fitInside){
    left = Math.max(0, Math.min(lw - w, left));
    top  = Math.max(0, Math.min(lh - h, top));
  }
  return { left, top, width: w, height: h };
}
// 从元素当前位置反算 v3 字段（拖拽 / 缩放后调用）。坐标相对「所在容器浮层」。
function freeStateFromEl(im, el){
  // ⚠ 区域身份（2026-09-26）：所属区域解析不到（锚点元素不在 DOM）时**放弃采样** ——
  //   此时任何参照系都是错的，写下去就是把图坐标改成别的地方（跳区域的数据来源）。
  const c = freeResolveContainer(im);
  if (!c) return;
  const layer = ensureFreeLayer(c);
  const lr = layer.getBoundingClientRect();
  const lw = Math.max(1, lr.width);
  const er = el.getBoundingClientRect();
  // ⚠ 防数据自毁闸（2026-09-25 人工回归审计）：图片尚未加载完成 / 元素不可见时
  // getBoundingClientRect 全是 0，旧逻辑会把 (0,0,wPct=0.02,aspect=1) 这种坏坐标
  // clamp 出来并经 commitImages 落盘，覆盖用户真实的自由摆放位置（表现为图缩在
  // 左上角、拖不动）。这里在不可测量时直接放弃采样，保持原记录不变。
  if (!(er.width > 1) || !(er.height > 0)) return;
  im.aKind = im.aKind || 'page';
  // y 轴（2026-09-27 穿模修复）：内容类归属按宿主高折算并标记 yMode:'h'，tail/page 保持按宽。
  const _yModeH = freeYModeH(im);
  const _yBase = _yModeH ? Math.max(1, lr.height) : lw;
  im.xPct = Math.max(-0.5, Math.min(3, (er.left - lr.left) / lw));
  im.yPct = Math.max(-0.5, Math.min(4, (er.top - lr.top) / _yBase));   // 内容卡片按高、其余按宽
  im.wPct = Math.max(0.02, Math.min(3, er.width / lw));
  im.aspect = er.height > 0 ? er.width / er.height : 1;
  if (_yModeH) im.yMode = 'h';
  delete im.x; delete im.y; delete im.dy; delete im.hPct; delete im.section;
}
/* ===== 原图「原地自由摆放」（2026-09-23 用户第 ⑤ 项）=====
 * 用户原话：「我点完自由摆放之后，它会重新生成一个图……按道理你自由摆放的话，应该就是本身
 * 的那个图片可以变成自由摆放的模式啊。」
 * 所以：记一条 inplace:true 的记录，sourcePath = 这张图自己的键（媒体项 key / 内容路径），
 * 渲染时**不克隆、不隐藏**，直接把那张已经存在的元素原地绝对定位。
 * 元素上打 data-ff-free + data-ve-img(=记录 id)，于是拖动 / 缩放 / 吸附 / 落盘全部沿用
 * 自由层既有机制，一行都不用重写。 */
function freeOwnedEl(im){
  if (!im || !im.sourcePath) return null;
  const k = String(im.sourcePath).replace(/"/g, '\\"');
  return document.querySelector('[data-ve-media-item="' + k + '"]')
      || document.querySelector('[data-ve-media-path="' + k + '"]');
}
function placeOwnedFree(im){
  const el = freeOwnedEl(im);
  if (!el) return false;      // 原图已经不在内容里了（被删掉）→ 不渲染幽灵
  el.setAttribute('data-ff-free', '1');
  el.setAttribute('data-ve-img', im.id);
  el.classList.add('ve-free-img');
  // ⚠ 区域身份：严格解析，解析不到就保持原排版等锚点回来（绝不挂到别的区域去）。
  const c = freeResolveContainer(im);
  if (!c){ el.dataset.ffPending = '1'; freeRetryPending(); return true; }
  delete el.dataset.ffPending;
  const layer = ensureFreeLayer(c);
  applyFreeGeom(el, im, layer);
  if (!freeLayerWidth(layer)) freeWatchContainer(layer);
  return true;
}
// 渲染自由图片层：按锚点分组，每组在自己所属容器里放一个绝对浮层。
// 折叠态容器（display:none / details:not([open])）自动隐藏其子层 → 满足「展开层级才显示」。
function VE_renderFreeLayer(isEditor){
  try { freeMigrate(window.__veImages || []); } catch (_) {}
  const imgs = window.__veImages || [];
  // 记录已经没了（用户在右侧统筹区删了 / 恢复了常规摆放）→ 把原图的行内几何清干净，
  // 否则它会带着 position:absolute 一直飘着，看起来像「删不掉的东西」。
  document.querySelectorAll('[data-ff-free]').forEach(el => {
    const key = el.getAttribute('data-ve-media-item') || el.getAttribute('data-ve-media-path') || '';
    if (!imgs.some(i => i && i.inplace && i.sourcePath === key)) unfreeElement(el);
  });
  document.querySelectorAll('.ve-free-layer').forEach(l => l.remove());
  // 上一轮放进「待定区」的图先清掉，本轮重新按其真实归属分派。
  document.querySelectorAll('[data-ff-pending].ve-free-img').forEach(el => el.remove());
  const map = new Map();
  const pendings = [];
  imgs.forEach(im => {
    if (!im || !im.id || !im.src) return;
    if (im.inplace){ placeOwnedFree(im); return; }   // 原图自己变自由：不克隆
    // ⚠ 区域身份（2026-09-26）：严格解析所属区域。解析不到 → 进待定区隐藏，
    //   绝不降级挂到 section / 整页浮层（否则图会显示在别的区域，且坐标会被写坏）。
    const c = freeResolveContainer(im);
    if (!c){ pendings.push(im); return; }
    if (!map.has(c)) map.set(c, []);
    map.get(c).push(im);
  });
  if (pendings.length){
    const pz = freePendingZone();
    pendings.forEach(im => {
      const img = document.createElement('img');
      img.className = 've-free-img';
      img.src = im.src;
      img.setAttribute('data-ve-img', im.id);
      img.dataset.ffPending = '1';
      pz.appendChild(img);
    });
    freeRetryPending();
  }
  let tailBottom = 0;
  map.forEach((list, c) => {
    const layer = ensureFreeLayer(c);
    // 旧记录自动升级（2026-09-27 穿模修复）：yPct 旧语义按宽，这里量到真实几何后
    // 按「同帧像素不变」换算成按高（yPct × 旧基准宽 ÷ 宿主高），一次升级永久生效。
    // 展示页升级只改内存（commitFreeImages 有 __veApi 闸门），VE 里打开后落盘固化。
    let _upgraded = false;
    const _lr0 = layer.getBoundingClientRect();
    if (_lr0.width > 1 && _lr0.height > 1){
      list.forEach(im => {
        if (im && !im.yMode && freeYModeH(im) && im.yPct != null){
          im.yPct = im.yPct * _lr0.width / _lr0.height;   // 同帧像素不变，绝不 clamp
          im.yMode = 'h';
          _upgraded = true;
        }
      });
    }
    list.forEach(im => {
      const img = document.createElement('img');
      img.className = 've-free-img';
      img.src = im.src;
      img.setAttribute('data-ve-img', im.id);
      layer.appendChild(img);
      const r = applyFreeGeom(img, im, layer);
      if ((im.aKind || 'page') === 'tail' && r) tailBottom = Math.max(tailBottom, r.top + r.height);
    });
    // ⚠ 2026-09-28：所属区域「有宽没高」（C 区项目 <details> 折叠 → 浮层 1239×0）也要挂观察，
    //   否则项目展开后没有任何东西会按新区域尺寸重算自由图，图会一直停在折叠时的旧几何上。
    if (!freeLayerWidth(layer) || layer.getBoundingClientRect().height <= 1) freeWatchContainer(layer);
    if (_upgraded) commitFreeImages();
  });
  const tz = document.querySelector('.ve-tail-zone');
  if (tz) tz.style.minHeight = (tailBottom > 0 ? Math.ceil(tailBottom) : '') + 'px';
  // 接线函数 VE_wireFreeImages 定义在 initVEDirect 作用域内（依赖 selectElement/drag 等内部符号），
  // 模块级的 VE_renderFreeLayer 无法直接引用它；改为走 window.__veWireFree（由 VE_wireFreeImages 自身赋值）。
  // 展示页（非 ve 模式、initVEDirect 不运行）不接线，仅渲染可见即可。
  if (typeof window.__veWireFree === 'function') window.__veWireFree();
}

/* —— 画布宽度变了（手机 / 电脑预览互相切换）→ 自由摆放的图必须**按新宽度重算** ——
 * 2026-09-23 用户报的真 bug：「我在手机的这个预览版，我发现 AI Lab 底下的图片不见了」。
 * 根因：自由图的几何是「比例 × 浮层宽度」，而浮层宽度是渲染那一刻量的。
 * 从 1280 切到 390 之后没有任何代码重算 → 那块图带着 left:775px（1280 时代的值）
 * 停在 390 宽的画布外面，等于凭空消失。
 * ⚠ 这里**不能**依赖画布自己 window 的 resize 事件：画布 iframe 由父窗口改 style.width，
 *   真机上事件会来，但为了确定性，父窗口 fitCanvas() 会额外发一条 ve-relayout-free 指令。 */
let _veRelayoutTimer = null;
// ⚠ 2026-09-26 人工回归第 4 轮：自由图「正在被拖动 / 缩放」的标记。
// 背景（真人复现 + CDP 逐帧取证）：每次松手后，父窗口 visual-editor-fix.js 会
// setTimeout(fitCanvas,60) 与 (,600) 各来一次，fitCanvas 又无条件 post ve-relayout-free，
// 于是自由图层在松手后约 +130ms / +830ms 各整层重建一次；watchCanvasSize 的 800ms
// 轮询也会在长拖动途中触发。VE_renderFreeLayer 会把整个 .ve-free-layer 删掉重来，
// 若此刻用户正在拖（真人松手后 <0.8s 再抓非常常见），drag.el 立刻变成游离节点：
//   · onMove 把坐标写进游离节点 → 画面上的图不跟随，看上去「拖到一半跳回原位」
//   · onUp 量到的 rect 全 0 → 本次拖动被整段丢弃（实测 Δx=0.0‰）
// 这里不改动触发条件与任何数值计算，只把「重建」推迟到拖动结束之后。
// ⚠ 用 var 而不是 let：refitFreeInLayer（上面）会读它，而它有可能在模块求值完成前
//   就被 ResizeObserver / setTimeout 回调读到 —— let 会落进 TDZ 直接抛 ReferenceError。
//   var 会提升成 undefined，typeof 判断安全返回 false（= 不拦截），语义不受影响。
var _veFreeDragBusy = false;
function VE_relayoutFree(){
  clearTimeout(_veRelayoutTimer);
  // ⚠ 2026-09-26 人工回归：VE_renderFreeLayer(true) 会把整层自由图的 DOM 换掉，
  // 而这条指令在「点一下自由图 → 选中 → commitImages → 父窗口 fitCanvas」之后必然到达。
  // 结果就是：刚选中的节点被换掉，选中态与八向手柄一起消失 —— 用户体感
  // 「点一下图片像刷新了一次，选中没了，也没法改尺寸/位置」。
  // 这里不动触发条件（避免影响按新宽度/新高度重算几何），只在重建前记住选中的
  // 是哪一张，重建后原样选回来。
  const _keepSel = document.querySelector('.ve-free-img.ve-el-selected');
  const _keepId = _keepSel ? _keepSel.getAttribute('data-ve-img') : '';
  _veRelayoutTimer = setTimeout(function _relayoutNow(){
    // ⚠ 正在拖 / 正在缩放 → 绝不重建。整层重建会换掉 drag.el 指向的节点，
    // 让本次拖动整个失效（真人实测：松手后 80ms 再抓，Δx=0.0‰）。稍后重试即可，
    // 拖动结束的 onUp 本身就会 VE_renderFreeLayer() 刷新几何，不需要这里补。
    if (_veFreeDragBusy){ _veRelayoutTimer = setTimeout(_relayoutNow, 120); return; }
    try { VE_renderFreeLayer(true); } catch (_) {}
    try { refitFreeInLayer(); } catch (_) {}
    try { VE_layoutHeroPixel(); } catch (_) {}
    if (typeof window.__veWireFree === 'function') { try { window.__veWireFree(); } catch (_) {} }
    if (_keepId && typeof window.__veSelectFreeImg === 'function') {
      try { window.__veSelectFreeImg(_keepId); } catch (_) {}
    }
  }, 60);
}
// 读取元素当前的真实计算样式（供右侧工具箱回显）
function VE_readComputedStyle(el){
  if (!el) return null;
  const c = getComputedStyle(el);
  return {
    fontSize: c.fontSize,
    fontWeight: String(c.fontWeight || '400'),
    color: c.color,
    textAlign: c.textAlign || 'left',
    lineHeight: c.lineHeight,
    letterSpacing: c.letterSpacing,
    fontStyle: c.fontStyle || 'normal',
    textTransform: c.textTransform || 'none',
    textDecoration: c.textDecorationLine || c.textDecoration || 'none',
    backgroundColor: c.backgroundColor || '',
  };
}
// 读取「当前选区或整元素」的 inline 标记状态（B/I/U/color/backgroundColor/fontSize），
// 用于右侧按钮 on 状态显示。execCommand('bold') 是给文字包 <b>，原元素 computed fontWeight 不变，
// 所以光看 getComputedStyle 会误判为 false。这里同时看 innerHTML + 当前 selection 范围。
function VE_readInlineState(el){
  if (!el) return { bold:false, italic:false, underline:false, color:'', backgroundColor:'', fontSize:'', fontSizePx:0 };
  const html = el.innerHTML || '';
  // 默认目标就是 el 本身（fallback：selection 空时读父级 computed）
  let target = el;
  try {
    const s = window.getSelection();
    if (s && s.rangeCount && !s.isCollapsed && el.contains(s.anchorNode)){
      // 选区存在：把目标设为"选区起点 → 终点"中遇到的最近一个 inline 样式祖先
      // 关键：起点终点可能落在不同 span 内，取**靠近起点的祖先**
      let n = s.anchorNode;
      if (n && n.nodeType === 3) n = n.parentElement;
      while (n && n !== el){
        const tag = (n.tagName || '').toLowerCase();
        if (tag === 'b' || tag === 'strong' || tag === 'i' || tag === 'em' || tag === 'u' || tag === 'span' || tag === 'font'){ target = n; break; }
        n = n.parentElement;
      }
    } else {
      // selection 空（如刚点完工具按钮还没 cache 选区）：遍历 el 内所有 span/b/i/u/font，
      // 把"最近一次被应用样式的祖先"作为目标（取最后一个有 style/font-size/font-color 的）
      let last = null;
      el.querySelectorAll('b,strong,i,em,u,span,font').forEach(n => {
        const inline = (n.style && (n.style.fontSize || n.style.color || n.style.backgroundColor)) || (n.tagName === 'FONT' && (n.getAttribute('color') || n.size));
        if (inline) last = n;
      });
      if (last) target = last;
    }
  } catch(_){}
  const c = target ? getComputedStyle(target) : null;
  const hasTag = (re) => re.test(html);
  // 读 inline.style.fontSize 的精确值（px），不受父级继承影响
  let inlineFsPx = 0;
  if (target && target.style && target.style.fontSize){
    inlineFsPx = parseFloat(target.style.fontSize) || 0;
  }
  // 优先用 target 的 style.fontSize 明确值，否则 fallback 到 computedStyle
  const fontSizeVal = inlineFsPx ? (inlineFsPx + 'px') : (c ? c.fontSize : '');
  const inBoldTag = target && (target.tagName === 'B' || target.tagName === 'STRONG');
  const inItalicTag = target && (target.tagName === 'I' || target.tagName === 'EM');
  const inUnderTag = target && (target.tagName === 'U');
  const isBoldByWeight = c && (parseInt(c.fontWeight, 10) >= 600);
  const isItalicByStyle = c && (c.fontStyle === 'italic');
  const isUnderByDeco = c && /underline/.test(c.textDecorationLine || c.textDecoration || '');
  return {
    bold: !!(inBoldTag || hasTag(/<(b|strong)\b/i)),
    italic: !!(inItalicTag || hasTag(/<(i|em)\b/i)),
    underline: !!(inUnderTag || hasTag(/<u\b/i)),
    color: c ? c.color : '',
    backgroundColor: c ? c.backgroundColor : '',
    fontSize: fontSizeVal,
    fontSizePx: inlineFsPx || (c ? parseFloat(c.fontSize) || 0 : 0),
    isBoldByWeight, isItalicByStyle, isUnderByDeco,
  };
}
// 图片栏尺寸：imgSizes[path].widthPct 表示「媒体栏占整行业务宽度的百分比」，
// 直接作用在分栏栅格的 --pm-w 上（而不是给 <img> 一个百分比宽度）。
// 这样图片 / 视频 / 音频共用同一条宽度控制，窄画布与宽窗口的显示比例完全一致。
function VE_applyImgSizesToDom(sizes){
  if (!sizes || typeof sizes !== 'object') return;
  Object.entries(sizes).forEach(([path, v]) => {
    if (!path || !v || !v.widthPct) return;
    // 媒体栏是分栏布局，限 18–70% 才不会挤掉文字；普通图片允许 5–100%（与拖动范围一致，
    // 否则会出现"拖到 100% 保存后又被夹回 70%"的错觉）。
    const isBox = /^projects\.\d+\.media$/.test(path);
    const pct = isBox ? Math.max(18, Math.min(70, Number(v.widthPct) || 38))
                      : Math.max(5, Math.min(100, Number(v.widthPct) || 100));
    const box = isBox ? document.querySelector(`[data-ve-media-box="${String(path).replace(/"/g, '\\"')}"]`) : null;
    if (box) {
      box.style.setProperty('--pm-w', pct + '%');
      // 同上：父级也要写，否则 grid 取不到变量，保存过的尺寸在刷新后"看起来没生效"
      const grid = box.closest('.project-detail');
      if (grid) grid.style.setProperty('--pm-w', pct + '%');
      return;
    }
    // 带数据路径的图片（AI 项目封面/截图等）
    const byPath = document.querySelector(`img[data-ve-media-path="${String(path).replace(/"/g, '\\"')}"]`);
    if (byPath) { byPath.style.width = pct + '%'; return; }
    // auto:<src>：没有数据路径的普通图片，按归一化后的 src 匹配
    if (path.indexOf('auto:') === 0) {
      const want = path.slice(5);
      document.querySelectorAll('img').forEach(im => {
        const got = String(im.currentSrc || im.src || '').split('?')[0].replace(/^https?:\/\/[^/]+/, '');
        if (got && got === want) im.style.width = pct + '%';
      });
    }
  });
}
// 单个媒体项（图片 / 视频 / 音频）的宽度与对齐：design.mediaItems['projects.0.media#image0'] = {widthPct, align}
// 渲染时已按 design 烘进 --pmi-w，这里是父窗口改了设置后实时回灌用（不需要重载页面）。
function VE_applyMediaItemsToDom(items){
  if (!items || typeof items !== 'object') return;
  Object.entries(items).forEach(([key, v]) => {
    const el = document.querySelector(`[data-ve-media-item="${String(key).replace(/"/g, '\\"')}"]`);
    if (!el) return;
    const w = (v && v.widthPct != null) ? Math.max(10, Math.min(100, Number(v.widthPct) || 100)) : 100;
    el.style.setProperty('--pmi-w', w + '%');
    el.classList.toggle('pmi-c', !!(v && v.align === 'center'));
    el.classList.toggle('pmi-r', !!(v && v.align === 'right'));
  });
}
// 栏外散落图片的「位置」摆放（Design，key = data-ve-media-path）：
//   design.imgPos[path] = { place: 'inline'|'float-right'|'float-left'|'full'|'free' }
// free 不存图片二进制：Content 继续持有引用，Design 只持有位置。
function VE_applyImgPosToDom(map){
  document.querySelectorAll('img[data-ve-media-path]').forEach(el =>
    el.classList.remove('ve-place-inline','ve-place-float-right','ve-place-float-left','ve-place-full','ve-place-free'));
  // 单个媒体项（主视觉 / 工作过程图）同样支持「自由摆放」，键是 data-ve-media-item（每张图唯一）。
  // 必须整格隐藏，所以类加在 <figure> 上而不是它里面的 <img>。
  document.querySelectorAll('[data-ve-media-item]').forEach(el =>
    el.classList.remove('ve-place-inline','ve-place-float-right','ve-place-float-left','ve-place-full','ve-place-free'));
  if (!map || typeof map !== 'object') return;
  // 「原地自由摆放」的原图**不能隐藏** —— 它自己就是那张被摆放的图（用户第 ⑤ 项）。
  // 只有历史上「克隆式」的自由记录才把原图 display:none 掉。
  const isOwnFree = k => (window.__veImages || []).some(i => i && i.inplace && i.sourcePath === k);
  // 记录里有没有对应这张图的自由图（克隆式或原地式）
  const hasFreeRec = k => (window.__veImages || []).some(i => i && i.sourcePath === k);
  Object.entries(map).forEach(([path, v]) => {
    const safe = String(path).replace(/"/g, '\\"');
    const place = (v && v.place) || 'inline';
    // free 只是「原图让位给自由副本」的协作标记，**必须有对应的自由图记录**。
    // 没有记录就绝不能隐藏 —— 否则这张原图会被 display:none 永久藏起来，用户看到的就是
    // 「图不见了」。历史数据里确实有这种残留（实测：main 的
    // imgPos['projects.0.media#image1']={place:'free'}，而那张媒体早已被删；用户之后往同一个
    // 项目里再放一张图，那张图一进来就是隐身的）。宁可显示出来让用户自己摆。
    if (place === 'free' && !hasFreeRec(path)) return;
    if (isOwnFree(path)) return;
    const cls = 've-place-' + (['float-right','float-left','full','free'].includes(place) ? place : 'inline');
    const el = document.querySelector(`[data-ve-media-path="${safe}"]`);
    if (el) el.classList.add(cls);
    const itemEl = document.querySelector(`[data-ve-media-item="${safe}"]`);
    if (itemEl) itemEl.classList.add(cls);
  });
}
// 媒体栏的左右位置（Design，key 与 imgSizes 相同）：{ "projects.1.media": { side: "left" } }
function VE_applyMediaLayoutToDom(map){
  if (!map || typeof map !== 'object') return;
  Object.entries(map).forEach(([path, v]) => {
    const box = document.querySelector(`[data-ve-media-box="${String(path).replace(/"/g, '\\"')}"]`);
    if (box){
      const left = !!(v && v.side === 'left');
      box.classList.toggle('media-left', left);
      const grid = box.closest('.project-detail');
      if (grid) grid.classList.toggle('media-on-left', left);
    }
    // 「正文下方」整行区的整行对齐（左 / 居中 / 右）
    const below = document.querySelector(`[data-ve-media-below="${String(path).replace(/"/g, '\\"')}"]`);
    if (below){
      const a = (v && (v.belowAlign === 'center' || v.belowAlign === 'right')) ? v.belowAlign : '';
      below.classList.toggle('jc-center', a === 'center');
      below.classList.toggle('jc-right', a === 'right');
      below.setAttribute('data-ve-below-align', a);
      const gap = belowGapOf(v);
      below.classList.toggle('symmetric', !!(v && v.symmetric));
      if (gap !== BELOW_GAP_PX || v.symmetric) below.style.setProperty('--below-gap', gap + 'px');
    }
  });
}

// 静态元素（无数据 backing，纯布局/标签，如 Selected Works 眉标、hero 横线）是否已被移除。
// 移除记录存 design.removedStatic（属于 Design，不碰 Content），保证「删除 → 保存 → 刷新 → 仍删除」。
function VE_isStaticRemoved(design, id){
  const rs = (design && design.removedStatic) || [];
  return Array.isArray(rs) && rs.indexOf(id) >= 0;
}
// 静态元素的「可编辑文案」：这类元素没有 content 数据 backing（不属于个人内容），
// 所以文案归 Template，存在 design.staticText[id]。空 / 未设 = 用内置默认文案。
// 例：{ 'eyebrow-selected-works': 'Selected works' }
const VE_STATIC_TEXT_DEFAULTS = { 'eyebrow-selected-works': 'Selected works' };
function VE_staticText(design, id){
  const map = (design && design.staticText) || {};
  const v = map[id];
  if (typeof v === 'string' && v.trim() !== '') return v;
  return VE_STATIC_TEXT_DEFAULTS[id] || '';
}
function VE_staticTextIsCustom(design, id){
  const map = (design && design.staticText) || {};
  return typeof map[id] === 'string' && map[id].trim() !== '' && map[id] !== VE_STATIC_TEXT_DEFAULTS[id];
}

// —— 轻量提示（公开浏览页用）——
// 公开页没有编辑器那套 toastInCanvas，但章节点击失败/外部来源不可跳转时
// **必须给用户一句话解释**，否则就是"点了没反应"。
// 这里做成最小可用：单例 DOM + 自动消失，不依赖任何外部样式。
function __ffToast(msg){
  try{
    let el=document.getElementById('ff-toast');
    if(!el){
      el=document.createElement('div');
      el.id='ff-toast'; el.className='ff-toast';
      document.body.appendChild(el);
    }
    // ⚠ 2026-09-26 i18n（B 线第 1 期）：msg 必须过 z() —— 这是「中文当 key」字典层的入口。
    // 以前直接 textContent=msg，「当前视频托管在外部平台…」这类提示在英文/日文界面里恒为中文。
    el.textContent = ffZ(msg);
    el.classList.add('on');
    clearTimeout(el.__t);
    el.__t=setTimeout(()=>el.classList.remove('on'), 3600);
  }catch(e){}
}
window.__ffToast=__ffToast;


// —— Showreel 视频来源解析 ——
// 用户要求：既能用本地/直链 MP4（保留 Chapter 跳转），也能挂 Bilibili / 腾讯视频等外部链接。
// 两类来源的能力**本质不同**，这里必须如实区分，不能假装外部播放器也支持章节跳转：
//
//  A. 直接媒体（本地文件 / 直链 mp4/m3u8/webm…）
//     → 走原生 <video>，currentTime 可写 → Chapter 跳转**完全可用**。
//  B. 平台页面链接（B站 / 腾讯视频 / 优酷…）
//     → 只能内嵌 iframe 播放器或跳转。宿主页面**拿不到**播放器的 currentTime
//       （跨域 iframe 无控制接口）→ **Chapter 跳转不可用**，必须在界面上说明。
//       另外 B 站 iframe 需要带 ?page=&autoplay= 且受平台策略影响，未必在所有网络下可播。
const SHOWREEL_platformOf=(rawUrl)=>{
  const s=String(rawUrl||'');
  if(/bilibili\.com|b23\.tv/i.test(s))  return {id:'bilibili', name:'Bilibili', embed:'iframe', chapters:false};
  if(/v\.qq\.com/i.test(s))             return {id:'tencent',  name:'腾讯视频', embed:'iframe', chapters:false};
  if(/youku\.com/i.test(s))             return {id:'youku',    name:'优酷',   embed:'iframe', chapters:false};
  if(/youtube\.com|youtu\.be/i.test(s)) return {id:'youtube',  name:'YouTube',embed:'iframe', chapters:false};
  if(/\.(mp4|webm|ogv|mov|m4v|m3u8)(\?|#|$)/i.test(s)) return {id:'direct', name:'direct', embed:'video', chapters:true};
  return {id:'other', name:'外部链接', embed:'link', chapters:false};
};
// 从 B 站页面 URL 里提取 BV 号，拼成官方 iframe 播放地址
const SHOWREEL_biliEmbed=(rawUrl)=>{
  const m=String(rawUrl||'').match(/(BV[0-9A-Za-z]{10})/);
  if(!m) return '';
  const pm=String(rawUrl).match(/[?&]p=(\d+)/);
  let e='https://player.bilibili.com/player.html?bvid='+m[1]+'&high_quality=1&danmaku=0';
  if(pm) e+='&p='+pm[1];
  return e;
};
const SHOWREEL_resolveSource=(sp, localUrl, chaptersHtml)=>{
  const ext=String(sp.externalVideoUrl||'').trim();
  const hasLocal=!!localUrl;
  const hasChapters=!!(chaptersHtml&&chaptersHtml.length);
  // 1) 有本地文件 → 永远优先本地（章节跳转可靠），外部链接降级为"备用观看方式"
  if(hasLocal){
    const player=`<div class="showreel-video"><video controls preload="metadata" playsinline class="pm-video-el" data-vurl="${encodeURI(localUrl)}" data-vname="${esc((sp.media&&sp.media.name)||localUrl.split('/').pop())}" onerror="__veVideoErr(this)" src="${localUrl}"></video></div>`;
    const extra=ext?`<div class="showreel-alt"><span class="showreel-alt-label">备用观看方式</span><a class="button" href="${esc(ext)}" target="_blank" rel="noopener">${esc(SHOWREEL_platformOf(ext).name)} 打开 ↗</a></div>`:'';
    return {player, extra};
  }
  // 2) 只有外部链接
  if(!ext){
    return {player:`<div class="showreel-empty">这个 Showreel 项目还没有视频：到「文本编辑 → Showreel」上传本地视频，或填一个外部视频链接。</div>`, extra:''};
  }
  const pf=SHOWREEL_platformOf(ext);
  // 2a) 直链媒体 → 当普通视频播，章节可用
  if(pf.embed==='video'){
    const player=`<div class="showreel-video"><video controls preload="metadata" playsinline crossorigin="anonymous" class="pm-video-el" data-vurl="${encodeURI(ext)}" data-vname="${esc(ext.split('/').pop())}" onerror="__veVideoErr(this)" src="${ext}"></video></div>`;
    return {player, extra:''};
  }
  // 2b) 平台页面 → 能内嵌就内嵌，并**明确告知章节跳转不可用**
  let embedUrl='';
  if(pf.id==='bilibili') embedUrl=SHOWREEL_biliEmbed(ext);
  const note=`<p class="showreel-note">此视频托管在 <b>${esc(pf.name)}</b>，由该平台的播放器播放。
    注意：<b>章节时间点跳转在此来源下不可用</b>（播放器控制权在平台手里，页面无法跳转）。
    如需章节跳转，请改用直链 MP4。</p>`;
  const alt=`<div class="showreel-alt"><span class="showreel-alt-label">外部观看入口</span><a class="button" href="${esc(ext)}" target="_blank" rel="noopener">在 ${esc(pf.name)} 打开 ↗</a></div>`;
  const player = embedUrl
    ? `<div class="showreel-embed"><iframe src="${esc(embedUrl)}" scrolling="no" frameborder="0" framespacing="0" allowfullscreen="true" loading="lazy" title="外部视频播放器（${esc(pf.name)}）"></iframe></div>`
    : `<div class="showreel-empty">这是一个 <b>${esc(pf.name)}</b> 页面链接，无法在页面内直接播放。请用下方入口在新标签页打开。</div>`;
  // 章节列表仍展示（它们是内容记录），但要标明不可点击跳转
  const chBlock=hasChapters
    ? `<div class="chapters chapters-inert" title="当前视频来源不支持跳转">${chaptersHtml}</div>`
    : '';
  return {player:player+note+chBlock, extra:alt};
};

// —— 页脚品牌标记（FolioFold）——
// 用户明确要求：Logo 固定出现在页脚署名行，**不可删除**，作为发布内容的一部分。
// 因此这里刻意**不挂 data-field / data-ve-item**：
//   · 不挂 data-field  → 不能被"删除媒体 / 删除文字"类操作移除
//   · 不挂 data-ve-item → Visual Editor 的选择框 / 拖拽控制器不会作用到它
// 这样它才是"产品标识"而不是"用户内容" —— 与顶栏 .ff-lockup 同一个定位。
// 署名文字本身仍是内容（可改），标识图形是产品固定件（不可删）。
function VE_renderFooterBrand(profile){
  const p = profile || {};
  // ⚠ 姓名与头衔要**各自包一层 span**再拼：i18n 的整篇翻译是「文本节点精确匹配」替换，
  // 拼成一个文本节点后（例如 '某人 · Product Designer'）在译文表里查不到这一整串，
  // 英文模式下页脚就会一直留中文。拆开后两段各自命中，中间的 ' · ' 原样保留。
  const parts = [p.name, p.role].filter(Boolean)
    .map(x => '<span class="ff-foot-part">' + esc(x) + '</span>');
  return '<span class="ff-foot-brand" title="FolioFold">'
       +   '<img class="ff-foot-mark" src="' + FF_FOOT_MARK + '" alt="" width="18" height="18" loading="lazy" onerror="this.style.display=\'none\'">'
       +   '<span class="ff-foot-text">' + parts.join(' \u00b7 ') + '</span>'
       + '</span>';
}
// 页脚标记图片地址：与 favicon 同一个品牌资源（已随 bundle 打包，见 build_public_bundle）。
// 发布出去的站点可能挂在 /<repo>/ 子路径下，绝对 /media/... 会跑到域名根而 404，
// 所以线上用相对路径；本地预览（服务挂在根）才用绝对路径。
const FF_FOOT_MARK = (function(){
  try {
    if (window.__PUBLIC_VIEWER__) return 'media/brand/folioframe-mark-96.png';
  } catch(e){}
  return '/media/brand/folioframe-mark-96.png';
})();
// 渲染 Pixel Character：脸来自 Content(profile.avatar)，布局/显隐/轨迹来自 Design(design.pixel)。
// 默认在 hero 右上（absolute 浮层，不挤压文字流）；若用户拖拽过则用 design.pixel.x/y；
// 若设了活动轨迹(design.pixel.path)则初始落在轨迹起点。使 Pixel 成为独立可定位的 Canvas Element。
// 兼容历史数据：如果 path 里有明显 > 1 的数（早期存的像素值），按旧数据原样渲染。
function VE_renderPixel(d, design){
  const av = d && d.profile && d.profile.avatar;
  if (!av || !av.src) return '';
  const px = (design && design.pixel) || {};
  if (px.visible === false) return '';            // 显式隐藏（Show/Hide 开关，存 design）
  const size = Math.round(px.size || av.size || 72);
  const scale = (px.scale && +px.scale) || 1;
  // size 是编辑器滑块的实际基准尺寸；scale 仅保留给旧版拖拽缩放数据。
  // 旧实现把 scale 同时乘进宽高和 CSS transform，导致尺寸被重复缩放。
  const w = size, h = size;
  const hasPath = Array.isArray(px.path) && px.path.length >= 2;
  // path 现在统一存 0..1 比例（旧数据可能存了 px）；第一次落地时做一次轻量归一化，
  // 让两种数据都能渲染而不偏移：
  let pathPx = null;
  if (hasPath){
    const hr = document.querySelector('.hero');
    const rect = hr ? hr.getBoundingClientRect() : { width: 1, height: 1 };
    const looksAbsolute = px.path.some(p => (p.x != null && (p.x > 1.5 || p.y > 1.5)));
    if (looksAbsolute){
      pathPx = px.path.map(p => ({ x: Math.round(p.x), y: Math.round(p.y) }));
    } else {
      pathPx = px.path.map(p => ({ x: Math.round(p.x * rect.width), y: Math.round(p.y * rect.height) }));
    }
  }
  let st = `width:${w}px;height:${h}px;position:absolute;`;
  if (px.x != null && px.y != null){
    st += `left:${px.x}px;top:${px.y}px;transform-origin:top left;`;
  } else if (pathPx && pathPx.length){
    st += `left:${pathPx[0].x}px;top:${pathPx[0].y}px;transform-origin:top left;`;
  } else {
    st += `right:14px;top:14px;transform-origin:top right;`;
  }
  st += `transform:scale(${scale});z-index:6`;
  // data-ff-base-size：用户在设计面板里给的形象基准尺寸。窄屏的「按正文让位」算法
  // （VE_layoutHeroPixel）要以它为上限逐档试小，而不是无限制地缩。
  return `<div class="hero-avatar ve-pixel" data-ve-item="profile.avatar" data-ve-kind="pixel-character" data-pixel="1" data-ff-base-size="${size}" data-ff-xpct="${px.xPct != null ? px.xPct : ''}" data-ff-ypct="${px.yPct != null ? px.yPct : ''}" style="${st}" title="Pixel 形象：可拖拽/删除；右侧工具箱可调位置·大小·活动轨迹·显隐"><img class="ve-pix-img" src="${esc(av.src)}" alt="avatar" style="width:100%;height:100%;display:block"></div>`;
}

/* —— 窄屏形象：按「正文实际占几行」自动让位（2026-09-23）——
 * 用户原话：「这个形象图标盖住了文字，但是之前其实是会有设置说这个图标不能盖过文字。
 *   然后它有一个在手机版最大不能超过多大的一个数值，但是我不知道为什么现在它又超过了，
 *   所以可能这个数值还需要再往下调……这需要根据创作者填写的内容来判断手机版或者是电脑版
 *   它实际最大只能到多大，而不是无限制的调节。」
 *
 * 固定阈值做不到这件事 —— 同一段简介写一行和写四行，需要的留白完全不同。
 * 所以这里用**实测**：把 hero 里的正文（眉标/标题/职位/简介）求一个并集矩形，
 * 然后从「基准尺寸」开始逐档缩小（每档 -8px，下限 40px），取第一个不与正文重叠的档位；
 * 如果缩到下限仍然重叠，就把形象从绝对定位改成**正常文档流 + 右对齐**放到正文正下方
 * —— hero 会自然被撑高，物理上不可能再压住任何文字。
 * 桌面宽度（画布 > 720）下直接还原成用户自己的设计值，本函数不干预。 */
const VE_FF_PIX_SEL = '.hero .eyebrow, .hero h1, .hero .role, .hero .intro';
function VE_layoutHeroPixel(){
  if (window.__veFitBusy) return;              // 重入保护：本函数会改 hero 高度，可能再次触发 ResizeObserver
  const pix = document.querySelector('.ve-pixel');
  if (!pix) return;
  const shell = document.querySelector('.shell') || document.documentElement;
  const shellW = shell.clientWidth || window.innerWidth || 1280;
  const clearFit = () => {
    delete pix.dataset.ffPixFit; delete pix.dataset.ffPixSize; delete pix.dataset.ffPixSig;
  };
  const restore = () => {
    if (pix.dataset.ffPixNarrow !== '1'){ clearFit(); return; }
    try { pix.setAttribute('style', pix.dataset.ffPixOrig || ''); } catch (_) {}
    delete pix.dataset.ffPixNarrow;
    clearFit();
  };
  if (shellW > 720){ restore(); return; }         // 桌面：不干预，交回用户设计值

  const texts = Array.prototype.slice.call(document.querySelectorAll(VE_FF_PIX_SEL));
  if (!texts.length){ restore(); return; }
  // 只有第一次进入窄屏时记下「用户自己的行内几何」，之后一直以它为准还原。
  if (pix.dataset.ffPixNarrow !== '1') pix.dataset.ffPixOrig = pix.getAttribute('style') || '';

  const base = Math.max(28, Math.round(Number(pix.getAttribute('data-ff-base-size')) || 72));
  const shellRect = shell.getBoundingClientRect();
  const GAP = 10;
  const px = v => Math.round(v);

  let tl = Infinity, tt = Infinity, tr = -Infinity, tb = -Infinity;
  texts.forEach(t => {
    const r = t.getBoundingClientRect();
    if (!r.width && !r.height) return;
    tl = Math.min(tl, r.left); tt = Math.min(tt, r.top);
    tr = Math.max(tr, r.right); tb = Math.max(tb, r.bottom);
  });
  if (!isFinite(tl)){ restore(); return; }

  /* —— 尺寸上限由「正文实际占多少」决定，而不是一个固定数字 ——
   * textH   = 正文并集矩形的高度（1 行半 vs 4 行，留白需求完全不同）
   * roomL/R = 正文左右真正剩下的横向空档（手机版通常是 0，所以必然走「排到正文下面」）
   * 三者取最小，再夹在 [40, 30% 容器宽] 之间。 */
  const textH = Math.max(0, tb - tt);
  const roomL = Math.max(0, tl - shellRect.left - GAP);
  const roomR = Math.max(0, shellRect.right - GAP - tr);
  const sideRoom = Math.max(roomL, roomR);
  const hardCap = Math.min(base, Math.round(shellW * 0.30), px(textH) || base);
  const beside = sideRoom >= 56;                 // 侧边真放得下才留在旁边，否则一律回文档流

  let chosen, mode;
  if (beside){
    mode = 'absolute';
    chosen = Math.max(40, Math.min(hardCap, Math.floor(sideRoom)));
  } else {
    mode = 'relative';
    // 排进文档流后物理上不可能压到文字，所以这里的上限只用于「别太夸张」。
    chosen = Math.max(36, Math.min(base, Math.round(shellW * 0.30), 88));
  }

  // 结果没变就不写 DOM —— 否则「写 style → hero 高度变 → ResizeObserver → 再写」会无限循环。
  const sig = [mode, chosen, px(shellW), px(tl), px(tt), px(tr), px(tb)].join('|');
  if (pix.dataset.ffPixNarrow === '1' && pix.dataset.ffPixSig === sig){
    pix.dataset.ffPixFit = '1'; pix.dataset.ffPixSize = String(chosen);
    return;
  }
  window.__veFitBusy = 1;

  /* 量「用户自己摆的那个左上角」：只在它当前就是绝对定位时直接量，**不去还原样式**。
   * 还原再量会瞬时改变 hero 高度，把 ResizeObserver 拖进振荡。 */
  let left = NaN, top = NaN;
  if (mode === 'absolute'){
    const st = window.getComputedStyle(pix);
    const r = pix.getBoundingClientRect();
    if (st.position === 'absolute' && r.width){ left = r.left; top = r.top; }
    else {
      // 现在在文档流里（上一次裁决是 relative），用设计里的百分比位置还原一个合理落点。
      const hero = document.querySelector('.hero');
      const hr = hero ? hero.getBoundingClientRect() : shellRect;
      const xp = Number(pix.getAttribute('data-ff-xpct'));
      const yp = Number(pix.getAttribute('data-ff-ypct'));
      const cx = isFinite(xp) && xp > 0 ? hr.left + xp * hr.width : hr.right - chosen - 14;
      const cy = isFinite(yp) && yp > 0 ? hr.top + yp * hr.height : hr.top + 14;
      left = Math.max(shellRect.left + 2, Math.min(cx, shellRect.right - chosen - 2));
      top = Math.max(shellRect.top + 2, Math.min(cy, shellRect.bottom - chosen - 2));
    }
    left = Math.max(shellRect.left + 2, Math.min(left, shellRect.right - chosen - 2));
    top = Math.max(shellRect.top + 2, Math.min(top, shellRect.bottom - chosen - 2));

    /* ⚠ 落点还必须落在**正文之外**：上面只夹了 shell 边界，没夹正文。
     * 实测故障（390 宽）：回算 xPct 得到的 left=207，而正文右边缘在 246 ——
     * 形象直接压在文字上，就是用户报的「形象图标盖住了文字」。
     * 判据：原落点已经整体落在某一侧空档里就原样保留（尊重使用者的设计）；
     *      否则贴到放得下的那一侧（右优先，形象默认在右）；真的一侧都放不下就把尺寸压到放得下。
     *      总之：**任何情况下都不许盖住正文**。 */
    if (left >= tr + GAP) { /* 已在右侧空档，保留 */ }
    else if (left + chosen <= tl - GAP) { /* 已在左侧空档，保留 */ }
    else if (shellRect.right - GAP - tr >= chosen) left = shellRect.right - GAP - chosen;
    else if (tl - shellRect.left - GAP >= chosen) left = shellRect.left + GAP;
    else {
      // 理论上进不来（beside 成立时 chosen ≤ sideRoom，两侧必有一侧放得下）。
      // 真进来也只许往更宽的那侧空档里贴、并把尺寸压到放得下为止 —— 宁可小一点，也绝不许压字。
      chosen = Math.max(28, Math.floor(sideRoom));
      left = sideRoom === roomR ? shellRect.right - GAP - chosen : shellRect.left + GAP;
    }
  }

  try {
    if (mode === 'absolute'){
      pix.style.position = 'absolute';
      pix.style.margin = '0';
      pix.style.width = chosen + 'px';
      pix.style.height = chosen + 'px';
      /* ⚠ 坐标系（2026-09-23 实测故障）：left/top 是相对**定位祖先的 padding box** 解析的，
       * 而 .ve-pixel 的 offsetParent 是 .hero（position:relative），不是 .shell。
       * 上面那一串夹取是按 shell 的边界算的（用户眼里的"画布"就是 shell），
       * 所以写回 DOM 前必须换算到 offsetParent 坐标系。
       * 不换算的后果：形象整体偏移一个 hero.left/hero.top —— 实测 390 宽下
       * 右边缘 291+117=408 > 画布 390，形象被切掉一截（就是用户说的"形象不见了半截"）。 */
      const op = pix.offsetParent || shell;
      const opR = op.getBoundingClientRect();
      const opL = opR.left + (op.clientLeft || 0);
      const opT = opR.top + (op.clientTop || 0);
      pix.style.left = px(left - opL + (op.scrollLeft || 0)) + 'px';
      pix.style.top = px(top - opT + (op.scrollTop || 0)) + 'px';
      pix.style.right = 'auto';
      pix.style.bottom = 'auto';
    } else {
      // 退回正常文档流、右对齐排到正文下面（hero 自己长高），物理上不可能再压住任何文字。
      pix.style.position = 'relative';
      pix.style.left = 'auto';
      pix.style.top = 'auto';
      pix.style.right = 'auto';
      pix.style.bottom = 'auto';
      pix.style.width = chosen + 'px';
      pix.style.height = chosen + 'px';
      pix.style.margin = '10px 0 0 auto';
    }
    pix.style.transform = 'none';
    pix.style.transformOrigin = 'top left';
  } finally {
    window.__veFitBusy = 0;
  }
  pix.dataset.ffPixNarrow = '1';
  pix.dataset.ffPixSig = sig;
  // 挂牌：窄屏下形象的几何（位置 + 尺寸）归本函数所有，
  // ve-runtime-fix.js 的运行时必须让位，不许再写 left/top/width。
  pix.dataset.ffPixFit = '1';
  pix.dataset.ffPixSize = String(chosen);
}
// 给 ve-runtime-fix.js 用：它在每次 rAF 定位前先调这个，拿到本函数的裁决。
window.__veFitPixel = VE_layoutHeroPixel;


// 内容结构（名称、文案）只认 portfolio.json；但**区块顺序属于页面模板结构**，
// 权威来源是 Template / design.json —— 导入别人的模板时，顺序应该跟着模板走。
// portfolio.json 里的 data.sections 是历史遗留位置：只有当 design 里没有顺序时才回退读它。
const VE_DEFAULT_SECTION_ORDER = ['about','experience','works','showreel','aiVoices'];
function VE_resolveSectionOrder(data, design, defs){
  const tplOrder = Array.isArray(design && design.sectionOrder) && design.sectionOrder.length ? design.sectionOrder : null;
  const legacyOrder = Array.isArray(data && data.sections) && data.sections.length ? data.sections : null;
  const visibility = (data && data.settings && data.settings.sectionVisibility) || {};
  const source = tplOrder || legacyOrder || VE_DEFAULT_SECTION_ORDER;
  const order = source.filter(key => defs[key] && visibility[key] !== false);
  return order.length ? order : VE_DEFAULT_SECTION_ORDER.filter(key => defs[key] && visibility[key] !== false);
}

// =====================================================================
// Pixel 运行时（在真实 Portfolio 与 VE 画布都会跑）
// path 统一用百分比 {x,y} (0..1) 表示，渲染时按当前 .hero 尺寸换算成像素，所以
// 画布里 vs 真实 Portfolio 不会因为视觉宽度不同而产生偏移。
//
// 三个动作（动画作用在内层 .ve-pix-img，外层只负责位移）：
//   jump       — 跳两下立住（~1.1s）。原地。
//   sway-idle  — 原地左右摇晃（~0.9s）。原地。
//   sway-walk  — 边走边摇晃：外层位移 + 内层 0.8s 周期摆动。沿 path 一次性随机走 1/2 ~ 1/5 段。
//
// 触发概率：
//   hover（不点）：60% jump / 30% sway-idle / 10% sway-walk
//   click：       25% jump / 35% sway-idle / 40% sway-walk
//
// 「沿轨迹走动」开关语义（按用户 2026-09-08 反馈）：
//   - 开关 ON  + 有 path → 形象被「锁定」只能走 path。sway-walk 沿 path 走随机一段；jump/sway-idle 在 path 当前位置原地播。
//   - 开关 OFF 或 没 path → 形象回到 px.x/y（用户拖拽的固定位置）静止，不走不漂移；hover/click 只能触发 jump/sway-idle。
// 不走路时无任何 idle 抖动（已取消 idle timer）。本轮取消 blink。
// =====================================================================
function VE_pixelRuntime(d, design, opts){
  if (!document.querySelector('.ve-pixel')) return;
  // ?ve=1 的画布使用 ve-runtime-fix.js 的单一受限运行时；
  // 不再叠加旧运行时，避免一次点击同时触发两套动画/定位逻辑。
  if (new URLSearchParams(location.search).get('ve') === '1') return;
  opts = opts || {};
  const px = (design && design.pixel) || {};
  if (px.visible === false) return;
  const pix = document.querySelector('.ve-pixel');
  const av = d && d.profile && d.profile.avatar;
  // 「沿轨迹走动」开关：只有明确 onPath === true 且有 path 才认为锁定
  const path = (px.onPath === true && Array.isArray(px.path) && px.path.length >= 2) ? px.path : null;
  const hero = () => document.querySelector('.hero');
  const heroRect = () => { const h = hero(); return h ? h.getBoundingClientRect() : { left: 0, top: 0, width: 1, height: 1 }; };
  // 把百分比 path 转成当前 hero 坐标系下的像素点集
  function resolvePath(){
    if (!path) return null;
    const rect = heroRect();
    const looksAbsolute = path.some(p => (p.x != null && (p.x > 1.5 || p.y > 1.5)));
    if (looksAbsolute) return path.map(p => ({ x: Math.round(p.x), y: Math.round(p.y) }));
    return path.map(p => ({ x: Math.round(p.x * rect.width), y: Math.round(p.y * rect.height) }));
  }

  // 状态机：busy=true 表示正在播放动画
  let busy = false;
  function playAct(act){
    if (busy) return;
    busy = true;
    pix.classList.remove('px-act-jump', 'px-act-sway', 'px-walk');
    // 强制 reflow 让上一帧动画清干净
    void pix.offsetWidth;
    const dur = act === 'jump' ? 1100 : 900;
    if (act === 'walk'){
      pix.classList.add('px-walk');
    } else {
      pix.classList.add(act === 'jump' ? 'px-act-jump' : 'px-act-sway');
    }
    setTimeout(() => {
      pix.classList.remove('px-act-jump', 'px-act-sway', 'px-walk');
      busy = false;
    }, dur + 60);
  }

  // —— 概率选择 ——
  // isClick=true 走 click 概率；false 走 hover 概率
  function pickAction(isClick){
    const r = Math.random();
    if (isClick){
      // 25 / 35 / 40
      if (r < 0.25) return 'jump';
      if (r < 0.60) return 'sway';
      return 'walk';
    }
    // hover：60 / 30 / 10
    if (r < 0.60) return 'jump';
    if (r < 0.90) return 'sway';
    return 'walk';
  }

  // —— 走一段（sway-walk 用）——
  // 在 path 上找当前位置 index，沿任意方向走 1/2~1/5 段距离
  function findCurIndex(pts){
    const r = pix.getBoundingClientRect();
    const heroR = heroRect();
    const cx = (r.left + r.width / 2) - heroR.left;
    const cy = (r.top  + r.height / 2) - heroR.top;
    let best = 0, bestD = Infinity;
    pts.forEach((p, i) => {
      const d = (p.x - cx) ** 2 + (p.y - cy) ** 2;
      if (d < bestD){ bestD = d; best = i; }
    });
    return best;
  }
  function walkOnce(){
    const pts = resolvePath();
    if (!pts || pts.length < 2) return false;
    const cur = findCurIndex(pts);
    // 随机方向：50% 反向 / 50% 顺着（或跳到任意点）
    let dir, target;
    if (Math.random() < 0.5){
      dir = -1;
    } else {
      dir = 1;
    }
    // 走 1/2、1/3、1/4、1/5 段
    const totalLen = pts.length;
    const frac = [1/2, 1/3, 1/4, 1/5][Math.floor(Math.random() * 4)];
    const steps = Math.max(1, Math.round(totalLen * frac));
    // 走到不超过边界
    let next = cur + dir * steps;
    next = Math.max(0, Math.min(totalLen - 1, next));
    target = pts[next];
    // 走的时间：单段距离越长越慢，但慢点不显得太匀速。10s–18s 随机。
    const dur = 10000 + Math.random() * 8000;
    pix.style.transition = 'left ' + dur + 'ms linear, top ' + dur + 'ms linear';
    pix.style.left = target.x + 'px';
    pix.style.top  = target.y + 'px';
    pix.style.right = 'auto'; pix.style.bottom = 'auto';
    // 播放 walk 动画，到点停下
    playAct('walk');
    return true;
  }

  // —— 主触发 ——
  // onTrigger(isClick, e)
  function trigger(isClick, e){
    if (busy) return;
    // 工具条点击不触发（避免和删除/编辑冲突）
    if (e && e.target && e.target.closest && e.target.closest('.ve-el-bar')) return;
    const act = pickAction(isClick);
    // 「walk」必须 path 存在
    if (act === 'walk' && !path){
      // 退回到 sway-idle（开关关闭或没 path 时走路概率自然归零）
      playAct('sway');
      return;
    }
    if (act === 'walk'){
      if (!walkOnce()) playAct('sway');
    } else {
      playAct(act);
    }
  }

  // 注意：这里不能引用外层 initVEDirect 的局部 justDragged（词法上访问不到，
  // 会 ReferenceError → click 动画永远不触发）。VE_pixelRuntime 是独立顶层函数。
  // 真实拖动后浏览器本就不会发 click（有位移），所以无需 justDragged 防误触。
  pix.addEventListener('pointerenter', (e) => trigger(false, e));
  pix.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('.ve-el-bar')) return;
    e.stopPropagation();
    trigger(true, e);
  });

  // 暴露给测试/调试
  window.__vePixelStop = () => { busy = false; pix.classList.remove('px-act-jump','px-act-sway','px-walk'); };
}

/* =====================================================================
 * VE 直接编辑层（在 ?ve=1 画布内运行）
 * 让用户在画布上「所见即所得」地直接操作：
 *   1) 改文字：切到「改字」模式后，点任意带 data-field 的文本，直接输入，
 *      blur 时把 {path, value} 通过 postMessage 交给父窗口（VE）保存到 portfolio.json。
 *   2) 挪间距：切到「间距」模式后，在两个区块之间会显示可拖动的间距杆，
 *      上下拖动改变它们之间留白；数值持久化到父窗口 design.spacing 并重画。
 *   3) 图片尺寸：切到「图片」模式后，每张 .ve-resizable 图片出现角柄，
 *      拖动可改宽度百分比；持久化到父窗口 design.imgSizes 并重画。
 * 父窗口负责保存与 reload，iframe 只负责编辑交互 + 上报数值。
 * ===================================================================== */
function initVEDirect(){
  const API = {
    post: (msg) => { try { window.parent.postMessage(msg, '*'); } catch(_){} }
  };
  window.__veApi = API;   // 供模块级自由图片迁移/落盘使用（VE 父窗口存在时才持久化）
  const root = document.documentElement;
  let mode = 'select';   // select | browse | text | space | image

  // —— 工具栏 ——
  const tb = document.createElement('div');
  tb.className = 've-toolbar';
  tb.innerHTML = `
    <span class="ve-tb-title">画布直改</span>
    <button data-m="browse" class="ve-tb-btn">🖱 浏览</button>
    <button data-m="text"   class="ve-tb-btn">✎ 改文字</button>
    <button data-m="select" class="ve-tb-btn active">✥ 元素</button>
    <button data-m="space"  class="ve-tb-btn">↕ 挪间距</button>
    <button data-m="image"  class="ve-tb-btn">▣ 图片尺寸</button>
    <button data-m="addimg" class="ve-tb-btn">🖼 添加图片</button>
    <span class="ve-tb-hint">「元素」模式点选任意内容：可改文字 / 删除 / 拖动排序；选中后按 Delete 删除。文字工具在右侧，选中文字即用。要加图片：点「🖼 添加图片」后在右侧选文件，再到画布点击放置。</span>`;
  // 嵌入 Visual Editor 时，编辑模式由父窗口右侧工具栏承载，不能遮挡作品集画布。
  // 非嵌入页面保留此工具栏，方便单页本地调试。
  const embeddedEditor = window.parent !== window;
  if (!embeddedEditor) document.body.appendChild(tb);

  const setMode = (m) => {
    mode = m;
    tb.querySelectorAll('.ve-tb-btn').forEach(b => b.classList.toggle('active', b.dataset.m === m));
    root.classList.remove('ve-m-browse','ve-m-text','ve-m-space','ve-m-image','ve-m-addimg','ve-m-select','ve-m-drawpath');
    root.classList.add('ve-m-' + m);
    if (m !== 'addimg') pendingImage = null;
    clearTextEdit();
    clearSpaceUI();
    clearImageUI();
    clearSelection();
    clearDrawUI();
    document.body.classList.toggle('ve-noselect', m !== 'text'); // text 模式下允许选字
    if (m === 'space') renderSpaceBars();
    if (m === 'image') renderImageHandles();
    if (m === 'addimg'){ renderPlaceBar(); toastInCanvas('已选好图片：点画布上任意位置就能放下它（点项目媒体区则并进那个项目）'); }
    else removePlaceBar();
    if (m === 'drawpath') startDrawPath();
    document.body.classList.toggle('ve-edit-mode', m !== 'browse');
  };
  tb.querySelectorAll('.ve-tb-btn').forEach(b => b.onclick = () => setMode(b.dataset.m));

  // ============ 局部文字样式 + 自由图片层（添加图片 / 拖动吸附 / 缩放 / 删除） ============
  // pendingImage: { src, url, name, type, attach } —— url 是 /media/... 引用（优先，避免 base64 落盘），
  // attach=true 表示"点中哪个项目就并进它的媒体栏"。
  let pendingImage = null;
  const toastInCanvas = (msg) => { try { API.post({ type:'ve-toast', msg }); } catch(_){} };

  // 选区缓存：点击右侧工具（跨 iframe）会丢失选区，故在 selectionchange 时缓存 Range
  let veCachedRange = null;
  function cacheRange(){
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) { veCachedRange = null; return; }
    const r = sel.getRangeAt(0);
    if (curEditEl && curEditEl.contains(r.commonAncestorContainer)) veCachedRange = r.cloneRange();
    else veCachedRange = null;
  }
  function restoreRange(){
    if (!veCachedRange) return false;
    try { const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(veCachedRange); return true; } catch(_){ return false; }
  }
  function selectAllIn(el){ const r = document.createRange(); r.selectNodeContents(el); const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r); }
  function wrapRange(styleObj){
    const sel = window.getSelection(); if (!sel.rangeCount) return;
    const r = sel.getRangeAt(0); if (r.collapsed) return;
    const span = document.createElement('span');
    Object.assign(span.style, styleObj);
    let inserted = null;
    try {
      r.surroundContents(span);
      inserted = span;
    } catch(_) {
      span.appendChild(r.extractContents());
      r.insertNode(span);
      inserted = span;
    }
    // 关键：包完 span 后 selection 已经丢了（surroundContents 后选区指向 span 整体，
    // extractContents 路径则彻底清空）。手动把 selection 重新设到 span 内的全部内容上，
    // 这样连续按 A+/A- 时下次 restoreRange 还能命中刚才包裹的那段。
    if (inserted){
      try {
        const nr = document.createRange();
        nr.selectNodeContents(inserted);
        const ns = window.getSelection();
        ns.removeAllRanges();
        ns.addRange(nr);
      } catch(_){}
    }
  }
  // —— 颜色实时更新（2026-09-08 vR+）——
  // 选区可能跨多个文本节点。策略：把当前选区拆成「子范围 × 文本节点」，
  // 对每个文本节点所在的 inline 祖先（带 style.color 或 style.backgroundColor）
  // 复用并更新 style 值；没有 inline 祖先时只包裹一次。
  // 这样高频拖动色盘时不会产生嵌套 span。
  function applyColorToSelection(el, cssProp, value){
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const r = sel.getRangeAt(0);
    if (r.collapsed) return;
    if (el.contains(r.startContainer) && el.contains(r.endContainer)){
      const startNode = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
      const endNode   = r.endContainer.nodeType === 3 ? r.endContainer.parentElement : r.endContainer;
      if (startNode === endNode){
        const topInline = findTopInlineUnder(el);
        if (topInline){
          topInline.style[cssProp] = value;
          try { sel.removeAllRanges(); sel.addRange(r); } catch(_){}
          return;
        }
        // 没有 inline 子元素 → 整个 el 应用（不创建多余 span）
        el.style[cssProp] = value;
        try { sel.removeAllRanges(); sel.addRange(r); } catch(_){}
        return;
      }
    }
    // 跨节点选区：退到 execCommand 路径（execCommand 自己处理复杂范围）
    try {
      document.execCommand('styleWithCSS', false, true);
      if (cssProp === 'color') document.execCommand('foreColor', false, value);
      else { if (!document.execCommand('hiliteColor', false, value)) document.execCommand('backColor', false, value); }
    } catch(_){}
  }
  // 找 el 下「第一个带 inline style 的直接子元素链」。如果第一层子元素就有 inline style，
  // 就用它（避免深入嵌套）。否则返回 null（让 caller 走 el.style[cssProp] = value）。
  function findTopInlineUnder(el){
    let cur = el.firstElementChild;
    while (cur){
      // 跳过 block-level 容器（不应该给 .hero div 这种加 color）
      const cs = window.getComputedStyle(cur);
      if (cs.display === 'block' || cs.display === 'list-item') break;
      if (cur.style && (cur.style.cssText || '').length > 0) return cur;
      // 进入 inline 子元素继续找（但如果中间经过 block-level 节点就停）
      cur = cur.firstElementChild;
    }
    return null;
  }
  function findInlineAncestor(node, scope){
    let n = node;
    while (n && n !== scope){
      if (n.nodeType === 1 && (n.style && (n.style.cssText || '').length > 0)) return n;
      n = n.parentNode;
    }
    return null;
  }
  // 把局部选中样式（或整元素）应用到画布，并提交 innerHTML 给父窗口落盘。
  // prop 是「语义」名，直接对应右侧文本工具按钮：fontWeight/fontStyle/textDecoration/
  // color/backgroundColor/fontSize(px 绝对值或 'up'/'down')/textAlign/reset。
  // 「改文字」模式进入一个字段时会自动全选它。这个选择在浏览器中也会被
  // selectionchange 标成 range，但语义上仍然是整字段编辑；若把它当局部
  // 富文本保存，颜色/字号只会留在临时 HTML，无法成为三端共用的 Design 数据。
  function isWholeFieldSelection(el){
    try {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount !== 1 || sel.isCollapsed) return false;
      const range = sel.getRangeAt(0);
      const full = document.createRange();
      full.selectNodeContents(el);
      if (range.compareBoundaryPoints(Range.START_TO_START, full) === 0
        && range.compareBoundaryPoints(Range.END_TO_END, full) === 0) return true;
      // 浏览器会在已有 inline span 的字段里把自动全选的边界收在 span
      // 内，而不是字段元素本身；边界不相同但选中文本等于整个字段时，
      // 仍应按整字段处理。
      return (range.toString() || '').trim() === (el.innerText || '').trim();
    } catch (_) { return false; }
  }
  function applyInlineStyle(prop, value, scope, options = {}){
    const preview = options.preview === true;
    const el = curEditEl || (selEl && selEl.hasAttribute('data-field') ? selEl : null);
    if (!el) return;
    // 默认全选整个字段时，强制使用可持久化的字段级样式；只有用户手动
    // 选中其中一小段文字，才保留局部富文本的 range 逻辑。
    if (scope === 'range' && isWholeFieldSelection(el)) scope = 'field';
    // 元素模式是「整段文字」编辑，不应继续把字体/颜色塞进一层层 span。
    // 视觉属性单独存进 textStyles；inlineStyles 只保留真正的局部富文本选区。
    const fieldProps = ['fontSize', 'color', 'backgroundColor', 'textAlign'];
    // 颜色、字号、背景、对齐都是本编辑器的“字段视觉属性”。浏览器在
    // contenteditable 内部会不稳定地把自动选中的整段标成 range，导致这些
    // 属性误存为临时 span。统一固定到字段级，确保画布、文本编辑与作品集
    // 都从同一个 textStyles 数据源读取；局部 B/I/U 仍继续使用 range。
    if (fieldProps.includes(prop) || prop === 'reset') scope = 'field';
    if (scope === 'field' && (fieldProps.includes(prop) || prop === 'reset')) {
      const path = el.getAttribute('data-field') || '';
      if (!path) return;
      const styles = Object.assign({}, window.__veTextStyles || {});
      const next = Object.assign({}, styles[path] || {});
      if (prop === 'reset') {
        delete styles[path];
        el.style.removeProperty('font-size'); el.style.removeProperty('color');
        el.style.removeProperty('background-color'); el.style.removeProperty('text-align');
      } else {
        next[prop] = value;
        styles[path] = next;
        el.style[prop] = value;
      }
      window.__veTextStyles = styles;
      const inline = Object.assign({}, window.__veInlineStyles || {});
      delete inline[path];
      window.__veInlineStyles = inline;
      // 色盘拖动仅更新画布的临时视觉状态。它绝不能通知父页面重新渲染
      // 工具箱，否则原生色盘会被卸载，造成用户看到的“闪退”。
      if (preview) return;
      // 字段级样式与清掉的局部富文本必须作为一条消息提交。
      // 分两条异步消息会让父编辑器把同一次编辑拆成两个历史状态，
      // 造成撤销/重做与刷新后的结果不一致。
      API.post({ type:'ve-commit-textstyles', textStyles: styles, inlineStyles: inline });
      notifySelection(el);
      return;
    }
    const wasEditing = (el === curEditEl);
    if (!restoreRange()){
      if (!el.isContentEditable){ el.setAttribute('contenteditable','true'); el.focus(); }
      selectAllIn(el);
    } else if (!el.isContentEditable){ el.setAttribute('contenteditable','true'); el.focus(); }
    const selR = (() => { try { const s = window.getSelection(); return (s && s.rangeCount && !s.isCollapsed) ? s.getRangeAt(0) : null; } catch(_){ return null; } })();
    const fontSizeCur = (() => {
      try { if (selR){ const n = selR.startContainer.nodeType === 3 ? selR.startContainer.parentElement : selR.startContainer; return parseFloat(getComputedStyle(n).fontSize) || 16; } } catch(_){}
      return parseFloat(getComputedStyle(el).fontSize) || 16;
    })();
    try {
      // B/I/U：execCommand 是「按当前选中是否已加样式自动反向」的开关，
      // 与右侧按钮 on/off 状态天然同步，故只需按语义触发即可。
      if (prop === 'fontWeight'){ document.execCommand('bold'); }
      else if (prop === 'fontStyle'){ document.execCommand('italic'); }
      else if (prop === 'textDecoration'){ document.execCommand('underline'); }
      // —— color / backgroundColor 实时化（2026-09-08 vR+）：
      // 之前 execCommand('foreColor') 在色盘拖动时每次都生成新 <font>，高频嵌套 span 会爆。
      // 现在：复用选区祖先中最近的同属性 inline 元素并直接更新 style；没有才包一层。
      else if (prop === 'color'){
        // 元素模式编辑的是整段文字：直接改外层，避免每次选中/读取都落到旧的内层 span。
        if (scope === 'field') el.style.color = value; else applyColorToSelection(el, 'color', value);
      }
      else if (prop === 'backgroundColor'){
        if (scope === 'field') el.style.backgroundColor = value; else applyColorToSelection(el, 'backgroundColor', value);
      }
      else if (prop === 'fontSize'){
        const next = /^\d+(\.\d+)?px?$/.test(String(value)) ? parseFloat(value)
          : Math.max(8, Math.min(160, fontSizeCur + (value === 'up' ? 2 : -2)));
        if (scope === 'field') el.style.fontSize = next + 'px'; else wrapRange({ fontSize: next + 'px' });
      }
      else if (prop === 'textAlign'){ el.style.textAlign = value; }
      else if (prop === 'reset'){ el.innerHTML = el.innerText; }
    } catch(e) { /* ignore */ }
    if (!wasEditing && el !== curEditEl) el.removeAttribute('contenteditable');
    if (preview) return;
    commitInline(el);
    cacheRange();
    notifySelection(el);
  }
  function commitInline(el){
    const path = el.getAttribute('data-field'); if (!path) return;
    // —— 关键修复（2026-09-08 vS）—— 当 el 自身有 inline style 但 innerHTML 还没生成任何
    // tag（如基线无 span 的 .intro 直接设了 el.style.color），仅靠 innerHTML 检测不到改色。
    // 把 el.style 同步反映到 __veInlineStyles：构造一个等价的 wrapper span，把 style 转成字符串。
    let html = el.innerHTML;
    const elStyle = el.getAttribute('style') || '';
    if (elStyle){
      // 已有 inline style：把内层包一层等价 span（保证 design.inlineStyles 落盘后刷新可还原）
      const wrap = document.createElement('span');
      wrap.setAttribute('style', elStyle);
      wrap.innerHTML = html || el.textContent || '';
      html = wrap.outerHTML;
    }
    // 同步更新本地缓存：父端 saveInlineStyles 会通过 getInlineStyles() 读这个 map 落盘
    window.__veInlineStyles = window.__veInlineStyles || {};
    if (html && /<[a-zA-Z]/.test(html)) window.__veInlineStyles[path] = html;
    else delete window.__veInlineStyles[path];
    // 把当前的 inlineStyles 整张 map 也带过去，避免父端「快照里有 A+、磁盘是 B」的不一致
    API.post({ type:'ve-commit-inline', path, html, allInlineStyles: Object.assign({}, window.__veInlineStyles) });
  }
  function commitImages(){ API.post({ type:'ve-commit-images', images: window.__veImages }); }
  function placeImage(src, x, y){
    const id = 'img_' + Date.now();
    const cx = x - window.scrollX, cy = y - window.scrollY;   // 文档坐标→视口坐标
    const anchor = freeAnchorFromClientPoint(cx, cy);
    const im = { id, src, aKind: anchor.aKind, aSection: anchor.aSection || '', aItem: anchor.aItem || '', aLabel: anchor.aLabel || '整页' };
    // 用容器浮层 rect 把落点折算成初始比例坐标（横纵都按容器宽）
    const c = freeContainerFor(anchor);
    const layer = ensureFreeLayer(c);
    const lr = layer.getBoundingClientRect();
    // ⚠ BUG-4（2026-09-26 人工回归第 4 轮最小修复）：原写法 lw = Math.max(1, lr.width)。
    // 容器此刻不可测量（宽度 0：浮层刚建好还没布局 / 所在区块折叠）时 lw=1，
    // 于是 wPct = min(3, 320/1) = 3 → **300% 画布宽**的巨图，x/y 也一并被 clamp 到 3/4，
    // 图片直接飞出可视区、用户以为「添加图片没反应」。与 BUG-3 同源，这里同样拒绝采样，
    // 改用一组安全默认比例（整页左上 1/4 宽），等下一次真实测量时再被正确覆盖。
    const measurable = lr.width > 1;
    const lw = measurable ? lr.width : 1;
    if (measurable){
      // y 轴（2026-09-27 穿模修复）：内容类归属按宿主高折算并标记 yMode:'h'，tail/page 保持按宽。
      const _yModeH = freeYModeH(im);
      const _yBase = _yModeH ? Math.max(1, lr.height) : lw;
      im.xPct = Math.max(0, Math.min(3, (cx - lr.left) / lw));
      im.yPct = Math.max(-0.2, Math.min(4, (cy - lr.top) / _yBase));
      im.wPct = Math.min(3, 320 / lw);
      if (_yModeH) im.yMode = 'h';
    } else {
      im.xPct = 0.08; im.yPct = 0.08; im.wPct = 0.25;
    }
    im.aspect = 1;
    window.__veImages = window.__veImages || [];
    window.__veImages.push(im);
    VE_renderFreeLayer();
    const nel = document.querySelector('[data-ve-img="' + cssEsc(id) + '"]');
    if (nel) selectElement(nel);
    commitImages();
    const probe = new Image();
    probe.onload = () => {
      if (!probe.naturalWidth) return;
      const it = (window.__veImages || []).find(i => i.id === id);
      if (!it) return;
      it.aspect = Math.max(0.2, probe.naturalWidth / probe.naturalHeight);
      VE_renderFreeLayer();
      const el2 = document.querySelector('[data-ve-img="' + cssEsc(id) + '"]');
      if (el2 && selEl && selEl.getAttribute && selEl.getAttribute('data-ve-img') === id) selectElement(el2);
      commitImages();
    };
    probe.onerror = () => {};    probe.src = src;
  }
  /* 父窗口「已添加的媒体（统筹区）」点了一整行 → 在画布里把这一项找出来。
   * 为什么需要（2026-09-23 用户原话）：「我希望点击这个图片，它可以自动定位出这个图片在哪，
   *   这样子方便编辑，因为现在这两张图，说实话我不知道它的具体位置，这样子我删的话我就不好删」。
   * 三把钥匙按顺序试（id → path → key），因为三类媒体的 DOM 锚点写法不一样：
   *   · 自由摆放记录      → [data-ve-img="<记录 id>"]
   *   · 区项媒体 / 截图 / 封面 → [data-ve-media-path="projects.0.media.image"]
   *   · 媒体项（主视觉等）  → [data-ve-media-item="projects.0.media#image1"]
   *   · 项目 Logo 点缀图   → [data-ve-logo-path="aiVoices.projects.0"]
   *   · 区块 Logo 点缀图   → [data-ve-logo-path="sectionLogos.<区块>"]
   * 顺带把折叠的区块展开 —— 否则滚过去只看到一条标题，用户还是找不到。 */
  function VE_locateMedia(msg){
    if (!msg) return;
    const Q = v => String(v).replace(/"/g, '\\"');
    const ATTRS = ['data-ve-media-path','data-ve-media-item','data-ve-logo-path','data-ve-section-logo','data-ve-img','data-ve-item'];
    const find = value => {
      if (!value) return null;
      const v = String(value);
      for (const a of ATTRS){ const el = document.querySelector('[' + a + '="' + Q(v) + '"]'); if (el) return el; }
      // 'projects.0.media#image1' ↔ 'projects.0.media.image1'（两种 key 写法历史上都出现过）
      const alt = v.indexOf('#') >= 0 ? v.replace('#', '.') : v.replace(/^(.*\.media)\.image(\d+)$/, '$1#image$2');
      if (alt !== v) for (const a of ATTRS){ const el = document.querySelector('[' + a + '="' + Q(alt) + '"]'); if (el) return el; }
      return null;
    };
    const el = find(msg.id) || find(msg.path) || find(msg.key);
    if (!el){ API.post({ type:'ve-locate-result', ok:false, reason:'not-found' }); return; }
    /* ① 先展开沿途所有收起的容器，再量坐标：
     *   · <details> —— 项目/经历正文
     *   · .entry（区块的「展开/收起」）—— 收起时整块 display:none，媒体量出来是 0×0，
     *     滚动定位等于没反应（用户反馈：收起的下拉栏里点图片没动静，不了解的人会以为功能坏了）。
     * setEntryOpen 是展开的唯一入口（会同步文案）；ve-embed 下程序化 click 会被早退拦截，不能走 click。 */
    let anc = el.parentElement;
    while (anc){
      if (anc.tagName === 'DETAILS') anc.open = true;
      if (anc.classList && anc.classList.contains('entry') && !anc.classList.contains('open')){
        if (typeof setEntryOpen === 'function') setEntryOpen(anc, true);
        else {
          anc.classList.add('open');
          const t = anc.querySelector('.expand-text'); if (t) t.textContent = ffT('public.collapse','收起');
        }
      }
      anc = anc.parentElement;
    }
    try { if (typeof selectElement === 'function') selectElement(el); } catch (_) {}
    try {
      el.classList.remove('ve-locate-flash');
      void el.offsetWidth;                       // 复位动画，连点两次也能重新闪
      el.classList.add('ve-locate-flash');
      setTimeout(() => { try { el.classList.remove('ve-locate-flash'); } catch (_) {} }, 2800);
    } catch (_) {}
    // 展开触发的重排可能晚一帧；且 <img loading="lazy"> 在收起（不可见）期间不会加载，
    // 展开后才开始拉大图 —— 高度要等图片解码完才有值。等图片就绪（上限 6s 兜底）再回报，
    // 否则父窗口拿到的 height=0、滚动落点不准（用户看到的是「还是定位不到」）。
    const report = () => requestAnimationFrame(() => requestAnimationFrame(() => {
      const r2 = el.getBoundingClientRect();
      // 画布 iframe 是整页高、内部不滚动 → r.top 就是文档坐标，直接回报给父窗口去滚
      API.post({ type:'ve-locate-result', ok:true, y: Math.round(r2.top + r2.height / 2), height: Math.round(r2.height) });
    }));
    const imgEl = (el.tagName === 'IMG') ? el : el.querySelector('img');
    if (imgEl && !imgEl.complete){
      let waited = 0;
      const timer = setInterval(() => {
        if (imgEl.complete || waited >= 6000){ clearInterval(timer); report(); }
        waited += 60;
      }, 60);
    } else {
      report();
    }
  }
  // 按 id 删除自由图片：画布内删除与父窗口统筹区删除共用。只过滤该 id，
  // 其余图片的 xPct/yPct/wPct/aspect 完全不动 → 删除后不影响其他图片的位置与比例。
  function removeFreeImageById(id){
    if (!id) return;
    const removed = (window.__veImages || []).find(i => i && i.id === id);
    window.__veImages = (window.__veImages || []).filter(i => i.id !== id);
    // 删除自由布局只恢复内容图的普通流位置，不删除 Content 中的媒体引用。
    if (removed && removed.sourcePath){
      const pos = Object.assign({}, window.__veImgPos || {});
      delete pos[removed.sourcePath];
      window.__veImgPos = pos;
      VE_applyImgPosToDom(pos);
      // 同一份 Design 同时改 images 与 imgPos，必须只发一条保存消息；两条并发的
      // read-modify-write 请求会让后一条拿旧快照覆盖前一条。
      API.post({ type:'ve-commit-bound-media', images:window.__veImages, imgPos:pos });
    }
    const el = document.querySelector('[data-ve-img="' + cssEsc(id) + '"]');
    if (removed && removed.inplace){
      // 原地自由摆放：这个元素就是**页面里的原图本身**，绝不能从 DOM 里删掉！
      // （删掉 = 用户的图在画布上凭空消失）这里只清掉自由态，让它回到普通排版。
      if (el) unfreeElement(el);
      if (selEl && selEl === el) clearSelection();
    } else if (el){
      if (el.parentNode) el.remove();
      if (selEl && selEl === el) clearSelection();
    }
    VE_renderFreeLayer();
    if (!(removed && removed.sourcePath)) commitImages();
    API.post({ type:'ve-delete-image', id });
  }
  function deleteFreeImage(el){
    const id = el.getAttribute('data-ve-img'); if (!id) return;
    removeFreeImageById(id);
  }

  // 自由图片层：拖动 + 吸附辅助线 + 缩放手柄（坐标统一相对「所在容器浮层」）
  let drag = null, resz = null;
  const FREE_DIRS = ['nw','ne','sw','se','n','s','w','e'];
  // 同浮层（同容器）内其它自由图片的局部矩形，供吸附用
  function sameLayerRects(layer){
    const out = [];
    if (!layer) return out;
    const llr = layer.getBoundingClientRect();
    document.querySelectorAll('.ve-free-img').forEach(im => {
      if (im.offsetParent !== layer) return;
      const r = im.getBoundingClientRect();
      out.push({ left: r.left - llr.left, top: r.top - llr.top, right: r.right - llr.left, bottom: r.bottom - llr.top });
    });
    return out;
  }
  // 在浮层内做吸附：中线 + 同层其它图片的边；返回局部坐标与辅助线位置
  function snapLocal(axis, pos, len, layer){
    const cands = [layer.getBoundingClientRect().width / 2];
    sameLayerRects(layer).forEach(r => { cands.push(r[axis==='x'?'left':'top'], r[axis==='x'?'right':'bottom']); });
    let best = null, bestD = 6, out = pos;
    cands.forEach(c => {
      const d1 = Math.abs(pos - c); if (d1 < bestD){ bestD = d1; out = c; best = c; }
      const d2 = Math.abs(pos - (c - len/2)); if (d2 < bestD){ bestD = d2; out = c - len/2; best = c; }
    });
    return { pos: out, guide: best };
  }
  // 拖动时高亮「松手后会归属到哪个容器」
  function highlightSectionUnder(cx, cy){
    clearAnchorHi();
    const p = freeAnchorFromClientPoint(cx, cy);
    const c = freeContainerFor(p);
    if (c && c !== document.querySelector('.shell')) c.classList.add('ve-anchor-hi');
  }
  function drawGuides(gx, gy){
    clearGuides();
    const layer = (drag && drag.el && (drag.layer || drag.el.offsetParent)) || document.querySelector('.ve-free-layer');
    if (!layer) return;
    if (gx != null){ const g = document.createElement('div'); g.className = 've-snap ve-snap-v'; g.style.left = gx + 'px'; layer.appendChild(g); }
    if (gy != null){ const g = document.createElement('div'); g.className = 've-snap ve-snap-h'; g.style.top = gy + 'px'; layer.appendChild(g); }
  }
  function clearGuides(){ document.querySelectorAll('.ve-snap').forEach(g => g.remove()); }
  function clearAnchorHi(){ document.querySelectorAll('.ve-anchor-hi').forEach(e => e.classList.remove('ve-anchor-hi')); }
  function onMove(e){
    if (!drag) return;
    // ⚠ 2026-09-26 人工回归第 4 轮：万一 drag.el 仍被别的路径整层重建换掉了
    //（不止 ve-relayout-free，任何重建都会摘掉旧节点），这里按 id 把新节点重新抓回来，
    // 让拖动继续跟手，而不是把坐标写进一个游离节点、画面纹丝不动。
    if (drag.el && !drag.el.isConnected){
      const _nel = document.querySelector('[data-ve-img="' + cssEsc(drag.id) + '"]');
      if (_nel){ drag.el = _nel; drag.layer = (freeGeomOfEl(_nel) || {}).layer || _nel.offsetParent; }
      else { drag = null; return; }
    }
    // 始终用 window 级 pointermove 追踪最新指针位置（拖离图片后 img 自身监听不再触发），
    // 供 onUp 据松手点重锚到正确容器。
    drag.lastX = e.clientX; drag.lastY = e.clientY;
    // ⚠ 区域身份：只用拖动开始时锁定的所属区域浮层，绝不用 offsetParent 兜底。
    const layer = drag.layer; if (!layer) return;
    const lr = layer.getBoundingClientRect();
    // ⚠ BUG-6：容器被折叠（details 未展开 / display:none）时 lr 退化成全 0，
    // 按全 0 参照算出来的局部坐标会把图甩到 (0,0) —— 就是「按着鼠标拖到一半突然跳到最上方」。
    // 参照层量不出来就先不写，保持原样，等容器可见后再拖。
    if (!(lr.width > 1) || !(lr.height > 0)) return;
    const localX = (e.clientX - drag.offX) - lr.left;
    const localY = (e.clientY - drag.offY) - lr.top;
    const sx = snapLocal('x', localX, drag.w, layer);
    const sy = snapLocal('y', localY, drag.h, layer);
    // ⚠ 区域约束（2026-09-26 人工回归）：自由图属于哪个区域（aKind/aSection/aItem）就在哪个
    // 区域里动 —— 拖到边界被夹住，绝不会因为拖出界就变成别的区域/整页图。
    // 参照层 inset:0，它的盒子就是所属容器的 padding box，天然是夹取边界。
    const maxX = Math.max(0, lr.width - drag.w), maxY = Math.max(0, lr.height - drag.h);
    sx.pos = Math.max(0, Math.min(maxX, sx.pos));
    sy.pos = Math.max(0, Math.min(maxY, sy.pos));
    if (drag.el.parentElement === layer){
      drag.el.style.left = sx.pos + 'px';
      drag.el.style.top = sy.pos + 'px';
    } else {
      // 「原地自由摆放」的原图不搬家：它的 offsetParent 未必是浮层，必须按视口坐标折算。
      freePlaceEl(drag.el, { left: sx.pos, top: sy.pos, width: drag.w, height: drag.h }, layer);
    }
    positionFreeHandles(drag.el);        // 手柄在父层里，拖动时要跟着重摆
    // 区域绑定（BUG-6 第 5 轮）后不再「按落点预判归属」：拖动期间高亮的一律是
    // 图片自己的容器浮层，避免误导用户「拖到这儿松手就会变成这个区域」。
    clearAnchorHi();
    if (layer && layer !== document.querySelector('.shell')) layer.classList.add('ve-anchor-hi');
    drawGuides(sx.guide, sy.guide);
  }
  function onUp(e){
    if (!drag){ _veFreeDragBusy = false; return; }
    const it = (window.__veImages || []).find(i => i.id === drag.id);
    _veFreeDragBusy = false;
    if (it){
      // ⚠⚠ 区域绑定（2026-09-26 第 5 轮人工回归，用户明确要求）：所属区域（aKind/aSection/aItem）
      // 在图片创建/「自由摆放」时就已定死，拖动只在自己区域内移动（onMove 已夹住），
      // 松手**绝不按落点重新归属**。旧实现 freeAnchorFromClientPoint(lx,ly) 会把拖出界的
      // 图改判成整页/别的区块，还会读不存在的 p.label → aLabel 恒「整页」。
      // 坐标一律相对**原容器**浮层折算。
      const own = { aKind: it.aKind || 'page', aSection: it.aSection || '', aItem: it.aItem || '' };
      // ⚠ 区域身份（2026-09-26）：严格解析所属区域 —— 解析不到就直接放弃采样，
      //   绝不用 section / 整页浮层当替身（那会把 xPct/yPct 写成另一套坐标 = 跳区域）。
      const newC = freeResolveContainer(own);
      // ⚠ 参照系一致性：拖动期间用的层必须属于「同一个所属容器」。图层若在拖动途中
      //   被重建/搬家（例如所属区块临时不可见），本次采样同样放弃，保留原记录。
      const refMismatch = !newC || (drag && drag.layer && drag.layer.parentElement !== newC);
      if (!refMismatch){
      const nl = ensureFreeLayer(newC);
      const nlr = nl.getBoundingClientRect(), nlw = Math.max(1, nlr.width);
      // ⚠ 量的一定是「当前还挂在文档上」的那个节点。若拖动途中被整层重建换过，
      // drag.el 是游离节点，getBoundingClientRect() 全 0 → 会被下面的防自毁闸挡掉，
      // 本次拖动等于白拖。按 id 取回现场节点再量。
      const _live = (drag.el && drag.el.isConnected) ? drag.el
        : document.querySelector('[data-ve-img="' + cssEsc(drag.id) + '"]') || drag.el;
      const er = _live.getBoundingClientRect();
      // ⚠ 防数据自毁闸（2026-09-25 人工回归审计）：拖拽目标不可测量（图未加载 /
      // 所在区块折叠导致 0 尺寸）时，er 全 0 会在这里被 clamp 成 (0,0,0.02,1) 的坏
      // 坐标并重锚成 page 落盘，覆盖用户真实摆放。此时放弃本次落点采样，保留原记录。
      if (er.width > 1 && er.height > 0){
        // aLabel 兜底刷新：历史数据可能存着过期文案（如 aKind=item 却写着「整页」）
        if (it.aKind === 'item' && it.aItem){
          const _an = document.querySelector('[data-ve-item="' + cssEsc(it.aItem) + '"]');
          if (_an) it.aLabel = freeItemLabel(_an);
        }
        // y 轴（2026-09-27 穿模修复）：内容类归属按宿主高折算并标记 yMode:'h'。
        const _yModeH = freeYModeH(it);
        const _yBase = _yModeH ? Math.max(1, nlr.height) : nlw;
        it.xPct = Math.max(-0.5, Math.min(3, (er.left - nlr.left) / nlw));
        it.yPct = Math.max(-0.5, Math.min(4, (er.top - nlr.top) / _yBase));
        it.wPct = Math.max(0.02, Math.min(3, er.width / nlw));
        it.aspect = er.height > 0 ? er.width / er.height : 1;
        if (_yModeH) it.yMode = 'h';
        delete it.x; delete it.y; delete it.dy; delete it.hPct; delete it.section;
      }
      }
    }
    clearGuides(); clearAnchorHi();
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    drag = null;
    if (it){ VE_renderFreeLayer(); const nel = document.querySelector('[data-ve-img="' + cssEsc(it.id) + '"]'); if (nel) selectElement(nel); commitImages(); }
  }
  function startFreeResize(el, dir, e){
    e.preventDefault(); e.stopPropagation();
    // ⚠ 区域身份：没有解析出所属区域就没有合法参照系，禁止缩放（避免写出错误坐标）。
    const _g = freeGeomOfEl(el); if (!_g || !_g.layer) return;
    const layer = _g.layer; if (!layer) return;
    const lr = layer.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    resz = { el, layer, id: el.getAttribute('data-ve-img'), dir, startRect: { left: r.left - lr.left, top: r.top - lr.top, width: r.width, height: r.height } };
    _veFreeDragBusy = true;   // 缩放同属「正在操作」，期间也禁止整层重建
    window.addEventListener('pointermove', onResize);
    window.addEventListener('pointerup', onResizeUp);
  }
  function onResize(e){
    if (!resz) return;
    // 与 onMove 同理：节点若被整层重建换掉，按 id 抓回新节点继续缩放。
    if (resz.el && !resz.el.isConnected){
      const _nel = document.querySelector('[data-ve-img="' + cssEsc(resz.id) + '"]');
      if (_nel){ resz.el = _nel; resz.layer = (freeGeomOfEl(_nel) || {}).layer || _nel.offsetParent; }
      else { _veFreeDragBusy = false; resz = null; return; }
    }
    // ⚠ 区域身份：同上，只用锁定的所属区域浮层。
    const layer = resz.layer; if (!layer) return;
    const lr = layer.getBoundingClientRect();
    // 与 onMove 同理：参照层量不出来时不写（BUG-6 的「按住鼠标突然跳到最上方」同样会发生在这里）
    if (!(lr.width > 1) || !(lr.height > 0)) return;
    const s = resz.startRect, d = resz.dir;
    const px = e.clientX - lr.left, py = e.clientY - lr.top;  // 指针在浮层内的局部坐标
    const right = s.left + s.width, bottom = s.top + s.height;
    let left = s.left, top = s.top, width = s.width, height = s.height;
    if (d.indexOf('e') >= 0) width = Math.max(24, Math.min(px - s.left, lr.width - s.left));
    if (d.indexOf('s') >= 0) height = Math.max(24, Math.min(py - s.top, lr.height - s.top));
    if (d.indexOf('w') >= 0){ left = Math.max(0, Math.min(px, right - 24)); width = right - left; }
    if (d.indexOf('n') >= 0){ top = Math.max(0, Math.min(py, bottom - 24)); height = bottom - top; }
    freePlaceEl(resz.el, { left, top, width, height }, layer);
    positionFreeHandles(resz.el);        // 缩放过程中手柄要跟着（父层挂载后不再自动跟随）
  }
  function onResizeUp(){
    if (!resz){ _veFreeDragBusy = false; return; }
    _veFreeDragBusy = false;
    const it = (window.__veImages || []).find(i => i.id === resz.id);
    // ⚠ 2026-09-26 人工回归：缩放结束要和「拖动移动」的 onUp 一样，重建自由图层后
    // 把选中态选回新节点。否则 commitImages → 父窗口 fitCanvas → ve-relayout-free
    // 触发的整层重建会换掉 DOM，用户「拖完手柄发现选中没了，没法接着调位置」。
    if (it){
      // 与 onUp 同理：量当前还挂在文档上的节点，别量游离节点（会被防自毁闸挡掉）。
      const _liveR = (resz.el && resz.el.isConnected) ? resz.el
        : document.querySelector('[data-ve-img="' + cssEsc(resz.id) + '"]') || resz.el;
      freeStateFromEl(it, _liveR);
      VE_renderFreeLayer();
      const nel = document.querySelector('[data-ve-img="' + cssEsc(it.id) + '"]');
      if (nel) selectElement(nel);
      commitImages();
    }
    window.removeEventListener('pointermove', onResize);
    window.removeEventListener('pointerup', onResizeUp);
    resz = null;
  }
  function VE_wireFreeImages(){
    window.__veWireFree = VE_wireFreeImages;
    // 供模块级 VE_relayoutFree 在整层重建后把选中态选回来（2026-09-26 人工回归）。
    // selectElement 依赖本作用域内的符号，只能像这样桥接出去。
    window.__veSelectFreeImg = function(id){
      const el = document.querySelector('[data-ve-img="' + cssEsc(String(id)) + '"]');
      if (el) selectElement(el);
    };
    document.querySelectorAll('.ve-free-img').forEach(img => {
      if (img.__veWired) return;
      img.__veWired = true;
      img.addEventListener('pointerdown', (e) => {
        if (!(mode === 'select' || mode === 'addimg' || mode === 'image')) return;
        if (e.target.classList && e.target.classList.contains('ve-free-handle')) return;
        e.preventDefault(); e.stopPropagation();
        // ⚠ 区域身份（2026-09-26）：所属区域解析不到（锚点元素不在 DOM）时不进入拖动 ——
        //   此时 offsetParent 兜底会拿错参照系，松手时把坐标写成另一套 = 跳区域。
        const _g0 = freeGeomOfEl(img);
        if (!_g0 || !_g0.layer) return;
        selectElement(img);
        const r = img.getBoundingClientRect();
        drag = { el: img, id: img.getAttribute('data-ve-img'),
          // layer = 坐标参照的那个容器浮层。副本的 offsetParent 就是浮层；
          // 「原地自由摆放」的原图 offsetParent 另有其人，必须显式记住真正的参照层。
          layer: _g0.layer,
          offX: e.clientX - r.left, offY: e.clientY - r.top, w: r.width, h: r.height, lastX: e.clientX, lastY: e.clientY };
        _veFreeDragBusy = true;   // 见 VE_relayoutFree：拖动期间禁止整层重建
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      });
      img.addEventListener('pointermove', (e) => { if (drag && drag.el === img){ drag.lastX = e.clientX; drag.lastY = e.clientY; } });
    });
  }
  // Pixel Character 拖拽：在「元素」模式下按住拖动 → 实时改绝对位置，松手上报父窗口持久化到 design.pixel
  function VE_wirePixel(){
    const pix = document.querySelector('.ve-pixel');
    if (!pix) return;
    pix.addEventListener('pointerdown', (e) => {
      if (mode !== 'select') return;
      // 不要 preventDefault — 否则浏览器不发后续 click 事件，导致 pix 的 click handler（动画触发）失效。
      // 只要 stopPropagation 避免冒泡到 document 的 select 选中逻辑（已修复：select 也排除 .ve-pixel）。
      e.stopPropagation();
      selectElement(pix);
      const r = pix.getBoundingClientRect();
      const hero = document.querySelector('.hero');
      const hr = hero ? hero.getBoundingClientRect() : { left:0, top:0 };
      const offX = e.clientX - r.left, offY = e.clientY - r.top;
      // 保持当前缩放（transform 里有 translateX/scale；仅取 X/Y 轴缩放，去掉位移，因为改走 left/top 绝对定位）
      let scale = 1;
      try {
        const m = new DOMMatrixReadOnly(getComputedStyle(pix).transform || 'none');
        if (m && !isNaN(m.a) && m.a) scale = Math.abs(m.a) || 1;
      } catch (_) {}
      justDragged = false;
      const move = (ev) => {
        justDragged = true;
        let x = ev.clientX - offX - hr.left, y = ev.clientY - offY - hr.top;
        pix.style.left = x + 'px'; pix.style.top = y + 'px'; pix.style.right = 'auto'; pix.style.bottom = 'auto';
        pix.style.transform = 'scale(' + scale + ')';
        pix.style.transformOrigin = 'top left';
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        const x = Math.round(parseFloat(pix.style.left) || 0), y = Math.round(parseFloat(pix.style.top) || 0);
        API.post({ type:'ve-pixel-update', pixel: { x, y, scale } });
        setTimeout(() => { justDragged = false; }, 50);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  // ============ 活动轨迹：在画布上画一条连续自由线 ============
  // 路径点统一存为「相对 .hero 的百分比坐标」(0..1)，无论画布的视觉宽度怎么变，
  // 真实 Portfolio 里的 .hero 宽度可能与画布不同，按百分比就能完全对齐，不会有偏移。
  let drawPts = [], drawLayer = null, drawing = false, dDoneBtn = null;
  function pxHeroXY(e){
    const hr = document.querySelector('.hero');
    const hrRect = hr ? hr.getBoundingClientRect() : { left:0, top:0, width:1, height:1 };
    const w = Math.max(1, hrRect.width), h = Math.max(1, hrRect.height);
    const px = (e.clientX + window.scrollX) - hrRect.left;
    const py = (e.clientY + window.scrollY) - hrRect.top;
    return {
      x: Math.round(px * 1000) / 1000,   // 0..1 横向比例
      y: Math.round(py * 1000) / 1000,   // 0..1 纵向比例
      _px: Math.round(px), _py: Math.round(py),   // 仅用于 SVG 可视化（hero-relative 像素）
    };
  }
  function pathToPx(heroRect, p){
    return { x: Math.round(p.x * heroRect.width), y: Math.round(p.y * heroRect.height) };
  }
  function clearDrawUI(){
    if (drawLayer){ drawLayer.remove(); drawLayer = null; }
    if (dDoneBtn){ dDoneBtn.remove(); dDoneBtn = null; }
    drawPts = []; drawing = false;
    window.removeEventListener('pointermove', drawMove);
    window.removeEventListener('pointerup', drawUp);
  }  function drawMove(e){
    if (!drawing) return;
    const p = pxHeroXY(e);
    const last = drawPts[drawPts.length - 1];
    // 用可视化像素近似做"距上次画太近就跳过"，坐标仍存百分比
    if (last && Math.abs((p._px||0) - (last._px||0)) < 8 && Math.abs((p._py||0) - (last._py||0)) < 8) return;
    drawPts.push(p);
    redrawPathLayer();
  }
  function drawUp(){ drawing = false; }
  function redrawPathLayer(){
    if (!drawLayer) return;
    drawLayer.innerHTML = '';
    if (drawPts.length < 2) return;
    const hr = document.querySelector('.hero');
    const r = hr ? hr.getBoundingClientRect() : { left:0, top:0 };
    const s = document.createElementNS('http://www.w3.org/2000/svg','svg');
    s.setAttribute('class','ve-draw-svg');
    // SVG 用 _px/_py（hero-relative 像素）画
    const d = 'M' + drawPts.map(p => (p._px != null ? p._px : p.x) + ' ' + (p._py != null ? p._py : p.y)).join(' L');
    const path = document.createElementNS('http://www.w3.org/2000/svg','path');
    path.setAttribute('d', d);
    path.setAttribute('fill','none'); path.setAttribute('stroke','#e64e2e'); path.setAttribute('stroke-width','2.5'); path.setAttribute('stroke-linecap','round');
    path.setAttribute('stroke-dasharray','6 5');
    s.appendChild(path);
    // 小圆点表示路径点
    drawPts.forEach(p=>{ const c=document.createElementNS('http://www.w3.org/2000/svg','circle'); c.setAttribute('cx',p.x); c.setAttribute('cy',p.y); c.setAttribute('r','3'); c.setAttribute('fill','#1f4e8c'); s.appendChild(c); });
    drawLayer.appendChild(s);
  }
  function startDrawPath(){
    clearDrawUI();
    const hr = document.querySelector('.hero');
    if (!hr) return;
    drawLayer = document.createElement('div');
    drawLayer.className = 've-draw-layer';
    document.body.appendChild(drawLayer);
    dDoneBtn = document.createElement('div');
    dDoneBtn.className = 've-draw-done';
    dDoneBtn.innerHTML = `<span class="ve-draw-tip">按住并拖动，在画布上画一条连续自由线（形象的走动轨迹）</span><button id="ve-draw-commit" class="ve-btn">✓ 完成轨迹</button><button id="ve-draw-cancel" class="ve-btn">取消</button>`;
    document.body.appendChild(dDoneBtn);
    document.getElementById('ve-draw-commit').onclick = () => {
      if (drawPts.length < 2){ toastInCanvas('轨迹太短，请至少画两点'); return; }
      // 只上传百分比 {x,y}，去掉 _px/_py 字段
      const pts = drawPts.map(p => ({ x: p.x, y: p.y }));
      API.post({ type:'ve-pixel-path', path: pts });
      clearDrawUI(); setMode('select'); toastInCanvas('已保存活动轨迹');
    };
    document.getElementById('ve-draw-cancel').onclick = () => { clearDrawUI(); setMode('select'); toastInCanvas('已取消画轨迹'); };
    // 开始画：全局 pointerdown（capture）只在 drawpath 模式下启动，注册一次即可
    if (!window.__veDrawBegin){
      window.__veDrawBegin = (e) => {
        if (mode !== 'drawpath') return;
        if (e.target.closest('.ve-draw-done') || e.target.closest('.ve-toolbar')) return;
        drawing = true; drawPts = []; drawPts.push(pxHeroXY(e));
        window.addEventListener('pointermove', drawMove);
        window.addEventListener('pointerup', drawUp);
      };
      document.addEventListener('pointerdown', window.__veDrawBegin, true);
    }
  }
  // 选中文字时（改文字模式）把选区状态同步给右侧工具箱，使其出现并可作用于局部
  document.addEventListener('selectionchange', () => {
    if (mode !== 'text' || !curEditEl) return;
    const sel = window.getSelection();
    const inEdit = sel && sel.rangeCount && !sel.isCollapsed && curEditEl.contains(sel.getRangeAt(0).commonAncestorContainer);
    // 进入「改文字」会自动选中整段；这不是局部富文本选区。把它作为
    // field 回报给父编辑器，颜色/字号才能写入共享的 Design 数据。
    const payload = { type:'ve-select', path: curEditEl.getAttribute('data-field'), scope: inEdit && !isWholeFieldSelection(curEditEl) ? 'range' : 'field', text: inEdit ? (sel.toString()||'').slice(0,40) : '', computed: VE_readComputedStyle(curEditEl), inline: VE_readInlineState(curEditEl), saved:{} };
    if (inEdit) cacheRange();
    API.post(payload);
  });

  // ================= 添加图片：点画布任意位置放置 =================
  // 规则（本轮重做，用户反馈「点了添加图片，图片进不来」）：
  //   · 点画布上**任何位置** → 就在那里放一张自由浮层图片（绝对定位，不影响分栏/展开排版）
  //   · 点某个项目的**媒体区**（媒体栏 / 正文下方整行区 / 已有媒体项）→ 并进那个项目的媒体列表
  //   · 底部有一条常驻提示条，明确告诉你现在该干什么，也能一键「放下 / 并入 / 取消」
  // 之前只弹一句 toast 说"点项目媒体栏=并入"，用户点下去要么被当作自由浮层（在很下面看不到），
  // 要么因为画布 iframe 重载把 pending 状态冲掉而毫无反应 —— 现在 pending 会由父端在重载后补发。
  function placeBarEl(){ return document.querySelector('.ve-place-bar'); }
  function removePlaceBar(){ const b = placeBarEl(); if (b) b.remove(); }
  function renderPlaceBar(){
    removePlaceBar();
    if (mode !== 'addimg' || !pendingImage) return;
    const bar = document.createElement('div');
    bar.className = 've-place-bar';
    const thumb = pendingImage.url || pendingImage.src || '';
    bar.innerHTML = `<img class="vpb-thumb" src="${thumb}" alt="">
      <span><b>点画布任意位置</b>放下这张图片<span class="vpb-hint">（点项目里的媒体区＝并进那个项目）</span></span>
      <button class="ve-btn" data-a="center">放到页面中央</button>
      <button class="ve-btn ghost" data-a="cancel">取消</button>`;
    document.body.appendChild(bar);
    const c = bar.querySelector('[data-a="center"]');
    if (c) c.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); consumePendingImage(window.scrollX + window.innerWidth / 2, window.scrollY + window.innerHeight / 2); };
    const x = bar.querySelector('[data-a="cancel"]');
    if (x) x.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); pendingImage = null; API.post({ type: 've-add-image-done' }); setMode('select'); toastInCanvas('已取消放置图片'); };
  }
  function consumePendingImage(x, y){
    if (!pendingImage) return;
    const src = pendingImage.url || pendingImage.src;
    pendingImage = null;
    API.post({ type: 've-add-image-done' });
    // 先退出放置模式再放图：否则 setMode 里的 clearSelection 会把刚放下的图片取消选中
    setMode('select');
    if (src) placeImage(src, x, y);
    toastInCanvas('图片已放下：可直接拖动位置、拖角柄改大小（虚线为对齐提示）');
  }
  function attachPendingTo(el){
    if (!pendingImage) return false;
    const item = el.closest('[data-ve-item^="projects."]');
    if (!item) return false;
    const idx = Number((item.getAttribute('data-ve-item') || '').split('.')[1]);
    if (!Number.isFinite(idx)) return false;
    const pend = pendingImage;
    pendingImage = null;
    API.post({ type: 've-attach-image', project: idx, url: pend.url || pend.src, name: pend.name || '', type: pend.type || '' });
    setMode('select');
    toastInCanvas('已把图片并进这个项目的媒体列表');
    return true;
  }
  document.body.addEventListener('click', (e) => {
    if (mode !== 'addimg' || !pendingImage) return;
    if (e.target.closest('.ve-toolbar') || e.target.closest('.ve-place-bar')) return;
    if (e.target.closest('.ve-free-img')) return;
    // ① 点项目里的「媒体区」→ 并进该项目（跟版式走）
    if (e.target.closest('[data-ve-media-box],[data-ve-media-below],[data-ve-media-item]')){
      if (attachPendingTo(e.target)) return;
    }
    // ② 其余任何位置 → 就地自由摆放
    const p = { x: e.clientX + window.scrollX, y: e.clientY + window.scrollY };
    consumePendingImage(p.x, p.y);
  }, true);

  // ================= 改文字 =================
  let curEditEl = null;
  function clearTextEdit(){
    if (curEditEl){ curEditEl.blur(); curEditEl.removeAttribute('contenteditable'); document.querySelectorAll('.ve-field-editing').forEach(e=>e.classList.remove('ve-field-editing')); curEditEl = null; }
  }
  // 改文字模式：用 capture 阶段拦截，确保点到大标题(data-field)时在冒泡到
  // 触发展开的 .entry-btn 之前 stopPropagation，这样能直接编辑区块标题而不展开。
  document.body.addEventListener('click', (e) => {
    if (mode !== 'text') return;
    // 点击工具栏内部不触发
    if (e.target.closest('.ve-toolbar')) return;
    if (e.target.closest('.ve-edit-btn')) return;   // 右侧编辑入口按钮
    const el = e.target.closest('[data-field],[data-static-text]');
    if (el){
      e.preventDefault(); e.stopPropagation();
      clearTextEdit();
      el.setAttribute('contenteditable','true');
      el.__veOriginalText = el.innerText;   // 标记编辑前的文字，等 blur 时比对是否真的改了字
      el.classList.add('ve-field-editing');
      curEditEl = el;
      // 光标移到末尾
      try { const r=document.createRange(); r.selectNodeContents(el); r.collapse(false); const s=window.getSelection(); s.removeAllRanges(); s.addRange(r); } catch(_){}
      el.focus();
      return;
    }
    // 点到空白处 → 结束编辑并保存当前
    if (curEditEl){ commitEdit(curEditEl); clearTextEdit(); }
  }, true);
  document.body.addEventListener('blur', (e) => {
    if (e.target && e.target.getAttribute && e.target.hasAttribute && e.target.hasAttribute('contenteditable')){
      // 延迟，等 click 处理完
      setTimeout(() => {
        if (document.activeElement !== e.target && e.target.__veOriginalText != null && e.target.innerText !== e.target.__veOriginalText){
          commitEdit(e.target);
        }
      }, 120);
    }
  }, true);
  // 输入后自动保存：不能要求用户再点一次空白处才让标题同步到其它编辑器。
  // blur / 点击空白仍保留，作为立即提交的补充。
  document.body.addEventListener('input', (e) => {
    if (e.target && e.target.hasAttribute && e.target.hasAttribute('contenteditable')){
      const field = e.target;
      clearTimeout(field.__veCommitTimer);
      field.__veCommitTimer = setTimeout(() => {
        if (field.isConnected && (field.getAttribute('data-field') || field.getAttribute('data-static-text')) && field.innerText.trim()) {
          commitEdit(field);
          field.__veOriginalText = field.innerText;
        }
      }, 300);
    }
  }, true);
  document.body.addEventListener('keydown', (e) => {
    if (mode!=='text' || !curEditEl) return;
    if (e.key === 'Escape'){ clearTextEdit(); }
  });

  function commitEdit(el){
    if (!el) return;
    // 静态元素（Selected works 眉标）：文案归 Template，走 design.staticText。
    const staticId = el.getAttribute('data-static-text');
    if (staticId){
      const value = el.innerText.replace(/\u00a0/g,' ').trim();
      // 空 = 恢复默认文案（由父窗口处理：本地立刻回填默认值，画面不会留空）
      API.post({ type:'ve-commit-static-text', id: staticId, value: value });
      el.style.outline = '2px solid var(--accent,#e64e2e)';
      setTimeout(()=> el.style.outline = '', 900);
      return;
    }
    if (!el.hasAttribute('data-field')) return;
    const path = el.getAttribute('data-field');
    let value = el.innerText.replace(/\u00a0/g,' ').trim();
    // data-single：整段作为单个字符串；否则按行拆成数组
    const single = el.hasAttribute('data-single');
    if (value === '' ) return; // 空不提交
    // 用户在画布里重打了文字 → 该字段旧的局部样式标记也应清掉，避免残留
    if (window.__veInlineStyles && window.__veInlineStyles[path]){
      delete window.__veInlineStyles[path];
    }
    API.post({ type:'ve-commit-text', path, value, single: !!single });
    // 本地即时高亮提示
    el.style.outline = '2px solid var(--accent,#e64e2e)';
    setTimeout(()=> el.style.outline = '', 900);
  }

  // ================= 元素模式（PPT 式：点哪改哪 / 选到什么删什么） =================
  // 任何带 data-field（可改文字）或 data-ve-item（数组中的一项，可删除）的元素
  // 都能被鼠标选中；选中后浮出小工具条：改文字 / 删除（二次确认）。
  // 删除不用刷新页面：本地把后续兄弟的索引 -1，保证再删别的项时路径仍然正确。
  let selEl = null, hoverEl = null, elBar = null, delArmed = false, delTimer = null;

  // 找到最合适的可操作目标（自身或最近祖先）
  function operableTarget(node){
    if (!node || node === document.body || !node.closest) return null;
    if (node.closest('.ve-toolbar') || node.closest('.ve-el-bar')) return null;
    // 媒体项优先：点图片/视频先选中**这一项**（这样才能单独调大小、单独换位置）；
    // 想操作整条媒体栏（换边 / 加图 / 加视频 / 清空）走工具条上的「⇱ 整栏设置」或点栏内空白处。
    const mi = node.closest('[data-ve-media-item]');
    if (mi) return mi;
    const box = node.closest('[data-ve-media-box]');
    if (box) return box;
    const el = node.closest('[data-ve-item],[data-field],[data-ve-img],[data-ve-group],img.ve-resizable,video.ve-resizable');
    if (el) return el;
    // 兜底（「元素」模式）：细粒度识别不到时，把「整个板块」当做一个元素选中，
    // 这样用户可以对任何模块做整块删除（隐藏），而不依赖其内部是否带 data-field / data-ve-item。
    if (mode === 'select') {
      const sec = node.closest('.entry[data-section]');
      if (sec) return sec;
    }
    return null;
  }
  function clearHover(){
    if (hoverEl){ hoverEl.classList.remove('ve-el-hover'); hoverEl = null; }
  }
  function clearSelection(){
    clearHover();
    disarmDelete();
    if (selEl){ selEl.classList.remove('ve-el-selected'); selEl = null; }
    if (elBar){ elBar.remove(); elBar = null; }
    document.querySelectorAll('.ve-free-handle').forEach(h => h.remove());
    document.querySelectorAll('.ve-media-handle').forEach(h => h.remove());
    if (mode === 'image') clearSizeSelection();
    API.post({ type:'ve-select', path:'', itemPath:'', section:'', kind:'', text:'', computed:null, saved:{} });
  }
  // 只收起「手柄 + 分隔条 + 选中实线」，保留可调对象的虚线轮廓（那是"这里能调"的提示）
  function clearSizeSelection(){
    if (veSizeSel && veSizeSel.isConnected) veSizeSel.classList.remove('ve-size-selected');
    veSizeSel = null;
    document.querySelectorAll('.ve-img-handle, .ve-col-divider, .ve-img-place-bar').forEach(h => h.remove());
    document.querySelectorAll('[data-ve-media-item], [data-ve-media-box], img').forEach(el => {
      if (el.__veHandles) el.__veHandles = null;
      if (el.__veMoveHandle) el.__veMoveHandle = null;
      if (el.__vePlaceBar) el.__vePlaceBar = null;
    });
  }
  function disarmDelete(){
    delArmed = false;
    if (delTimer){ clearTimeout(delTimer); delTimer = null; }
    if (elBar){ const b = elBar.querySelector('[data-a="del"]'); if (b){ b.classList.remove('armed'); b.textContent = '🗑 删除'; } }
  }
  function selectElement(el){
    clearSelection();
    selEl = el;
    el.classList.add('ve-el-selected');
    const imgId = el.getAttribute('data-ve-img');
    // 图片尺寸模式：选中谁，手柄与工具条就归谁（PPT 行为）——其余对象保持只有虚线轮廓。
    // 自由图片（data-ve-img）走自己的八向手柄，不进 PPT 尺寸体系。
    if (mode === 'image' && !imgId && el.classList && (el.hasAttribute('data-ve-media-item') || el.hasAttribute('data-ve-media-box') || el.tagName === 'IMG' || (el.tagName === 'VIDEO' && el.hasAttribute('data-ve-media-path')))) selectSizeTarget(el);
    if (imgId){ buildImageBar(el, imgId); notifySelection(el); return; }
    if (el.hasAttribute && el.hasAttribute('data-ve-media-item')){ buildMediaItemBar(el); notifySelection(el); return; }
    if (el.hasAttribute && el.hasAttribute('data-ve-media-box')){ buildMediaBoxBar(el); notifySelection(el); return; }
    // Section 只用于同步右侧“添加内容 / 展开所选内容”的上下文；不在画布
    // 上再覆盖一层“收起 / 删除整块”工具，避免遮挡原本的内容与展开入口。
    if (el.classList && el.classList.contains('entry') && el.hasAttribute('data-section')){ notifySelection(el); return; }
    buildElBar(el);
    notifySelection(el);
  }
  // 告诉右侧工具箱「现在选中了什么」，并回显它当前的真实样式
  function notifySelection(el){
    const imgId = el.getAttribute('data-ve-img');
    if (imgId){
      // 图片：不显示文字工具，只告知选中了图片（用于显示删除）
      const _imgSec = (el.closest && el.closest('.entry[data-section]')) ? el.closest('.entry[data-section]').getAttribute('data-section') : '';
      API.post({ type:'ve-select', path:'', itemPath:'img:' + imgId, section:_imgSec, kind:'image', text:'', computed:null, saved:{} });
      return;
    }
    const fieldPath = el.getAttribute('data-field') || '';
    const saved = (window.__veTextStyles || {})[fieldPath] || {};
    // 分类上下文：选中的无论是分类标题还是它下面的某个项目，都把所属分类一起报给父窗口，
    // 「添加内容」才知道该往哪个分类里加项目。
    const groupEl = el.closest ? el.closest('[data-ve-group]') : null;
    // 媒体栏本身没有 data-ve-item，用 data-ve-media-box 作为路径回报，父窗口据此知道在调哪一个项目
    const itemPath = el.getAttribute('data-ve-item') || el.getAttribute('data-ve-media-box') || el.getAttribute('data-field') || '';
    // 所在区块（Section）：供父窗口「⌄ 展开」精准展开该区块，而不是永远落在默认的 About 上
    const entryEl = el.closest ? el.closest('.entry[data-section]') : null;
    const section = entryEl ? entryEl.getAttribute('data-section') : '';
    API.post({
      type: 've-select',
      path: fieldPath,
      itemPath,
      section,
      kind: el.getAttribute('data-ve-kind') || (el.tagName === 'IMG' ? 'image' : 'text'),
      groupId: groupEl ? groupEl.getAttribute('data-ve-group') : '',
      groupIndex: groupEl ? Number(groupEl.getAttribute('data-ve-group-index')) : -1,
      scope: (el.hasAttribute('contenteditable') && !isWholeFieldSelection(el) ? 'range' : 'field'),
      text: (el.innerText || '').trim().slice(0, 40),
      computed: VE_readComputedStyle(el),
      inline: VE_readInlineState(el),
      saved,
    });
  }
  function buildElBar(el){
    const bar = document.createElement('div');
    bar.className = 've-el-bar';
    const fieldPath = el.getAttribute('data-field');
    const itemPath  = el.getAttribute('data-ve-item');
    const kind      = el.getAttribute('data-ve-kind') || '';
    const groupId   = el.getAttribute('data-ve-group');
    const btns = [];
    if (fieldPath || el.getAttribute('data-static-text')) btns.push(`<button data-a="text">✎ 改文字</button>`);
    if (itemPath)  btns.push(`<button data-a="del">${kind.indexOf('media') === 0 ? '🗑 删除媒体' : '🗑 删除'}</button>`);
    if (groupId)   btns.push(`<button data-a="add-in">＋ 在此分类添加</button>`);
    // 没有可删除路径的图片（AI 项目封面 / 截图等，只有 data-ve-media-path）：同样给删除入口，
    // 否则这类图选中后只能缩放、删不掉。
    if (!itemPath && el.getAttribute && el.getAttribute('data-ve-media-path')){
      btns.push(`<button data-a="del-mediapath">🗑 删除图片</button>`);
    }
    if (!btns.length) btns.push(`<button data-a="none" disabled>不可编辑</button>`);
    bar.innerHTML = btns.join('');
    document.body.appendChild(bar);
    elBar = bar;
    positionElBar();
    bar.querySelectorAll('button').forEach(b => {
      b.onmousedown = e => e.stopPropagation();
      b.onclick = (e) => {
        e.preventDefault(); e.stopPropagation();
        const a = b.dataset.a;
        if (a === 'text') enterTextEdit(el);
        else if (a === 'del') toggleDelete(el, b);
        else if (a === 'del-mediapath'){
          const mp2 = el.getAttribute('data-ve-media-path') || '';
          if (!mp2) return;
          if (!window.confirm('删除这张图片？')) return;
          API.post({ type: 've-delete-media-path', path: mp2 });
        }
        else if (a === 'add-in') API.post({ type:'ve-add-here', groupId, mediaPath:'' });
      };
    });
  }
  // 图片选中工具条：删除 + 八向缩放手柄（四角 + 四边，自由缩放，整体可缩小/拉伸）+ 所属区块
  function buildImageBar(el, imgId){
    const bar = document.createElement('div');
    bar.className = 've-el-bar';
    const it = (window.__veImages || []).find(i => i.id === imgId) || {};
    // 「所属」文案按结构派生 + 运行时翻译；绝不直接用 it.aLabel（那是存盘写死的中文）。
    const label = veFreeAnchorLabel(it);
    // it.inplace = 「原图自己变自由摆放」（2026-09-23 用户第 ⑤ 项）→ 这时元素就是原图本身，
    // 唯一该给的动作是「回到普通排版」；真要删图请用媒体项条上的 🗑 删除此项 / 图片条上的 🗑 删除图片。
    bar.innerHTML = (it.inplace
        ? `<button data-a="unfree" title="这张图本身没有变，只是取消自由摆放、回到普通排版">↺ 恢复常规摆放</button>`
        : `<button data-a="del-img">🗑 删除图片</button>`)
      + `<span class="ve-bar-seg">所属</span><b class="ve-sec-name">${esc(label)}</b>`;
    document.body.appendChild(bar);
    elBar = bar;
    positionElBar();
    bar.querySelectorAll('button').forEach(b => {
      b.onmousedown = e => e.stopPropagation();
      b.onclick = (e) => {
        e.preventDefault(); e.stopPropagation();
        if (b.dataset.a === 'unfree'){ unfreeByKey(it.sourcePath || ''); return; }
        if (b.dataset.a === 'del-img') deleteFreeImage(el);
      };
    });
    // 八向缩放手柄：**必须挂在图片的父层上，不能塞进 <img> 里**。
    // <img> 是替换元素（replaced element），浏览器不给它布局任何子节点 ——
    // 手柄会被量成 0×0、offsetParent 为 null，鼠标永远点不到，
    // 于是"排版编辑里加的图片没有尺寸调整能力"（2026-09-22 实测到的真身）。
    // 挂到父层（.ve-free-layer，position:absolute）后，用图片自身的 offset* 换算位置即可。
    // ⚠ 「原地自由摆放」的原图仍在媒体栏/正文里，它的 offsetParent 才是它的包含块，
    //   而下面的 positionFreeHandles 用的正是 el.offsetLeft/offsetTop（相对包含块）
    //   → 所以宿主必须取 offsetParent，取 parentNode 会在多层 relative 下错位。
    if (el.__veFreeHandles) el.__veFreeHandles.forEach(h => h.remove());
    const handleHost = el.offsetParent
      || ((el.parentNode && el.parentNode.nodeType === 1) ? el.parentNode : document.body);
    el.__veFreeHandles = ['nw','ne','sw','se','n','s','w','e'].map(dir => {
      const h = document.createElement('div');
      h.className = 've-free-handle ve-fh-' + dir + ' ve-on';
      h.dataset.dir = dir;
      h.style.margin = '0';        // 清掉 .ve-fh-n/.ve-fh-s 的 margin-left:-6px，位置一律用 inline left/top 算
      h.title = '拖动缩放（四角可整体缩小/拉伸，四边单向）';
      handleHost.appendChild(h);
      h.addEventListener('pointerdown', (e) => startFreeResize(el, dir, e));
      return h;
    });
    positionFreeHandles(el);
  }
  /** 把八向手柄按图片当前的 offset* 摆到父层里（图片一移动/缩放就要跟着重算）。 */
  function positionFreeHandles(el){
    if (!el || !el.__veFreeHandles) return;
    const L = el.offsetLeft, T = el.offsetTop, W = el.offsetWidth, H = el.offsetHeight;
    const at = {
      nw:[L-7,T-7], n:[L+W/2-6,T-7], ne:[L+W-7,T-7],
      w:[L-7,T+H/2-6],                 e:[L+W-7,T+H/2-6],
      sw:[L-7,T+H-7], s:[L+W/2-6,T+H-7], se:[L+W-7,T+H-7]
    };
    el.__veFreeHandles.forEach(h => {
      const p = at[h.dataset.dir];
      if (!p) return;
      h.style.left = p[0] + 'px';
      h.style.top = p[1] + 'px';
    });
  }
  // ================= 媒体栏内嵌编辑（图片 + 视频同栏） =================
  // 用户要求：不要再靠右侧的「媒体的位置与尺寸 / 添加图片」面板，
  // 直接在画布上对项目媒体栏做三件事：
  //   1) 拖右下角手柄 = 改宽度（写入 design.imgSizes[path].widthPct，与作品集/文本编辑共享同一份数据）
  //   2) 横向拖动媒体栏本体 = 换到左边 / 右边（写入 design.mediaLayout[path].side）
  //   3) 媒体栏上的按钮 = 加图片 / 加视频 / 清空（图片和视频都收在同一条媒体栏里，比例一致）
  const mediaPathOf = box => (box && box.getAttribute('data-ve-media-box')) || '';
  const mediaProjectIndex = box => {
    const m = /^projects\.(\d+)\.media$/.exec(mediaPathOf(box));
    return m ? Number(m[1]) : -1;
  };
  function applyMediaSide(box, side){
    box.classList.toggle('media-left', side === 'left');
    const grid = box.closest('.project-detail');
    if (grid) grid.classList.toggle('media-on-left', side === 'left');
  }
  function buildMediaBoxBar(box){
    const path = mediaPathOf(box);
    const side = box.classList.contains('media-left') ? 'left' : 'right';
    const bar = document.createElement('div');
    bar.className = 've-el-bar ve-media-bar';
    bar.innerHTML = `<button data-a="side" title="把整条媒体栏切到另一侧">⇄ 放到${side === 'left' ? '右' : '左'}边</button>`
      + `<button data-a="img" title="上传图片并放进这个项目">🖼 加图片</button>`
      + `<button data-a="video" title="上传视频并放进这个项目">🎬 加视频</button>`
      + `<button data-a="del" title="清空这个项目的所有媒体">🗑 清空媒体</button>`;
    document.body.appendChild(bar);
    elBar = bar;
    positionElBar();
    bar.querySelectorAll('button').forEach(b => {
      b.onmousedown = e => e.stopPropagation();
      b.onclick = (e) => {
        e.preventDefault(); e.stopPropagation();
        const a = b.dataset.a;
        if (a === 'side') {
          const next = box.classList.contains('media-left') ? 'right' : 'left';
          applyMediaSide(box, next);
          API.post({ type: 've-commit-medialayout', path, side: next });
          toastInCanvas(next === 'left' ? '媒体栏已放到左边' : '媒体栏已放到右边');
        } else if (a === 'img' || a === 'video') {
          pickAndAttachMedia(a === 'video' ? 'video' : 'image', mediaProjectIndex(box));
        } else if (a === 'del') {
          if (!window.confirm('清空这个项目的所有媒体（图片 / 视频 / 音频）？此操作可在「文本编辑」里撤销。')) return;
          API.post({ type: 've-clear-media', path });
        }
      };
    });
    // 缩放手柄不再在这里造：媒体栏被选中时会作为「可调对象」拿到正式的 6 个手柄
    // （见 selectSizeTarget / makeSizeHandles）。这里再放一个 ◢ 会和那 6 个重影，
    // 而且它不受「选中项才显示 / 滚出视口就隐藏」管理，会变成屏幕上"莫名其妙卡着的方块"。
    // 横向拖动媒体栏本体：往左拖 = 放到左边，往右拖 = 放到右边
    if (!box.__veMediaDrag){
      box.__veMediaDrag = true;
      box.addEventListener('pointerdown', (e) => {
        if (mode !== 'select') return;
        if (e.button !== 0) return;
        if (e.target.closest('.ve-el-bar')) return;
        if (e.target.closest('video,audio')) return;       // 别干扰播放器控件
        const startX = e.clientX;
        let moved = false;
        const onMove = (ev) => {
          const dx = ev.clientX - startX;
          if (!moved && Math.abs(dx) < 16) return;
          moved = true; justDragged = true;
          applyMediaSide(box, dx > 0 ? 'right' : 'left');
        };
        const onUp = () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          if (!moved) return;
          const next = box.classList.contains('media-left') ? 'left' : 'right';
          API.post({ type: 've-commit-medialayout', path: mediaPathOf(box), side: next });
          toastInCanvas(next === 'left' ? '媒体栏已放到左边' : '媒体栏已放到右边');
          setTimeout(() => { justDragged = false; }, 30);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      });
    }
  }
  // 直接从画布上传媒体：iframe 与服务器同源，先 POST /api/upload 拿到 /media 引用（不写 base64），
  // 再由父窗口（Visual Editor）把它合并进对应项目的 media 字段并保存草稿。
  function pickAndAttachMedia(slot, projectIndex){
    if (projectIndex < 0){ toastInCanvas('请先点中一个项目的媒体栏，再上传'); return; }
    const inp = document.createElement('input');
    inp.type = 'file';
    // ⚠ 2026-09-24：音频/视频写明确的格式清单，不用宽泛的 `audio/*`。
    //   宽泛通配在部分系统上筛不出文件（对话框里"看不到支持的格式"），用户以为不支持。
    //   明确列出 mp3 / wav / m4a / aac / ogg / flac 等，用户能一眼看到支持范围。
    inp.accept = slot === 'video' ? 'video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov,.m4v'
      : slot === 'audio' ? '.mp3,.wav,.m4a,.aac,.ogg,.oga,.opus,.flac,audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/aac,audio/ogg,audio/flac,audio/opus'
      : 'image/*';
    inp.style.display = 'none';
    document.body.appendChild(inp);
    inp.onchange = async () => {
      const f = inp.files && inp.files[0];
      inp.remove();
      if (!f) return;
      toastInCanvas('正在上传「' + f.name + '」…');
      try {
        const form = new FormData();
        form.append('file', f);
        form.append('kind', 'projects');
        const res = await fetch('/api/upload', { method: 'POST', body: form });
        const ref = await res.json();
        if (!ref || ref.error) throw new Error((ref && ref.error) || '上传失败');
        API.post({ type: 've-attach-media', project: projectIndex, slot, url: ref.url, name: ref.name || '', type: ref.type || '', warn: ref.warn || '' });
      } catch (err) {
        toastInCanvas('上传失败：' + (err && err.message ? err.message : err));
      }
    };
    inp.click();
  }
  // 工具条定位：absolute 相对 body，用与 body 的相对偏移，body 有任何 margin 都不会偏
  function positionElBar(){
    if (!elBar || !selEl) return;
    const r = selEl.getBoundingClientRect();
    const br = document.body.getBoundingClientRect();
    elBar.style.top  = Math.max(2, r.top - br.top - 30) + 'px';
    elBar.style.left = Math.max(2, r.left - br.left) + 'px';
  }
  function enterTextEdit(el){
    if (!el) return;
    // 静态元素（如 Selected works 眉标）：没有 data-field，但带 data-static-text 时也可改文字，
    // 文案存 design.staticText[id]（归 Template），交给父窗口落盘。
    const staticId = el.getAttribute && el.getAttribute('data-static-text');
    if (!el.getAttribute('data-field') && !staticId) return;
    clearTextEdit();
    el.setAttribute('contenteditable','true');
    el.classList.add('ve-field-editing');
    curEditEl = el;
    try { const r=document.createRange(); r.selectNodeContents(el); r.collapse(false); const s=window.getSelection(); s.removeAllRanges(); s.addRange(r); } catch(_){}
    el.focus();
    // 关键修复（2026-09-08 vS）：进 edit 后把该元素同步设为 VE 主页面 veSelection，
    // 否则右侧 applyTextLive 检测不到 veSelection 直接 return，色盘拖动没反应。
    try { selEl = el; notifySelection(el); } catch(_){}
  }
  // 删除要二次确认（点一次变「确认删除」，再点一次才真删），避免误删
  function toggleDelete(el, btn){
    if (!delArmed){
      delArmed = true;
      btn.classList.add('armed'); btn.textContent = '⚠ 确认删除';
      delTimer = setTimeout(disarmDelete, 3000);
      return;
    }
    disarmDelete();
    performDelete(el);
  }
  function performDelete(el){
    const itemPath = el && el.getAttribute('data-ve-item');
    if (!itemPath) return;
    const segs = itemPath.split('.');
    const last = segs[segs.length - 1];
    const isArrayIdx = /^\d+$/.test(last);
    // 数组项（projects.N / experience.N / ...）：本地先移除 DOM 并重排后续兄弟索引，避免刷新跳顶
    if (isArrayIdx){
      const idx = Number(last);
      el.remove();
      reindexAfterDelete(segs.slice(0, -1), idx);
    } else {
      // 非数组对象属性（profile.avatar）或静态元素（static:xxx）：直接移除 DOM，
      // 由父窗口按路径决定是 delete 末段 key（对象）还是记入 design.removedStatic（静态）。
      el.remove();
      if (itemPath.indexOf('static:') === 0){
        API.post({ type:'ve-delete-static', id: itemPath.slice('static:'.length) });
        clearSelection();
        return;
      }
    }
    clearSelection();
    API.post({ type:'ve-delete-item', path: itemPath });
  }
  // 数组删掉一项后，所有路径里「同数组且索引更大」的段都要 -1
  function reindexAfterDelete(prefixSegs, removedIdx){
    const bumpAttr = (el, attr) => {
      const p = el.getAttribute(attr); if (!p) return;
      const segs = p.split('.');
      if (segs.length <= prefixSegs.length) return;
      for (let i=0;i<prefixSegs.length;i++) if (segs[i] !== prefixSegs[i]) return;
      const n = Number(segs[prefixSegs.length]);
      if (!Number.isFinite(n)) return;
      if (n > removedIdx){ segs[prefixSegs.length] = String(n - 1); el.setAttribute(attr, segs.join('.')); }
    };
    ['data-ve-item','data-field','data-ve-media-path'].forEach(attr => {
      document.querySelectorAll('[' + attr + ']').forEach(el => bumpAttr(el, attr));
    });
    // 已存的文本样式也是按 data-field 路径索引的，必须一起前移，否则样式会贴到错的元素上
    const map = window.__veTextStyles || {};
    const next = {};
    Object.entries(map).forEach(([p, st]) => {
      const segs = p.split('.');
      let out = p;
      if (segs.length > prefixSegs.length) {
        let match = true;
        for (let i = 0; i < prefixSegs.length; i++) if (segs[i] !== prefixSegs[i]) { match = false; break; }
        if (match) {
          const n = Number(segs[prefixSegs.length]);
          if (Number.isFinite(n) && n > removedIdx) { segs[prefixSegs.length] = String(n - 1); out = segs.join('.'); }
        }
      }
      next[out] = st;
    });
    window.__veTextStyles = next;
    API.post({ type:'ve-commit-textstyles', textStyles: next });
  }

  // hover 高亮
  document.addEventListener('mousemove', (e) => {
    if (mode !== 'select') { if (hoverEl) clearHover(); return; }
    const t = operableTarget(e.target);
    if (t !== hoverEl){ clearHover(); hoverEl = t; if (t) t.classList.add('ve-el-hover'); }
  });
  // 选中：capture 阶段拦截，避免触发 <summary> 展开 / 复制按钮 / 链接跳转
  // 元素识别 + 改文字是最高优先级：点到文字就直接进入编辑，点到媒体/元素就选中它；
  // 展开/收起不再靠「点标题碰运气」，改由工具栏的「⌄ 展开」按钮统一控制。
  document.addEventListener('click', (e) => {
    // 「元素」模式点哪选哪；「图片尺寸」模式也允许选中媒体对象 ——
    // 这样像 PPT 一样：点一下对象就同时拿到手柄和操作条（换位置 / 对齐 / 复位）。
    if (mode !== 'select' && mode !== 'image') return;
    if (justDragged) return;   // 刚拖完，不当作选中
    // 展开 / 收起：capture 阶段绝不拦截 —— 必须让 .entry-btn 的 onclick 收到这次点击。
    // 否则下面的 preventDefault + stopPropagation 会把「展开」吞成「选中整块」，表现为点了没反应。
    if (e.target.closest && e.target.closest('.expand-label')) return;
    if (e.target.closest('.ve-toolbar') || e.target.closest('.ve-el-bar')) return;
    // 自己的手柄/辅助件不算「点空白」，别让点手柄把选中清掉
    if (e.target.closest('.ve-img-handle') || e.target.closest('.ve-col-divider') || e.target.closest('.ve-space-bar') || e.target.closest('.ve-gap-line')) return;
    // 图片尺寸模式：只认媒体对象，点别处一律当取消选中（不然顺手就把文字选进来、进入编辑）
    if (mode === 'image' && !e.target.closest('[data-ve-media-item],[data-ve-media-box],img.ve-resizable,video.ve-resizable,[data-ve-img]')){
      clearSelection();
      return;
    }
    // Pixel Character 例外：点击应该触发 jump/sway/walk 动画（hover/click 行为），
    // 而非「选中」（选中由 pointerdown 拖拽逻辑完成）。让 click 走自己的 listener。
    if (e.target.closest('.ve-pixel')) return;
    const t = operableTarget(e.target);
    if (t){
      e.preventDefault(); e.stopPropagation();
      selectElement(t);
      // 文字字段：选中即进入编辑，省掉「先点元素/改文字模式、再点文字」这一步
      if (t.hasAttribute && t.hasAttribute('data-field')) enterTextEdit(t);
      return;
    }
    clearSelection();
  }, true);
  // —— 拖动排序 + 吸附指示线 ——
  // 作品集是流式文档布局，所以「移动」= 改变它在同级数组里的顺序。
  // 拖动时实时找最近的插入槽并画一条吸附指示线，对齐到页面中心时还会出现居中参考线。
  let dragEl = null, dragX0 = 0, dragY0 = 0, dragMoved = false, dropInd = null, centerGuide = null, justDragged = false;

  function itemSegs(el){ return (el.getAttribute('data-ve-item') || '').split('.'); }
  function siblingsOf(el){
    const segs = itemSegs(el);
    if (segs.length < 2) return [];
    // 只有「数组中的一项」（路径最后一段是数字下标）才有排序意义。
    // 媒体栏这类 projects.N.media 只是对象属性，不参与拖动排序。
    if (!/^\d+$/.test(segs[segs.length - 1] || '')) return [];
    const prefix = segs.slice(0, -1).join('.');
    return [...document.querySelectorAll('[data-ve-item]')].filter(x => {
      const q = itemSegs(x);
      return q.length === segs.length && q.slice(0, -1).join('.') === prefix;
    });
  }
  // 找到离当前指针最近的插入槽（某个兄弟的上边或下边）
  function findDropSlot(y){
    const sibs = siblingsOf(dragEl);
    let best = null, bestDist = Infinity, before = true;
    sibs.forEach(s => {
      if (s === dragEl) return;
      const r = s.getBoundingClientRect();
      const dTop = Math.abs(y - r.top);
      const dBot = Math.abs(y - r.bottom);
      if (dTop < bestDist){ bestDist = dTop; best = s; before = true; }
      if (dBot < bestDist){ bestDist = dBot; best = s; before = false; }
    });
    return best ? { el: best, before } : null;
  }
  function showGuides(y, slot, elRect){
    const bRect = document.body.getBoundingClientRect();
    if (!dropInd){
      dropInd = document.createElement('div');
      dropInd.className = 've-drop-indicator';
      document.body.appendChild(dropInd);
    }
    if (slot){
      const r = slot.el.getBoundingClientRect();
      const top = (slot.before ? r.top : r.bottom);
      dropInd.style.top = (top - bRect.top) + 'px';
      const w = r.width, left = r.left - bRect.left;
      dropInd.style.left = left + 'px';
      dropInd.style.width = w + 'px';
    }
    // 居中参考线：元素水平中心接近页面中心时吸附提示
    if (!centerGuide){
      centerGuide = document.createElement('div');
      centerGuide.className = 've-center-guide';
      document.body.appendChild(centerGuide);
    }
    const cx = elRect.left + elRect.width / 2;
    const pageCx = window.innerWidth / 2;
    const near = Math.abs(cx - pageCx) < 24;
    centerGuide.style.display = near ? 'block' : 'none';
    if (near){
      centerGuide.style.top = '0px';
      centerGuide.style.height = document.documentElement.scrollHeight + 'px';
      centerGuide.style.left = (pageCx - bRect.left) + 'px';
    }
  }
  function clearGuides(){
    if (dropInd){ dropInd.remove(); dropInd = null; }
    if (centerGuide){ centerGuide.remove(); centerGuide = null; }
  }

  document.addEventListener('mousedown', (e) => {
    if (mode !== 'select' || e.button !== 0) return;
    if (e.target.closest('.ve-toolbar') || e.target.closest('.ve-el-bar')) return;
    if (e.target.isContentEditable) return;
    const t = operableTarget(e.target);
    if (!t || !t.getAttribute('data-ve-item')) return;
    // 至少有两个同级元素才谈得上排序
    if (siblingsOf(t).length < 2) return;
    dragEl = t; dragX0 = e.clientX; dragY0 = e.clientY; dragMoved = false;
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragEl) return;
    const dy = e.clientY - dragY0, dx = e.clientX - dragX0;
    if (!dragMoved && Math.abs(dx) + Math.abs(dy) < 6) return;
    if (!dragMoved){ dragMoved = true; dragEl.classList.add('ve-el-dragging'); }
    const slot = findDropSlot(e.clientY);
    showGuides(e.clientY, slot, dragEl.getBoundingClientRect());
  });
  document.addEventListener('mouseup', (e) => {
    if (!dragEl) return;
    const el = dragEl; dragEl = null;
    el.classList.remove('ve-el-dragging');
    clearGuides();
    if (!dragMoved) return;
    justDragged = true;
    setTimeout(() => { justDragged = false; }, 60);
    const slot = findDropSlot(e.clientY);
    if (!slot) return;
    // 用「移动后的完整路径顺序」描述结果，避免各种索引边界算错
    const self = el.getAttribute('data-ve-item');
    const arr = siblingsOf(el).map(s => s.getAttribute('data-ve-item')).filter(p => p !== self);
    let ins = arr.indexOf(slot.el.getAttribute('data-ve-item'));
    if (ins < 0) return;
    if (!slot.before) ins += 1;
    arr.splice(ins, 0, self);
    if (arr.join('|') === siblingsOf(el).map(s => s.getAttribute('data-ve-item')).join('|')) return; // 顺序没变
    clearSelection();
    API.post({ type: 've-reorder', order: arr });
  });

  // 双击直接进入文字编辑（PPT 习惯：单击选中，双击进编辑）
  document.addEventListener('dblclick', (e) => {
    if (mode !== 'select') return;
    if (e.target.closest('.ve-toolbar') || e.target.closest('.ve-el-bar')) return;
    const t = operableTarget(e.target);
    if (t && (t.getAttribute('data-field') || t.getAttribute('data-static-text'))){ e.preventDefault(); e.stopPropagation(); enterTextEdit(t); }
  }, true);
  // Delete / Backspace 删除选中项
  document.addEventListener('keydown', (e) => {
    if (mode !== 'select' || !selEl) return;
    const t = e.target;
    if (t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    if (e.key === 'Delete' || e.key === 'Backspace'){ e.preventDefault(); performDelete(selEl); }
    else if (e.key === 'Escape'){ clearSelection(); }
  });
  // 元素模式也要能随滚动/重排跟住工具条
  window.addEventListener('scroll', () => { if (mode === 'select') positionElBar(); }, { passive:true });
  window.addEventListener('resize', () => { if (mode === 'select') positionElBar(); });

  // ================= 挪间距 =================
  // 每个间距控件定义一条「真实视觉空隙」。杆用 position:fixed 悬浮在空隙上，
  // 并随页面滚动 / 窗口缩放实时 reposition（scroll / resize 时重算锚点），
  // 避免页面往下滚后杆还停在原地让人搞不清对应哪一处。
  const DEFAULTS = {
    topSpace: 75, heroNameGap: 0, heroPad: 48, metaTop: 40, dirGap: 42, entryGap: 0, footerTop: 80,
    footerBottom: 28
  };
  // 所有间距键都不允许为负：负值会让「下面这块内容往上盖住上面那块」，
  // 用户看到的是"这块内容不见了 / 间距没生效"。保留这个集合是为了兼容旧引用。
  const NONNEG_KEYS = new Set(['topSpace','heroNameGap','heroPad','metaTop','dirGap','entryGap','footerTop','footerBottom']);
  function renderSpaceBars(){
    clearSpaceUI();
    const cur = window.__veSpacing || {};
    const bar = (label, key, cfg) => {
      // cfg: {aboveBetween:null} 或 {up,low} 或 {beforeEl, inset}
      const b = document.createElement('div');
      b.className = 've-space-bar';
      b.title = label + '：上下拖动调整，或点击右侧数值直接输入';
      const v0 = Math.round(cur[key] != null ? cur[key] : (DEFAULTS[key] != null ? DEFAULTS[key] : 0));
      b.innerHTML = `<span class="ve-space-label">${label}</span><span class="ve-space-val">${v0}px</span>`;
      b._key = key; b._cfg = cfg; b._label = label; b._topOffset = (cfg && typeof cfg.topOffset === 'number') ? cfg.topOffset : 0;
      document.body.appendChild(b);
      // —— 缝隙虚线：既是"这条缝能调"的提示，也是整条缝的拖拽把手 ——
      // 旧版只有一颗 150px 的药丸，既压在画布正中间、又难抓；现在细线横跨内容列，
      // 鼠标碰到线就把左侧的小把手展开成完整标签。
      const line = document.createElement('div');
      line.className = 've-gap-line';
      line.title = label + '：上下拖这条虚线调间距；把左边的小把手展开后，点数值可直接输入';
      document.body.appendChild(line);
      b._line = line; line._bar = b;
      const openBar = () => { b.classList.add('open'); line.classList.add('live'); };
      const closeBar = () => { if (!b.classList.contains('dragging')){ b.classList.remove('open'); line.classList.remove('live'); } };
      b.addEventListener('mouseenter', openBar);
      b.addEventListener('mouseleave', closeBar);
      line.addEventListener('mouseenter', openBar);
      line.addEventListener('mouseleave', closeBar);
      line.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); startDrag(b, e); });
      b.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); startDrag(b, e); };
      // —— 数值可直接输入 ——
      // 拖杆适合"看着感觉调"，但要"底部就留 150px 这么长"时，敲数字才精确、可复现。
      // 点数字 → 变输入框 → 回车 / 失焦提交；提交走的是与拖拽**完全相同**的
      // setSpacing + ve-commit-space 通道，所以父窗口的落盘、回读校验、通知 Studio 全都一致，
      // 不会出现"输入的值存不住 / 退出后又变回去"。
      const valEl = b.querySelector('.ve-space-val');
      if (valEl) {
        valEl.title = '点击可直接输入像素值（0 - ' + SPACE_MAX + '）';
        valEl.style.cursor = 'text';
        valEl.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
        valEl.addEventListener('click', (e) => {
          e.preventDefault(); e.stopPropagation();
          if (valEl.querySelector('input')) return;
          const c0 = String(valEl.textContent || '').replace(/[^\d.-]/g, '') || '0';
          valEl.innerHTML = `<input type="number" min="0" max="${SPACE_MAX}" step="1" value="${c0}"`
            + ` style="width:58px;padding:1px 3px;font:inherit;text-align:center;border:1px solid currentColor;border-radius:4px;background:transparent;color:inherit">`;
          const inp = valEl.querySelector('input');
          if (!inp) return;
          inp.focus(); inp.select();
          let done = false;
          const commit = () => {
            if (done) return; done = true;
            let v = parseFloat(inp.value);
            if (!isFinite(v)) v = parseFloat(c0) || 0;
            v = Math.max(0, Math.min(SPACE_MAX, Math.round(v)));
            setSpacing(key, v);
            valEl.textContent = v + 'px';
            API.post({ type:'ve-commit-space', spacing: Object.assign({}, window.__veSpacing || {}) });
            repositionSpaceBars();
          };
          inp.addEventListener('keydown', (ev) => {
            ev.stopPropagation();
            if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
            else if (ev.key === 'Escape') { ev.preventDefault(); done = true; valEl.textContent = c0 + 'px'; }
          });
          inp.addEventListener('blur', () => commit());
        });
      }
      return b;
    };
    // —— 通用「上元素下边缘 ↔ 下元素上边缘」的中点 ——
    //   sel 既可以是选择器字符串，也可以**直接是元素**：有些缝隙的锚点没法用选择器唯一定位，
    //   例如"目录正上方那一块"到底是 .meta-band 还是别的，得按 DOM 相邻关系取才准。
    const pickEl = s => (s && s.nodeType === 1) ? s : (s ? document.querySelector(s) : null);
    const between = (upSel, lowSel) => {
      const up = pickEl(upSel), low = pickEl(lowSel);
      if (!up || !low) return null;
      return { upSel, lowSel };
    };
    const cfgTop    = between('.top', '.hero .eyebrow');                            // 顶部栏 → 眉标 之间的大段留白
    const cfgName   = between('.hero .eyebrow', '.hero h1');                       // 眉标 → 姓名（同一块内容内部的小间距）
    const cfgHero   = between('.hero .intro', '.hero-rule');                       // 姓名/简介 → 第一条横线
    const cfgMeta   = between('.hero', '.meta-band');                              // 横线 → Contact/技能
    // ⚠ 2026-09-24 修：原来写 `between('.meta-band, .hero', '.directory')`。
    //   逗号选择器交给 querySelector 时返回**文档里靠前**的那个 —— 也就是 `.hero`；
    //   于是中点成了 (hero 底 + 目录顶) / 2，而次展示区正好夹在这两者之间，
    //   这条"内容与目录间距"的虚线其实一直飘在次展示区**内部**。
    //   以前它恰好落在两块之间的空白上、没人发现；2026-09-24 展示区改版后落到了 Contact
    //   那一行字上，被守门用例 `qa/spacing-overlay-no-block.cjs` 抓到（用户反馈的
    //   「有个条挡在画布中间」正是这一类的表现）。
    //   正确锚点 = **目录正上方那一块**（按 DOM 相邻关系取 previousElementSibling），
    //   这样缝才真的是"上方内容 ↔ 目录"，虚线落在两条横线之间的真实空隙里。
    const dirEl = document.querySelector('.directory');
    const dirUpEl = dirEl ? dirEl.previousElementSibling : null;
    const cfgDir = (dirEl && dirUpEl && dirUpEl !== dirEl) ? between(dirUpEl, dirEl) : null;
    // 「目录与页脚间距」的杆要贴在**页脚正上方**那道缝里：有 Resume 区块时就是
    // Resume ↔ 页脚之间。旧写法取「.directory → .footer」的中点，加上 Resume 之后
    // 那个中点落在 Resume 区块内部，杆看起来飘在半空、很难找（用户反馈"脚注的间距调不了"）。
    const footEl = document.querySelector('.footer');
    const prevOfFoot = footEl ? footEl.previousElementSibling : null;
    const cfgFoot = (footEl && prevOfFoot && prevOfFoot.classList && prevOfFoot.classList.contains('resume'))
      ? { upSel:'.resume', lowSel:'.footer' }
      : between('.directory', '.footer');
    // 目录内各 entry 之间的统一间距（只在第二个 entry 上方放一根代表杆）
    const entries = document.querySelectorAll('.directory > .entry');
    if (cfgTop) bar('页面顶部留白', 'topSpace', { upSel:cfgTop.upSel, lowSel:cfgTop.lowSel, alignSel:'.hero' });
    if (cfgName) bar('眉标与姓名的间距', 'heroNameGap', cfgName);
    if (cfgHero) bar('姓名/简介到横线', 'heroPad', { upSel:cfgHero.upSel, lowSel:cfgHero.lowSel, alignSel:'.hero' });
    if (cfgMeta) bar('横线到下方内容', 'metaTop', { upSel:cfgMeta.upSel, lowSel:cfgMeta.lowSel, alignSel:'.meta-band' });
    if (cfgDir) bar('内容与目录间距', 'dirGap', { upSel:cfgDir.upSel, lowSel:cfgDir.lowSel, alignSel:'.directory' });
    if (entries.length >= 2) bar('区块之间的间距', 'entryGap', { beforeEl: entries[1], alignSel:'.directory' });
    if (cfgFoot) bar('目录与页脚间距', 'footerTop', { upSel:cfgFoot.upSel, lowSel:cfgFoot.lowSel, alignSel:'.footer' });
    // —— 页脚下方留白：**已改为固定值**（2026-09-19）——
    // 用户反馈：这根杆只能把间距越拖越大、收不回去，还经常和别的杆打架。
    // 现在与「页面顶部留白」(topSpace=75) 对称，固定为 SAME，不再提供独立拖动杆。
    // 仍保留 :root{--ff-page-bottom} 变量（供 styles.css 读取），只是值恒定。

    repositionSpaceBars();
    // 字体/图片/Resume 是异步落位的，量出来的几何会晚一点才稳定（尤其是从 URL 的
    // ?ve-mode=space 直接进模式时）。补几次重算，免得把手一开始钉在错的位置上。
    [120, 500, 1200].forEach(ms => setTimeout(() => { if (mode === 'space') repositionSpaceBars(); }, ms));
    // 从 URL 的 ?ve-mode=space 直接进模式时，画布内容（模板数据）可能还没渲染完，
    // 连 .hero / .footer 都还不存在 → 一根杆都建不出来，用户看到的是"进了模式但什么都没有"。
    // 这里补一次重试，最多 10 次（约 3 秒）。
    if (!document.querySelector('.ve-space-bar')) {
      renderSpaceBars._retry = (renderSpaceBars._retry || 0) + 1;
      if (renderSpaceBars._retry <= 10) {
        setTimeout(() => { if (mode === 'space') renderSpaceBars(); }, 300);
      }
    } else {
      renderSpaceBars._retry = 0;
    }
  }
  // 依据锚点实时重算每根杆的位置。杆是 absolute（相对 body.ve-embed），
  // 这里统一转成「文档坐标」= getBoundingClientRect(视口) + window.scrollX/Y，
  // 因此杆钉在对应空隙的文档位置上，页面滚动时天然跟着走、不飘不乱。
  //
  // 2026-09-22：横向不再取"内容列中点"（那正好是画布正中间，7 颗药丸叠着压住正文），
  // 而是把收起的把手塞进**左侧页边距**（.shell 的 42px padding 里），缝隙线横跨内容列。
  const GRIP_MAX = 25;    // 与 .ve-space-bar 默认 --ve-grip-w 一致（桌面画布用这个宽度）
  const GRIP_MIN = 14;    // 手机画布（.shell 只有 20px 留白）时的下限，仍能容下 ↕
  const GRIP_GUTTER = 5;  // 把手右边缘与内容列左边缘之间留的空隙
  const ARROW_W = 11;     // ↕ 字形宽度，用来算收窄后左右 padding
  function repositionSpaceBars(){
    document.querySelectorAll('.ve-space-bar').forEach(b => {
      const cfg = b._cfg; if (!cfg) return;
      // 锚点可以是选择器字符串，也可以直接是元素（见 renderSpaceBars 里的 between/pickEl）
      const r = (sel) => { const e = (sel && sel.nodeType === 1) ? sel : (sel ? document.querySelector(sel) : null); return e ? e.getBoundingClientRect() : null; };
      let cy = null, lx = null, rx = null;
      if (cfg.upSel && cfg.lowSel){
        const ru = r(cfg.upSel), rl = r(cfg.lowSel);
        if (ru && rl){
          cy = (ru.bottom + rl.top) / 2;
          lx = Math.min(ru.left, rl.left); rx = Math.max(ru.right, rl.right);
        }
      } else if (cfg.beforeEl){
        const re = cfg.beforeEl.getBoundingClientRect();
        cy = re.top; lx = re.left; rx = re.right;
      } else if (cfg.afterEl){
        // 挂在某个元素「下边缘之下」：用于页面底边这种没有实体元素的空隙。
        // afterKey 存在时，偏移量取该间距键当前值的一半 → 杆始终待在这道缝的中间。
        const re = cfg.afterEl.getBoundingClientRect();
        const off = cfg.afterKey
          ? Math.max(12, Math.round(((window.__veSpacing || {})[cfg.afterKey] != null
              ? window.__veSpacing[cfg.afterKey]
              : (DEFAULTS[cfg.afterKey] != null ? DEFAULTS[cfg.afterKey] : 0)) / 2))
          : (cfg.afterOffset || 0);
        cy = re.bottom + off; lx = re.left; rx = re.right;
      }
      if (cy != null){
        b.style.top = (cy + window.scrollY + (b._topOffset || 0)) + 'px';
        if (b._line) b._line.style.top = (cy + window.scrollY - 4) + 'px';
      }
      if (lx != null){
        // 收起的把手右边缘贴住内容列左边缘。页边距不够（手机画布只有 20px）时整体收窄，
        // 保证它始终待在留白里、绝不压到内容列上；只有在悬停/拖动展开时才临时向右盖过去。
        const gw = Math.max(GRIP_MIN, Math.min(GRIP_MAX, lx - GRIP_GUTTER));
        const pad = Math.max(1, Math.round((gw - ARROW_W) / 2));
        b.style.setProperty('--ve-grip-w', gw + 'px');
        b.style.setProperty('--ve-grip-pad', pad + 'px');
        b.style.left = (Math.max(0, lx - GRIP_GUTTER - gw) + window.scrollX) + 'px';
        if (b._line){
          b._line.style.left = (lx + window.scrollX) + 'px';
          b._line.style.width = Math.max(80, (rx != null ? rx : lx) - lx) + 'px';
        }
      }
    });
  }
  function startDrag(bar, e){
    const key = bar._key;
    const cur = Object.assign({}, window.__veSpacing || {});
    const startY = e.clientY;
    const startPx = (cur[key] != null ? cur[key] : (DEFAULTS[key] != null ? DEFAULTS[key] : 0));
    // 拖动期间锁住展开态：鼠标往下走会离开那颗 25px 的小把手，不能让它中途缩回去
    bar.classList.add('dragging');
    if (bar._line) bar._line.classList.add('live');
    const onMove = (ev) => {
      const dy = ev.clientY - startY;
      // 向下拖=留白变多（正）；向上=变少。统一夹到 [0, SPACE_MAX]，不再允许负值。
      let px = VE_clampGap(startPx + dy, startPx);
      setSpacing(key, px);
      const v = bar.querySelector('.ve-space-val'); if (v) v.textContent = Math.round(px) + 'px';
      // 空隙变化 → 让所有杆跟随最新几何位置
      repositionSpaceBars();
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      bar.classList.remove('dragging');
      if (bar._line) bar._line.classList.remove('live');
      // ⚠️ 值要「随消息一起」交给父窗口去落盘，不能让父窗口收到通知后再回头问 iframe 要：
      // 这中间只要画布被重新加载（保存 / 面板同步 / 切模板都会触发），父窗口问到的就是
      // 重载后从服务器读回来的旧值 —— 表现正是「我拖到 220，一保存又变回 427」。
      API.post({ type:'ve-commit-space', spacing: Object.assign({}, window.__veSpacing || {}) });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }
  function setSpacing(key, px){
    const cur = Object.assign({}, window.__veSpacing || {});
    cur[key] = VE_clampGap(px, cur[key]);
    window.__veSpacing = cur;
    VE_applySpacingToDom(cur);
  }
  function clearSpaceUI(){
    document.querySelectorAll('.ve-space-bar').forEach(b => b.remove());
    document.querySelectorAll('.ve-gap-line').forEach(l => l.remove());
  }
  // 页面滚动 / 缩放时让间距杆与图片手柄跟着内容走。
  // 图片手柄现在由 rAF 持续同步（positionSizeUI），滚动时只需顺手补一次"刚进视口"的标记。
  let veImgRebuildTimer = null;
  function scheduleImageHandlesRebuild(){
    positionSizeUI();
    sweepSizeTargets();
    if (veImgRebuildTimer) clearTimeout(veImgRebuildTimer);
    veImgRebuildTimer = setTimeout(() => { veImgRebuildTimer = null; if (mode === 'image') sweepSizeTargets(); }, 220);
  }
  window.addEventListener('scroll', () => { if (mode === 'space') repositionSpaceBars(); if (mode === 'image') scheduleImageHandlesRebuild(); positionBottomBar(); }, { passive:true });
  window.addEventListener('resize', () => { if (mode === 'space') repositionSpaceBars(); if (mode === 'image') scheduleImageHandlesRebuild(); else positionBottomBar(); });

  // ================= 图片尺寸（PPT 式） =================
  // 原则：画布上任何一张图片 / 媒体栏都能像 PPT 里那样直接拖手柄改大小，并带虚线对齐辅助。
  // 唯一事实来源是 design.imgSizes[key] = { widthPct }：
  //   · 媒体栏   key = 元素上的 data-ve-media-box（如 projects.0.media）→ 作用在 --pm-w
  //   · 普通图片 key = data-ve-media-path；没有的话退化为 auto:<站点相对路径> → 作用在 img 的 width%
  // 画布与最终作品集读同一份数据、走同一个应用函数，所以两边永远一致。
  let imgState = null;
  // 本轮新增：手柄只给「选中项」，位置由 rAF 持续同步
  let veSizeSel = null;        // 当前选中的可调对象（媒体项 / 媒体栏 / 散图）
  let veSizeTargets = [];      // 本模式下所有可调对象（虚线轮廓 + 点击命中）
  let veRafId = 0;             // 位置同步的 rAF 句柄
  const VE_REF_SELECTOR = '.project-detail,.entry-body,.entry,.ai-project,.ai-project-card,.showreel-project,.shell';
  function veImgKeyOf(el){
    if (!el || !el.getAttribute) return '';
    // 单个媒体项（图片 / 视频 / 音频）优先：它才是「独立缩放」的对象
    const mi = el.getAttribute('data-ve-media-item');
    if (mi) return mi;
    const box = el.getAttribute('data-ve-media-box');
    if (box) return box;
    const p = el.getAttribute('data-ve-media-path');
    if (p) return p;
    const src = String(el.currentSrc || el.src || '').split('?')[0].replace(/^https?:\/\/[^/]+/, '');
    return src ? 'auto:' + src : '';
  }
  // 参照宽度必须是「稳定容器」，否则会越拖越漂：
  //   · 媒体项 → 它所在的媒体容器（侧栏 .media-stack 或「正文下方」.project-media-below），
  //     容器宽度由分栏比例决定、不会被这一项自己的宽度带偏 → 百分比语义稳定
  //   · 其他   → 最近的大容器
  function veRefWidthOf(el){
    if (el.hasAttribute && el.hasAttribute('data-ve-media-item')){
      const p = el.parentElement;
      return Math.max(1, (p && p.clientWidth) || el.getBoundingClientRect().width || 1);
    }
    const ref = el.closest(VE_REF_SELECTOR) || el.parentElement;
    return Math.max(1, (ref && ref.clientWidth) || (el.parentElement && el.parentElement.clientWidth) || el.getBoundingClientRect().width || 1);
  }
  function veApplyWidth(el, pct){
    if (el.hasAttribute && el.hasAttribute('data-ve-media-item')){
      // 媒体项：只改自己这一项的宽度，同栏的图片 / 视频**互不影响**
      el.style.setProperty('--pmi-w', pct + '%');
      return;
    }
    if (el.hasAttribute && el.hasAttribute('data-ve-media-box')){
      el.style.setProperty('--pm-w', pct + '%');
      // 关键：CSS 的 grid-template-columns:...var(--pm-w) 写在「父」.project-detail 上，
      // 而 CSS 自定义属性不会向上继承 → 只写在媒体栏上是没用的（一直回落到 38%）。
      const grid = el.closest('.project-detail');
      if (grid) grid.style.setProperty('--pm-w', pct + '%');
    } else el.style.width = pct + '%';
  }
  // 折叠的条目里图片宽高为 0 → 手柄被定位到画布左上角外面（用户看到的就是"没有手柄"）。
  // 进尺寸模式先把条目全展开：只改 DOM 状态，不写数据、不触发 scrollIntoView。
  function veExpandAllForResize(){
    document.querySelectorAll('.entry').forEach(en => {
      if (en.classList.contains('open')) return;
      en.classList.add('open');
      const t = en.querySelector('.expand-text'); if (t) t.textContent = ffT('public.collapse','收起');
    });
    document.querySelectorAll('details').forEach(d => { d.open = true; });
  }
  function renderImageHandles(){
    clearImageUI();
    veExpandAllForResize();
    // 展开/折叠带过渡动画时，刚展开的元素这一帧尺寸还是 0；
    // 300ms 后按同一套规则再扫一次（幂等），保证动画结束后所有对象都被标记为可调。
    const n = buildImageHandles(false);
    setTimeout(() => {
      if (document.documentElement.classList.contains('ve-m-image')) buildImageHandles(true);
    }, 300);
    startSizeRaf();
    return n;
  }
  // —— 手柄位置的实时同步（本轮新增）——
  // 之前只在 scroll / resize 时重算，所以「展开某条目、删掉一条、媒体加载完」这类
  // 布局变化不会触发重算 → 手柄停在旧位置（用户反馈：「莫名其妙的东西跟随着，划走之后还在」）。
  // 用 rAF 持续同步：目标不在可视带内就隐藏，绝不飘在无关内容上。
  function startSizeRaf(){
    if (veRafId) return;
    let tick = 0;
    const loop = () => {
      veRafId = requestAnimationFrame(loop);
      if (mode !== 'image'){ stopSizeRaf(); return; }
      if (tick++ % 2) return;   // 隔帧刷新即可，肉眼无差别，CPU 减半
      positionSizeUI();
    };
    veRafId = requestAnimationFrame(loop);
  }
  function stopSizeRaf(){
    if (veRafId){ cancelAnimationFrame(veRafId); veRafId = 0; }
  }
  function sizeUIVisible(r){
    if (!r || r.width < 4 || r.height < 4) return false;
    const vh = window.innerHeight || 1200;
    return r.bottom > 4 && r.top < vh - 4;   // 完全滚出可视带的对象，不显示手柄
  }
  function positionSizeUI(){
    // ⓪ 底部伸缩杆：每帧跟着页面底边走（改留白、改内容高度都会动）
    ensureBottomBar();
    // ① 选中对象的手柄 + ⠿
    if (veSizeSel && veSizeSel.isConnected){
      const r = veSizeSel.getBoundingClientRect();
      if (sizeUIVisible(r)) positionHandlesFor(veSizeSel);
      else setHandlesDisplay(veSizeSel, 'none');
    }
    // ② 分栏分隔条
    document.querySelectorAll('.ve-col-divider').forEach(h => { if (h._colBox) positionColDivider(h, h._colDetail, h._colBox); });
    // ③ 工具条跟着选中对象走
    if (elBar && selEl && selEl.isConnected) positionElBar();
    // ④ 自动给「刚进入视口、之前没被标记」的对象补上虚线轮廓（滚动后才加载出来的图片）
    if (!document.body.dataset.veSweepTick || Date.now() - Number(document.body.dataset.veSweepTick) > 400){
      document.body.dataset.veSweepTick = String(Date.now());
      sweepSizeTargets();
      // 顺带把「容器当时没宽度 → 先按百分比/0 点占位」的自由图补成精确像素。
      // 折展开、字体加载完、图片加载完都可能改变容器宽度，只靠 ResizeObserver 会漏掉
      // 「观察之前就已经有宽度」的情况 —— 这里每 400ms 兜一次，代价可忽略。
      try { refitFreeInLayer(); } catch (_) {}
    }
  }
  // 给「刚可见」的对象补标记（幂等、不重建手柄）
  function sweepSizeTargets(){
    document.querySelectorAll('[data-ve-media-item]').forEach(el => {
      if (el.classList.contains('ve-size-target')) return;
      if (el.hasAttribute('data-ff-free')) return;   // 原地自由摆放的原图走自由层手柄，不进 PPT 尺寸体系
      const r = el.getBoundingClientRect();
      if (r.width >= 8 && r.height >= 8){
        el.classList.add('ve-size-target');
        el.setAttribute('data-ve-key', veImgKeyOf(el));
        makeSizeHandles(el, el === veSizeSel);
        veSizeTargets.push(el);
      }
    });
  }
  function setHandlesDisplay(el, disp){
    (el.__veHandles || []).forEach(h => { h.style.display = disp; });
    if (el.__veMoveHandle) el.__veMoveHandle.style.display = disp;
  }
  // 自由图落地用的图片地址：**存站内相对路径**，不存带 origin 的绝对地址。
  // 用户可能在 localhost:3000 打开、也可能在 127.0.0.1:3000 打开（甚至换端口），
  // 存绝对地址会让自由图在另一种入口下加载失败 → 又变成「刷新后看不到图」。
  // （实测历史数据里就有 http://localhost:3000/media/... 这种记录。）
  function freeSrcOf(el){
    const raw = String((el && (el.currentSrc || el.src)) || '');
    if (!raw) return '';
    try {
      const u = new URL(raw, location.href);
      if (u.origin === location.origin) return u.pathname + u.search;
      return raw;                       // 站外图片（外部链接）保持原样
    } catch (_) { return raw; }
  }
  /* 让「页面里本来就有的那张图」自己变成自由摆放 —— 不新增副本、不隐藏原图。
   * 2026-09-23 用户第 ⑤ 项原话：「我点完自由摆放之后，它会重新生成一个图……按道理你自由摆放
   * 的话，应该就是本身的那个图片可以变成自由摆放的模式啊。」（旧实现是「隐藏原图 + 克隆一张」，
   * 画布上看起来多出一张，删原图还会连带删克隆。）
   * 现在：design.images[] 里记一条 inplace:true、sourcePath = 这张图自己的键；
   *   imgPos[key] = { place:'free' } 保留（历史数据与右侧统筹区都读它，渲染侧据此不再隐藏原图）；
   *   元素上打 data-ff-free + data-ve-img，直接进自由层既有的拖动 / 缩放 / 吸附 / 落盘机制。
   * key 一律用「媒体项 key」（带 #imageK，每图唯一）或「内容路径」，绝不能用共用的 media 路径。 */
  function freeBindOwnElement(el, key, labelFallback){
    if (!el || !key) return false;
    // ⚠ 2026-10-01（用户实测 BUG）：旧写法只认 <img>，其余一律去后代里找 <img>。
    //   <video>（C 区媒体项视频 / E 区 AI Project 视频）里根本没有 img → src 为空 →
    //   本函数直接 return false —— 用户看到的就是「工具条上明明写着自由摆放，点下去毫无反应，
    //   只能缩放、挪不动位置」。现在 IMG / VIDEO 都直接取自身，其余再去后代里找。
    const src = freeSrcOf((el && (el.tagName === 'IMG' || el.tagName === 'VIDEO')) ? el : (el && el.querySelector('img, video')));
    if (!src) return false;
    const rect = el.getBoundingClientRect();
    // 封面原本可能处于 float-right，视觉坐标会落在文章节点之外；优先锁定它所属的
    // 内容卡片（项目卡片 / AI 卡片），自由摆放的范围才落在合理区域内。
    const owner = el.closest('[data-ve-item][data-ve-kind="project"]')
      || el.closest('.project') || el.closest('[data-ve-item]');
    const ownerSection = owner && owner.closest('[data-section]');
    const p = owner ? {
      aKind:'item',
      aSection:(ownerSection && ownerSection.getAttribute('data-section')) || '',
      aItem:owner.getAttribute('data-ve-item') || '',
      aLabel:freeItemLabel(owner) || labelFallback
    } : freeAnchorFromClientPoint(rect.left + Math.min(rect.width / 2, 12), rect.top + Math.min(rect.height / 2, 12));
    const layer = ensureFreeLayer(freeContainerFor(p));
    const lr = layer.getBoundingClientRect(), lw = Math.max(1, lr.width);
    // y 轴（2026-09-27 穿模修复）：内容类归属按宿主高折算并标记 yMode:'h'，tail/page 保持按宽。
    const _yModeH = freeYModeH(p);
    const _yBase = _yModeH ? Math.max(1, lr.height) : lw;
    // 重复点「自由摆放」不该越点越多：沿用同一张图已有的记录 id。
    const prev = (window.__veImages || []).find(i => i && i.inplace && i.sourcePath === key);
    const item = { id:(prev && prev.id) || ('bound_' + Date.now()), src, sourcePath:key, inplace:true,
      aKind:p.aKind, aSection:p.aSection || '', aItem:p.aItem || '', aLabel:p.aLabel || labelFallback,
      xPct:Math.max(-.2, Math.min(1.4, (rect.left - lr.left) / lw)),
      yPct:Math.max(-.2, Math.min(2.5, (rect.top - lr.top) / _yBase)),
      wPct:Math.max(.05, Math.min(.8, rect.width / lw)), aspect:rect.height > 0 ? rect.width / rect.height : 1 };
    if (_yModeH) item.yMode = 'h';
    // 同一张图可能还留着历史上「克隆式」的自由记录 —— 一起清掉，保证画布上只有一张。
    window.__veImages = (window.__veImages || []).filter(i => !(i && i.sourcePath === key));
    window.__veImages.push(item);
    const pos = Object.assign({}, window.__veImgPos || {}, { [key]:{place:'free'} });
    window.__veImgPos = pos;
    VE_applyImgPosToDom(pos);
    VE_renderFreeLayer();
    // 位置标记与原图几何必须原子落盘：两条并发的 read-modify-write 会互相覆盖。
    API.post({ type:'ve-commit-bound-media', images:window.__veImages, imgPos:pos });
    requestAnimationFrame(() => { const own = document.querySelector('[data-ve-img="' + cssEsc(item.id) + '"]'); if (own) selectElement(own); });
    return true;
  }
  // 这张图当前是不是自由摆放。判据是**有没有自由图记录**，不看 imgPos 标记 ——
  // 只有标记没有记录 = 历史残留（那张图早被删了），这时工具条若显示「恢复常规摆放」，
  // 用户会以为功能坏了（图明明在普通排版里）。
  function freeStateOfKey(key){
    const rec = (window.__veImages || []).find(i => i && i.sourcePath === key) || null;
    return { free: !!rec, record: rec };
  }
  // 「恢复常规摆放」：原地式清掉原图的行内几何；克隆式删掉副本并恢复原图。
  function unfreeByKey(key){
    if (!key) return;
    const recs = (window.__veImages || []).filter(i => i && i.sourcePath === key);
    if (!recs.length){
      // 只有 imgPos 标记、没有记录（异常数据）→ 至少把标记去掉，别让原图继续被隐藏
      const pos = Object.assign({}, window.__veImgPos || {});
      delete pos[key];
      window.__veImgPos = pos;
      VE_applyImgPosToDom(pos);
      VE_renderFreeLayer();
      API.post({ type:'ve-commit-bound-media', images:window.__veImages, imgPos:pos });
      return;
    }
    recs.forEach(r => removeFreeImageById(r.id));
    if (typeof toastInCanvas === 'function') toastInCanvas('已恢复常规摆放');
  }
  function freeBoundMedia(el, key){ return freeBindOwnElement(el, key, '所属内容'); }
  // 「文本编辑里插入的图片」（项目主视觉 / 工作过程图）同样走原地自由摆放。它们渲染成
  // <figure data-ve-media-item="projects.0.media#image1">，两个关键差别：
  //   ① 一个项目里可能有多张图**共用同一个 media 路径**（主视觉 + 过程图）。若沿用
  //      data-ve-media-path 当键，第二张会把第一张顶掉、恢复/隐藏时还会两张一起动。
  //      所以一律用「媒体项 key」（带 #imageK，天然唯一）。
  //   ② 锚点必须取所属**项目卡片**（[data-ve-item="projects.N"]），不能取媒体项自己 ——
  //      媒体项只是侧栏里的一小格，拿它当容器，可拖动范围会被缩到那一格里，等于没法摆。
  function freeBoundMediaItem(itemEl){
    if (!itemEl) return false;
    return freeBindOwnElement(itemEl, itemEl.getAttribute('data-ve-media-item') || '', '所属项目');
  }
  function buildImageHandles(silent){
    clearImageUI();
    const targets = [];
    // ⓿ 媒体项里的图片：取消懒加载 + 关掉原生拖图 + 加载完重扫。
    //    必须做在「可见性判断」之前 —— 否则懒加载 → 高度 0 → 判定不可见 → 连轮廓都不会标记（死锁）。
    document.querySelectorAll('[data-ve-media-item] img').forEach(im => {
      im.draggable = false;
      if (im.loading === 'lazy') im.loading = 'eager';
      if (!im.complete) im.addEventListener('load', () => { if (mode === 'image') sweepSizeTargets(); }, { once: true });
    });
    // ① 每个媒体项（图片 / 视频 / 音频）各自是一个可调对象 —— 「图片和视频不再绑在一起」的关键
    //    ⚠ 已经「原地自由摆放」的那张不进 PPT 尺寸体系：它有自己的八向手柄与自由拖拽，
    //      两套手柄叠在一起会互相打架（拖它反而会变成"换到别的媒体栏"）。
    document.querySelectorAll('[data-ve-media-item]').forEach(el => { if (!el.hasAttribute('data-ff-free')) targets.push(el); });
    // ② 分栏比例：正文与媒体栏之间的竖向分隔条 —— 只在「当前选中对象所属的那条媒体栏」旁出现。
    //    之前每条媒体栏都挂一条，一屏好几根蓝色竖条飘着，正是用户说的「莫名其妙的东西」。
    const selBox = (veSizeSel && veSizeSel.hasAttribute && veSizeSel.hasAttribute('data-ve-media-box'))
      ? veSizeSel
      : (veSizeSel && veSizeSel.closest ? veSizeSel.closest('[data-ve-media-box]') : null);
    if (selBox){
      const dt = selBox.closest('.project-detail');
      const rb = selBox.getBoundingClientRect();
      if (dt && rb.width >= 8 && rb.height >= 8) makeColDivider(dt, selBox);
    }
    // ③ 栏外散落图片（AI 项目封面 / 截图等）
    document.querySelectorAll('img, video').forEach(img => {
      if (img.closest && img.closest('[data-ve-media-item]')) return;     // 已由所属媒体项统一控制
      if (img.closest && img.closest('[data-ve-media-box]')) return;      // 同上
      if (img.classList && img.classList.contains('ve-pix-img')) return;    // Pixel Character 有独立的定位/大小控制
      if (img.classList && img.classList.contains('ve-free-img')) return;   // 自由浮层图片有独立的手柄/拖动
      if (!img.getAttribute('data-ve-media-path') && !img.getAttribute('src')) return;
      // 画布里取消懒加载：否则视口外的图片不加载 → 测不到尺寸 → 拿不到手柄（表现为"没有手柄"）
      if (img.loading === 'lazy') { img.loading = 'eager'; }
      const key = veImgKeyOf(img);
      const cur = (window.__veImgSizes || {})[key];
      if (cur && cur.widthPct) img.style.width = cur.widthPct + '%';  // 恢复已保存的尺寸
      targets.push(img);
    });
    // ④ 标记「可调对象」（虚线轮廓）；真正的手柄只给当前选中的那一个。
    //    这就是「编辑块非常奇怪」的解法：一屏只有一组手柄，其余只显示细虚线。
    let n = 0;
    veSizeTargets = [];
    targets.forEach(el => {
      el.classList.remove('ve-size-target', 've-size-selected');
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return;   // 真的不可见（未加载/仍在隐藏容器里）就不标记
      el.classList.add('ve-size-target');
      if (el.hasAttribute('data-ve-media-item')){
        el.setAttribute('data-ve-key', veImgKeyOf(el));
        el.setAttribute('data-ve-item-key', el.getAttribute('data-ve-media-item'));
      }
      veSizeTargets.push(el); n++;
    });
    // 选中态：沿用原选中；原选中没了就默认选第一个 —— 进来就能直接拉手柄，不用先找"点哪儿"
    if (!veSizeSel || !veSizeSel.isConnected || veSizeTargets.indexOf(veSizeSel) < 0) veSizeSel = veSizeTargets[0] || null;
    targets.forEach(el => makeSizeHandles(el, el === veSizeSel));
    if (veSizeSel){
      veSizeSel.classList.add('ve-size-selected');
      positionHandlesFor(veSizeSel);
      positionSizeUI();
    }
    if (!silent && typeof toastInCanvas === 'function') {
      toastInCanvas(n
        ? `图片尺寸与位置：共 ${n} 个对象。点一下某个图片/视频选中它 → 拖角柄改大小、拖顶部 ⠿ 换位置；虚线是它对不齐的提示`
        : '图片尺寸与位置：当前没有可见图片（已自动展开所有条目）');
    }
    return n;
  }
  // 选中一个可调对象（点画布 / 点工具条都会走这里）
  function selectSizeTarget(el){
    if (!el || !el.classList) return;
    if (veSizeSel === el) { veSizeSel.classList.add('ve-size-selected'); return; }
    if (veSizeSel && veSizeSel.isConnected) veSizeSel.classList.remove('ve-size-selected');
    veSizeSel = el;
    el.classList.add('ve-size-selected');
    if (!el.classList.contains('ve-size-target')) el.classList.add('ve-size-target');
    makeSizeHandles(el, true);
    // 分隔条跟着选中项所在的媒体栏走
    document.querySelectorAll('.ve-col-divider').forEach(h => h.remove());
    const box = el.hasAttribute('data-ve-media-box') ? el : el.closest('[data-ve-media-box]');
    if (box){
      const dt = box.closest('.project-detail');
      const rb = box.getBoundingClientRect();
      if (dt && rb.width >= 8 && rb.height >= 8) makeColDivider(dt, box);
    }
    positionSizeUI();
  }
  // —— PPT 式六柄：四角 + 左右边中点。上下边中点不提供（高度由图片比例自动决定，
  //    与 PPT 里"锁纵横比"的拖角体验一致，也保证画布与作品集渲染完全一致）。——
  function makeSizeHandles(el, withHandles){
    // 双击 = 恢复默认尺寸（PPT 里拖坏了最常用的补救动作）
    if (!el.__veDblReset){
      el.__veDblReset = (ev) => {
        if (mode !== 'image') return;
        ev.preventDefault(); ev.stopPropagation();
        const key = veImgKeyOf(el);
        const next = Object.assign({}, window.__veImgSizes || {});
        delete next[key];
        window.__veImgSizes = next;
        if (el.hasAttribute('data-ve-media-item')){
          resetMediaItemSize(el);   // 媒体项：只复位自己，同栏其他项不受影响
        } else if (el.hasAttribute('data-ve-media-box')){
          el.style.setProperty('--pm-w', '38%');
          const g = el.closest('.project-detail'); if (g) g.style.setProperty('--pm-w', '38%');
          API.post({ type: 've-commit-image', path: key, widthPct: null, reset: true });
        } else {
          el.style.removeProperty('width');
          API.post({ type: 've-commit-image', path: key, widthPct: null, reset: true });
        }
        if (typeof toastInCanvas === 'function') toastInCanvas('已恢复默认尺寸');
        positionHandlesFor(el);
      };
      el.addEventListener('dblclick', el.__veDblReset);
    }
    // 图片本体也能直接拖（视频要留出播放控件，只走 ⠿ 柄）—— 换位置不必先选中
    if (el.hasAttribute('data-ve-media-item')){
      el.classList.add('ve-media-movable');
      el.querySelectorAll('img').forEach(im => { im.draggable = false; });
      if (!el.__veBodyDrag){
        el.__veBodyDrag = (e) => {
          if (mode !== 'image') return;
          if (e.button !== 0) return;
          // 已经「原地自由摆放」的原图由自由层接管拖动（pointerdown）——
          // 这里再启动"换媒体栏"的 mousedown 拖拽会和它在同一元素上打架。
          if (el.hasAttribute('data-ff-free')) return;
          if (e.target.closest && e.target.closest('.ve-img-handle, .ve-el-bar, .ve-col-divider, video, audio')) return;
          startMediaMove(el, e);
        };
        el.addEventListener('mousedown', el.__veBodyDrag);
      }
    }
    // 没被选中 → 不生成手柄（只保留上面的轮廓与换位能力）
    if (!withHandles){
      if (el.__veHandles){ el.__veHandles.forEach(h => h.remove()); el.__veHandles = null; }
      if (el.__veMoveHandle){ el.__veMoveHandle.remove(); el.__veMoveHandle = null; }
      return;
    }
    if (el.__veHandles) el.__veHandles.forEach(h => h.remove());
    // 角柄不再印 ◢/⋮ 文字 —— PPT 里就是干净的小方块，文字反而让一屏看起来像"贴满标签"
    el.__veHandles = ['nw','ne','sw','se','w','e'].map(dir => {
      const h = document.createElement('div');
      h.className = 've-img-handle ve-h-' + dir;
      h.dataset.dir = dir;
      h.title = '拖动改这一项的大小（双击复位）';
      document.body.appendChild(h);
      h._el = el; h._img = el;
      h.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); startSizeDrag(el, dir, e); };
      return h;
    });
    // 移动柄（顶部中央 ⠿）：拖动 = 换位置（栏内排序 / 挪到正文下方 / 挪回侧栏）
    // 放在顶部中央是因为上边中点本来就不做缩放（高度由图片比例决定），位置正好空着。
    if (el.hasAttribute('data-ve-media-item')){
      if (el.__veMoveHandle) el.__veMoveHandle.remove();
      const mh = document.createElement('div');
      mh.className = 've-img-handle ve-move-handle';
      mh.innerHTML = '⠿';
      mh.title = '拖动换位置：同一条媒体栏内排序、拖到正文区域＝挪到正文下方整行并排、拖到另一个项目的媒体栏＝换到那个项目';
      document.body.appendChild(mh);
      mh._el = el; mh._img = el; mh._move = true;
      mh.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); startMediaMove(el, e); };
      el.__veMoveHandle = mh;
    } else if (el.hasAttribute && el.hasAttribute('data-ve-media-path')){
      // —— 栏外散落图片（AI 封面 / 截图等）：此前只有缩放手柄、不能挪位置 ——
      // 这里给一条「位置」工具条：只留两件事 —— 删除这张图 / 转成自由摆放。
      // （2026-09-23 用户原话：「不要有正文左侧正文右侧这种东西了，直接有自由摆放就行了，
      //   有删除和自由摆放两个功能我觉得足以」。旧的 float/full/inline 按钮已撤掉，
      //   但**渲染侧仍支持**历史数据里已存的 place 值 —— 不能把用户以前选过的排版搞坏。）
      // 选择后写入 design.imgPos[path].place，作品集与画布读同一份数据，所见即所得。
      if (el.__vePlaceBar) el.__vePlaceBar.remove();
      const pb = document.createElement('div');
      pb.className = 've-el-bar ve-img-place-bar';
      const pbKey = veImgKeyOf(el);
      // 回显状态同样只认「有没有自由图记录」：只有 imgPos 标记而没有记录是历史残留，
      // 那张图其实在普通排版里，此时必须显示「✥ 自由摆放」而不是「↺ 恢复常规摆放」。
      const cur = freeStateOfKey(pbKey).free ? 'free' : (((window.__veImgPos || {})[pbKey] || {}).place || 'inline');
      const mk = (val, label, tip) => `<button data-place="${val}" class="${cur === val ? 'on' : ''}" title="${tip}">${label}</button>`;
      // 2026-10-01：E 区 / C 区的本地视频也走这条工具条，按钮文案按元素类型给（不然视频写着「删除图片」）。
      const _vWord = el.tagName === 'VIDEO' ? '视频' : '图片';
      pb.innerHTML =
          `<button data-a="del-imgpath" title="从内容里删掉这个${_vWord}（可在文本编辑里重新上传）">🗑 删除${_vWord}</button>`
        + (cur === 'free'
            ? `<button data-a="unfree" title="这张图本身没变，只是取消自由摆放、回到常规排版">↺ 恢复常规摆放</button>`
            : mk('free', '✥ 自由摆放', '让这张图在所属内容区域内直接拖动和缩放（用的是它本身，不会新增副本）'));
      document.body.appendChild(pb);
      pb._el = el;
      el.__vePlaceBar = pb;
      pb.querySelectorAll('button').forEach(b => {
        b.onmousedown = e => e.stopPropagation();
        b.onclick = (e) => {
          e.preventDefault(); e.stopPropagation();
          const key = veImgKeyOf(el);
          if (!key) return;
          if (b.dataset.a === 'del-imgpath'){
            if (!window.confirm('删除这张图片？')) return;
            API.post({ type: 've-delete-media-path', path: key });
            return;
          }
          if (b.dataset.a === 'unfree'){
            unfreeByKey(key);
            return;
          }
          if (b.dataset.place === 'free'){
            freeBoundMedia(el, key);
            if (typeof toastInCanvas === 'function') toastInCanvas('已转为自由摆放：可以在所属项目里拖动它、也可以拖角柄改大小');
            return;
          }
          const next = Object.assign({}, window.__veImgPos || {});
          next[key] = Object.assign({}, next[key] || {}, { place: b.dataset.place });
          window.__veImgPos = next;
          VE_applyImgPosToDom(next);
          API.post({ type: 've-commit-imgpos', imgPos: next });
          pb.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
          if (typeof toastInCanvas === 'function') toastInCanvas('已调整图片位置');
          positionHandlesFor(el);
        };
      });
      // 浮条位置：贴在图片上方（选中才显示，与角柄一起由 positionSizeUI 同步）
      requestAnimationFrame(() => positionPlaceBar(el));
    }
    positionHandlesFor(el);
  }
  // 浮条贴在图片左上角上方；滚出视口则隐藏。
  function positionPlaceBar(el){
    const pb = el && el.__vePlaceBar;
    if (!pb) return;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > (window.innerHeight || 1200) - 4){
      pb.style.display = 'none'; return;
    }
    pb.style.display = 'flex';
    pb.style.left = Math.max(4, r.left) + 'px';
    pb.style.top = Math.max(4, r.top - 34) + 'px';
  }
  // ============ 画布底部可拖拽伸缩（2026-09-20，用户明确要求）============
  // 用户原话：「真正的要点不是所谓的目录与页面角标的距离，而是它这个底部能不能缩短。
  //   你要不然就直接让整个画布都可以调整尺寸行不行？我直接把底部往上拉。」
  // 之前的做法是给「页脚下方留白」一个写死的固定值 —— 用户不接受：
  //   他碰到的情况是间距被拖大之后回不来，固定值又没法按每套模板的观感微调。
  // 现在的做法：在页面**最底边**放一根可拖拽横杆，往上拖 = 页面变短，往下拖 = 页面变长。
  // 拖的结果写到 design.spacing.footerBottom（和原来的间距数据同一份），
  // 所以作品集、画布、发布出去的站点读的是同一个值，所见即所得。
  let __veBottomBar = null;
  function veBottomSpacing() {
    const sp = (window.__veSpacing && typeof window.__veSpacing === 'object') ? window.__veSpacing : {};
    const v = Number(sp.footerBottom);
    return Number.isFinite(v) ? v : FOOTER_BOTTOM_FIXED;
  }
  function ensureBottomBar() {
    // 页面高度属于右侧工具区的数值编辑，不应以浮层覆盖作品内容。
    // 兼容旧页面可能遗留的节点：进入任何模式都主动清理。
    removeBottomBar();
  }
  function removeBottomBar() {
    if (__veBottomBar) { __veBottomBar.remove(); __veBottomBar = null; }
  }
  // 取「真正可见的视口高度」。
  // ⚠ 2026-09-20 踩坑：在 Studio 排版面板里，画布是**整页高度的 iframe**（自己不带滚动条，
  //   由父窗口滚动）。此时 iframe 内的 window.innerHeight = 9000+ 这种整页高度，
  //   拿它当"视口底"算出来的杆子位置会落在页面最底下 —— 鼠标永远够不到。
  //   所以优先问父窗口要它的可视高度，换算成 iframe 坐标系里的位置。
  function veViewportBottomInIframe() {
    const localH = window.innerHeight || 900;
    let top = 0, outerH = localH;
    try {
      if (window.parent && window.parent !== window) {
        const fr = window.frameElement;
        if (fr && fr.getBoundingClientRect) {
          top = fr.getBoundingClientRect().top;           // iframe 在父窗口里的位置
          outerH = window.parent.innerHeight || localH;
        }
      }
    } catch (_) { top = 0; outerH = localH; }
    // 父窗口可视区底边 → 换算到 iframe 内部坐标
    return outerH - top;
  }
  function positionBottomBar() {
    const b = __veBottomBar;
    if (!b) return;
    const shell = document.querySelector('.shell') || document.body;
    const r = shell.getBoundingClientRect();
    const vh = veViewportBottomInIframe();
    // 杆子**始终吸附在可见视口底缘**，不再"贴在页面底边"。
    // 为什么：Studio 里画布是整页 iframe，贴在 7000px 处页面底边的杆子鼠标够不到，
    // 拖动根本不会开始（实测：拖了等于没拖）。
    // 吸附后无论页面多长、滚到哪里，这根杆都在手边，随时能拖。
    // 代价是"杆子 ≠ 页面底边本身"，用 tooltip 把方向说清楚。
    const y = Math.max(6, vh - 26);
    b.style.left = Math.max(8, r.left) + 'px';
    b.style.width = Math.max(120, r.width) + 'px';
    b.style.top = y + 'px';
    b.classList.add('ve-bottom-bar-pinned');
    const pageBottom = r.bottom - veBottomSpacing();
    b.classList.toggle('ve-bottom-bar-inview', pageBottom <= vh - 6 && pageBottom >= 0);
    const val = b.querySelector('.ve-bottom-val');
    if (val) val.textContent = Math.round(veBottomSpacing()) + 'px';
    b.title = '页面底部留白（当前 ' + Math.round(veBottomSpacing()) + 'px）\n'
      + '· 往下拖 = 页面变短\n· 往上拖 = 页面变长\n（页面底边在下面看不到时，这根杆就是它的遥控器）';
    b.style.display = 'flex';
  }
  function startBottomDrag(e) {
    e.preventDefault(); e.stopPropagation();
    const startY = e.clientY;
    const startV = veBottomSpacing();
    // ⚠ 杆子恒吸附在视口底缘（见 positionBottomBar 的说明），所以它是"页面底边的遥控器"：
    //   往下拖 = 把底边往上推 = 缩短页面；往上拖 = 拉长页面。
    //   这与"直接抓住底边拖"的直觉方向相反，但正因为杆子不在底边上，
    //   这样映射才符合"把页面收短/放长"的操作意图（用户要的是缩短，往下拖更顺手）。
    //   tooltip 与杆上的 ⇕ 都写明了方向，不用猜。
    const sign = -1;
    document.body.classList.add('ve-dragging');
    const tip = document.createElement('div');
    tip.className = 've-size-tip ve-bottom-tip';
    document.body.appendChild(tip);
    const move = (ev) => {
      // 上限 600：不是"拖不动"，而是防止拖出天文数字把页面拉成无限长。
      // 下限 0：贴到 0 就是"页面底边紧贴脚注"，仍然能再拖回来。
      const next = Math.max(0, Math.min(600, Math.round(startV + sign * (startY - ev.clientY))));
      const sp = Object.assign({}, window.__veSpacing || {}, { footerBottom: next });
      window.__veSpacing = sp;
      VE_applySpacingToDom(sp);
      positionBottomBar();
      tip.textContent = next + 'px';
      tip.style.left = (ev.clientX + 14) + 'px';
      tip.style.top = (ev.clientY - 26) + 'px';
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('ve-dragging');
      tip.remove();
      positionBottomBar();
      API.post({ type: 've-commit-space', spacing: window.__veSpacing || {} });
      if (typeof toastInCanvas === 'function') toastInCanvas('页面底部已调整到 ' + Math.round(veBottomSpacing()) + 'px');
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    move(e);
  }

  function positionHandlesFor(el){
    if (!el.__veHandles) return;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) { el.__veHandles.forEach(h => { h.style.display = 'none'; }); if (el.__veMoveHandle) el.__veMoveHandle.style.display = 'none'; return; }
    el.__veHandles.forEach(h => {
      const d = h.dataset.dir;
      const isW = d.includes('w'), isE = d.includes('e');
      const left = isW ? r.left - 6 : (isE ? r.right - 6 : r.left + r.width / 2 - 6);
      const top  = d.startsWith('n') ? r.top - 6 : (d.startsWith('s') ? r.bottom - 6 : r.top + r.height / 2 - 6);
      h.style.left = left + 'px';
      h.style.top = top + 'px';
      h.style.display = 'flex';
    });
    // 移动柄：顶部中央
    const mh = el.__veMoveHandle;
    if (mh){
      mh.style.left = (r.left + r.width / 2 - 10) + 'px';
      mh.style.top = (r.top - 11) + 'px';
      mh.style.display = 'flex';
    }
  }
  // 兼容旧调用：媒体栏内嵌工具条创建的是单个手柄，走右下角逻辑
  function positionImgHandle(h, el){
    if (!el) return;
    h._img = el; h._el = el;
    const r = el.getBoundingClientRect();
    h.style.left = (r.right - 8) + 'px';
    h.style.top = (r.bottom - 8) + 'px';
  }
  // —— 拖动时的辅助层：虚线外框 + 三条竖向对齐虚线（左/中/右）+ 尺寸气泡 ——
  let veGuides = null;
  function showResizeGuides(el){
    hideResizeGuides();
    const mk = cls => { const d = document.createElement('div'); d.className = cls; document.body.appendChild(d); return d; };
    veGuides = { frame: mk('ve-size-frame'), v1: mk('ve-guide-v'), v2: mk('ve-guide-v'), v3: mk('ve-guide-v'), h1: mk('ve-guide-h'), h2: mk('ve-guide-h'), tip: mk('ve-size-tip') };
    updateResizeGuides(el);
    return veGuides;
  }
  // 对齐参考线：除了「容器左/中/右」，还把同容器里其它媒体项的左右边缘、上下边缘都算作候选 ——
  // 这样并排的几张图能互相吸附到同一条线、同一水平线上（用户要的"吸附 + 灵活排版"）。
  function siblingBoxes(el){
    const out = [];
    const p = el.parentElement;
    if (!p) return out;
    [...p.children].forEach(s => {
      if (s === el || !s.getBoundingClientRect) return;
      const r = s.getBoundingClientRect();
      if (r.width > 8 && r.height > 8) out.push(r);
    });
    return out;
  }
  function updateResizeGuides(el, pct){
    if (!veGuides) return;
    const r = el.getBoundingClientRect();
    const g = veGuides;
    g.frame.style.left = r.left + 'px'; g.frame.style.top = r.top + 'px';
    g.frame.style.width = r.width + 'px'; g.frame.style.height = r.height + 'px';
    const lines = [r.left, r.left + r.width / 2, r.right];
    [g.v1, g.v2, g.v3].forEach((v, i) => { v.style.left = lines[i] + 'px'; });
    const vCands = [];
    const ref = el.closest(VE_REF_SELECTOR);
    if (ref) {
      const rr = ref.getBoundingClientRect();
      vCands.push(rr.left, rr.left + rr.width / 2, rr.right);   // 与容器左/中/右对齐
    }
    siblingBoxes(el).forEach(sr => { vCands.push(sr.left, sr.right); });   // 与相邻项左右边缘对齐
    [g.v1, g.v2, g.v3].forEach((v, i) => {
      v.classList.toggle('ve-guide-on', vCands.some(c => Math.abs(lines[i] - c) < 5));
    });
    // 横向参考线：顶 / 底与相邻项对齐（并排图是否落在同一水平线上，一眼能看出来）
    g.h1.style.top = r.top + 'px';
    g.h2.style.top = r.bottom + 'px';
    const hCands = [];
    siblingBoxes(el).forEach(sr => { hCands.push(sr.top, sr.bottom); });
    g.h1.classList.toggle('ve-guide-on', hCands.some(c => Math.abs(r.top - c) < 5));
    g.h2.classList.toggle('ve-guide-on', hCands.some(c => Math.abs(r.bottom - c) < 5));
    const shown = (pct != null) ? pct : (r.width / veRefWidthOf(el) * 100);
    const perRow = el.parentElement ? Math.max(1, Math.round(el.parentElement.clientWidth / Math.max(1, r.width))) : 1;
    g.tip.textContent = `宽 ${Math.round(shown)}% · ${Math.round(r.width)}px${perRow > 1 ? ' · 一行约 ' + perRow + ' 个' : ''}`;
    g.tip.style.left = Math.max(2, r.left + r.width / 2 - 60) + 'px';
    g.tip.style.top = Math.max(2, r.top - 26) + 'px';
  }
  function hideResizeGuides(){
    if (!veGuides) return;
    Object.keys(veGuides).forEach(k => { try { veGuides[k].remove(); } catch (_) {} });
    veGuides = null;
  }
  // 吸附：常用版式比例 + 与相邻元素等宽 + 「一排刚好 N 个铺满」——让"对齐"是能停得住的
  function snapWidthPct(el, raw){
    const marks = [100, 75, 66.7, 50, 38, 33.3, 25, 20];
    for (const m of marks) if (Math.abs(raw - m) < 1.2) return m;
    const parent = el.parentElement;
    if (parent) {
      for (const s of parent.children) {
        if (s === el) continue;
        const w = s.getBoundingClientRect().width;
        if (w < 8) continue;
        const sp = w / veRefWidthOf(el) * 100;
        if (Math.abs(raw - sp) < 1.2) return sp;   // 与相邻项等宽
      }
      // 横排换行容器（正文下方整行区）：吸附到「N 个刚好一排」的宽度，
      // 这是「几张等宽横图落在同一条水平线上」最容易命中的方式。
      const cs = getComputedStyle(parent);
      if ((cs.display === 'flex') && String(cs.flexDirection).indexOf('row') === 0){
        for (let n = 1; n <= 6; n++){
          const p = rowFitPct(parent, n);
          if (p < 8) break;
          if (Math.abs(raw - p) < 1.4) return p;
        }
      }
    }
    return raw;
  }
  function startSizeDrag(el, dir, e){
    const key = veImgKeyOf(el);
    if (!key) return;
    const isBox = !!(el.hasAttribute && el.hasAttribute('data-ve-media-box'));
    const isItem = !!(el.hasAttribute && el.hasAttribute('data-ve-media-item'));
    const refW = veRefWidthOf(el);
    const startW = el.getBoundingClientRect().width;
    const startX = e.clientX;
    const store = isItem ? (window.__veMediaItems || {}) : (window.__veImgSizes || {});
    const cur = store[key];
    let pct = (cur && cur.widthPct) || (startW / refW) * 100;
    // 媒体栏 18–70%（分栏要留文字位置）；单个媒体项 10–100%（它是栏内的项，不必再留文字位置）；散图 5–100%
    const min = isBox ? 18 : (isItem ? 10 : 5), max = isBox ? 70 : 100;
    // 方向：默认（媒体栏在右）向左拖=变宽；媒体栏在左、或拖左侧手柄时反过来
    let sgn = (isBox && !el.classList.contains('media-left')) ? -1 : 1;
    if (dir === 'w' || dir === 'nw' || dir === 'sw') sgn *= -1;
    showResizeGuides(el);
    const onMove = (ev) => {
      const dx = (ev.clientX - startX) * sgn;
      const raw = ((startW + dx) / refW) * 100;
      pct = Math.max(min, Math.min(max, snapWidthPct(el, raw)));
      veApplyWidth(el, pct);
      updateResizeGuides(el, pct);
      positionHandlesFor(el);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      hideResizeGuides();
      const w = parseFloat(pct.toFixed(1));
      if (isItem){
        // 媒体项：写到 design.mediaItems（只影响这一项），不碰整栏比例
        // 特殊：在「正文下方」整行区里，如果拖动到的宽度正好是「每行 N 个」，就按 N 记下来 ——
        //       这样换窗口宽度后仍然恰好 N 个一行（纯百分比会被间隙挤到下一行）。
        let patch = { widthPct: w };
        const parent = el.parentElement;
        if (parent && isRowContainer(parent)){
          const n = Math.max(1, Math.min(6, Math.round(parent.clientWidth / Math.max(1, el.getBoundingClientRect().width))));
          if (Math.abs(w - rowFitPct(parent, n)) < 1.0) patch = { perRow: n, widthPct: null };
        }
        const map = Object.assign({}, window.__veMediaItems || {});
        map[key] = Object.assign({}, map[key] || {}, patch);
        window.__veMediaItems = map;
        API.post({ type: 've-commit-media-item', key, patch });
      } else {
        const next = Object.assign({}, window.__veImgSizes || {});
        next[key] = { widthPct: w };
        window.__veImgSizes = next;
        API.post({ type: 've-commit-image', path: key, widthPct: w });
      }
      positionHandlesFor(el);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }
  function startBoxDrag(box, handle, e){ startSizeDrag(box, 'se', e); }
  function startImgDrag(img, handle, e){ startSizeDrag(img, 'se', e); }
  // ================= 分栏比例（正文 : 媒体栏）=================
  // 之前「整条媒体栏 6 个手柄」既当栏宽又当项宽，跟新的「每项独立手柄」混在一起会分不清。
  // 现在拆开：栏宽只由这条竖向分隔条负责（拖它 = 改比例），每个媒体项自己的手柄只改自己。
  function colGapPx(){ return 34; }   // 与 CSS 里 .project-detail 的 gap 保持一致
  function setColPct(detail, box, pct){
    const p = pct.toFixed(1) + '%';
    if (box) box.style.setProperty('--pm-w', p);
    if (detail) detail.style.setProperty('--pm-w', p);   // grid 规则写在父级，必须同时写
  }
  function positionColDivider(h, detail, box){
    if (!h || !box) return;
    const rb = box.getBoundingClientRect();
    if (rb.width < 8 || rb.height < 8){ h.style.display = 'none'; return; }
    const onLeft = box.classList.contains('media-left');
    h.style.display = 'block';
    h.style.left = ((onLeft ? rb.right : rb.left) - 5) + 'px';
    h.style.top = rb.top + 'px';
    h.style.height = rb.height + 'px';
  }
  function makeColDivider(detail, box){
    const h = document.createElement('div');
    h.className = 've-col-divider';
    h.title = '拖动调整「正文 : 媒体栏」的比例（双击恢复 38%）';
    h._colDetail = detail; h._colBox = box;
    document.body.appendChild(h);
    positionColDivider(h, detail, box);
    h.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); startColDrag(detail, box, h, e); };
    h.ondblclick = (e) => {
      e.preventDefault(); e.stopPropagation();
      setColPct(detail, box, 38);
      API.post({ type: 've-commit-image', path: box.getAttribute('data-ve-media-box') || '', widthPct: null, reset: true });
      positionColDivider(h, detail, box);
      repositionImageHandles();
      if (typeof toastInCanvas === 'function') toastInCanvas('分栏比例已恢复 38%');
    };
    return h;
  }
  function startColDrag(detail, box, h, e){
    const startX = e.clientX;
    const onLeft = box.classList.contains('media-left');
    const rd = detail.getBoundingClientRect();
    const avail = Math.max(1, rd.width - colGapPx());
    const startW = box.getBoundingClientRect().width;
    let pct = Math.max(18, Math.min(70, startW / avail * 100));
    const tip = document.createElement('div');
    tip.className = 've-size-tip';
    document.body.appendChild(tip);
    const paint = () => {
      const r = h.getBoundingClientRect();
      tip.textContent = `媒体栏 ${Math.round(pct)}%`;
      tip.style.left = Math.max(2, r.left - 40) + 'px';
      tip.style.top = Math.max(2, r.top - 28) + 'px';
    };
    paint();
    const onMove = (ev) => {
      // 媒体栏在右：分隔条就是它的左边缘，往左拖 = 变宽；在左：分隔条是右边缘，往右拖 = 变宽
      const dx = ev.clientX - startX;
      const w = onLeft ? (startW + dx) : (startW - dx);
      pct = Math.max(18, Math.min(70, w / avail * 100));
      setColPct(detail, box, pct);
      positionColDivider(h, detail, box);
      box.querySelectorAll('[data-ve-media-item]').forEach(it => positionHandlesFor(it));
      paint();
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      tip.remove();
      API.post({ type: 've-commit-image', path: box.getAttribute('data-ve-media-box') || '', widthPct: parseFloat(pct.toFixed(1)) });
      setTimeout(repositionImageHandles, 40);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  // ================= 媒体项换位（同项目内）=================
  // 拖动媒体项 = 换位置：① 在同一条媒体栏里上下排序；② 拖到正文区域 = 挪到「正文下方」整行；
  // 拖回媒体栏 = 回到侧栏。位置写在 design.mediaItems[key].order / .place，仍然不碰内容数据。
  // 跨项目移动要改「这张图归属于哪个项目」＝内容数据本身，风险高，本轮明确不做：拖到别的项目会提示不可放置。
  function mediaPathOfDetail(detail){
    const box = detail && detail.querySelector('[data-ve-media-box]');
    return box ? (box.getAttribute('data-ve-media-box') || '') : '';
  }
  function itemElsIn(root){
    return [...root.querySelectorAll('[data-ve-media-item]')];
  }
  // 项目的全局媒体顺序：先侧栏（阅读顺序），再「正文下方」。上移/下移按这个全局序走，
  // 所以「图片想往上挪 / 跟视频换个位置」能跨容器真正移动（不只是同栏内重排）。
  function projectItemList(detail){
    const box = detail.querySelector('[data-ve-media-box]');
    const below = detail.querySelector('[data-ve-media-below]');
    const list = [];
    if (box) itemElsIn(box).forEach(el => list.push(el));
    if (below) itemElsIn(below).forEach(el => list.push(el));
    return list;
  }
  function moveProjectItem(el, dir, detail){
    const list = projectItemList(detail);
    const i = list.indexOf(el);
    if (i < 0) return false;
    const j = dir === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= list.length){
      if (typeof toastInCanvas === 'function') toastInCanvas(dir === 'up' ? '已经是第一个了' : '已经是最后一个了');
      return false;
    }
    const target = list[j];
    const host = (target.closest('[data-ve-media-box]') || target.closest('[data-ve-media-below]'));
    if (!host) return false;
    if (dir === 'up') host.insertBefore(el, target);
    else host.insertBefore(el, target.nextElementSibling);
    syncProjectMediaLayout(detail);
    commitMediaItems(renumberProjectMedia(detail), '媒体顺序已保存');
    return true;
  }
  function ensureBelowContainer(detail, mediaPath){
    let c = detail.querySelector('[data-ve-media-below]');
    if (!c){
      c = document.createElement('div');
      c.className = 'project-media-below';
      c.setAttribute('data-ve-media-below', mediaPath || mediaPathOfDetail(detail));
      detail.appendChild(c);
    }
    return c;
  }
  // 空容器不删除，只打标记：平时隐藏，进「媒体尺寸」模式才显出来当投放区
  function syncProjectMediaLayout(detail){
    if (!detail) return;
    const box = detail.querySelector('[data-ve-media-box]');
    const below = detail.querySelector('[data-ve-media-below]');
    const hasCol = !!(box && box.querySelector('[data-ve-media-item]'));
    if (box) box.toggleAttribute('data-ve-empty', !hasCol);
    if (below) below.toggleAttribute('data-ve-empty', !below.querySelector('[data-ve-media-item]'));
    detail.classList.toggle('no-media', !hasCol);
  }
  // 按 DOM 顺序重新编号（order 用连续整数，简单可靠；侧栏与「正文下方」共用一条序列）
  function renumberProjectMedia(detail){
    const map = {};
    itemElsIn(detail).forEach((it, i) => {
      const k = it.getAttribute('data-ve-media-item');
      if (!k) return;
      map[k] = { order: i + 1, place: it.closest('[data-ve-media-below]') ? 'below' : 'column' };
    });
    return map;
  }
  function commitMediaItems(map, msg){
    if (!map || !Object.keys(map).length) return;
    API.post({ type: 've-commit-media-items', map, savedMsg: msg || '媒体位置已保存' });
  }
  // 容器是不是「横排换行」布局（正文下方整行区）——决定了插入点按 X 还是按 Y 判断
  function isRowContainer(c){
    if (!c) return false;
    const cs = getComputedStyle(c);
    return cs.display === 'flex' && String(cs.flexDirection).indexOf('row') === 0;
  }
  // 在容器里按「阅读顺序」找插入参照物：返回 null = 放到最后
  function insertionRefIn(container, ev, draggedEl){
    const items = itemElsIn(container).filter(x => x !== draggedEl);
    if (!items.length) return null;
    const rowAxis = isRowContainer(container);
    for (const it of items){
      const r = it.getBoundingClientRect();
      let before;
      if (rowAxis){
        const sameRow = ev.clientY >= r.top - 6 && ev.clientY <= r.bottom + 6;
        before = sameRow ? (ev.clientX < r.left + r.width / 2) : (ev.clientY < r.top + r.height / 2);
      } else {
        before = ev.clientY < r.top + r.height / 2;
      }
      if (before) return it;
    }
    return null;
  }
  function resolveDropTarget(ev, el, mediaPath, detail){
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    if (!under || !under.closest) return { kind: 'reject' };
    if (under.closest('.project-detail') !== detail) return { kind: 'reject' };
    // ① 落在某个媒体项上 → 插到它前面或后面（横排看 X，竖排看 Y）
    const tItem = under.closest('[data-ve-media-item]');
    if (tItem && tItem !== el){
      const r = tItem.getBoundingClientRect();
      const rowAxis = isRowContainer(tItem.parentElement);
      const after = rowAxis
        ? (ev.clientY > r.bottom - 6 || ev.clientX > r.left + r.width / 2)
        : (ev.clientY > r.top + r.height / 2);
      return { kind: 'item', el: tItem, after };
    }
    // ② 落在侧边媒体栏里
    const tBox = under.closest('[data-ve-media-box]');
    if (tBox && tBox.getAttribute('data-ve-media-box') === mediaPath){
      return { kind: 'container', container: tBox, refNode: insertionRefIn(tBox, ev, el) };
    }
    // ③ 落在「正文下方」整行区（可能落在它的空白处，此时按整行的阅读顺序算插入点）
    const tBelow = under.closest('[data-ve-media-below]');
    if (tBelow) return { kind: 'container', container: tBelow, refNode: insertionRefIn(tBelow, ev, el) };
    // ④ 项目卡片内的其他区域（正文 / 空白）→ 落到「正文下方」
    if (under.closest('.project-main') || under.closest('.project-detail')){
      const c = ensureBelowContainer(detail, mediaPath);
      return { kind: 'container', container: c, refNode: insertionRefIn(c, ev, el) };
    }
    return { kind: 'reject' };
  }
  function paintDropIndicator(line, t, draggedEl, detail){
    if (!line) return;
    if (!t || t.kind === 'reject'){ line.style.display = 'none'; return; }
    let r = null;
    if (t.kind === 'item'){
      const rr = t.el.getBoundingClientRect();
      const rowAxis = isRowContainer(t.el.parentElement);
      if (rowAxis) r = { vertical: true, top: rr.top, height: rr.height, at: (t.after ? rr.right : rr.left) };
      else r = { vertical: false, left: rr.left, width: rr.width, at: (t.after ? rr.bottom : rr.top) };
    } else if (t.container){
      const ref = t.refNode;
      if (ref){
        const rr = ref.getBoundingClientRect();
        const rowAxis = isRowContainer(t.container);
        if (rowAxis) r = { vertical: true, top: rr.top, height: rr.height, at: rr.left };
        else r = { vertical: false, left: rr.left, width: rr.width, at: rr.top };
      } else {
        const kids = itemElsIn(t.container).filter(x => x !== draggedEl);
        const rowAxis = isRowContainer(t.container);
        if (kids.length){
          const rr = kids[kids.length - 1].getBoundingClientRect();
          if (rowAxis) r = { vertical: true, top: rr.top, height: rr.height, at: rr.right };
          else r = { vertical: false, left: rr.left, width: rr.width, at: rr.bottom };
        } else {
          const rc = t.container.getBoundingClientRect();
          if (rc.width > 8 && rc.height > 8) r = { vertical: rowAxis, top: rc.top, height: Math.min(rc.height, 120), left: rc.left, width: rc.width, at: rowAxis ? rc.left + 4 : rc.top + 2 };
          else {
            const rd = detail.getBoundingClientRect();
            r = { vertical: false, left: rd.left, width: rd.width, at: rd.bottom - 6 };
          }
        }
      }
    }
    if (!r){ line.style.display = 'none'; return; }
    line.style.display = 'block';
    line.classList.toggle('ve-drop-v', !!r.vertical);
    if (r.vertical){
      line.style.left = r.at + 'px';
      line.style.top = r.top + 'px';
      line.style.height = (r.height || 60) + 'px';
      line.style.width = '';
    } else {
      line.style.left = r.left + 'px';
      line.style.width = r.width + 'px';
      line.style.top = r.at + 'px';
      line.style.height = '';
    }
  }
  function applyMediaDrop(el, detail, t){
    if (!t || t.kind === 'reject') return;
    let container = null, refNode = null;
    if (t.kind === 'item'){
      container = t.el.parentElement;
      refNode = t.after ? t.el.nextElementSibling : t.el;
    } else { container = t.container; refNode = t.refNode || null; }
    if (!container) return;
    const samePlace = (container === el.parentElement) && (refNode === el || refNode === el.nextElementSibling);
    if (!samePlace){
      if (refNode) container.insertBefore(el, refNode); else container.appendChild(el);
    }
    syncProjectMediaLayout(detail);
    commitMediaItems(renumberProjectMedia(detail), '媒体位置已保存');
    buildImageHandles(true);
    selectElement(el);
    const wentBelow = !!el.closest('[data-ve-media-below]');
    if (typeof toastInCanvas === 'function') toastInCanvas(wentBelow ? '已挪到正文下方（整行并排，可拖手柄改一行几个）' : '位置已调整');
  }
  function startMediaMove(el, e){
    if (mode !== 'image') return;
    const key = el.getAttribute('data-ve-media-item');
    if (!key) return;
    const mediaPath = key.split('#')[0];
    const detail = el.closest('.project-detail');
    if (!detail) return;
    let started = false, ghost = null, line = null, last = null;
    const onMove = (ev) => {
      if (!started){
        if (Math.abs(ev.clientX - e.clientX) + Math.abs(ev.clientY - e.clientY) < 5) return;
        started = true;
        document.documentElement.classList.add('ve-dragging-media');
        el.classList.add('ve-media-dragging');
        ghost = document.createElement('div'); ghost.className = 've-media-ghost'; document.body.appendChild(ghost);
        line = document.createElement('div'); line.className = 've-drop-line'; document.body.appendChild(line);
      }
      ghost.style.left = (ev.clientX + 14) + 'px';
      ghost.style.top = (ev.clientY + 14) + 'px';
      last = resolveDropTarget(ev, el, mediaPath, detail);
      const bad = !last || last.kind === 'reject';
      ghost.textContent = bad ? '只能在本项目内换位置（跨项目移动暂不支持）' : '松手放到这里';
      ghost.classList.toggle('ve-bad', bad);
      paintDropIndicator(line, bad ? null : last, el, detail);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.documentElement.classList.remove('ve-dragging-media');
      el.classList.remove('ve-media-dragging');
      if (ghost) ghost.remove();
      if (line) line.remove();
      if (started && last && last.kind !== 'reject') applyMediaDrop(el, detail, last);
      else { positionHandlesFor(el); repositionImageHandles(); }
      if (started && (!last || last.kind === 'reject') && typeof toastInCanvas === 'function')
        toastInCanvas('换位置只在同一个项目内生效（跨项目会改动内容数据，暂不开放）');
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }
  function resetMediaItemSize(el){
    const key = veImgKeyOf(el);
    el.style.removeProperty('--pmi-w');
    const map = Object.assign({}, window.__veMediaItems || {});
    delete map[key];
    window.__veMediaItems = map;
    API.post({ type: 've-commit-media-item', key, patch: null, savedMsg: '已恢复默认尺寸' });
  }
  // 「一排刚好 N 个」：宽度写成 calc((100% - 间隙*(N-1))/N)，
  // 这样任何窗口宽度下都恰好 N 个一行 —— 用纯百分比会被间隙挤到换行。
  function belowRowWidthCss(n, gap){ gap = (gap == null) ? BELOW_GAP_PX : gap; return `calc((100% - ${gap * (n - 1)}px)/${n})`; }
  // 读容器当前间距（容器上的 --below-gap，否则回退默认）
  function containerGap(c){ if (!c) return BELOW_GAP_PX; const v = parseFloat(getComputedStyle(c).getPropertyValue('--below-gap')); return Number.isFinite(v) && v > 0 ? v : BELOW_GAP_PX; }
  function rowFitPct(container, n){
    const gap = containerGap(container);
    const pw = container.clientWidth || 1;
    return Math.max(6, Math.min(100, (pw - gap * (n - 1)) / n / pw * 100));
  }
  // 当前这一行实际是「一行几个」
  function currentPerRow(container){
    const first = itemElsIn(container)[0];
    if (!first) return 0;
    const fw = first.getBoundingClientRect().width;
    const cw = container.clientWidth;
    if (fw < 8 || cw < 8) return 0;
    return Math.max(1, Math.min(6, Math.round(cw / fw)));
  }
  // 选中媒体项时的工具条：
  //   上移 / 下移 · 移到底下（移回侧栏）· 一行 N 个 · 整行对齐（在正文下方时）· 单项对齐（在侧栏时）· 复位 · 整栏设置
  function buildMediaItemBar(el){
    const key = el.getAttribute('data-ve-media-item') || '';
    const detail = el.closest('.project-detail');
    const belowC = el.closest('[data-ve-media-below]');
    const inBelow = !!belowC;
    const align = el.classList.contains('pmi-r') ? 'right' : (el.classList.contains('pmi-c') ? 'center' : 'left');
    const rowAlign = belowC ? (belowC.getAttribute('data-ve-below-align') || 'left') : 'left';
    const box = detail ? detail.querySelector('[data-ve-media-box]') : null;
    const curPerRow = belowC ? currentPerRow(belowC) : 0;
    const bar = document.createElement('div');
    bar.className = 've-el-bar ve-media-item-bar';
    bar.innerHTML =
        `<button data-a="up" title="往前面挪一位">⇧ 上移</button>`
      + `<button data-a="down" title="往后面挪一位">⇩ 下移</button>`
      + `<button data-a="place" title="${inBelow ? '回到侧边媒体栏' : '脱离侧栏，整行并排放到正文下方'}">${inBelow ? '⇧ 移回侧栏' : '⇩ 移到正文下方'}</button>`
      + (inBelow
          ? `<span class="ve-bar-seg">每行</span>`
            + [1, 2, 3, 4].map(n => `<button data-a="row" data-n="${n}" class="${curPerRow === n ? 'on' : ''}" title="把这一行调成每行 ${n} 个：等宽并排，自动扣掉间隙，换窗口宽度也不会挤到下一行">${n}</button>`).join('')
            + `<button data-a="rowalign" title="整行左 / 居中 / 右对齐">⬌ 整行：${rowAlign === 'center' ? '居中' : (rowAlign === 'right' ? '右' : '左')}</button>`
            + `<span class="ve-bar-seg">间距</span>`
            + `<button data-a="gap-" title="缩小这一行图片之间的间距">−</button>`
            + `<button data-a="gap+" title="拉大这一行图片之间的间距">＋</button>`
            + `<button data-a="sym" class="${belowC.classList.contains('symmetric') ? 'on' : ''}" title="对称模式：整行居中，拖一张往一侧、其它项沿中线自动反向挪">⬔ 对称</button>`
          : `<button data-a="align" title="在这一栏里的左右对齐（左 / 居中 / 右 循环）">⬌ 对齐：${align === 'left' ? '左' : (align === 'center' ? '中' : '右')}</button>`)
      + (freeStateOfKey(key).free
          ? `<button data-a="unfree" title="这张图本身没变，只是取消自由摆放、回到栏内普通排版">↺ 恢复常规摆放</button>`
          : `<button data-a="free" title="在所属项目卡片里自由拖动 / 缩放。用的是这张图本身，不会新增副本">✥ 自由摆放</button>`)
      + `<button data-a="reset" title="恢复默认尺寸（双击媒体项也可以）">↺ 复位尺寸</button>`
      + `<button data-a="del-item" title="只删除这一项媒体，同项目里的其他媒体不受影响">🗑 删除此项</button>`
      + (box ? `<button data-a="box" title="选中整条媒体栏（换左右边 / 加图 / 加视频 / 清空）">⇱ 整栏设置</button>` : '');
    document.body.appendChild(bar);
    elBar = bar;
    positionElBar();
    bar.querySelectorAll('button').forEach(b => {
      b.onmousedown = e => e.stopPropagation();
      b.onclick = (e) => {
        e.preventDefault(); e.stopPropagation();
        const a = b.dataset.a;
        // 删除单项媒体：不需要 detail，也不影响同项目里的其他项
        if (a === 'del-item'){
          if (!key) return;
          if (!window.confirm('删除这一项媒体？同项目里的其他媒体不受影响。')) return;
          API.post({ type: 've-delete-media-item', key });
          return;
        }
        if (a === 'free'){
          if (freeBoundMediaItem(el) && typeof toastInCanvas === 'function') toastInCanvas('已转为自由摆放：就是这张图本身，在项目卡片里拖动它、拖角柄改大小');
          return;
        }
        if (a === 'unfree'){ unfreeByKey(key); return; }
        if (!detail) return;
        if (a === 'up' || a === 'down'){
          // 上移/下移 = 跨「侧栏 + 正文下方」的项目全局顺序：
          // 上是把这一项移到前一个（可能是侧栏里的视频），下移到后一个；跨容器也会真的移动。
          const moved = moveProjectItem(el, a, detail);
          if (moved){
            buildImageHandles(true); selectElement(el);
            if (typeof toastInCanvas === 'function') toastInCanvas('位置已调整');
          }
        } else if (a === 'place'){
          if (inBelow){
            if (box) box.appendChild(el); else ensureBelowContainer(detail, mediaPathOfDetail(detail)).appendChild(el);
          } else ensureBelowContainer(detail, mediaPathOfDetail(detail)).appendChild(el);
          syncProjectMediaLayout(detail);
          commitMediaItems(renumberProjectMedia(detail), '媒体位置已保存');
          buildImageHandles(true); selectElement(el);
          if (typeof toastInCanvas === 'function') toastInCanvas(inBelow ? '已移回侧边媒体栏' : '已挪到正文下方（整行并排，可拖手柄或按「一行 N 个」调整）');
        } else if (a === 'row'){
          // 把「本条所在整行容器」里所有项设成同一宽度 = 每行 N 个，等宽并排落在同一条水平线上
          const n = Math.max(1, Math.min(4, Number(b.dataset.n) || 3));
          const c = el.parentElement;
          const gap = containerGap(c);
          c.style.setProperty('--below-gap', gap + 'px');
          const map = {};
          itemElsIn(c).forEach(it => {
            it.style.setProperty('--pmi-w', belowRowWidthCss(n, gap));
            const k = it.getAttribute('data-ve-media-item');
            if (k) map[k] = Object.assign({}, (window.__veMediaItems || {})[k] || {}, { place: 'below', perRow: n, widthPct: null });
          });
          window.__veMediaItems = Object.assign({}, window.__veMediaItems || {}, map);
          commitMediaItems(map, `已设为每行 ${n} 个`);
          selectElement(el);
          if (typeof toastInCanvas === 'function') toastInCanvas(`已把这一行设为「每行 ${n} 个」等宽并排`);
        } else if (a === 'rowalign'){
          const order = ['left', 'center', 'right'];
          const next = order[(order.indexOf(rowAlign) + 1) % 3];
          const c = el.parentElement;
          c.classList.toggle('jc-center', next === 'center');
          c.classList.toggle('jc-right', next === 'right');
          c.setAttribute('data-ve-below-align', next === 'left' ? '' : next);
          const mp = mediaPathOfDetail(detail);
          const cur = (window.__veMediaLayout || {})[mp] || {};
          window.__veMediaLayout = Object.assign({}, window.__veMediaLayout || {}, { [mp]: Object.assign({}, cur, { belowAlign: next === 'left' ? '' : next }) });
          API.post({ type: 've-commit-medialayout', path: mp, patch: { belowAlign: next === 'left' ? '' : next }, msg: '整行对齐：' + (next === 'left' ? '左' : (next === 'center' ? '居中' : '右')) });
          selectElement(el);
          if (typeof toastInCanvas === 'function') toastInCanvas('整行对齐：' + (next === 'left' ? '左' : (next === 'center' ? '居中' : '右')));
        } else if (a === 'gap-' || a === 'gap+'){
          // 调节「正文下方」整行区里图片之间的间距（0–120px，步长 4）；
          // 容器用 CSS var(--below-gap)，每一项宽度用 calc((100% - gap*(N-1))/N) 同步抠掉间距。
          const c = el.parentElement;
          const gap = Math.max(0, Math.min(120, containerGap(c) + (a === 'gap+' ? 4 : -4)));
          c.style.setProperty('--below-gap', gap + 'px');
          itemElsIn(c).forEach(it => {
            const k = it.getAttribute('data-ve-media-item');
            const cur = k ? (window.__veMediaItems || {})[k] : null;
            if (cur && cur.perRow){
              it.style.setProperty('--pmi-w', belowRowWidthCss(cur.perRow, gap));
            }
          });
          const mp = mediaPathOfDetail(detail);
          const cur = (window.__veMediaLayout || {})[mp] || {};
          window.__veMediaLayout = Object.assign({}, window.__veMediaLayout || {}, { [mp]: Object.assign({}, cur, { belowGap: gap }) });
          API.post({ type: 've-commit-medialayout', path: mp, patch: { belowGap: gap }, msg: '间距：' + gap + 'px' });
          selectElement(el);
          if (typeof toastInCanvas === 'function') toastInCanvas('这一行图片间距：' + gap + 'px');
        } else if (a === 'sym'){
          // 对称模式：整行居中 + 共享间距——居中后拖一张往一侧，其它项沿中线自动反向挪。
          const c = el.parentElement;
          const on = !c.classList.contains('symmetric');
          c.classList.toggle('symmetric', on);
          if (on && !c.classList.contains('jc-center') && !c.classList.contains('jc-right')){
            c.classList.add('jc-center'); c.setAttribute('data-ve-below-align', 'center');
          }
          const mp = mediaPathOfDetail(detail);
          const cur = (window.__veMediaLayout || {})[mp] || {};
          const belowAlign = c.getAttribute('data-ve-below-align') || '';
          window.__veMediaLayout = Object.assign({}, window.__veMediaLayout || {}, { [mp]: Object.assign({}, cur, { symmetric: on, belowAlign }) });
          API.post({ type: 've-commit-medialayout', path: mp, patch: { symmetric: on, belowAlign }, msg: on ? '已开启对称模式（居中）' : '已关闭对称模式' });
          buildMediaItemBar(el);   // 刷新「对称」按钮高亮
          selectElement(el);
          if (typeof toastInCanvas === 'function') toastInCanvas(on ? '对称模式：居中，拖一张其它项自动反向挪' : '已关闭对称模式');
        } else if (a === 'align'){
          const order = ['left', 'center', 'right'];
          const next = order[(order.indexOf(align) + 1) % 3];
          el.classList.toggle('pmi-c', next === 'center');
          el.classList.toggle('pmi-r', next === 'right');
          commitMediaItems({ [key]: { align: next } }, '对齐已保存');
          selectElement(el);
          if (typeof toastInCanvas === 'function') toastInCanvas('对齐：' + (next === 'left' ? '左' : (next === 'center' ? '居中' : '右')));
        } else if (a === 'reset'){
          resetMediaItemSize(el);
          if (typeof toastInCanvas === 'function') toastInCanvas('已恢复默认尺寸');
          selectElement(el);
        } else if (a === 'box'){
          if (box) selectElement(box);
        }
      };
    });
  }

  function clearImageUI(){
    stopSizeRaf();
    veSizeSel = null; veSizeTargets = [];
    document.querySelectorAll('.ve-img-handle, .ve-col-divider, .ve-img-place-bar').forEach(h => h.remove());
    removeBottomBar();   // 离开图片模式时把底部伸缩杆也收掉
    document.querySelectorAll('[data-ve-media-item], [data-ve-media-box], img').forEach(el => {
      if (el.__veHandles) el.__veHandles = null;
      if (el.__veMoveHandle) el.__veMoveHandle = null;
      if (el.__vePlaceBar) el.__vePlaceBar = null;
      if (el.__veDblReset) { el.removeEventListener('dblclick', el.__veDblReset); el.__veDblReset = null; }
      if (el.__veBodyDrag) { el.removeEventListener('mousedown', el.__veBodyDrag); el.__veBodyDrag = null; }
      if (el.classList) el.classList.remove('ve-media-movable', 've-size-target', 've-size-selected');
    });
    hideResizeGuides();
    // 故意不清掉已保存的宽度（--pm-w / img.style.width）：尺寸存在 design.imgSizes 里，
    // 清掉会让"浏览态"看起来变回去，与存档不一致。
  }
  function repositionImageHandles(){
    positionSizeUI();
  }

  // 接收父窗口传入的 spacing / imgSizes / 模式指令
  window.addEventListener('message', (ev) => {
    const msg = ev && ev.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 've-set-spacing'){ window.__veSpacing = msg.spacing || {}; VE_applySpacingToDom(window.__veSpacing); }
    else if (msg.type === 've-set-imgsizes'){ window.__veImgSizes = msg.imgSizes || {}; VE_applyImgSizesToDom(window.__veImgSizes); }
    else if (msg.type === 've-set-medialayout'){ window.__veMediaLayout = msg.mediaLayout || {}; VE_applyMediaLayoutToDom(window.__veMediaLayout); }
    else if (msg.type === 've-set-media-items'){ window.__veMediaItems = msg.mediaItems || {}; VE_applyMediaItemsToDom(window.__veMediaItems); }
    else if (msg.type === 've-set-imgpos'){ window.__veImgPos = msg.imgPos || {}; VE_applyImgPosToDom(window.__veImgPos); }
    else if (msg.type === 've-set-textstyles'){ window.__veTextStyles = msg.textStyles || {}; VE_applyTextStyles(window.__veTextStyles); }
    // 右侧工具箱改动某个属性 → 立即应用到画布并落盘
    else if (msg.type === 've-set-textstyle'){
      const map = Object.assign({}, window.__veTextStyles || {});
      const cur = Object.assign({}, map[msg.path] || {});
      if (msg.value === '' || msg.value == null) delete cur[msg.prop];
      else cur[msg.prop] = msg.value;
      if (Object.keys(cur).length) map[msg.path] = cur; else delete map[msg.path];
      window.__veTextStyles = map;
      VE_applyTextStyles(map);
    }
    else if (msg.type === 've-clear-textstyle'){
      const map = Object.assign({}, window.__veTextStyles || {});
      delete map[msg.path];
      window.__veTextStyles = map;
      document.querySelectorAll(`[data-field="${String(msg.path).replace(/"/g,'\\"')}"]`).forEach(el => {
        VE_TEXT_PROPS.forEach(p => el.style.removeProperty(p.replace(/[A-Z]/g, m => '-' + m.toLowerCase())));
      });
    }
    // 右侧文本工具：把 B/I/U/颜色/字号/对齐/清除应用到「当前选区」或「整元素」
    else if (msg.type === 've-preview-textstyle'){ applyInlineStyle(msg.prop, msg.value, msg.scope || 'field', { preview:true }); }
    else if (msg.type === 've-apply-inline'){ applyInlineStyle(msg.prop, msg.value, msg.scope || 'field'); }
    // 父窗口（右侧）选好图片文件 → 暂存，等待用户在画布点击放置 / 并入项目
    else if (msg.type === 've-add-image-pending'){
      const src = msg.src || msg.url || '';
      pendingImage = src ? { src, url: msg.url || '', name: msg.name || '', type: msg.type || '', attach: msg.attach !== false } : null;
      if (pendingImage) setMode('addimg');
    }
    // 直接把图片加到视口中心（备用路径）
    else if (msg.type === 've-add-image'){ placeImage(msg.src, window.scrollX + window.innerWidth/2, window.scrollY + window.innerHeight/2); }
    else if (msg.type === 've-set-spacing-key'){
      if (!msg.key) return;
      setSpacing(msg.key, Number(msg.value) || 0);
      // 同 startDrag：把最新值随消息交给父窗口落盘，避免父窗口回头问 iframe 时拿到旧值。
      API.post({ type:'ve-commit-space', spacing: Object.assign({}, window.__veSpacing || {}) });
      // 若当前在挪间距模式，杆要跟上新数值
      if (mode === 'space' && typeof repositionSpaceBars === 'function') repositionSpaceBars();
    }
    else if (msg.type === 've-set-mode'){ setMode(msg.mode || 'select'); }
    // 画布重载后父窗口用来「对齐」模式的轻量消息：模式已经一致就什么都不做。
    // 不能复用 ve-set-mode —— 那个会 clearSpaceUI + renderSpaceBars 整套重建，
    // 用户在这一刻正好要在拖间距杆时会被换成新元素，手感直接断掉。
    else if (msg.type === 've-sync-mode'){ const m = msg.mode || 'select'; if (m !== mode) setMode(m); }
    else if (msg.type === 've-pixel-set-mode'){ setMode(msg.mode || 'select'); }
    else if (msg.type === 've-clear-mode'){ setMode('select'); }
    // 父窗口右侧「统筹区」按 id 删除某张自由图片（只按 id 过滤，不影响其他图片坐标/比例）
    else if (msg.type === 've-delete-free-image'){ removeFreeImageById(msg.id); }
    // 父窗口右侧「统筹区」点了一行 → 在画布里把这张图找出来（高亮 + 选中 + 回报位置）
    else if (msg.type === 've-locate'){ VE_locateMedia(msg); }
    // 画布宽度变了（手机/电脑预览切换）→ 自由摆放的图按新宽度重算，形象按正文重新让位
    else if (msg.type === 've-relayout-free'){ VE_relayoutFree(); }
  });

  // 初始应用已存间距/图片尺寸/文本样式（画布与真实作品集一致）
  VE_applySpacingToDom(window.__veSpacing || {});
  VE_applyImgSizesToDom(window.__veImgSizes || {});
  VE_applyMediaLayoutToDom(window.__veMediaLayout || {});
  VE_applyImgPosToDom(window.__veImgPos || {});
  VE_applyTextStyles(window.__veTextStyles || {});
  // 渲染自由图片层并接线（VE 模式可拖拽 / 吸附 / 缩放 / 删除）
  VE_renderFreeLayer();
  VE_wireFreeImages();
  // Pixel Character 拖拽接线（select 模式按住可拖，见 VE_wirePixel）
  VE_wirePixel();

  // 当前画布的真实尺寸语义：contentHeight 不含底部留白；canvasHeight 是最终页面高度。
  // 不另存一个会与 footerBottom 竞争的“固定高度”：右侧输入高度时反算 footerBottom，
  // 所以项目展开后内容变高会自然撑开画布，绝不会被旧的高度裁掉。
  function getCanvasMetrics(){
    const shell = document.querySelector('.shell');
    const footerBottom = Math.max(0, Math.round(veBottomSpacing()));
    if (!shell) return { contentHeight: 0, minimumCanvasHeight: 0, canvasHeight: 0, footerBottom };
    const canvasHeight = Math.ceil(Math.max(shell.scrollHeight || 0, shell.getBoundingClientRect().height || 0));
    const contentHeight = Math.max(0, canvasHeight - footerBottom);
    return { contentHeight, minimumCanvasHeight: contentHeight, canvasHeight, footerBottom };
  }

  // 返回供父窗口读取当前状态
  return {
    getMode: () => mode,
    getSpacing: () => window.__veSpacing || {},
    getCanvasMetrics,
    getImgSizes: () => window.__veImgSizes || {},
    getTextStyles: () => window.__veTextStyles || {},
    getInlineStyles: () => window.__veInlineStyles || {},
    getImages: () => window.__veImages || [],
    setSpacing,
    setMode,
  };
}

// —— 主题预设（与 editor/themes.js 保持同步）——
const THEMES = {
  'light-01':{label:'Light 01 · 米白纸面',mode:'light',ink:'#161616',paper:'#f1eee7',soft:'#ede9df',line:'#cac5ba',accent:'#e64e2e',muted:'#77736b',dark:'#20201e',heroEyebrow:'#e64e2e',surface:'#f8f5ee',surface2:'#efe9dd',field:'#ffffff',card:'#ffffff',danger:'#b3261e',ok:'#2f6b46',warn:'#9a6b1e'},
  'light-02':{label:'Light 02 · 冷白专业',mode:'light',ink:'#1c2433',paper:'#f4f6fa',soft:'#e9edf3',line:'#d6dce6',accent:'#1f4e8c',muted:'#5a6477',dark:'#0f1622',heroEyebrow:'#1f4e8c',surface:'#ffffff',surface2:'#eef2f7',field:'#ffffff',card:'#ffffff',danger:'#c0392b',ok:'#2f6b46',warn:'#9a6b1e'},
  // ⚠ 2026-09-25：原「Light 03 · 暖灰编辑」与 Light 01 太像 → 已替换为莫兰迪灰粉；新增 Light 04 · 森野墨绿。
  'light-03':{label:'Light 03 · 莫兰迪灰粉',mode:'light',ink:'#3b3533',paper:'#f2edeb',soft:'#eae2de',line:'#d4c8c3',accent:'#96706a',muted:'#857a76',dark:'#2b2523',heroEyebrow:'#8a635d',surface:'#f9f5f3',surface2:'#efe8e4',field:'#fffdfc',card:'#fffdfc',danger:'#a8433a',ok:'#4d6b4f',warn:'#8a6a2f'},
  'light-04':{label:'Light 04 · 森野墨绿',mode:'light',ink:'#22302a',paper:'#f3f1e9',soft:'#e8e6da',line:'#c9cdbc',accent:'#2f6b52',muted:'#5f6b64',dark:'#16211c',heroEyebrow:'#2f6b52',surface:'#faf9f3',surface2:'#eceadf',field:'#ffffff',card:'#ffffff',danger:'#a8342a',ok:'#2f6b52',warn:'#8a6a1e'},
  'dark-01':{label:'Dark 01 · 石墨影院',mode:'dark',ink:'#f4f0e8',paper:'#14130f',soft:'#1c1b17',line:'#34332d',accent:'#e8a85a',muted:'#a09a8a',dark:'#0a0a08',heroEyebrow:'#e8a85a',surface:'#1c1b17',surface2:'#232220',field:'#0d0c0a',card:'#20201d',danger:'#ff7b6b',ok:'#7bd08f',warn:'#e8b86a'},
  'dark-02':{label:'Dark 02 · 深海蓝',mode:'dark',ink:'#eef1f6',paper:'#0e1a2a',soft:'#152339',line:'#2a3a52',accent:'#5fb7c2',muted:'#8593a8',dark:'#08111c',heroEyebrow:'#5fb7c2',surface:'#14233a',surface2:'#1b2d48',field:'#0a1422',card:'#16263e',danger:'#ff8a7a',ok:'#6fd08a',warn:'#e8c06a'},
  // ⚠ 2026-09-25：原「Dark 03 · 墨绿暗金」与 Dark 01 撞色系 → 已替换为酒红丝绒；新增 Dark 04 · 紫夜深空。
  'dark-03':{label:'Dark 03 · 酒红丝绒',mode:'dark',ink:'#f6ebe6',paper:'#1a1013',soft:'#241419',line:'#3f252b',accent:'#dc9a72',muted:'#a08a8c',dark:'#0f080a',heroEyebrow:'#dc9a72',surface:'#241419',surface2:'#2e1a20',field:'#160d10',card:'#291720',danger:'#ff8f80',ok:'#84cf95',warn:'#e6bb78'},
  'dark-04':{label:'Dark 04 · 紫夜深空',mode:'dark',ink:'#ece9f7',paper:'#14102a',soft:'#1d1840',line:'#332b5e',accent:'#ae9ff2',muted:'#9089ae',dark:'#0b0919',heroEyebrow:'#ae9ff2',surface:'#1d1840',surface2:'#262052',field:'#100c22',card:'#221c4a',danger:'#ff8ba0',ok:'#7fd8b0',warn:'#e8c078'},
};
function resolveTheme(d){
  const t=(d&&d.theme)||{};
  const preset=THEMES[t.preset]||THEMES['light-01'];
  if(!d.theme&&d.styles){
    return Object.assign({},preset,{ink:d.styles.text||preset.ink,paper:d.styles.background||preset.paper,accent:d.styles.accent||preset.accent});
  }
  return preset;
}
function applyTheme(t){
  const r=document.documentElement;
  Object.entries({ink:t.ink,paper:t.paper,soft:t.soft,line:t.line,accent:t.accent,muted:t.muted,dark:t.dark,'hero-eyebrow':t.heroEyebrow||t.accent}).forEach(([k,v])=>r.style.setProperty(`--${k}`,v));
  // 语义 token（深色下自动提亮）
  r.style.setProperty('--surface',t.surface||t.soft);
  r.style.setProperty('--surface2',t.surface2||t.soft);
  r.style.setProperty('--field',t.field||'#ffffff');
  r.style.setProperty('--card',t.card||'#ffffff');
  r.style.setProperty('--danger',t.danger||'#c0392b');
  r.style.setProperty('--ok',t.ok||'#2f6b46');
  r.style.setProperty('--warn',t.warn||'#9a6b1e');
  // ⚠ 2026-09-25：压在实体色块上的文字色。深色主题下 accent 是**浅色**，
  //   原先写死的 color:#fff 会几乎看不见 → 抽成 token（浅色主题白字 / 深色主题近黑字）。
  r.style.setProperty('--on-solid', t.mode==='dark' ? (t.dark||'#0a0a08') : '#ffffff');
  // 让原生控件（滚动条、表单控件）跟随深浅色
  r.style.colorScheme=t.mode||'light';
  r.setAttribute('data-theme-mode',t.mode||'light');
  // dark 主题下 body 直接用 paper 作为底色
  if(t.mode==='dark'){
    r.style.setProperty('--editor-paper-mode','dark');
    document.body.style.background=t.paper;
  }else{
    r.style.setProperty('--editor-paper-mode','light');
    document.body.style.background='';
  }
}

// —— Publish 面板：发布状态 + 下载 PDF + 公开链接 + 模板 ——
async function openPublishPanel(d){
  document.querySelector('#publish-dialog')?.remove();

  // 读取 Design 状态（draft / published 是否存在）
  let designDraft = null, designPublished = null;
  try { designDraft = await fetch('/api/design', { cache: 'no-store' }).then(r => r.json()); } catch (e) {}
  try { designPublished = await fetch('/api/design/published', { cache: 'no-store' }).then(r => r.json()); } catch (e) {}
  const hasDesignDraft = !!(designDraft && Object.keys(designDraft).length);
  const hasDesignPublished = !!(designPublished && Object.keys(designPublished).length);

  const dialog=document.createElement('dialog');
  dialog.id='publish-dialog';
  dialog.className='publish-dialog';
  dialog.innerHTML=`
    <div class="publish-head"><h2>发布作品集</h2><button class="publish-close" aria-label="关闭">×</button></div>

    <section class="publish-section">
      <h3>① 发布状态</h3>
      <div class="publish-status">
        <div class="publish-status-row"><span class="publish-status-label">Content 内容</span><span class="publish-tag">草稿（Draft）</span></div>
        <div class="publish-status-row"><span class="publish-status-label">Design 设计</span><span class="publish-tag ${hasDesignDraft ? '' : 'dim'}">${hasDesignDraft ? '草稿（Draft）' : '未保存'}</span></div>
        <div class="publish-status-row"><span class="publish-status-label">已发布内容</span><span class="publish-tag ${hasDesignPublished ? '' : 'dim'}">${hasDesignPublished ? '已发布（Published）' : '未发布'}</span></div>
      </div>
      <p class="publish-desc">点「发布」把当前草稿（内容 + 排版）固化为本地最新版本。草稿的后续修改不会自动影响已发布页面。</p>
      <div class="publish-actions">
        <button class="publish-btn primary" id="do-publish">发布</button>
      </div>
    </section>

    <section class="publish-section">
      <h3>② 下载 PDF</h3>
      <p class="publish-desc">把<strong>已发布版</strong>作品集导出成 PDF（不含任何编辑 UI）。点击后会在打印窗口选择「另存为 PDF」，文件名自动为 <b>FolioFold-YYYYMMDD.pdf</b>。</p>
      <div class="publish-actions">
        <button class="publish-btn" id="export-pdf">下载 PDF</button>
        <button class="publish-btn" id="export-html">导出 HTML</button>
        <button class="publish-btn" id="export-zip">导出 ZIP</button>
      </div>
    </section>

    <section class="publish-section" id="publink-section">
      <h3>③ 公开链接（Public Link）</h3>
      <div id="publink-body"><p class="publish-desc">读取部署状态中…</p></div>
    </section>

    <section class="publish-section">
      <h3>④ 模板</h3>
      <p class="publish-desc">导出轻量设计模板（theme / 排版 / 间距 / 结构 / 区块顺序），不含私人内容与媒体文件；或导入一个模板应用到当前设计。</p>
      <div class="publish-actions">
        <button class="publish-btn" id="export-template">导出模板（JSON）</button>
        <button class="publish-btn" id="import-template">导入模板</button>
        <input type="file" id="import-template-file" accept="application/json,.json" style="display:none">
      </div>
    </section>`;

  document.body.append(dialog);
  dialog.querySelector('.publish-close').onclick=()=>{dialog.close();dialog.remove()};
  dialog.addEventListener('cancel',e=>{e.preventDefault();dialog.close();dialog.remove()});
  dialog.addEventListener('click',e=>{if(e.target===dialog){dialog.close();dialog.remove()}});

  // ① 发布（本地快照）
  dialog.querySelector('#do-publish').onclick=async()=>{
    try{
      const res=await fetch('/api/publish',{method:'POST'});
      const j=await res.json();
      if(!res.ok)throw Error(j.error||'发布失败');
      dialog.querySelector('#do-publish').textContent='已发布 ✓';
      setTimeout(()=>{dialog.close();dialog.remove()},800);
    }catch(e){dialog.querySelector('#do-publish').textContent='发布失败：'+e.message}
  };

  // ② 下载 PDF / 导出 HTML / ZIP（均来自已发布版）
  const tplQ = (window.__TPL__ && window.__TPL__!=='main') ? '&tpl='+encodeURIComponent(window.__TPL__) : '';
  dialog.querySelector('#export-pdf').onclick=()=>{ window.open('/portfolio/?mode=published&print=1'+tplQ,'_blank'); };
  const tplQ2 = tplQ ? '?'+tplQ.slice(1) : '';   // tplQ 形如 '&tpl=x'，这里需首字母是 '?'
  dialog.querySelector('#export-html').onclick=()=>{ window.open('/api/export/html'+tplQ2,'_blank'); };
  // 「导出 ZIP」= 导出整个静态网站（可自行上传到任意托管），与发布面板③里的 ZIP 同一个后端。
  dialog.querySelector('#export-zip').onclick=()=>{ window.location.href='/api/export/site-zip'+tplQ2; };

  // ④ 模板导出 / 导入
  dialog.querySelector('#export-template').onclick=()=>exportTemplateData(d);
  dialog.querySelector('#import-template').onclick=()=>dialog.querySelector('#import-template-file').click();
  dialog.querySelector('#import-template-file').onchange=(e)=>importTemplateFile(e.target.files[0]);

  // ③ 公开链接（Public Link）状态 + 配置 + 部署
  await renderPublicLink(dialog);
  dialog.showModal();
}

// —— 公开链接：根据 /api/deploy/status 渲染不同 UI，并接管「配置」与「发布到公网」 ——
let __deployedAt = 0, __deployedProvider = null; // 最近一次成功发布的时刻/provider（按钮显示「✓ 已更新」）

// ⚠⚠ 发布状态机必须放在**模块级**，不能只放在点击闭包里（2026-09-18 真实故障修复）。
// 为什么：面板为了自愈（探针结论陈旧、大媒体后台进度）会整体重渲 provider 区，
// 重渲会把按钮 / 进度条 / 错误行这些 DOM 节点整个换掉。状态若只挂在 DOM 或点击闭包上，
// 就被一起抹掉 —— 用户看到的是「点一下闪一下、什么也没发生」，于是反复点击；
// 更糟的是第二次点击会真的再发一次发布请求，两次发布并发互相踩（历史上造成过空站点事故）。
// 放进模块级后：无论重渲多少次，第一下点击就立刻进入「发布中…」并一直显示到出结果。
// 状态：idle（未发布）→ starting（已点击，正在提交请求）→ running（服务端已在传）
//       → ok（成功，按钮变绿）/ error（失败，错误常驻显示）
const PUBUI = { phase: 'idle', provider: '', detail: '', total: 0, sent: 0, pct: 0,
                elapsed: 0, error: '', warnings: [], since: 0 };
let __pubPollTimer = null;
let __pubSetupOpen = false; // 凭证表单打开时禁止自愈重渲，否则用户填到一半的输入会被清空

function pubuiBusy(){ return PUBUI.phase === 'starting' || PUBUI.phase === 'running'; }

// 进度块：starting 阶段也要立刻显示（文案是「正在提交发布请求…」），
// 这样"第一下点击"永远有反馈，不用等服务端把 job 建起来。
function pubuiProgressHtml(){
  if (!pubuiBusy()) return '';
  const stage = PUBUI.detail || '正在提交发布请求…';
  const t = PUBUI.elapsed ? '（已用 ' + Math.round(PUBUI.elapsed) + ' 秒）' : '';
  const bar = PUBUI.total
    ? '<div class="pub-prog-bar"><i style="width:' + PUBUI.pct + '%"></i></div><div class="pub-prog-pct">' + PUBUI.pct + '%</div>'
    : '';
  return '<div class="pub-progress" id="publink-progress"><div class="pub-prog-stage">' + esc(stage) + t + '</div>' + bar + '</div>';
}

// 失败原因常驻显示（不再只靠一闪而过的提示），且能扛住重渲。
function pubuiErrorHtml(){
  if (pubuiBusy() || PUBUI.phase !== 'error' || !PUBUI.error) return '';
  const err = String(PUBUI.error);
  // 后端已经带了「发布失败：」前缀时不再重复加，避免出现「发布失败：发布失败：…」。
  const shown = /^发布失败[：:]/.test(err) ? err : ('发布失败：' + err);
  // ⚠ 2026-09-19 二次修复（真实故障）：整块（标题 + 正文 + 修复引导 + 操作按钮）必须包在
  // **同一个容器**里。旧版把引导段落放在容器外面，清理时只按 id 删掉标题卡片，
  // 后面跟随的段落成了孤儿节点，每重渲一次就多留一份 → 同一段话重复显示两遍。
  // ⚠ 改这里必须同步 studio/studio.js 的 stPubuiErrorHtml。
  let h = '<div class="pub-err-box" id="publink-err"><div class="pub-err-title">✗ 发布失败</div><div class="pub-err-body">' + esc(shown) + '</div>';
  if (PUBUI.provider === 'cloudbase') {
    // 权限类失败：给出可直接照做的修复路径，而不是让用户对着英文报错发呆。
    if (/Access Denied|权限|403/i.test(err)) {
      h += '<div class="pub-err-fix">你当前的密钥能读取 CloudBase 环境，但<b>没有对象存储的写权限</b>——'
        + '上传文件底层就是往对象存储（COS）里写对象，所以每个文件都被拒。'
        + '这不是"没授权"，而是<b>策略挂错了层</b>：只挂 CloudBase 自身的策略不够。'
        + '到 <a href="https://console.cloud.tencent.com/cam" target="_blank" rel="noopener">访问管理 CAM ↗</a>'
        + ' → 左侧「用户」→「<b>用户列表</b>」→ 找到这把密钥对应的<b>子账号所在的那一行</b>，'
        + '点该行右侧操作列的「<b>授权</b>」（入口在列表行上；主账号行没有这个入口，也不必点进用户详情里找）'
        + ' → 在「关联策略」窗口搜 <b>QcloudCOSFullAccess</b> → 勾选 → 确定'
        + '（QcloudCOSFullAccess＝对象存储 COS 全读写访问权限，上传文件靠它，必须挂在这个子账号上）。</div>';
    }
    if (/node'?(')? is not recognized|找不到 node|not recognized/i.test(err)) {
      h += '<div class="pub-err-fix">这是运行环境问题：CloudBase CLI 需要 Node.js 才能跑。'
        + '请先<b>重启 FolioFold 服务</b>（双击启动脚本），本机已自带 Node.js 会自动修复。</div>';
    }
  }
  // 下一步按钮就在错误块里 —— 修好权限后直接点「更新发布」，不必再去别处找入口。
  h += '<div class="pub-err-actions">'
    + '<button class="publish-btn primary" id="publink-err-retry">⟳ 更新发布</button>'
    + '<button class="publish-btn" id="publink-err-permcheck">🔍 权限体检</button>'
    + (PUBUI.provider === 'cloudbase' ? '<button class="publish-btn" id="publink-err-reconfig">配置腾讯云</button>' : '')
    + '<button class="publish-btn" id="publink-err-zip">改用「导出 ZIP」</button>'
    + '</div>'
    + '<div class="pub-err-report" id="publink-err-report" hidden></div>'
    + '</div>';
  return h;
}

// 权限体检结果渲染（数据来自 /api/cloudbase/permcheck）。
// ⚠ 目的：让用户一眼看懂"我是谁 / 缺哪一层权限 / 去哪开"，而不是对着 `Access Denied` 发呆。
function pubPermReportHtml(res){
  if (!res || res.error) return '<div class="pub-err-report-line">体检失败：' + esc((res && res.error) || '没有返回内容') + '</div>';
  let h = '<div class="pub-err-report-line"><b>权限体检结果</b></div>';
  (res.checks || []).forEach(c => {
    h += '<div class="pub-err-report-line">' + (c.ok ? '✓' : '✗') + ' ' + esc(c.name || '') + '：' + esc(c.detail || '') + '</div>';
  });
  if (res.verdict) h += '<div class="pub-err-report-line"><b>' + esc(res.verdict).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>') + '</b></div>';
  if (res.fix && res.fix.length) {
    h += '<div class="pub-err-report-line">怎么修：<ol>' + res.fix.map(s => '<li>' + esc(s) + '</li>').join('') + '</ol></div>';
  }
  if (res.canDeploy) h += '<div class="pub-err-report-line">✓ 权限已就绪，点上面的「⟳ 更新发布」即可。</div>';
  return h;
}

function pubuiMount(host){
  // 清理按**类名全量**清理：旧版按 id 只删标题卡片，后面跟随的引导段落会残留成孤儿，
  // 每重渲一次就多留一份 → 用户看到同样的话重复两遍。
  document.querySelectorAll('.pub-err-box, .pub-progress').forEach(n => n.remove());
  if (!host) host = document.getElementById('publink-provider-body') || document.getElementById('publink-body');
  if (!host) return;
  const h = pubuiProgressHtml() + pubuiErrorHtml();
  if (!h) return;
  // 插到容器最前面，并滚进视野：用户点完发布就应当立刻看到结果。
  host.insertAdjacentHTML('afterbegin', h);
  const box = document.getElementById('publink-err');
  if (!box) return;
  const retry = document.getElementById('publink-err-retry');
  if (retry) retry.onclick = () => { const b = document.getElementById('publink-deploy'); if (b) b.click(); };
  const rc = document.getElementById('publink-err-reconfig');
  if (rc) rc.onclick = () => { const pv = document.getElementById('publink-provider-body'); if (pv) renderSetupForm(pv, ''); };
  const z = document.getElementById('publink-err-zip');
  if (z) z.onclick = () => { window.__pubProvider = 'zip'; renderPublicLink(document.getElementById('publish-dialog')); };
  // 权限体检：直接问后端"这把密钥到底缺哪一层权限"，把结论摆到卡片里。
  // 走的是用户自己已保存的凭证，只读探测 + 一次 0 字节写入自检（成功即刻删除）。
  const pc = document.getElementById('publink-err-permcheck');
  if (pc) pc.onclick = async () => {
    const rep = document.getElementById('publink-err-report');
    if (!rep) return;
    rep.hidden = false;
    rep.innerHTML = '<div class="pub-err-report-line">正在体检…（读取环境 + 一次 0 字节写入自检，自检文件立即删除）</div>';
    pc.disabled = true;
    try {
      const res = await fetch('/api/cloudbase/permcheck', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
      }).then(r => r.json());
      rep.innerHTML = pubPermReportHtml(res);
    } catch (e) {
      rep.innerHTML = '<div class="pub-err-report-line">体检请求失败：' + esc(String((e && e.message) || e)) + '</div>';
    } finally { pc.disabled = false; }
  };
  try { box.scrollIntoView({ block: 'nearest' }); } catch (_) {}
}

// 只更新进度块的文字/百分比（不动其它 DOM）——1.5 秒一次的轮询不能重渲整个面板，
// 否则会闪、会丢滚动位置、会丢用户正在输入的凭证。
function pubuiPaint(){
  if (!pubuiBusy()) { const e = document.getElementById('publink-progress'); if (e) e.style.display = 'none'; return; }
  let el = document.getElementById('publink-progress');
  if (!el) {
    const host = document.getElementById('publink-provider-body') || document.getElementById('publink-body');
    if (!host) return;
    host.insertAdjacentHTML('beforeend', '<div class="pub-progress" id="publink-progress"></div>');
    el = document.getElementById('publink-progress');
  }
  if (!el) return;
  const stage = PUBUI.detail || '正在提交发布请求…';
  const t = PUBUI.elapsed ? '（已用 ' + Math.round(PUBUI.elapsed) + ' 秒）' : '';
  const bar = PUBUI.total
    ? '<div class="pub-prog-bar"><i style="width:' + PUBUI.pct + '%"></i></div><div class="pub-prog-pct">' + PUBUI.pct + '%</div>'
    : '';
  el.style.display = 'block';
  el.innerHTML = '<div class="pub-prog-stage">' + esc(stage) + t + '</div>' + bar;
}

function pubuiStopPoll(){ if (__pubPollTimer) { clearInterval(__pubPollTimer); __pubPollTimer = null; } }

function pubuiStartPoll(){
  pubuiStopPoll();
  const tick = async () => {
    if (!pubuiBusy()) return;
    // 客户端兜底：20 分钟还没有结果就收敛为失败，避免按钮永远卡在「发布中…」
    // （服务端另有 15 分钟看门狗；这里只是防止请求本身断掉却没有回调的情况）。
    if (Date.now() - PUBUI.since > 20 * 60 * 1000) {
      PUBUI.phase = 'error';
      PUBUI.error = '发布超过 20 分钟仍没有结果，已停止等待。请先打开公开网址确认页面是否已经更新：如果页面已经是新的，就不需要再更新了。';
      pubuiStopPoll(); pubuiPaint(); return;
    }
    let s = { publish: {} };
    try { s = await fetch('/api/deploy/status', { cache: 'no-store' }).then(r => r.json()); } catch (_) {}
    const p = s.publish || {};
    // ⚠ 只信任"本次"发布：只有当服务端 running 时才读它的阶段。
    // 旧实现直接读 p.phase/p.ok，会显示**上一次**发布的遗留文案（甚至因为它 ok:true 而误判）。
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
    pubuiPaint();
  };
  __pubPollTimer = setInterval(tick, 1500);
  tick();
}

async function renderPublicLink(dialog){
  const body=document.getElementById('publink-body');
  if(!body) return;
  __pubSetupOpen = false;   // 能走到完整重渲，说明凭证表单已关闭
  // 打开发布面板即触发一次自愈：从历史找回可能因异常写入丢失的发布记录（幂等，无丢失则不写盘）。
  try{ await fetch('/api/deploy/heal',{method:'POST',cache:'no-store'}).then(r=>r.json()).catch(()=>{}); }catch(e){}
  let st={provider:'github', providers:{cloudbase:{configured:false,envId:'',publicUrl:''}, github:{configured:false,login:'',publicUrl:''}}, publicUrl:'', deployedAt:''};
  try{ st=await fetch('/api/deploy/status',{cache:'no-store'}).then(r=>r.json()); }catch(e){}
  if(!window.__pubProvider) window.__pubProvider = st.provider || 'github';
  const prov = window.__pubProvider==='cloudbase' ? 'cloudbase' : (window.__pubProvider==='zip' ? 'zip' : 'github');
  const cb = (st.providers&&st.providers.cloudbase)||{configured:false,envId:'',publicUrl:''};
  const gh = (st.providers&&st.providers.github)||{configured:false,login:'',publicUrl:''};
  // 部署按钮：① 本次发布进行中 → 常驻「发布中…」+ 禁用（重渲也不会丢、也就无法重复点击）；
  // ② 刚成功 → 绿色「✓ 已更新 时:分」；③ 否则常规文案。
  const muFailed = (st.mediaUpload && (st.mediaUpload.failed || []).filter(Boolean).length) || 0;
  // 供 depListHtml 里的「删除 / 改发布内容」用后重渲整个面板（这两个按钮在 renderGithubSection
  // / renderCloudBaseSection 里创建，那两处拿不到 dialog 变量，故在这里挂全局引用）。
  window.__ffRenderPublicLink = () => renderPublicLink(dialog);
  // 供「改发布内容」弹窗列出可选模板
  try { window.__tplList = (await fetch('/api/templates', {cache:'no-store'}).then(r=>r.json())).items || []; } catch(_) { window.__tplList = window.__tplList || []; }
  window.__ffDeployBtnHtml = (baseLabel) => {
    if (pubuiBusy() && PUBUI.provider === prov) {
      return `<button class="publish-btn primary" id="publink-deploy" disabled>发布中…</button>`;
    }
    const okGreen = PUBUI.phase === 'ok' && PUBUI.provider === prov && !muFailed;
    return okGreen
      ? `<button class="publish-btn primary st-done" id="publink-deploy">✓ 已更新 ${new Date(PUBUI.since).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</button>`
      : `<button class="publish-btn primary" id="publink-deploy">${baseLabel}</button>`;
  };
  const deployBtnHtml = window.__ffDeployBtnHtml;
  // 出网方式（2026-09-25 加，与 studio.js 同步）：系统代理"开着但已失效"会让两个渠道
  // 同时发布失败，以前界面完全看不出来。这里如实显示当前是怎么出网的。
  const nw = st.network || {};
  const netLine = nw.note
    ? `<div class="pub-net${nw.downgraded ? ' warn' : ''}">出网方式：${nw.mode === 'proxy' ? '系统代理' : '直连'} — ${esc(nw.note)}</div>`
    : '';
  body.innerHTML = `
    <div class="publink-tabs">
      <button class="publink-tab ${prov==='github'?'active':''}" data-prov="github">GitHub Pages</button>
      <button class="publink-tab ${prov==='cloudbase'?'active':''}" data-prov="cloudbase">CloudBase（需腾讯云配置）</button>
      <button class="publink-tab ${prov==='zip'?'active':''}" data-prov="zip">导出 ZIP</button>
    </div>
    ${netLine}
    <div id="publink-provider-body"></div>`;
  body.querySelectorAll('.publink-tab').forEach(b=>{ b.onclick=()=>{ window.__pubProvider=b.dataset.prov; renderPublicLink(dialog); }; });
  const pb=document.getElementById('publink-provider-body');
  if(prov==='github') await renderGithubSection(pb, gh);
  else if(prov==='zip') renderZipSection(pb);
  else renderCloudBaseSection(pb, cb);
  wirePublicLink(dialog, st);
}

// —— 导出 ZIP：不是发布平台，而是把当前站点打包下载到本地 ——
// 它与发布走**同一条打包链路**（build_public_bundle），所以"导出能看的，发布就能看"。
// 设计上刻意不做成"又一个渠道"：不触网、不需要账号、不产生任何外部依赖。
function renderZipSection(pb){
  if(!pb) return;
  pb.innerHTML=`
    <p class="publish-desc">把当前作品集导出为一个<b>完整静态网站 ZIP</b>，下载到本机。</p>
    <div class="publish-hint">
      <p><b>它是什么：</b>不是发布平台，而是一个「万能出口」。导出的包不需要 FolioFold、不需要联网，解压后双击 <b>index.html</b> 就能离线浏览。</p>
      <p><b>能用来做什么：</b>想放到国内平台（如腾讯云 EdgeOne Pages、CloudBase）时，把导出的 ZIP 直接拖到平台的上传页即可，<b>不需要填任何密钥</b>。</p>
      <p><b>包里有什么：</b>index.html（样式脚本已内联）、media/ 媒体、以及一份 <b>folioframe-export.json</b> 导出清单。</p>
      <p><b>包里绝不会有什么：</b>GitHub 令牌、腾讯云 SecretKey 等任何账号凭证 —— 一分都不会进包。</p>
      <p class="publish-warn"><b>关于大文件：</b>默认<b>不打包超过 90MB 的单个媒体</b>（避免 ZIP 过大），这些文件会在清单和 README 里<b>逐条列出</b>，你可以单独压缩后补传。已打进包里但超过 25MB 的文件也会在 README 里标出——离线看不受影响，但部分平台上传时有单文件上限。</p>
      <p style="font-size:12px;opacity:.72">确实想要"一份都不少"的离线副本？用下面的第二个按钮导出完整版（跳过体积限制，包会很大）。</p>
    </div>
    <div class="publish-actions">
      <button class="publish-btn primary" id="publink-zip">导出网站 ZIP</button>
      <button class="publish-btn" id="publink-zip-all">导出完整版（含大媒体）</button>
    </div>
    <div id="publink-zip-result"></div>`;
  const q='?tpl='+encodeURIComponent(ffCurTpl());
  const btn=document.getElementById('publink-zip');
  if(btn) btn.onclick=()=>{ window.location.href='/api/export/site-zip'+q; };
  const btnAll=document.getElementById('publink-zip-all');
  if(btnAll) btnAll.onclick=()=>{ window.location.href='/api/export/site-zip'+q+'&include=all'; };
}

// —— CloudBase：腾讯云静态网站托管（国内部署）——
// 文案统一为官方口径：不写死任何易变的配额 / 价格 / 套餐数字，规格一律指向官方文档。
// ⚠ 改这里必须同步 studio/studio.js 的 stRenderCloudBaseSection / stRenderCloudBaseSetup。
const CB_OFFICIAL_LINKS = '<a href="https://cloud.tencent.com/document/product/876/46900" target="_blank" rel="noopener">静态网站托管 ↗</a>　'
  + '<a href="https://cloudbase.net/pricing" target="_blank" rel="noopener">定价与套餐说明 ↗</a>　'
  + '<a href="https://cloud.tencent.com/document/buy-guide/876/127357" target="_blank" rel="noopener">免费额度与续期规则 ↗</a>　'
  + '<a href="https://docs.cloudbase.net/service/alias" target="_blank" rel="noopener">默认域名中间页说明 ↗</a>';
// 免费体验版官方规则（2026-09-19 核实，来源见上「免费额度与续期规则」）：
//   0 元/月；每账号限 1 个；3000 资源点/月；单次 6 个月，到期前 1 个月内可 0 元续 6 个月；
//   不支持自动续费；不能加购资源包或开启按量；可升级个人版但不可降回免费版；
//   续期政策仅适用于云开发控制台创建的体验版。数字会变，一律以官方文档为准。
// 腾讯云控制台**直达**链接。2026-09-18 逐个 curl 校验过：未登录时会 302 到腾讯云登录页，
// 登录后直达目标页（不是编造的地址）。没有这些链接，用户会卡在"环境 ID 去哪找"。
// ⚠ 改这里必须同步 studio/studio.js 的 stCbConsoleLinks。
const CB_CONSOLE_LINKS = {
  home:    'https://cloud.tencent.com/login',                 // 登录腾讯云（未登录时直达登录页）
  env:     'https://console.cloud.tencent.com/tcb',           // CloudBase 控制台根：首次在此「开通云开发」+「新建环境」
  envList: 'https://console.cloud.tencent.com/tcb/env/index', // 环境列表（已有环境时在此复制环境 ID）
  hosting: 'https://console.cloud.tencent.com/tcb/hosting',   // 静态网站托管（需在环境里开通）
  cam:     'https://console.cloud.tencent.com/cam/capi',      // 访问管理 → API 密钥管理
  verify:  'https://console.cloud.tencent.com/developer',     // 账号信息 → 实名认证
};
function cbLink(url, text){ return '<a href="' + url + '" target="_blank" rel="noopener">' + text + '</a>'; }

// —— 「让 WorkBuddy 一键配置 CloudBase」提示词 ——
// 用户诉求：FolioFold 不该把人丢进腾讯云自己摸索；把整段引导交给用户自己的 WorkBuddy，
// 由它先带用户登录 + 实名认证，再代做/引导建环境、开静态托管、生成密钥，最后汇总回三个值。
// ⚠ 改这里必须同步 studio/studio.js（两份内容保持一致）。
// 两版指令：GENERIC 通用（任意 Agent 可用）、WORKBUDDY 版（可代操作）。
function cbPromptGeneric(){
  return [
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
}
function cbPromptWorkBuddy(){
  return [
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
}
// 从 WorkBuddy 返回的汇总文本里解析出三个值（容错中英文冒号、大小写、前后引号）。
function cbParseConfig(text){
  const t = String(text || '');
  const g = (re) => { const m = t.match(re); return m ? m[1].trim().replace(/^["'\u201c\u201d\s]+|["'\u201c\u201d\s]+$/g, '') : ''; };
  let envId     = g(/env\s*id\s*[:：]\s*([A-Za-z0-9_\-.]+)/i);
  let secretId  = g(/secret\s*id\s*[:：]\s*([A-Za-z0-9_\-.]+)/i);
  let secretKey = g(/secret\s*key\s*[:：]\s*([A-Za-z0-9_\-.]+)/i);
  // 兜底：粘贴的是整段对话（带前后文、代码块、没有 key: 前缀）时也要认出来。
  if(!secretId)  secretId  = g(/\b(AKID[A-Za-z0-9]{12,40})\b/);
  if(!envId){
    // 环境 ID 形如 folioframe-site-d4f57yrt27bf927f，或 环境名-xxxxxxxx
    const m = t.match(/\b([a-z0-9][a-z0-9-]{1,40}-[a-z0-9]{8,24})\b/);
    if(m) envId = m[1];
  }
  if(!secretKey){
    // 形如 ItRp11tcCcv77vZ4PZZQ8e1CD6pQtIYj （32 位以上大小写数字混合，排除常见英文词）
    const m = t.match(/\b([A-Za-z0-9]{32,64})\b/g) || [];
    const cand = m.find(x => /[A-Z]/.test(x) && /[a-z]/.test(x) && /\d/.test(x) && !/^AKID/i.test(x));
    if(cand) secretKey = cand;
  }
  return { envId, secretId, secretKey };
}
// 复制提示词到剪贴板（带 execCommand 兜底），并临时改按钮文字反馈。
// kind: 'generic'（通用，任意 Agent 可用）| 'workbuddy'（WorkBuddy 专用，可代操作）
async function cbCopyPrompt(btn, kind){
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
  if (!ok) { alert('复制失败，请展开「查看提示词全文」手动复制。'); return; }
  const old = btn.textContent;
  btn.textContent = '✓ 已复制，去粘贴给 Agent';
  setTimeout(() => { btn.textContent = old; }, 3500);
}
function cbDocsHtml(){
  return `<p><b>用途：</b>把当前作品集部署到腾讯云 CloudBase 静态网站托管（国内节点）。</p>
      <p><b>需要：</b>腾讯云账号 + 实名认证 + 一个 CloudBase 环境（免费体验版即可）。</p>
      <p><b>去哪配置：</b>${cbLink(CB_CONSOLE_LINKS.env,'CloudBase 控制台 ↗')}　${cbLink(CB_CONSOLE_LINKS.cam,'API 密钥管理 ↗')}</p>
      <p><b>官方文档：</b>${CB_OFFICIAL_LINKS}</p>
      <p class="publish-desc" style="font-size:12px;opacity:.75">配额、计费、单文件大小限制等均以官方文档为准；大媒体建议用 CloudBase CLI 部署。</p>
      ${cbAccessNoteHtml()}`;
}
function cbLinksRowHtml(){
  return `<p class="publish-desc" style="margin-top:10px;font-size:12px;opacity:.72">官方文档：${CB_OFFICIAL_LINKS}</p>`;
}
// 「访问须知（默认域名的中间页）」：CloudBase 默认域名（*.tcloudbaseapp.com）仅供开发测试，
// 浏览器直接访问（导航请求）会先展示「访问提示中间页」，访客点「确定访问」才能进入；
// 且默认域名有访问频率限制。唯一合规的去除方式 = 绑定已完成 ICP 备案的自定义域名。
// 官方依据：https://docs.cloudbase.net/service/alias（默认域名访问限制及中间页）。
// ⚠ 改这里必须同步 studio/studio.js 的 stCbAccessNoteHtml。
function cbAccessNoteHtml(){
  return `<p class="publish-desc" style="margin-top:10px;font-size:12px;opacity:.72"><b>访问须知（默认域名的中间页）：</b>平台默认域名（<code>*.tcloudbaseapp.com</code>）仅供开发测试使用。访客用浏览器直接打开时，会先看到一个「<b>访问提示中间页</b>」——提示当前环境仅供开发测试、内容未经合规审核，点「<b>确定访问</b>」后即可进入；同一访客在 Cookie 有效期内不会重复出现。该中间页无法关闭，<b>唯一合规的去除方式是绑定一个已完成 ICP 备案的自定义域名</b>。此外默认域名存在访问频率限制，访问量异常时平台可能限制访问，面向正式用户请使用自定义域名。详见 ${cbLink('https://docs.cloudbase.net/service/alias','官方说明 ↗')}。</p>`;
}
// —— 站点有效期 / 额度提醒 ——
// 数据来自 /api/cloudbase/quota（只读 DescribeBillingInfo）。
// ⚠ 拿不到就显示「未知」，绝不猜天数；免费额度规则一律指向官方文档。
async function cbRenderQuota(){
  const box=document.getElementById('cb-quota-box');
  if(!box) return;
  box.style.display='block';
  box.innerHTML='<p class="publish-desc">正在读取该环境的套餐与到期信息…</p>';
  let r=null;
  try{
    r=await fetch('/api/cloudbase/quota',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(x=>x.json());
  }catch(e){}
  if(!r||!r.ok){
    box.innerHTML='<p class="publish-desc" style="color:#9a6700"><b>站点有效期：</b>暂时读不到（'+
      esc((r&&r.error)||'网络不可用')+'）。可在 '+cbLink(CB_CONSOLE_LINKS.envList,'CloudBase 控制台 ↗')+
      ' 的「套餐用量」查看到期时间与剩余资源点。</p>';
    return;
  }
  const lines=[];
  const isFree = /trial|free/i.test(r.packageId||'') || r.isAlwaysFree;
  lines.push('<b>套餐：</b>'+esc(r.packageId||'未知')+(isFree?'（免费体验版）':'')+
             (r.autoRenew?'　自动续费：已开启':'　自动续费：未开启（免费版不支持自动续费）'));
  // 到期时间 → 剩余天数（只做字符串解析，解析不出就如实显示原文）
  const exp=(r.expireTime||'').trim();
  let days=null;
  if(exp){
    const t=Date.parse(exp.replace(/-/g,'/'));
    if(!isNaN(t)) days=Math.ceil((t-Date.now())/86400000);
  }
  if(exp){
    let tail='';
    if(days!==null){
      if(days<0) tail='　<span style="color:#c0392b;font-weight:600">已到期</span>';
      else if(days<=30) tail='　<span style="color:#c0392b;font-weight:600">仅剩 '+days+' 天，建议尽快续期</span>';
      else if(days<=60) tail='　<span style="color:#9a6700;font-weight:600">剩余 '+days+' 天</span>';
      else tail='　<span style="color:#0a7d33;font-weight:600">剩余 '+days+' 天</span>';
    }
    lines.push('<b>到期时间：</b>'+esc(exp)+tail);
  } else {
    lines.push('<b>到期时间：</b>未知（接口未返回，请在控制台「套餐用量」查看）');
  }
  if(r.status) lines.push('<b>环境状态：</b>'+esc(r.status)+(r.status!=='NORMAL'?'（非正常，可能已隔离或停服）':''));
  if(r.freeQuota) lines.push('<b>免费配额：</b>'+esc(r.freeQuota));
  lines.push('<span style="font-size:12px;opacity:.8">免费体验版：3000 资源点/月，单次 6 个月，到期前 1 个月内可 0 元续 6 个月；资源点用尽会停服。'+
    '规则以'+cbLink('https://cloud.tencent.com/document/buy-guide/876/127357','官方文档 ↗')+'为准；去 '+
    cbLink(CB_CONSOLE_LINKS.envList,'控制台套餐用量 ↗')+' 续期或查看剩余额度。</span>');
  box.innerHTML='<p class="publish-desc" style="line-height:1.9;margin:0">'+lines.join('<br>')+'</p>';
}
function renderCloudBaseSection(pb, cb){
  if(!pb) return;
  const btn = window.__ffDeployBtnHtml || ((l)=>`<button class="publish-btn primary" id="publink-deploy">${l}</button>`);
  // 部署代码已接入真实 CloudBase CLI 链路，但本机尚未用真实账号跑通端到端发布 —— 如实标注。
  const notVerified = `<p class="publish-desc" style="color:#9a6700"><b>当前状态：</b>部署代码已接入真实 CloudBase CLI 链路（密钥登录 + 静态托管上传），填入你自己的腾讯云凭证后即可真实发布；尚未用真实账号完成端到端发布验证。</p>`;
  // ⚠ 已发布链接不依赖当前 CloudBase 配置：只要有记录就照常列出（历史事实），
  // 配置丢失只是"无法更新/更新发布"，已有的公网链接仍可正常访问。
  // ⚠⚠ 必须按「当前模板」过滤（与 studio.js 同口径）：旧实现用 cb.publicUrl / deployments[0].url，
  //   导致切到任何模板都显示"已发布"并挂着别人的链接（新模板一打开就显示"该模板已有链接"）。
  const __cbTpl = window.__TPL__ || 'main';
  const __cbList = (cb.deployments||[]).filter(d => d && d.url && (d.tpl||'main') === __cbTpl);
  const cbLast = __cbList.length ? __cbList[__cbList.length-1] : null;
  const cbUrl = cbLast ? (cbLast.url||'') : '';
  if(cbLast){
    const cbConnBanner = (!cb.configured)
      ? `<p class="publish-desc" style="color:#9a6700">⚠ CloudBase 当前未配置 / 配置已失效。<b>你已有的发布链接仍可正常访问</b>；只有「更新当前发布 / 更新发布 / 改发布内容」需要先重新配置 CloudBase 才能操作。</p>`
      : '';
    pb.innerHTML=`
      <div class="publish-status">
        <div class="publish-status-row"><span class="publish-status-label">平台</span><span class="publish-tag">CloudBase 静态网站托管</span></div>
        <div class="publish-status-row"><span class="publish-status-label">环境</span><span class="publish-tag">${esc(cb.envId||'')}</span></div>
        <div class="publish-status-row"><span class="publish-status-label">状态</span><span class="publish-tag">已发布（Published）</span></div>
      </div>
      <div id="cb-quota-box" class="publish-hint" style="display:none;border-left:3px solid #0a7d33"></div>
      <p class="publish-desc">公开地址（任何人无需安装 FolioFold 即可浏览）：</p>
      <div class="publish-link-row">
        <input class="publish-link-input" id="publink-url" readonly value="${esc(cbUrl)}">
        <button class="publish-btn" id="publink-copy">复制</button>
      </div>
      <div class="publish-actions">
        <a class="publish-btn" id="publink-open" href="${esc(cbUrl)}" target="_blank" rel="noopener">打开作品集 ↗</a>
        ${cb.configured ? btn('更新当前发布') : '<button class="publish-btn" disabled title="先重新配置 CloudBase 才能更新">更新当前发布</button>'}
        <span style="margin-left:auto;font-size:12px;opacity:.7;align-self:center">仅更新 CloudBase 下本模板的当前公开地址，其它模板的链接不受影响</span>
        <button class="publish-btn" id="publink-reconfig">重新配置</button>
      </div>
      ${cbConnBanner}
      ${depListHtml(cb.deployments, ffCurTpl(), '这个平台下还没有任何发布记录。')}
      ${cb.configured ? newDeployHtml('cloudbase', ffCurTpl(), (cb.deployments||[]).map(d=>d.path).filter(Boolean)) : ''}
      ${cbLinksRowHtml()}
      ${cbAccessNoteHtml()}
      <p class="publish-desc">「更新当前发布」只覆盖本模板现在这个地址，同一环境下其它模板的地址不受影响。也可以改用「导出 ZIP」，把包上传到静态网站托管，无需密钥。</p>`;
    cbRenderQuota();
    wireDepList(pb, cb.deployments, () => (window.__ffRenderPublicLink && window.__ffRenderPublicLink()), 'cloudbase');
  } else if(cb.configured){
    pb.innerHTML=`
      <div class="publish-status">
        <div class="publish-status-row"><span class="publish-status-label">平台</span><span class="publish-tag">CloudBase 静态网站托管</span></div>
        <div class="publish-status-row"><span class="publish-status-label">环境</span><span class="publish-tag">${esc(cb.envId||'')}</span></div>
        <div class="publish-status-row"><span class="publish-status-label">状态</span><span class="publish-tag">已配置（尚未发布）</span></div>
      </div>
      <div id="cb-quota-box" class="publish-hint" style="display:none;border-left:3px solid #0a7d33"></div>
      ${notVerified}
      <div class="publish-actions">
        ${btn('发布到 CloudBase')}
        <button class="publish-btn" id="publink-reconfig">重新配置</button>
      </div>
      ${cbLinksRowHtml()}
      ${cbAccessNoteHtml()}`;
    cbRenderQuota();
    // 失败原因必须**常驻**贴回面板：否则后端返回的 `发布失败：xxx`
    // 会被这里整体重渲抹掉，用户只看到「已配置（尚未发布）」，误以为点了没反应。
    pubuiMount(pb);
  } else {
    pb.innerHTML=`
      <div class="publish-hint">${cbDocsHtml()}</div>
      ${notVerified}
      <div class="publish-actions">
        <button class="publish-btn primary" id="publink-setup">配置腾讯云</button>
        <button class="publish-btn" id="publink-zip-from-cb">改用「导出 ZIP」（无需配置）</button>
      </div>
      <p class="publish-desc" style="font-size:12px;opacity:.72">配置步骤、指令、密钥填写都在「配置腾讯云」里。</p>`;
    const z=document.getElementById('publink-zip-from-cb');
    if(z) z.onclick=()=>{ window.__pubProvider='zip'; renderPublicLink(document.getElementById('publish-dialog')); };
  }
}

// 「访问须知」：只陈述访问稳定性可能存在差异，不断言任何地区一定无法访问。
// ⚠ 改这里必须同步 studio/studio.js 的同名文案。
function ghAccessNoteHtml(){
  return `<p class="publish-desc" style="margin-top:10px;font-size:12px;opacity:.72"><b>访问须知：</b>GitHub Pages 的公开链接在不同网络环境下的访问稳定性可能存在差异。如在你所在环境打开不畅，可改用「导出 ZIP」或 CloudBase，按实际访问环境选择合适的发布方式。</p>`
    + `<p class="publish-desc" style="margin-top:6px;font-size:12px;opacity:.72"><b>⚠ 仓库维护：</b>这个用来发布的仓库建好后，<b>建议不要改名、也不要设为私有</b>——改名会让旧 Pages 链接直接失效（GitHub 不对项目站点做重定向），设为私有会让 Pages 返回 404。若确需改名，改名后重新发布一次并更新已分享的链接即可。</p>`;
}

// ============ 多模板多路径：已发布列表 + 「新增发布」 ============
// 背景：一个仓库 / 一个环境可以挂多套内容，各占一个子路径，链接互相独立。
// 设计约束（用户明确）：**不做总入口** —— 发给别人哪条链接，他只看得到那套内容，
// 看不到另一套、也不知道还有别的。所以这里只在**你自己的面板**里列全部链接。
// ⚠ 改这里必须同步 studio/studio.js 的 stDepListHtml / stNewDeployHtml。

// 已发布链接列表：每行一个地址 + 单独复制按钮；当前模板那条标「当前」。
// ⚠ 一个模板可以有多条记录（点几次「另外发布一个链接」就有几条）——
//   只有该模板**最后一条**才算"当前"（「更新当前发布」覆盖的就是它），其余标「历史」。
// ============ 发布类操作的统一外壳（2026-09-20）============
// 起因（用户原话）：「我输入了 tpl-2，没有任何反应。」
// 两个根因：
//   ① 用 window.prompt 让人手填模板 ID —— 填什么全靠猜，填错了也没反馈；
//   ② 按钮只是把文字换成「发布中…」，没有接进统一的发布进度状态机，
//      于是服务端到底跑没跑、跑到哪一步，界面上一无所知。
// 现在凡是会触发服务端发布/删除的按钮，一律走 ffPickTpl + runPubJob 两个入口。

// 通用「选一个模板」弹窗：按**模板名**列出来直接选，不再让人手填 id。
// 返回 Promise<模板 id 或 null(取消)>。
//
// ⚠⚠ 2026-09-24 与 studio.js 同步修一个真 bug：本函数可能在**已经 showModal 的对话框之上**被调用
//   （Studio 外壳的「公开链接」面板就是 `<dialog>`），而 `showModal()` 会把元素放进浏览器
//   **top layer —— 层级高于任何 z-index**。旧的 `position:fixed;z-index:99999` 遮罩因此被压在
//   下面，用户点不到。改用 `<dialog>.showModal()`：top layer 里后开的在更上层，天然压住前一个。
//   ⚠ 以后凡是在弹窗里再开弹窗，一律 showModal，别再跟 top layer 比大小。
function ffPickTpl(opt){
  const o = opt || {};
  const list = o.list || [];
  const cur = String(o.current || '');
  return new Promise(resolve => {
    const dlg = document.createElement('dialog');
    dlg.className = 'ff-pick-dialog';
    const rows = list.length
      ? list.map(t => {
          const id = String(t.id || '');
          const nm = String(t.name || id);
          const sel = id === cur ? ' checked' : '';
          return '<label class="ff-pick-row">'
            + '<input type="radio" name="ff-pick-tpl" value="' + esc(id) + '"' + sel + '>'
            + '<span class="ff-pick-name">' + esc(nm) + '</span>'
            + '<code>' + esc(id) + '</code></label>';
        }).join('')
      : '<p class="ff-pick-empty">没有可选模板</p>';
    dlg.innerHTML = '<h3>' + esc(o.title || '选择模板') + '</h3>'
      + (o.desc ? '<p>' + esc(o.desc) + '</p>' : '')
      + '<div class="ff-pick-list">' + rows + '</div>'
      + '<div class="ff-pick-actions">'
      + '<button type="button" class="publish-btn" data-ff-pick-cancel>取消</button>'
      + '<button type="button" class="publish-btn primary" data-ff-pick-ok>' + esc(o.okText || '确定') + '</button>'
      + '</div>';
    let settled = false;
    const done = v => {
      if (settled) return;
      settled = true;
      try { if (dlg.open) dlg.close(); } catch (_) {}
      try { dlg.remove(); } catch (_) {}
      resolve(v);
    };
    const c = dlg.querySelector('[data-ff-pick-cancel]'); if (c) c.onclick = () => done(null);
    const k = dlg.querySelector('[data-ff-pick-ok]');
    if (k) k.onclick = () => {
      const r = dlg.querySelector('input[name=ff-pick-tpl]:checked');
      done(r ? r.value : null);
    };
    dlg.addEventListener('click', e => { if (e.target === dlg) done(null); });
    dlg.addEventListener('cancel', e => { e.preventDefault(); done(null); });
    dlg.addEventListener('close', () => done(null));
    document.body.appendChild(dlg);
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  });
}

// 统一的发布类操作执行器：点下去**立刻**出进度，结束必有结论（成功绿字 / 失败红字常驻）。
// provider：'github' | 'cloudbase'；label：提交阶段的文案；fn：真正发请求的 async 函数，返回后端 json。
async function runPubJob(provider, label, fn){
  if (pubuiBusy()) {
    if (typeof toastInCanvas === 'function') toastInCanvas('上一个操作还在进行中，请等它结束再点。');
    return false;
  }
  PUBUI.phase = 'starting'; PUBUI.provider = provider; PUBUI.detail = label;
  PUBUI.error = ''; PUBUI.total = 0; PUBUI.sent = 0; PUBUI.pct = 0; PUBUI.elapsed = 0;
  PUBUI.warnings = []; PUBUI.since = Date.now();
  pubuiMount(); pubuiPaint(); pubuiStartPoll();
  let ok = false, res = null;
  try {
    res = await fn();
    ok = !!(res && res.ok);
    if (!ok) throw new Error((res && (res.error || res.message)) || '操作失败');
    PUBUI.phase = 'ok'; PUBUI.since = Date.now();
    PUBUI.detail = (res && (res.message || res.detail)) ? String(res.message || res.detail) : '已完成';
  } catch (e) {
    PUBUI.phase = 'error'; PUBUI.error = String((e && e.message) || e);
    if (typeof toastInCanvas === 'function') toastInCanvas('✗ ' + String((e && e.message) || e).split('\n')[0].slice(0, 90));
  } finally {
    pubuiStopPoll(); pubuiPaint();
    try { if (typeof window.__ffRenderPublicLink === 'function') await window.__ffRenderPublicLink(); } catch (_) {}
  }
  if (ok && typeof toastInCanvas === 'function') toastInCanvas('✓ ' + String(PUBUI.detail || '已完成'));
  return ok;
}

// 当前模板：地址栏的 ?tpl= 是唯一事实来源（与 portfolio/index.html 的 fetch 拦截器同口径）。
// ⚠ 2026-10-06 修复：以前这里全直接读 window.__tpl —— 但**全项目从来没给它赋过值**，
//   于是它恒为 undefined，一切都静默退化成 'main'：在 FolioFold / Starter 模板下打开
//   Public Link，看到的却是 Main 的发布状态（跨模板状态串台）。
function ffCurTpl(){
  try {
    const t = new URLSearchParams(location.search).get('tpl');
    if (t && String(t).trim()) return String(t).trim();
  } catch (_) {}
  return (window.__tpl && String(window.__tpl).trim()) || 'main';
}

// 当前模板的**显示名**（Main / FolioFold / Starter…）。
// ⚠ 2026-10-06：面板里「✓ X 已发布」「更新 X」以前一律写死 "FolioFold"，在别的模板下会报错身份。
function ffCurTplName(){
  try {
    const id = ffCurTpl();
    const hit = (window.__tplList || []).find(x => String((x && x.id)) === id);
    if (hit && hit.name) return String(hit.name);
  } catch (_) {}
  return ffCurTpl();
}

// 一个模板在同一平台下可以有多条发布记录；「当前」= 最近发布的那条
// （「更新当前发布」覆盖的就是它 —— 与服务端 find_deployment 同口径）。
// ⚠ 2026-10-06 修复：服务端把列表按 (path, tpl) 排序后才下发给前端，**位置已不等于时间**。
//   老代码取「该模板最后出现的一条下标」当"当前"，在真实数据上标到了最旧那条
//   （2026-10-03 那条被标成"当前"，而 2026-10-05 那条反而是"历史"），
//   且与「更新当前发布」真正覆盖的记录不是同一条。
//   现在以服务端裁定的 current 为准；老数据没有该字段时按 deployedAt 兜底。
function depCurMap(items){
  const list = (items || []).filter(d => d && d.url);
  const map = {};
  const flagged = list.some(d => typeof d.current === 'boolean');
  list.forEach(d => {
    const t = d.tpl || 'main';
    if (flagged) { if (d.current) map[t] = d; return; }
    const p = map[t];
    if (!p) { map[t] = d; return; }
    const a = Date.parse(p.deployedAt || '') || 0, b = Date.parse(d.deployedAt || '') || 0;
    if (b >= a) map[t] = d;   // 时间相同取后出现的一条（= 服务端写入顺序的最后一条）
  });
  return map;
}
function depListHtml(list, curTpl, emptyHint){
  const items = (list || []).filter(d => d && d.url);
  const cur = String(curTpl || 'main');
  if (!items.length) return emptyHint ? `<p class="publish-desc" style="font-size:12px;opacity:.72">${esc(emptyHint)}</p>` : '';
  const curMap = depCurMap(items);
  // ⚠ 2026-10-06：只有**当前模板自己**的记录才允许出现「当前 / 历史」标记。
  //   别的模板的记录照常列出（那是真实存在的链接，还要能复制 / 删除），
  //   但绝不许标成任何形式的"当前" —— 以前会给它们打「该模板当前」，于是人在
  //   FolioFold 模板里却看到 Main 摆着一个"当前"，看着就是当前模板串台了。
  const hasMine = items.some(d => (d.tpl || 'main') === cur);
  const notice = hasMine ? ''
    : `<p class="publish-desc" style="font-size:12px;opacity:.72;margin:0 0 4px 0">本模板在这个平台下还没有发布记录。</p>`;
  const rows = items.map((d, i) => {
    const t = d.tpl || 'main';
    const isThisTpl = t === cur;
    const isCur = isThisTpl && curMap[t] === d;
    const name = d.tplName || t;
    const tag = isThisTpl ? (isCur ? ' · 当前' : ' · 历史') : ' · 其他模板';
    const sub = d.path ? '/' + esc(d.path) + '/' : '/';
    return `<div class="publish-dep-item">
    <div class="publish-link-row" style="margin-top:6px">
      <span class="publish-tag" style="min-width:auto;${isThisTpl && isCur ? 'font-weight:600' : 'opacity:.7'}">${esc(name)}${tag}</span>
      <input class="publish-link-input" id="publink-dep-${i}" readonly value="${esc(d.url)}">
      <button class="publish-btn" data-dep-copy="${i}">复制</button>
    </div>
    <p class="publish-desc" style="font-size:12px;opacity:.7;margin:2px 0 0 0">路径 <code>${sub}</code>
      <button class="publish-btn" data-dep-repub="${i}" style="padding:2px 8px;margin-left:8px;font-size:11px" title="把这个网址上的内容重新上传一次（内容没变也会刷一遍）。线上内容和你选的模板对不上时，点这个强制纠正">更新发布</button>
      <button class="publish-btn" data-dep-retarget="${i}" style="padding:2px 8px;margin-left:6px;font-size:11px" title="网址不动，把里面的内容换成另一个模板再发布一次">改发布内容</button>
      <button class="publish-btn" data-dep-del="${i}" style="padding:2px 8px;margin-left:6px;font-size:11px" title="删除这条发布：本机记录与线上路径一起删除">删除</button>
    </p>
    </div>`;
  }).join('');
  return `<div style="margin-top:8px">
    <p class="publish-desc" style="margin-bottom:2px"><b>这个平台下已发布的链接</b>（每条互相独立；你把哪条发给别人，他就只看到那一条的内容）：</p>
    ${notice}
    ${rows}
  </div>`;
}

// 绑定列表里的「复制 / 改发布内容 / 删除」按钮。
// list = 该平台的 deployments 原始数组（用于取 provider/tpl/path 三元组）；
// rerender = 操作完成后重渲面板的回调（通常是 renderPublicLink 的再次调用）。
function wireDepList(host, list, rerender, provider){
  // provider = 这一组记录属于哪个渠道（'github' / 'cloudbase'），由调用方传入。
  // ⚠ 必须显式带上（2026-09-28 修复）：老版本 /api/deploy/status 组装记录时漏了 provider 字段，
  // 而下面三个按钮都把它原样塞进请求体 → undefined 被 JSON.stringify 丢掉 →
  // 后端判空 → 一律「不支持的平台：(空)」，列表里的按钮就成了摆设。
  const items = (list || []).filter(d => d && d.url);
  (host || document).querySelectorAll('[data-dep-copy]').forEach(b => {
    b.onclick = async () => {
      const i = b.getAttribute('data-dep-copy');
      const inp = document.getElementById('publink-dep-' + i);
      if (!inp || !inp.value) return;
      try { await navigator.clipboard.writeText(inp.value); }
      catch (_) { inp.select(); document.execCommand && document.execCommand('copy'); }
      const old = b.textContent; b.textContent = '已复制';
      setTimeout(() => { b.textContent = old; }, 1500);
    };
  });
  // —— 删除：本机记录 + 线上路径一起删（用户明确要求"不要假删除"）——
  (host || document).querySelectorAll('[data-dep-del]').forEach(b => {
    b.onclick = async () => {
      const i = +b.getAttribute('data-dep-del');
      const d = items[i];
      if (!d) return;
      const name = d.tplName || d.tpl || 'main';
      const sub = d.path ? '/' + d.path + '/' : '/';
      if (!window.confirm('删除这条发布？\n\n· 模板：' + name + '\n· 路径：' + sub + '\n\n会同时删除线上对应的页面（GitHub Pages / CloudBase 上该路径将无法访问），此操作不可撤销。')) return;
      await runPubJob(d.provider || provider || 'github', '正在提交删除请求…', async () => {
        const r = await fetch('/api/deploy/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: (d.provider || provider || ''), tpl: d.tpl || 'main', path: d.path || '', remote: true }) }).then(x => x.json());
        // 线上没能删掉：如实把"去哪儿手动删"摆出来，而不是假装删干净了。
        if (r && r.ok && r.remoteOk === false && r.manualUrl) {
          if (typeof toastInCanvas === 'function') toastInCanvas('⚠ 线上没能自动删除，已打开手动删除页面');
          try { window.open(r.manualUrl, '_blank'); } catch (_) {}
        }
        return r;
      });
    };
  });
  // —— 更新发布：把这个地址的内容强制刷成它自己那个模板（修"线上内容和模板对不上"）——
  // 为什么要有这个按钮：记录上的标签写的是「模板二」，线上却可能是模板一的内容
  // （历史上一度只改了标签没真正重发）。点它 = 老老实实把该模板重新推一遍。
  (host || document).querySelectorAll('[data-dep-repub]').forEach(b => {
    b.onclick = async () => {
      const i = +b.getAttribute('data-dep-repub');
      const d = items[i];
      if (!d) return;
      const tpl = d.tpl || 'main';
      const nm = d.tplName || tpl;
      const sub = d.path ? '/' + d.path + '/' : '/';
      if (!window.confirm('把 ' + sub + ' 更新一遍？\n\n· 模板：' + nm + '\n· 路径：' + sub +
        '\n\n会用「' + nm + '」当前的内容覆盖这个网址上的页面。网址不变。')) return;
      await runPubJob(d.provider || provider || 'github', '正在准备更新 ' + sub + ' …', async () => {
        const r = await fetch('/api/deploy/retarget', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: (d.provider || provider || ''), tpl: tpl, path: d.path || '', newTpl: tpl }) }).then(x => x.json());
        if (r && r.ok) r.message = '已把 ' + sub + ' 更新为「' + nm + '」';
        return r;
      });
    };
  });
  // —— 改发布内容：保留网址，把内容换成**选出来**的另一个模板更新发布 ——
  // ⚠ 不再用 window.prompt 手填模板 ID：用户根本不知道该填什么，填错了也没反馈。
  (host || document).querySelectorAll('[data-dep-retarget]').forEach(b => {
    b.onclick = async () => {
      const i = +b.getAttribute('data-dep-retarget');
      const d = items[i];
      if (!d) return;
      const tpls = (window.__tplList || []);
      const sub = d.path ? '/' + d.path + '/' : '/';
      const target = await ffPickTpl({
        list: tpls.length ? tpls : [{ id: d.tpl || 'main', name: d.tplName || (d.tpl || 'main') }],
        current: d.tpl || 'main',
        title: '把 ' + sub + ' 发布成哪个模板？',
        desc: '网址保持不变，只把这个网址上的内容换成所选模板的内容。选同一个模板 = 原样重新上传一遍。',
        okText: '开始发布'
      });
      if (!target) return;
      const nm = ((tpls.find(t => t.id === target) || {}).name) || target;
      await runPubJob(d.provider || provider || 'github', '正在发布「' + nm + '」到 ' + sub + ' …', async () => {
        const r = await fetch('/api/deploy/retarget', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: (d.provider || provider || ''), tpl: d.tpl || 'main', path: d.path || '', newTpl: target }) }).then(x => x.json());
        if (r && r.ok) r.message = sub + ' 已发布为「' + nm + '」';
        return r;
      });
    };
  });
}

// 「新增发布」：不覆盖当前链接，另开一个子路径挂同一套内容。
// 折叠在 <details> 里，避免把主面板搞复杂 —— 多数时候用户只需要「更新当前发布」。
// 「发布到新地址」的模板下拉项。
// 为什么要显式选：以前默认发"当前模板"，但用户看不出到底发的是哪一个，
// 出现过「以为发的是模板二、结果线上还是模板一的内容」——必须让人自己点一下。
function newDepTplOptions(curTpl){
  const list = (window.__tplList || []);
  const cur = String(curTpl || 'main');
  if (!list.length) return '<option value="' + esc(cur) + '">' + esc(cur) + '</option>';
  return list.map(t => {
    const id = String(t.id || '');
    return '<option value="' + esc(id) + '"' + (id === cur ? ' selected' : '') + '>' + esc(t.name || id) + '</option>';
  }).join('');
}

function newDeployHtml(provider, curTpl, existingPaths){
  if (provider === 'zip') return '';
  const taken = (existingPaths || []).join('、');
  return `<details id="publink-newdep-box" style="margin-top:12px">
    <summary style="cursor:pointer;font-size:13px;opacity:.85">另外发布一个链接（不覆盖当前地址）</summary>
    <div class="publish-hint" style="margin-top:8px">
      <p><b>用途：</b>同一套内容再挂一个独立地址。比如你给不同岗位各做一版简历，可以每版发一个链接，
        互不影响 —— 你发哪条，对方就只看到哪条。<b>不会新建仓库或环境</b>，只是同一站点下的另一个子路径。</p>
      <p><b>路径名：</b>就是地址最后那一段。已自动填好一个不冲突的名字，可改成你喜欢的（只支持字母、数字、<code>-</code>、<code>_</code>）。</p>
      ${taken ? `<p style="font-size:12px;opacity:.75">已被占用的路径：<code>${esc(taken)}</code></p>` : ''}
      <p style="font-size:12px;opacity:.85;margin:10px 0 0"><b>① 发布哪一个模板？</b>（必选 —— 不默认、不猜）</p>
      <div class="publish-link-row" style="margin-top:6px">
        <select id="publink-newdep-tpl" class="publish-link-input" style="flex:1">${newDepTplOptions(curTpl)}</select>
      </div>
      <p style="font-size:12px;opacity:.85;margin:10px 0 0"><b>② 路径名</b>（地址最后那一段）</p>
      <div class="publish-link-row" style="margin-top:6px">
        <input class="publish-link-input" id="publink-newdep-path" placeholder="自动生成" value="">
        <button class="publish-btn primary" id="publink-newdep-go">发布到新地址</button>
      </div>
      <p class="publish-desc" id="publink-newdep-preview" style="font-size:12px;opacity:.75;margin-top:6px"></p>
    </div>
  </details>`;
}

// 填写/更新「新增发布」的地址预览。hostingBase = 该平台的站点根地址。
function wireNewDeploy(host, provider, curTpl, hostingBase, onGo){
  const box = document.getElementById('publink-newdep-box');
  if (!box) return;
  const inp = document.getElementById('publink-newdep-path');
  const prev = document.getElementById('publink-newdep-preview');
  const go = document.getElementById('publink-newdep-go');
  let suggested = '';
  const paint = () => {
    if (!prev) return;
    const v = (inp && inp.value || '').trim().replace(/^\/+|\/+$/g, '');
    prev.textContent = v
      ? ('将发布到：' + (hostingBase || '') + v + '/')
      : (suggested ? ('留空将使用自动生成的名字：' + suggested) : '');
  };
  // 打开折叠时才去问服务端建议名（不打开就不打扰）。
  box.addEventListener('toggle', async () => {
    if (!box.open || suggested) { paint(); return; }
    try {
      const q = '?provider=' + encodeURIComponent(provider) + '&tpl=' + encodeURIComponent(curTpl || 'main');
      const r = await fetch('/api/deploy/suggest-path' + q, { cache: 'no-store' }).then(x => x.json());
      if (r && r.ok && r.suggested) { suggested = r.suggested; if (inp) inp.placeholder = r.suggested; }
    } catch (e) {}
    paint();
  });
  if (inp) inp.addEventListener('input', paint);
  if (go) go.onclick = () => {
    const v = (inp && inp.value || '').trim().replace(/^\/+|\/+$/g, '');
    const sel = document.getElementById('publink-newdep-tpl');
    const tplSel = sel ? String(sel.value || '').trim() : '';
    if (!tplSel) { if (typeof toastInCanvas === 'function') toastInCanvas('请先选择要发布哪个模板'); return; }
    if (go.dataset.busy) return; go.dataset.busy = '1';
    onGo(v, tplSel);
  };
  paint();
}

// 平台站点根地址（用于「新增发布」的地址预览）：去掉已发布 URL 末尾的路径段。
function hostingBaseOf(url){
  const u = String(url || '');
  if (!u) return '';
  try {
    const m = u.match(/^(https?:\/\/[^/]+\/)/);
    return m ? m[1] : u;
  } catch (e) { return ''; }
}

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

async function renderGithubSection(pb, gh){
  if(!pb) return;
  // ⚠ deployBtnHtml 定义在 renderPublicLink 作用域内，这里拿不到（曾导致 ReferenceError → 整个分区空白）。
  // 改为读全局工厂 + 兜底，与 CloudBase 区保持一致。
  const deployBtnHtml = window.__ffDeployBtnHtml
    || ((l)=>`<button class="publish-btn primary" id="publink-deploy">${l}</button>`);
  let app={appConfigured:false}, status={connected:false, login:''};
  try{ app=await fetch('/api/github/app',{cache:'no-store'}).then(r=>r.json()); }catch(e){}
  try{ status=await fetch('/api/github/status',{cache:'no-store'}).then(r=>r.json()); }catch(e){}
  // 服务端能力结论是本地缓存 + 后台刷新；陈旧时自动重渲染一次，免手动刷新。
  if (status.probeStale) {
    if ((window.__ghProbeRetry || 0) < 4) {
      window.__ghProbeRetry = (window.__ghProbeRetry || 0) + 1;
      // 自愈重渲只在"用户没有正在操作"时做：凭证表单开着、发布进行中、或用户正在输入框打字都不重渲，
      // 否则用户填到一半的输入会被清空、进度/按钮会闪一下，中文拼音输入也会被强行打断（真实反馈 2026-09-18）。
      // 用户正在打字时，本次延后至其停手后再重渲（最多延后 30 秒）。
      if (!__pubSetupOpen && !pubuiBusy()) {
        setTimeout(function __ghProbeHeal(){
          const d = document.getElementById('publish-dialog');
          if (!(d && d.open)) return;
          if (__ffPubUserTyping()) {
            if ((window.__ghProbeDefer||0) < 30) { window.__ghProbeDefer = (window.__ghProbeDefer||0) + 1; setTimeout(__ghProbeHeal, 1000); }
            return;
          }
          renderPublicLink(d);
        }, 2500);
      }
    }
  } else { window.__ghProbeRetry = 0; window.__ghProbeDefer = 0; }
  // 警告判据来自服务端的**真实 API 探测**（canCreateRepo），不再靠令牌前缀猜。
  const capWarn=(status.connected && status.canCreateRepo===false)
    ? `<p class="publish-desc" style="color:#9a6700">⚠ ${esc(status.warning||'当前 GitHub 授权没有在你账号下新建仓库的权限，发布到 GitHub Pages 会失败。')}</p>`
    : '';
  const reauthWarn=(status.needsReauth||status.expired)
    ? `<p class="publish-desc" style="color:#c0392b">${esc(status.detail||'GitHub 授权已失效或过期，请点「连接 GitHub」重新授权一次。')}</p>`
    : '';
  const kindWarn='';
  // ⚠ 已发布链接不再依赖当前授权/连接状态：只要有发布记录就照常列出（历史事实），
  // 连接失效只是"无法更新/更新发布"，已有的公网链接仍可正常访问（防止"久不用就找不着链接"）。
  // ⚠⚠ 按「当前模板」过滤：只有本模板自己有发布记录才显示"已发布"+链接；
  //   新模板应落到下面"还没有发布过"分支要求重新发布，而不是挂着别人的链接。
  const __ghTpl = window.__TPL__ || 'main';
  const __ghList = (gh.deployments||[]).filter(d => d && d.url && (d.tpl||'main') === __ghTpl);
  const ghLast = __ghList.length ? __ghList[__ghList.length-1] : null;
  if(ghLast){
    const ghUrl = ghLast.url || '';
    const ghLogin = status.login || (ghLast.meta && ghLast.meta.owner) || '';
    const connBanner = (!status.connected)
      ? `<p class="publish-desc" style="color:#9a6700">⚠ GitHub 当前未连接 / 授权已失效。<b>你已有的发布链接仍可正常访问</b>；只有「更新当前发布 / 更新发布 / 改发布内容」需要先重新连接 GitHub 才能操作。</p>`
      : '';
    pb.innerHTML=`
      <div class="publish-status">
        <div class="publish-status-row"><span class="publish-status-label">状态</span><span class="publish-tag">✓ ${esc(ffCurTplName())} 已发布</span></div>
        <div class="publish-status-row"><span class="publish-status-label">账号</span><span class="publish-tag">${esc(ghLogin)}</span>${status.connected ? '' : '<span class="publish-status-label" style="color:#9a6700"> · GitHub 当前未连接</span>'}</div>
      </div>
      <p class="publish-desc">公网地址（任何人无需安装 FolioFold、无需 GitHub 账号即可浏览）：</p>
      <div class="publish-link-row">
        <input class="publish-link-input" id="publink-url" readonly value="${esc(ghUrl)}">
        <button class="publish-btn" id="publink-copy">复制</button>
      </div>
      <div class="publish-actions">
        <a class="publish-btn" id="publink-open" href="${esc(ghUrl)}" target="_blank" rel="noopener">打开 FolioFold ↗</a>
        ${status.connected ? deployBtnHtml('更新 ' + ffCurTplName()) : `<button class="publish-btn" disabled title="先重新连接 GitHub 才能更新">更新 ${esc(ffCurTplName())}</button>`}
        <button class="publish-btn" id="publink-connect">连接 GitHub</button>
        <button class="publish-btn" id="publink-disconnect">断开 GitHub</button>
        <span style="margin-left:auto;font-size:12px;opacity:.7;align-self:center">仅更新 GitHub 下本模板的当前公开地址，其它模板的链接不受影响</span>
      </div>
      ${connBanner}${reauthWarn}${capWarn}
      ${depListHtml(gh.deployments, ffCurTpl(), '这个平台下还没有任何发布记录。')}
      ${status.connected ? newDeployHtml('github', ffCurTpl(), (gh.deployments||[]).map(d=>d.path).filter(Boolean)) : ''}
      ${ghAccessNoteHtml()}
      <p class="publish-desc" style="margin-top:10px;font-size:12px;opacity:.72">「更新 ${esc(ffCurTplName())}」会覆盖本模板现在这个地址，链接保持不变；其它模板的地址不受影响。大视频自动走 Release Assets。</p>`;
    wireDepList(pb, gh.deployments, () => (window.__ffRenderPublicLink && window.__ffRenderPublicLink()), 'github');
  } else if(status.connected){
    pb.innerHTML=`
      <div class="publish-status">
        <div class="publish-status-row"><span class="publish-status-label">状态</span><span class="publish-tag">✓ GitHub 已连接</span></div>
        <div class="publish-status-row"><span class="publish-status-label">账号</span><span class="publish-tag">${esc(status.login)}</span></div>
      </div>
      ${reauthWarn}${capWarn}
      <div class="publish-actions">
        ${deployBtnHtml('发布 ' + ffCurTplName())}
        <button class="publish-btn" id="publink-github-adv">开发者选项</button>
        <button class="publish-btn" id="publink-disconnect">断开 GitHub</button>
      </div>
      <p class="publish-desc" style="margin-top:10px;font-size:12px;opacity:.72">首次发布会在你的账号下自动创建 <code>${esc(status.login||'你')}.github.io</code> 仓库并启用 Pages，无需你手动配置。</p>
      <p class="publish-desc" style="font-size:12px;opacity:.72">「开发者选项」仅用于自建 OAuth App 的调试，普通用户不需要。</p>
      ${ghAccessNoteHtml()}
      <div id="publink-gh-note" style="display:none"></div>`;
  } else {
    pb.innerHTML=`
      <div class="publish-status">
        <div class="publish-status-row"><span class="publish-status-label">状态</span><span class="publish-tag">未连接</span></div>
      </div>
      <p class="publish-desc">点「连接 GitHub」后，在 GitHub 页面输入一个 8 位代码即可完成授权。FolioFold 不需要你的密码、不需要你创建任何 GitHub 应用，也不需要 Client Secret。</p>
      ${status.detail?`<p class="publish-desc" style="color:#c0392b">${esc(status.detail)}</p>`:''}
      <div class="publish-actions">
        <button class="publish-btn primary" id="publink-connect">连接 GitHub</button>
      </div>
      <p class="publish-desc" style="font-size:12px;opacity:.72"><a href="#" id="publink-github-adv">开发者选项</a>（自建 OAuth App 调试用，普通用户不需要）</p>
      ${ghAccessNoteHtml()}
      <div id="publink-gh-device" style="display:none"></div>
      <div id="publink-gh-note" style="display:none"></div>`;
  }
  const disc=document.getElementById('publink-disconnect');
  if(disc) disc.onclick=async()=>{ disc.disabled=true; try{ await fetch('/api/github/disconnect',{method:'POST'}); }catch(e){} window.__pubProvider='github'; renderPublicLink(document.getElementById('publish-dialog')); };
  const conn=document.getElementById('publink-connect');
  if(conn) conn.onclick=()=>startGithubDeviceFlow(pb);
  const adv=document.getElementById('publink-github-adv');
  if(adv) adv.onclick=()=>renderGithubAdvanced(pb, app);
}

// —— Device Flow：一键授权（普通用户只需点开 GitHub 页面输入 8 位代码）——
// 全程只用公开 client_id，没有 client_secret；令牌只存本机 .folioframe/gh.json。
async function startGithubDeviceFlow(pb){
  if(!pb) return;
  const box=document.getElementById('publink-gh-device')||pb;
  box.style.display='block';
  box.innerHTML=`<p class="publish-desc">正在向 GitHub 申请授权码…</p>`;
  let d;
  try{
    d=await fetch('/api/github/device/start',{method:'POST'}).then(r=>r.json());
  }catch(e){ d={ok:false,error:String(e.message||e)}; }
  if(!d.ok){
    box.innerHTML=`<p class="publish-desc" style="color:#c0392b">申请失败：${esc(d.error||'未知错误')}</p>
      <div class="publish-actions"><button class="publish-btn" id="publink-gh-retry">重试</button></div>`;
    const rt=document.getElementById('publink-gh-retry'); if(rt) rt.onclick=()=>startGithubDeviceFlow(pb);
    return;
  }
  renderDeviceCodeBox(box, d);
  pollGithubDevice(pb, box);
}

function renderDeviceCodeBox(box, d){
  const code=esc(d.user_code||'');
  const uri=esc(d.verification_uri||'https://github.com/login/device');
  const uriFull=esc(d.verification_uri_complete||d.verification_uri||'https://github.com/login/device');
  box.innerHTML=`
    <p class="publish-desc" style="margin-top:12px">在 GitHub 页面输入下面的代码（已自动复制，可直接粘贴）：</p>
    <div style="display:flex;align-items:center;gap:10px;margin:8px 0 12px">
      <span id="publink-gh-code" style="font:700 26px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:3px;padding:10px 16px;border:1px dashed #b9b9c6;border-radius:10px;background:#fafafb;user-select:all">${code}</span>
      <button class="publish-btn" id="publink-gh-copycode">复制代码</button>
    </div>
    <div class="publish-actions">
      <a class="publish-btn primary" id="publink-gh-open" href="${uriFull}" target="_blank" rel="noopener">打开 GitHub 授权页 ↗</a>
      <button class="publish-btn" id="publink-gh-cancel">取消</button>
    </div>
    <p class="publish-desc" id="publink-gh-wait" style="margin-top:10px;font-size:12px;opacity:.8">等待你在 GitHub 上完成授权…</p>`;
  const copy=document.getElementById('publink-gh-copycode');
  if(copy) copy.onclick=async()=>{
    const t=(d.user_code||'');
    try{ await navigator.clipboard.writeText(t); }catch(_){}
    copy.textContent='已复制'; setTimeout(()=>{copy.textContent='复制代码';},1500);
  };
  const cancel=document.getElementById('publink-gh-cancel');
  if(cancel) cancel.onclick=()=>{ window.__ghPollStop=true; window.__pubProvider='github'; renderPublicLink(document.getElementById('publish-dialog')); };
}

async function pollGithubDevice(pb, box){
  window.__ghPollStop=false;
  const wait=document.getElementById('publink-gh-wait');
  let delay=5000;
  const t0=Date.now();
  while(!window.__ghPollStop && Date.now()-t0 < 15*60*1000){
    await new Promise(r=>setTimeout(r,delay));
    if(window.__ghPollStop) return;
    let r;
    try{ r=await fetch('/api/github/device/poll',{method:'POST'}).then(x=>x.json()); }
    catch(e){ continue; }
    if(!r.ok){ if(wait) wait.textContent='查询失败：'+(r.error||'未知错误'); continue; }
    if(r.status==='connected'){
      window.__pubProvider='github';
      // 连接成功 ≠ 能发布：服务端已用真实 API 探过建仓权限，这里如实转达。
      if(r.canCreateRepo===false && wait){ wait.textContent='已连接，但该授权无法新建仓库 —— 请看面板提示。'; wait.style.color='#9a6700'; }
      renderPublicLink(document.getElementById('publish-dialog'));
      return;
    }
    if(r.status==='denied'){ if(wait){ wait.textContent='你在 GitHub 上拒绝了授权。'; wait.style.color='#c0392b'; } return; }
    if(r.status==='expired'){ if(wait){ wait.textContent='授权码已过期，请重新点击「连接 GitHub」。'; wait.style.color='#c0392b'; } return; }
    if(r.slowDown) delay=Math.min(delay+5000, 15000);
  }
}

// —— 高级选项（可选）：自带 OAuth App 回环回调；默认折叠，普通用户可以完全忽略 ——
function renderGithubAdvanced(pb, app){
  if(!pb) return;
  const note=document.getElementById('publink-gh-note');
  const box=document.getElementById('publink-gh-device'); if(box) box.style.display='none';
  if(!note) return;
  note.style.display='block';
  const configured = !!(app && app.appConfigured);
  note.innerHTML=`
    <div style="border-top:1px solid #e6e6ee;margin-top:14px;padding-top:12px">
      <p class="publish-desc" style="font-size:12px"><b>仅开发者需要</b>：想让 FolioFold 用你自己注册的 OAuth App 身份授权时才填。普通用户请直接用「连接 GitHub」。<br>注册：<a href="https://github.com/settings/developers" target="_blank" rel="noopener">github.com/settings/developers</a> → <b>New OAuth App</b>，Homepage URL 与 Authorization callback URL 都填 <code>http://127.0.0.1:3000/api/github/callback</code>，勾上 <b>Enable device flow</b>（不勾则设备码授权用不了）。<b>只填 Client ID 即可</b>，Client Secret 非必需。</p>
      <label class="st-field-label" for="gh-cid">Client ID</label>
      <input class="publish-input" id="gh-cid" placeholder="GitHub OAuth App Client ID" value="${esc((app&&app.client_id)||'')}">
      <label class="st-field-label" for="gh-csec">Client Secret（可留空 → 走设备码授权）</label>
      <input class="publish-input" id="gh-csec" type="password" placeholder="留空也可以：只填 Client ID 即可授权">
      <div class="publish-actions">
        <button class="publish-btn" id="publink-github-clear">清除自带 App</button>
        <button class="publish-btn primary" id="publink-github-save">保存</button>
      </div>
      <p class="publish-desc" style="font-size:12px;opacity:.72">回调地址：<code>http://127.0.0.1:3000/api/github/callback</code>${configured?'（当前已配置自带 App）':''}</p>
    </div>`;
  const clear=document.getElementById('publink-github-clear');
  if(clear) clear.onclick=async()=>{
    try{ await fetch('/api/github/app',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:'',client_secret:''})}); }catch(e){}
    window.__pubProvider='github'; renderPublicLink(document.getElementById('publish-dialog'));
  };
  const save=document.getElementById('publink-github-save');
  if(save) save.onclick=async()=>{
    const cid=(document.getElementById('gh-cid').value||'').trim();
    const csec=(document.getElementById('gh-csec').value||'').trim();
    if(!cid){ alert('请填写你自己的 OAuth App Client ID。\n（如果只是想让 FolioFold 连接 GitHub，请直接用上面的「连接 GitHub」。）'); return; }
    save.disabled=true; save.textContent='保存中…';
    try{
      const r=await fetch('/api/github/app',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:cid, client_secret:csec})}).then(x=>x.json());
      if(!r.ok) throw Error(r.error||'保存失败');
    }catch(e){ alert('保存失败：'+e.message); save.disabled=false; save.textContent='保存'; return; }
    // 填了 secret → 回环授权；只填 Client ID → 设备码授权（用你自己的 App，不依赖 3000 端口回调）
    if(csec){ window.location.href='/api/github/connect?method=oauth'; return; }
    alert('Client ID 已保存 ✓\n接下来点「连接 GitHub」，会用你自己的 OAuth App 走设备码授权。');
    window.__pubProvider='github';
    renderPublicLink(document.getElementById('publish-dialog'));
  };
}


function wirePublicLink(dialog, st){
  const body=document.getElementById('publink-body'); if(!body) return;
  const host=document.getElementById('publink-provider-body')||body;
  // 大媒体（100MB+）后台上传进度：站点早已上线，只有视频等大文件还在传。
  // 上传期间每 5 秒自动重渲一次，用户不用手动刷新，也不会被误报成「发布失败」。
  const mu=(st&&st.mediaUpload)||{};
  if(mu.running){
    const total=mu.total||0, done=mu.done||0, pct=total?Math.round(done/total*100):0;
    const mp=document.createElement('p'); mp.className='publish-warn';
    mp.textContent='⏳ 大媒体后台上传中：'+done+'/'+total+'（'+pct+'%）'+(mu.current?' · 正在传 '+mu.current:'')+'。站点已经可以访问，上传完成后视频即可播放，不用再更新。';
    host.appendChild(mp);
    if((window.__pubMediaRetry||0)<240){ window.__pubMediaRetry=(window.__pubMediaRetry||0)+1;
      // 自愈重渲只在没有用户交互时做：凭证表单开着（用户可能在输入）或发布进行中（进度由 pubuiPaint 更新）都跳过，
      // 否则会把输入清空 / 画面闪一下。用户正在打字时延后重渲（最多延后 240 秒）。
      if(!__pubSetupOpen && !pubuiBusy()){
        setTimeout(function __pubMediaHeal(){
          if(!(dialog && dialog.open)) return;
          if(__ffPubUserTyping()){ if((window.__pubMediaDefer||0)<240){ window.__pubMediaDefer=(window.__pubMediaDefer||0)+1; setTimeout(__pubMediaHeal,1000);} return; }
          renderPublicLink(dialog);
        },5000);
      } }
  } else {
    window.__pubMediaRetry=0;
    const fails=((mu.failed)||[]).filter(Boolean);
    if(fails.length){
      const fp=document.createElement('p'); fp.className='publish-warn';
      fp.textContent='⚠ 大媒体上传未完成：'+fails.map(f=>f.file+(f.sizeMB?'（'+f.sizeMB+'MB）':'')).join('、')+'。站点其余部分已正常上线；稍后再点发布会继续上传（已传成功的会自动跳过）。';
      host.appendChild(fp);
    }
  }
  const setup=document.getElementById('publink-setup');
  if(setup) setup.onclick=()=>renderSetupForm(host, st.projectName||'');
  const reconfig=document.getElementById('publink-reconfig');
  if(reconfig) reconfig.onclick=()=>renderSetupForm(host, st.projectName||'');
  const copy=document.getElementById('publink-copy');
  if(copy) copy.onclick=async()=>{
    const i=document.getElementById('publink-url');
    if(i&&i.value){ try{await navigator.clipboard.writeText(i.value);}catch(_){i.select();document.execCommand&&document.execCommand('copy');} copy.textContent='已复制'; }
  };
  // 进度块 / 失败原因由模块级 PUBUI 复原：即使面板刚刚被自愈重渲过，也能把状态重新贴回来。
  pubuiMount(host);

  // 统一的发布执行器：mode='update'（更新当前发布）/ 'new'（新增子发布，path 指定路径名）。
  // 抽出来是因为两个按钮走的是同一条链路，只有 mode 与 path 不同 ——
  // 避免两份几乎一样的代码各自演化（这个项目已经在"两发布面板必须镜像"上踩够坑了）。
  // tplOverride：由「发布到新地址」的模板下拉显式指定（用户自己点选的那个）。
  const runDeploy = async (provider, mode, path, btnEl, tplOverride) => {
    // 已经在发布中：直接忽略（按钮本身也是 disabled 的，这里是双保险）。
    // 绝不能再发一次 —— 两次发布并发会互相覆盖，历史上出过"线上变空站点"的事故。
    if(pubuiBusy()) return;
    // ① 立刻进入"发布中"，同步渲染，不依赖任何异步 —— 第一下点击就必须有反馈。
    PUBUI.phase='starting'; PUBUI.provider=provider; PUBUI.detail='正在提交发布请求…';
    PUBUI.error=''; PUBUI.total=0; PUBUI.sent=0; PUBUI.pct=0; PUBUI.elapsed=0;
    PUBUI.warnings=[]; PUBUI.since=Date.now();
    if(btnEl){ btnEl.disabled=true; btnEl.textContent = mode==='new' ? '发布中…' : '发布中…'; }
    pubuiMount(host); pubuiPaint();
    pubuiStartPoll();
    try{
      // ⚠ 必须显式带上 tpl：服务端 /api/deploy/public 用 self._tpl() 解析模板，
      // 那个函数**只认 URL query**；不传就永远回落 'main' —— 这就是「选模板二发布，
      // 结果却新建/覆盖到模板一」的根因。这里 query + body 双保险。
      // 「发布到新地址」时以用户下拉里选的模板为准 —— 不再默默用"当前模板"。
      const tplId = String(tplOverride || '').trim() || ffCurTpl();
      const body = { provider, mode, tpl: tplId };
      if (mode === 'new' && path) body.path = path;
      const r=await fetch('/api/deploy/public?tpl=' + encodeURIComponent(tplId), {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(x=>x.json());
      if(!r.ok){
        if(r.busy) throw Error(r.error||'上一次发布还在进行中，请等它结束再点（避免两次发布互相覆盖）。');
        if(r.setupRequired) throw Error(r.error||'尚未配置');
        if(r.mediaBlocked) throw Error(r.error||'媒体文件过大');
        throw Error(r.error||'发布失败');
      }
      PUBUI.phase='ok'; PUBUI.detail=''; PUBUI.since=Date.now(); PUBUI.warnings=(r.warnings||[]);
      __deployedAt=PUBUI.since; __deployedProvider=provider; // 兼容旧标记
      if (mode === 'new') {
        const nm = r.subPath ? ('新地址 /' + r.subPath + '/') : '新地址';
        PUBUI.detail = '已发布到' + nm;
        if (typeof toastInCanvas === 'function') toastInCanvas('✓ ' + nm + ' 已上线');
      }
    }catch(e){
      PUBUI.phase='error'; PUBUI.error=String(e.message||e);
      if (typeof toastInCanvas === 'function') toastInCanvas('✗ 发布失败：' + String(e.message||e).split('\n')[0].slice(0,80) + '（详情见面板红色提示）');
    }finally{
      pubuiStopPoll();
      await renderPublicLink(dialog);   // 按最终状态重渲：成功→绿色按钮；失败→红色原因常驻
      // 发布成功但大媒体没传上去：站点已经上线，必须如实告诉用户"哪个文件暂时是空的"，
      // 而不是让整次发布看起来失败（旧行为：release 上传超时 → 整条发布报失败，网址也不显示）。
      (PUBUI.warnings||[]).forEach(w=>{
        const wn=document.createElement('p'); wn.className='publish-warn'; wn.textContent='⚠ '+w; host.appendChild(wn);
      });
    }
  };

  const deploy=document.getElementById('publink-deploy');
  if(deploy) deploy.onclick=()=>{
    const provider = window.__pubProvider==='cloudbase' ? 'cloudbase' : 'github';
    runDeploy(provider, 'update', '', deploy);
  };

  // 「另外发布一个链接」：不覆盖当前地址，另开一个子路径挂同一套内容。
  const depProvider = window.__pubProvider==='cloudbase' ? 'cloudbase' : 'github';
  if (depProvider !== 'zip') {
    // ⚠ gh / cb 是 renderPublicLink 的局部变量，这里拿不到 —— 从 st.providers 取（同 ghAccessNoteHtml 的教训）。
    const depPubUrl = (((st.providers||{})[depProvider]||{}).publicUrl) || '';
    const base = hostingBaseOf(depPubUrl);
    wireNewDeploy(host, depProvider, ffCurTpl(), base, (path, tplSel)=>{
      if (path && !/^[A-Za-z0-9_-]+$/.test(path)) {
        if (typeof toastInCanvas === 'function') toastInCanvas('路径名只能用字母、数字、- 和 _');
        const b = document.getElementById('publink-newdep-go'); if (b) delete b.dataset.busy;
        return;
      }
      runDeploy(depProvider, 'new', path, document.getElementById('publink-newdep-go'), tplSel);
    });
  }
}

function renderSetupForm(body, prefillName){
  __pubSetupOpen = true;   // 表单开着期间禁止自愈重渲，否则用户填到一半的内容会被清空
  body.innerHTML=`
    <p class="publish-desc"><b>配置腾讯云（只需做一次）</b>　可以按下面 6 步手动做，也可以复制指令让 Agent 代做。凭证只保存在本机，不会进入作品集数据或导出的 ZIP。</p>
    <div class="publish-hint" style="border-left:3px solid #0a7d33">
      <p><b>已有环境？先检测</b>　填入 SecretId / SecretKey 后只读查询（不改动任何资源，密钥不出本机）。</p>
      <div class="publish-actions">
        <button class="publish-btn primary" id="cb-probe-btn">🔍 检测我的 CloudBase 环境</button>
        <button class="publish-btn" id="cb-permcheck-btn">🔐 权限体检（能否上传）</button>
      </div>
      <div id="cb-probe-out" style="display:none;margin-top:8px"></div>
      <p style="font-size:12.5px;margin:10px 0 4px"><b>把 Agent 的回复整段粘到这里，会自动识别填入：</b></p>
      <textarea class="publish-input" id="cb-parse-text" rows="4" placeholder="粘贴包含 EnvId / SecretId / SecretKey 的整段内容…"></textarea>
      <div id="cb-parse-msg" style="font-size:12px;margin-top:4px"></div>
    </div>
    <p style="margin:14px 0 6px"><b>让 Agent 代做（推荐）</b>　复制任一版指令粘给 Agent：</p>
    <div class="publish-actions">
      <button class="publish-btn primary" id="cb-copy-prompt">📋 通用指令</button>
      <button class="publish-btn" id="cb-copy-prompt-wb">📋 WorkBuddy 增强版</button>
    </div>
    <p class="publish-desc" style="font-size:12px;opacity:.75">
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
    <div class="publish-hint">
      <p><b>① 登录并实名</b>　打开 ${cbLink(CB_CONSOLE_LINKS.home, '腾讯云官网 ↗')} 登录；未实名点右上角头像 → <b>账号信息 → 实名认证</b>（个人实名即可）。</p>
      <p><b>② 开通云开发</b>　打开 ${cbLink(CB_CONSOLE_LINKS.env, 'CloudBase 控制台 ↗')}（注意是 CloudBase 控制台，不是腾讯云首页）。首次需按指引「<b>开通云开发</b>」（同意服务条款 + 授权服务角色），<b>开通后「新建环境」入口才会出现</b>。</p>
      <p><b>③ 新建环境，拿到环境 ID</b>　点「新建环境」，套餐选「<b>免费体验版</b>」（0 元/月，限 1 个，3000 资源点/月），地域就近，其余用默认值。建好后复制<b>环境 ID</b>。<br><span style="color:#0a7d33;font-weight:600">→ 填到本页底部「EnvId」框</span></p>
      <p style="margin:0 0 6px 0;color:#9a6700;font-size:12.5px">⚠ 免费体验版是<b>控制台网页端</b>活动，用 API / 命令行下单会走正价，所以这一步只能你在网页上点。规则以 ${cbLink('https://cloud.tencent.com/document/buy-guide/876/127357','官方文档 ↗')} 为准（单次 6 个月，到期前 1 个月内可 0 元续 6 个月，不会自动续费，资源点用尽会停服）。</p>
      <p><b>④ 开通静态网站托管</b>　进入该环境的「<b>静态网站托管</b>」并开通，会得到一个默认域名。<b>不开通发布会失败。</b>去 ${cbLink(CB_CONSOLE_LINKS.hosting, '静态网站托管 ↗')}。<br><span style="color:#0a7d33;font-weight:600">已开通就不用再点——上面的「检测我的 CloudBase 环境」会直接告诉你状态和域名。</span></p>
      <p><b>⑤ 新建 API 密钥</b>　推荐在 ${cbLink('https://console.cloud.tencent.com/cam', '访问管理 CAM ↗')} →「<b>用户列表 → 新建用户</b>」选「<b>自定义创建</b>」：用户类型选「<b>可访问资源并接收消息</b>」，访问方式勾「<b>编程访问</b>」，在「设置用户策略」这一步就把 <b>两条</b>策略勾上：<b>QcloudTCBFullAccess</b> + <b>QcloudCOSFullAccess</b>——<b>创建时就挂好</b>，不要留到后面再补。<br><b>两条缺一不可</b>：只有前者时能读到环境，但上传每个文件都会 <b>Access Denied</b>——因为上传底层是往对象存储（COS）写对象，靠的是后者那层权限（QcloudCOSFullAccess＝对象存储 COS 全读写访问权限，含上传动作）。<br><b>已有子账号要补权限？</b>在「<b>用户列表</b>」里点该子账号<b>那一行</b>右侧操作列的「<b>授权</b>」→ 在「关联策略」窗口搜上面两个策略名 → 勾选 → 确定。注意：授权入口在<b>列表行</b>上，主账号行没有这个入口。<br>（<b>不要</b>选「快速创建」——它默认带 AdministratorAccess 全权限；「仅用于接收消息」不能编程访问，不能部署。）<br><span style="color:#0a7d33;font-weight:600">→ SecretId / SecretKey 填到本页底部；SecretKey 只在创建时显示一次，立刻保存</span></p>
      <p><b>⑥ 保存并发布</b>　填好三个值 → 点「保存配置」→ 关闭本面板 → 在发布面板点「<b>发布到 CloudBase</b>」。之后每次更新只需再点一次发布。</p>
      <p class="publish-warn"><b>安全：</b>SecretKey 相当于账号密码，勿截图分享、勿提交 Git。密钥存放于本机 <code>.folioframe/cloudbase.json</code>。</p>
      <p><b>官方文档：</b>${CB_OFFICIAL_LINKS}</p>
    </div>
    <label class="st-field-label" for="cb-env">EnvId（环境 ID）</label>
    <input class="publish-input" id="cb-env" placeholder="如 my-env-1a2b3c" autocomplete="off">
    <label class="st-field-label" for="cb-sid">SecretId</label>
    <input class="publish-input" id="cb-sid" placeholder="AKIDxxxxxxxxxxxxxxxx" autocomplete="off">
    <label class="st-field-label" for="cb-skey">SecretKey</label>
    <input class="publish-input" id="cb-skey" type="password" placeholder="只保存在本机，不会显示在页面上" autocomplete="new-password">
    <label class="st-field-label" for="cb-path">部署子目录（可选，留空为站点根目录）</label>
    <input class="publish-input" id="cb-path" placeholder="如 portfolio">
    <div class="publish-actions">
      <button class="publish-btn" id="publink-cancel-cfg">取消</button>
      <button class="publish-btn primary" id="publink-save-cfg">保存配置</button>
    </div>`;
  // 与 Studio 面板同一规则：真正要填写的字段不能被长说明推到可视区域之外。
  // 只重排本次创建的节点，所有既有 id、事件与 CloudBase 状态机保持不变。
  const configCard=document.createElement('section');
  configCard.className='cb-config-card';
  configCard.innerHTML='<h3>填写配置</h3><p>填写后可直接保存；下面的说明与帮助链接仍可展开查看。</p>';
  const configNodes=['cb-env','cb-sid','cb-skey','cb-path'].flatMap(id=>{
    const input=document.getElementById(id);
    const label=input?document.querySelector('label[for="'+id+'"]'):null;
    return [label,input].filter(Boolean);
  });
  const configActions=document.getElementById('publink-save-cfg')?.closest('.publish-actions');
  if(configNodes.length){ body.insertBefore(configCard,body.children[1]||null);configNodes.forEach(node=>configCard.appendChild(node));if(configActions)configCard.appendChild(configActions); }
  const cpb=document.getElementById('cb-copy-prompt');
  if(cpb) cpb.onclick=()=>cbCopyPrompt(cpb,'generic');
  const cpbw=document.getElementById('cb-copy-prompt-wb');
  if(cpbw) cpbw.onclick=()=>cbCopyPrompt(cpbw,'workbuddy');
  // 自动识别：粘贴/输入即解析（不再依赖"解析"按钮），并明确回报识别结果。
  const applyParsed=(silent)=>{
    const ta=document.getElementById('cb-parse-text');
    const msg=document.getElementById('cb-parse-msg');
    if(!ta) return 0;
    const cfg=cbParseConfig(ta.value||'');
    let n=0;
    if(cfg.envId){ const e=document.getElementById('cb-env'); if(e){ e.value=cfg.envId; n++; } }
    if(cfg.secretId){ const e=document.getElementById('cb-sid'); if(e){ e.value=cfg.secretId; n++; } }
    if(cfg.secretKey){ const e=document.getElementById('cb-skey'); if(e){ e.value=cfg.secretKey; n++; } }
    if(msg){
      if(!(ta.value||'').trim()){ msg.textContent=''; }
      else if(n===0){ msg.innerHTML='<span style="color:#9a6700">还没识别出可用的配置值。请粘贴包含 EnvId / SecretId / SecretKey 的整段内容（带不带标签都能识别）。</span>'; }
      else { msg.innerHTML='<span style="color:#0a7d33">✓ 已自动识别并填入 '+n+' 个字段：'+
        [cfg.envId?'EnvId':'',cfg.secretId?'SecretId':'',cfg.secretKey?'SecretKey':''].filter(Boolean).join(' / ')+
        '。确认无误后点「保存配置」。</span>'; }
    }
    return n;
  };
  const pta=document.getElementById('cb-parse-text');
  if(pta){ pta.addEventListener('input',()=>applyParsed(true)); pta.addEventListener('paste',()=>setTimeout(()=>applyParsed(true),30)); }
  // 「权限体检」：回答"这把密钥到底能不能上传"。
  // ⚠ 必须在**配置阶段**就能点，而不是等发布失败了才知道权限不够（真实故障 2026-09-19）：
  //   静态托管上传底层是往对象存储（COS）写对象，读得到环境不等于写得进去。
  //   这里只读探测 + 一次 0 字节写入自检（成功即刻删除），不改动任何业务数据。
  const pkbtn=document.getElementById('cb-permcheck-btn');
  if(pkbtn) pkbtn.onclick=async()=>{
    const out=document.getElementById('cb-probe-out');
    const sid=(document.getElementById('cb-sid').value||'').trim();
    const skey=(document.getElementById('cb-skey').value||'').trim();
    const envEl=document.getElementById('cb-env');
    const envid=envEl?(envEl.value||'').trim():'';
    if(!sid||!skey){
      if(out){ out.style.display='block'; out.innerHTML='<p class="publish-warn">请先在页面底部填写 <b>SecretId / SecretKey</b>，再点体检（需要凭证）。</p>'; }
      return;
    }
    pkbtn.disabled=true; const oldTxt=pkbtn.textContent; pkbtn.textContent='体检中…';
    if(out){ out.style.display='block'; out.innerHTML='<p class="publish-desc">正在体检：读取环境 + 一次 0 字节写入自检（自检文件立即删除）…</p>'; }
    try{
      const r=await fetch('/api/cloudbase/permcheck',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({secretId:sid,secretKey:skey,envId:envid})}).then(x=>x.json());
      if(out) out.innerHTML=pubPermReportHtml(r);
    }catch(e){
      if(out) out.innerHTML='<p class="publish-warn">体检请求失败：'+esc(String((e&&e.message)||e))+'</p>';
    }finally{ pkbtn.disabled=false; pkbtn.textContent=oldTxt; }
  };
  // 「检测我的 CloudBase 环境」：只读查询，列出环境并支持一键填入 EnvId
  const pbtn=document.getElementById('cb-probe-btn');
  if(pbtn) pbtn.onclick=async()=>{
    const out=document.getElementById('cb-probe-out');
    const sid=(document.getElementById('cb-sid').value||'').trim();
    const skey=(document.getElementById('cb-skey').value||'').trim();
    if(!sid||!skey){
      if(out){ out.style.display='block'; out.innerHTML='<p class="publish-warn">请先在页面底部填写 <b>SecretId / SecretKey</b>，再点检测（只读查询需要凭证）。</p>'; }
      return;
    }
    pbtn.disabled=true; const old=pbtn.textContent; pbtn.textContent='查询中…';
    if(out){ out.style.display='block'; out.innerHTML='<p class="publish-desc">正在只读查询你的 CloudBase 环境…</p>'; }
    try{
      const r=await fetch('/api/cloudbase/probe',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({secretId:sid,secretKey:skey})}).then(x=>x.json());
      if(!r.ok){
        out.innerHTML='<p class="publish-warn">查询失败：'+esc(r.error||'未知错误')+'</p>';
      } else if(!(r.environments||[]).length){
        out.innerHTML='<p class="publish-warn">你的账号下还没有 CloudBase 环境。请到 '+cbLink(CB_CONSOLE_LINKS.env,'CloudBase 控制台 ↗')+' 新建一个（免费体验版，只能在网页创建）。</p>';
      } else {
        const rows=r.environments.map(e=>{
          const st=e.staticOpened
            ? '<span style="color:#0a7d33">静态托管已开通'+(e.staticDomain?'：'+esc(e.staticDomain):'')+'</span>'
            : '<span style="color:#9a6700">静态托管未开通</span>';
          return '<div style="padding:8px 10px;border:1px solid #e5e5e5;border-radius:6px;margin:6px 0;background:#fff">'+
            '<div><b>'+esc(e.envId)+'</b>'+(e.alias?'（'+esc(e.alias)+'）':'')+'</div>'+
            '<div style="font-size:12px;opacity:.8">套餐：'+esc(e.packageName||'未知')+'　地域：'+esc(e.region||'未知')+'　状态：'+esc(e.status||'未知')+'</div>'+
            '<div style="font-size:12px;margin-top:2px">'+st+'</div>'+
            '<button class="publish-btn" data-use-env="'+esc(e.envId)+'" style="margin-top:6px">用这个环境 ID</button>'+
            '</div>';
        }).join('');
        out.innerHTML='<p class="publish-desc">共 '+r.environments.length+' 个环境（只读查询，未改动任何资源）：</p>'+rows;
        out.querySelectorAll('[data-use-env]').forEach(b=>{
          b.onclick=()=>{
            const v=b.getAttribute('data-use-env');
            const e=document.getElementById('cb-env');
            if(e){ e.value=v; e.scrollIntoView({block:'center'}); }
            const dm=out.querySelector('[data-use-env]');
            b.textContent='✓ 已填入';
          };
        });
      }
    }catch(e){
      if(out) out.innerHTML='<p class="publish-warn">查询请求失败：'+esc(e.message)+'</p>';
    }
    pbtn.disabled=false; pbtn.textContent=old;
  };
  const cancel=document.getElementById('publink-cancel-cfg');
  if(cancel) cancel.onclick=()=>{ __pubSetupOpen=false; window.__pubProvider='cloudbase'; renderPublicLink(document.getElementById('publish-dialog')); };
  document.getElementById('publink-save-cfg').onclick=async()=>{
    const envId=(document.getElementById('cb-env').value||'').trim();
    const sid=(document.getElementById('cb-sid').value||'').trim();
    const skey=(document.getElementById('cb-skey').value||'').trim();
    const path=(document.getElementById('cb-path').value||'').trim();
    if(!envId||!sid||!skey){ alert('EnvId、SecretId、SecretKey 都必须填写'); return; }
    const btn=document.getElementById('publink-save-cfg'); btn.disabled=true; btn.textContent='保存中…';
    try{
      const r=await fetch('/api/deploy/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:'cloudbase',envId:envId,secretId:sid,secretKey:skey,path:path})}).then(x=>x.json());
      if(!r.ok)throw Error(r.error||'保存失败');
      __pubSetupOpen=false;
      await renderPublicLink(document.getElementById('publish-dialog'));
    }catch(e){ alert('保存失败：'+e.message); btn.disabled=false; btn.textContent='保存配置'; }
  };
}

// —— 导出模板数据：轻量 JSON，只含「视觉设计」，绝不含内容文本 / 媒体本体 ——
async function exportTemplateData(d){
  // 优先从已保存的 design.json 读取 GrapesJS 视觉设计（theme / 组件样式）
  let design = null;
  try { design = await fetch('/api/design/published', { cache: 'no-store' }).then(r => r.json()); } catch (e) {}
  if (!design || !Object.keys(design).length) {
    try { design = await fetch('/api/design', { cache: 'no-store' }).then(r => r.json()); } catch (e) {}
  }
  if (!design || !Object.keys(design).length) design = null;

  const template={
    meta:{schema:'portfolio-template',version:2,exportedAt:new Date().toISOString()},
    design:{
      theme: (design && design.theme) || d.theme || null,
      typography: (design && design.typography) || {},
      spacing: (design && design.spacing) || d.styles?.spacing || ''
    },
    // 结构元信息（只记录字段名/分类 ID，不复制任何真实内容文本）
    structure:{
      sectionOrder:['about','experience','works','showreel','aiVoices'],
      projectGroups:(d.projectGroups||[]).map(g=>({id:g.id,title:g.title,description:''})),
      components:{
        about:{fields:['name','role','intro','about','education','skills','highlights']},
        experience:{fields:['company','position','date','summary','highlights']},
        works:{fields:['name','type','date','role','summary','keyWork','highlights','media']},
        showreel:{fields:['media','chapters']},
        contact:{fields:['contactLinks','publicLinks']}
      }
    }
  };
  const blob=new Blob([JSON.stringify(template,null,2)],{type:'application/json'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download='portfolio-template.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

// —— 导入模板：验证 → 预览 → 应用（只改 Design，绝不覆盖 Content）——
async function importTemplateFile(file){
  if(!file)return;
  let template;
  try {
    const text=await file.text();
    template=JSON.parse(text);
  } catch(e){ return alert('模板文件无法解析：'+e.message+'。请确认是有效的 JSON 文件。'); }

  // 验证模板格式
  const err=validateTemplate(template);
  if(err){ return alert('模板无效：'+err+'。未应用任何更改。'); }

  // 预览：先展示模板摘要，让用户确认
  const t=template.design||{};
  const themeLabel=(t.theme&&t.theme.preset)||'默认';
  const confirmMsg=`即将应用模板设计，但<strong>不会覆盖当前内容</strong>（作品、经历、联系方式等保持不变）。\n\n`+
    `· 主题：${themeLabel}\n`+
    (Object.keys(t.typography||{}).length?`· 排版：已包含\n`:'')+
    (t.spacing?`· 间距：${t.spacing}\n`:'')+
    `\n是否应用？`;
  if(!confirm(confirmMsg)) return;

  // 应用：把模板的视觉设计写入 design.json（只改 Design）
  try{
    const res=await fetch('/api/design/save',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ theme: t.theme || null, typography: t.typography || {}, spacing: t.spacing || '' })
    });
    const j=await res.json();
    if(!res.ok)throw Error(j.error||'应用失败');
    alert('模板已应用（仅更新设计，内容未变）。请到「③ 排版编辑」或「① 作品集」查看效果。');
  }catch(e){ alert('应用模板失败：'+e.message); }
}

function validateTemplate(template){
  if(!template || typeof template!=='object') return '根节点必须是对象';
  if(!template.meta || template.meta.schema!=='portfolio-template') return '缺少 meta.schema="portfolio-template"';
  if(!template.design || typeof template.design!=='object') return '缺少 design 对象';
  const theme=template.design.theme;
  if(theme!=null){
    if(typeof theme!=='object' || !theme.preset) return 'design.theme 缺少 preset';
    // ⚠ 与 editor/themes.js 的 THEME_PRESETS 必须一致（本文件是发布页/画布用的镜像副本）。
    const valid=['light-01','light-02','light-03','light-04','dark-01','dark-02','dark-03','dark-04'];
    if(!valid.includes(theme.preset)) return 'design.theme.preset 不是合法的主题 ID';
  }
  return null; // 通过
}

/** 底部状态条：说明当前看的是草稿还是已发布，并提供一步切换 / 发布。
 *  在外壳（Studio，?studio=1）里不显示这一条 —— 外壳顶栏已经有状态与「更新到发布版」。 */
function mountVersionBar(mode, content){
  if(document.getElementById('version-bar')) return;
  if(new URLSearchParams(location.search).get('studio')==='1') return;
  const bar=document.createElement('div');
  bar.id='version-bar';
  // ⚠ 底栏文案一律挂 data-i18n（键值层），不要在这里写死中文：
  //   底栏挂在 body 上、在 #app 之外，以前用「中文当 key」的字典层也盖不到它，
  //   英文模式下就一直是「草稿预览 / 文本编辑 / 排版编辑 / 更新」，用户看到的就是"切了没全变"。
  bar.innerHTML=`
    <span class="vb-dot ${mode==='draft'?'vb-draft':'vb-pub'}"></span>
    <span class="vb-text">${mode==='draft'
      ? '<b data-i18n="bar.draft">草稿预览</b> — <span data-i18n="bar.draftNote">你在编辑器里保存的内容会立刻出现在这里</span>'
      : '<b data-i18n="bar.published">已发布版</b> — <span data-i18n="bar.pubNote">只有点「更新」后才会同步草稿的最新改动</span>'}</span>
    <span class="vb-spacer"></span>
    <span class="vb-diff" id="vb-diff" data-i18n="bar.checking">检查中…</span>
    <a class="vb-link" href="${mode==='draft'?'/portfolio/?mode=published':'/portfolio/'}" data-i18n="${mode==='draft'?'bar.viewPublished':'bar.backToDraft'}">${mode==='draft'?'看已发布版':'回到草稿'}</a>
    <a class="vb-link" href="/editor/" data-i18n="nav.editor">文本编辑</a>
    <a class="vb-link" href="/visual-editor/" data-i18n="nav.visual">排版编辑</a>
    <button class="vb-btn" id="vb-publish" data-i18n="bar.update" data-i18n-title="bar.updateTitle" title="把当前草稿更新到发布版">更新</button>
  `;
  document.body.append(bar);
  // 底栏是 main() 里最后挂上去的、还在 autoTranslate 建根之后，所以这里必须主动 apply 一次，
  // 否则 data-i18n 要等到用户手动切一次语言才会生效。
  if (window.FF_I18N && FF_I18N.apply) { try { FF_I18N.apply(document); } catch (_) {} }

  const diff=document.getElementById('vb-diff');
  fetch('/api/publish/status',{cache:'no-store'})
    .then(r=>r.ok?r.json():null)
    .then(s=>{
      // 换成动态内容后要把初始的 data-i18n="bar.checking" 摘掉，
      // 否则下一次 apply(document)（切语言时）会把这里整个 textContent 覆写回「检查中…」。
      diff.removeAttribute('data-i18n');
      if(!s){diff.textContent='';return}
      if(s.dirty){
        diff.innerHTML='<b style="color:#c0392b" data-i18n="bar.dirty">有未更新的改动</b>';
        // ⚠ 别把接口的 s.detail 直接塞进 title：它是服务端写死的中文，
        //   英文界面鼠标一悬停就露出中英混排。按两个布尔量挑一句完整中文再整句翻译。
        diff.title = ffZ(s.contentDirty && s.designDirty
          ? '内容（文字/项目/章节）与排版（布局/主题）都有改动，还未更新到发布版。'
          : s.contentDirty
            ? '内容（文字/项目/章节）有改动，还未更新到发布版。'
            : '排版（布局/主题）有改动，还未更新到发布版。');
      }else{
        diff.innerHTML='<span data-i18n="bar.clean">已与发布版同步</span>';
      }
    })
    .catch(()=>{diff.removeAttribute('data-i18n');diff.textContent=''});

  // 底栏只做草稿→发布版更新；发布面板由顶部「发布」入口打开。
  document.getElementById('vb-publish').onclick=async()=>{
    const button=document.getElementById('vb-publish');
    button.disabled=true;button.dataset.i18n='bar.updating';button.textContent='更新中…';
    try{await fetch('/api/publish',{method:'POST'});location.href='/portfolio/?mode=published&tpl='+encodeURIComponent(window.__TPL__||'main')}
    catch(_){button.disabled=false;button.dataset.i18n='bar.update';button.textContent='更新';alert('更新失败，请稍后重试。')}
  };
}

async function main(){
  // 默认看「草稿」：编辑器里保存的内容会立刻出现在这里。
  // 想看已发布版（不会随编辑器变化）用 ?mode=published
  const q=new URLSearchParams(location.search);
  const mode=q.get('mode')==='published'?'published':'draft';
  const expandAll=q.get('expand')==='1';
  // 单文件导出模式：如果页面内联了数据，直接用；否则从 API 读取（支持离线/静态部署）
  const d = window.__PORTFOLIO_DATA__ ? window.__PORTFOLIO_DATA__ : await fetch(`/api/data?mode=${mode}`,{cache:'no-store'}).then(r=>r.json());

  // —— Content + Design 分离：读取对应 Design（draft 读 design.json，published 读 design.published.json）——
  // design 里的 theme / typography 属于 Design，可覆盖 Content 里的旧 theme（向后兼容）。
  let design = window.__PORTFOLIO_DESIGN__ || null;
  if (!design && !window.__PORTFOLIO_DATA__) {
    try {
      design = await fetch(mode === 'published' ? '/api/design/published' : '/api/design', { cache: 'no-store' }).then(r => r.json());
      if (design && !Object.keys(design).length) design = null;
    } catch (e) { design = null; }
  }
  if (design && design.theme) d.theme = design.theme;
  const root=document.querySelector('#app');
  const groups=Object.fromEntries(d.projectGroups.map(g=>[g.id,g]));
  const byId=p=>d.projects[p]||null;

  // —— 主题：Editor / Preview / Portfolio 三端共用同一 theme —— //
  const t=resolveTheme(d);
  applyTheme(t);

  const st=d.styles||{};
  const fontMap={'Noto Sans SC':"'Noto Sans SC',sans-serif",'Georgia':'Georgia,serif','Arial':'Arial,sans-serif'};
  const spacingMap={small:'28px',medium:'48px',large:'72px'};
  document.documentElement.style.setProperty('--editor-title-size',`${st.titleSize||52}px`);
  document.documentElement.style.setProperty('--editor-body-size',`${st.bodySize||16}px`);
  document.documentElement.style.setProperty('--editor-font',fontMap[st.font]||"'Noto Sans SC',sans-serif");
  document.documentElement.style.setProperty('--editor-font-weight',st.weight||'400');
  document.documentElement.style.setProperty('--editor-spacing',spacingMap[st.spacing]||'48px');

  // —— 项目卡片：内容驱动，图片作为辅助，不预留空白。本轮简化：只保留单张图片入口 ——
  // 媒体（图片 / 视频 / 音频）统一放进同一个「媒体栏」，默认在右边，与正文按比例分栏。
  // 尺寸与左右位置存在 Design（design.imgSizes / design.mediaLayout），画布与真实作品集共用同一套 → 所见即所得。
  // 浏览器「硬」解不了的封装：连 H.264/MJPEG 都没有的纯容器（AVI/MKV/FLV/WMV/MXF）。
  // 注意：.mov/.m4v 已从名单移除——Chromium/Edge 能播 H.264/HEVC 封装的 MOV，只有 ProRes 这类编码才不行，
  // 而编码无法靠后缀判断，故交给「先试播、解码失败再 onerror 兜底」处理，最大化支持的格式。
  const HARD_UNPLAYABLE = /\.(avi|mkv|flv|wmv|mxf)(\?|#|$)/i;
  const canPlayInBrowser = u => !HARD_UNPLAYABLE.test(String(u || ''));
  // 视频解不了时的兜底展示块（下载原文件入口）
  // 说明块的「内容部分」单独抽出：这样解码失败时可以把内容塞进**原有的媒体项外壳**里，
  // 外壳上的 data-ve-media-item / --pmi-w 得以保留 —— 换成不支持块之后，这一项仍然可以单独调大小、单独挪位置。
  // 播不了有两种完全不同的原因，必须分开讲，否则用户会一直以为"上传失败"：
  // ① 走 GitHub Release 附件的大文件：视频本身完全正常，是 GitHub 只肯以
  //    application/octet-stream + Content-Disposition: attachment 下发，浏览器一律拒绝内联播放；
  // ② 真的编码不兼容（ProRes / AVI / MKV / HEVC 等）。
  // 第一种是 FolioFold 能自己解决的（压缩到单文件上限以内就能回到 Pages 托管），所以直接给出下一步。
  const RELEASE_ASSET_RE = /\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\//;
  const videoUnsupportedInner = (u, name) => {
    // 公开查看器（浏览者视角）：网页是给访客看的，他们不需要知道底层逻辑 / 编码 / 第三方平台。
    // 播放不了就只说"暂时无法播放"，最多给一个"下载原文件"动作，绝不做任何解释。
    if (window.__PUBLIC_VIEWER__) {
      return `<strong>暂时无法播放</strong><a class="pm-link" href="${u}" target="_blank" rel="noopener">下载原文件 ↗</a>`;
    }
    // Studio / 编辑器内（创作者视角）：详细说明原因与下一步操作。
    const isAttach = RELEASE_ASSET_RE.test(String(u || ''));
    const why = isAttach
      ? `<b>它是被当作「大文件附件」发布的</b>：GitHub 对 Release 附件只肯以「下载」方式下发（响应头强制 application/octet-stream + attachment），浏览器遇到这种响应一律拒绝在线播放，所以只剩下载按钮。<b>这不是上传失败，视频文件本身是好的。</b>原因是它超过了 GitHub 仓库的单文件上限（90MB），FolioFold 才把它挪去附件区。解决办法只有一个：压到 90MB 以内再发布一次 —— 打开「② 文本编辑 → Showreel」，在最下面的「视频压缩」卡片点「② 压缩整片并替换」，然后回到「③ 排版编辑 → 发布」更新发布。`
      : `<b>它的封装或编码浏览器解不了</b>（例如 ProRes 的 MOV、AVI、MKV，或 HEVC 编码）。这不是上传失败，是编码本身的问题。三种解决办法：① 用 FolioFold 自带的「视频压缩」（② 文本编辑 → Showreel → 最下面的卡片）转成 H.264 的 MP4；② 用格式工厂 / HandBrake / 剪映导出为 <b>H.264 编码的 MP4</b> 后重新上传（MOV 容器 + H.264 编码也可以直接播）；③ 改用「外部视频链接」指向 B 站 / YouTube 等播放页。`;
    return `<strong>当前视频浏览器无法直接在线播放</strong><p>「${esc(name)}」${why}</p><a class="pm-link" href="${u}" target="_blank" rel="noopener">下载原文件 ↗</a>`;
  };
  const videoUnsupported = (u, name, path) => `<div class="pm-item pm-unsupported" data-ve-media data-ve-kind="media-video"${path?` data-ve-item="${path}"`:''}>${videoUnsupportedInner(u, name)}</div>`;
  // 解码失败兜底：把 <video> 换成「不支持」说明块。inline onerror 在全局作用域求值，故挂到 window。
  // 仅替换最近的媒体容器（.pm-item / .showreel-video / .ai-video），绝不波及相邻内容（如 Showreel 章节）。
  window.__veVideoErr = function(el){
    try{
      const wrap = el.closest('.pm-item, .showreel-video, .ai-video');
      if(!wrap) return;
      const url = decodeURIComponent(el.getAttribute('data-vurl')||'');
      const name = el.getAttribute('data-vname')||'视频文件';
      const path = wrap.getAttribute('data-ve-item')||'';
      // 优先「原地换内容」而不是整块替换：保留媒体项外壳，尺寸/位置设置不丢
      if (wrap.classList && wrap.classList.contains('pm-item')) {
        wrap.classList.remove('pm-video');
        wrap.classList.add('pm-unsupported');
        wrap.innerHTML = videoUnsupportedInner(url, name);
      } else {
        wrap.outerHTML = videoUnsupported(url, name, path);
      }
    }catch(_){/* 兜底失败也不应阻塞页面 */}
  };
  const project=p=>{
    const m=p.media||{};
    const pi=d.projects.indexOf(p);
    const sourceSummary=(p.structuredContent&&p.structuredContent.summary)!=null?p.structuredContent.summary:(p.summary||'');
    const displaySummary=FF_I18N?FF_I18N.resolveLocalizedSummary(d,'projects',p,sourceSummary):sourceSummary;
    const mediaPath = 'projects.' + pi + '.media';
    // 图片：mainVisual 优先，其后是 processImages（去重）
    const images=[];
    [url(m.mainVisual), ...((m.processImages||[]).map(url))].forEach(x=>{ if(x && images.indexOf(x)<0) images.push(x); });
    const image=images[0]||'';
    const video=url(m.video);
    const audio=url(m.audio);
    const layout=(design && design.mediaLayout && design.mediaLayout[mediaPath]) || {};
    const sizeCfg=(design && design.imgSizes && design.imgSizes[mediaPath]) || {};
    const widthPct=(sizeCfg.widthPct!=null) ? Math.max(18, Math.min(70, Number(sizeCfg.widthPct)||38)) : 38;
    const hasMedia=!!(video||audio||images.length||m.externalVideoUrl||m.externalLink);
    const hasDetailBody=!!(displaySummary||(p.highlights&&p.highlights.length)||hasMedia);
    const detailed=p.showDetails!==false;
    const canExpand=detailed&&hasDetailBody;
    // 类型 = Company 后备；显示在 role/date 附近
    const typeLabel=p.type||p.company||'';
    // —— 媒体项：图片 / 视频 / 音频**各自独立**（不再整栏一起缩放） ——
    // 每项都能单独调宽度、单独换位置、单独改对齐。数据只写 Design、不碰 Content，
    // 所以怎么摆都不会动到作品内容本身：
    //   design.mediaItems[itemKey] = { widthPct, order, place, align }
    //   · itemKey 形如 'projects.0.media#image0' / '...#video' / '...#audio'
    //   · widthPct 10–100：占「所在媒体容器」的百分比（默认 100 = 撑满整栏）
    //   · order：同一项目内的排列序号（侧栏与正文下方共用一条序列）
    //   · place：'column' = 侧边媒体栏（默认）；'below' = 挪到正文下方整行
    //   · align：容器内的水平对齐 left / center / right
    const miCfg = (design && design.mediaItems) || {};
    const mediaItems = [];
    // 「正文下方」整行区的整行对齐（左 / 中 / 右）：存在 design.mediaLayout[<媒体路径>].belowAlign。
    // 为什么不在下面的项上继续用 auto margin？因为横排换行后每一项都吃剩余空间会把整行拉散，
    // 整行对齐必须是容器级（justify-content）才符合直觉。
    const belowAlign = (layout.belowAlign === 'center' || layout.belowAlign === 'right') ? layout.belowAlign : '';
    const belowSymmetric = !!layout.symmetric;
    const belowGap = belowGapOf(layout);
    const mkMediaItem = (tag, cls, key, natural, kind, attrs, inner) => {
      const c = miCfg[key] || {};
      const w = (c.widthPct != null) ? Math.max(10, Math.min(100, Number(c.widthPct) || 100)) : 100;
      const align = (c.align === 'center' || c.align === 'right') ? c.align : 'left';
      const place = (c.place === 'below') ? 'below' : 'column';
      const order = (c.order != null && isFinite(Number(c.order))) ? Number(c.order) : natural;
      // 正文下方的项：宽度分两种存法，都是「怎么摆」而不是「内容」——
      //   · perRow = N → 宽度写成 calc((100% - 间隙*(N-1))/N)，任何宽度下都恰好 N 个一排（不会被间隙挤到换行）
      //   · widthPct   → 手动拖出来的自由宽度
      // 未设过任何值时，交给 CSS 默认「一行 3 个」。
      const perRow = (place === 'below' && c.perRow != null) ? Math.max(1, Math.min(6, Number(c.perRow) || 3)) : 0;
      const styleW = perRow
        ? ` style="--pmi-w:calc((100% - ${belowGap * (perRow - 1)}px)/${perRow})"`
        : ((place === 'below' && c.widthPct == null) ? '' : ` style="--pmi-w:${w}%"`);
      const alignCls = (place === 'below' || align === 'left') ? '' : (' pmi-' + (align === 'center' ? 'c' : 'r'));
      // 「自由摆放」的媒体项：渲染时就把 ve-place-free 烘进去（display:none），
      // 否则刷新后原图会重新出现、和自由副本重叠成两张。
      const imgPlace = (((design && design.imgPos) || {})[key] || {}).place || '';
      const posCls = (imgPlace && imgPlace !== 'inline') ? (' ve-place-' + imgPlace) : '';
      mediaItems.push({
        key, kind, order, natural, place, perRow,
        html: `<${tag} class="pm-item ${cls}${alignCls}${posCls}" data-ve-media-item="${key}"${styleW} ${attrs}>${inner}</${tag}>`
      });
    };
    images.forEach((src,k)=>{
      mkMediaItem('figure','pm-image',`${mediaPath}#image${k}`,k*10,'image',
        `data-ve-media data-ve-kind="media-image" data-ve-item="${mediaPath}" data-ve-media-path="${mediaPath}" data-ve-media-index="${k}"`,
        `<img src="${src}" alt="${esc(p.name)}" loading="lazy" class="ve-resizable" data-ve-media data-ve-media-path="${mediaPath}" data-ve-kind="media-image">`);
    });
    if(video){
      // 浏览器可能解不了的封装（ProRes/MOV/.m4v 等）先尝试播放：能播就播，解码失败由 onerror 兜底成不支持块。
      // 只有 AVI/MKV/FLV/WMV/MXF 这类硬不可播才直接给说明块。
      const vname = (m.video && m.video.name) || video.split('/').pop();
      const hard = HARD_UNPLAYABLE.test(video);
      mkMediaItem('div', hard ? 'pm-video pm-unsupported' : 'pm-video', `${mediaPath}#video`, 900, 'video',
        `data-ve-media data-ve-kind="media-video" data-ve-item="${mediaPath}"`,
        hard ? videoUnsupportedInner(video, vname)
             : `<video controls preload="metadata" playsinline class="pm-video-el" data-vurl="${encodeURI(video)}" data-vname="${esc(vname)}" onerror="__veVideoErr(this)" src="${video}"></video>`);
    }
    if(audio){
      mkMediaItem('div','pm-audio',`${mediaPath}#audio`,990,'audio',
        `data-ve-media data-ve-kind="media-audio" data-ve-item="${mediaPath}"`,
        `<audio controls src="${audio}"></audio>`);
    }
    // 排序：先 order、再自然序 —— 老数据没有 order 时保持原顺序不变
    mediaItems.sort((a,b)=>(a.order-b.order) || (a.natural-b.natural));
    const colItems = mediaItems.filter(x=>x.place!=='below');
    const belowItems = mediaItems.filter(x=>x.place==='below');
    const mediaColumn=colItems.length
      ? `<div class="project-media media-stack${layout.side==='left'?' media-left':''}" data-ve-media-box="${mediaPath}" data-ve-kind="media-box" style="--pm-w:${widthPct}%">${colItems.map(x=>x.html).join('')}</div>`
      : '';
    // 「正文下方」落点容器：拖到这里 = 脱离侧栏、整行排列（对应「项目底下很空，把图片挪下去」）。
    // 横排（flex-wrap）→ 同宽的几张横图自然落在同一条水平线上；jc-* 控制整行左/中/右对齐。
    const mediaBelow=belowItems.length
      ? `<div class="project-media-below${belowAlign?' jc-'+belowAlign:''}${belowSymmetric?' symmetric':''}" data-ve-media-below="${mediaPath}" data-ve-below-align="${belowAlign}"${belowSymmetric||belowGap!==BELOW_GAP_PX?` style="--below-gap:${belowGap}px"`:''}>${belowItems.map(x=>x.html).join('')}</div>`
      : '';
    if(!canExpand){
      return `<article class="project project-compact" data-ve-item="projects.${pi}" data-ve-kind="project">
        <div class="project-head">${logoPair(p,'projects.'+pi).before}<h4 data-field="projects.${pi}.name" data-single>${esc(p.name||ffZ('未命名项目'))}</h4>${logoPair(p,'projects.'+pi).after}<span class="project-role"><span data-field="projects.${pi}.role" data-single>${esc(p.role)}</span>${typeLabel?`<i class="project-type">${esc(typeLabel)}</i>`:''}<i data-field="projects.${pi}.date" data-single>${esc(p.date)}</i></span></div>
        ${p.keyWork?.length?`<div class="key-work"><ul>${p.keyWork.map((x,ki)=>`<li data-field="projects.${pi}.keyWork.${ki}" data-single data-ve-item="projects.${pi}.keyWork.${ki}" data-ve-kind="chip">${esc(x)}</li>`).join('')}</ul></div>`:''}
      </article>`;
    }
    const toggleLabel=`<span class="expand-label"><span class="expand-text">${esc(ffT('public.expand','展开'))}</span><span class="chev" aria-hidden="true"></span></span>`;
    return `<details class="project" data-ve-item="projects.${pi}" data-ve-kind="project">
      <summary class="project-head">
        ${logoPair(p,'projects.'+pi).before}<h4 data-field="projects.${pi}.name" data-single>${esc(p.name||ffZ('未命名项目'))}</h4>${logoPair(p,'projects.'+pi).after}
        <span class="project-role"><span data-field="projects.${pi}.role" data-single>${esc(p.role)}</span>${typeLabel?`<i class="project-type">${esc(typeLabel)}</i>`:''}<i data-field="projects.${pi}.date" data-single>${esc(p.date)}</i></span>
        <span class="project-toggle">${toggleLabel}</span>
      </summary>
      <div class="project-detail${mediaColumn?'':' no-media'}" style="--pm-w:${widthPct}%">
        <div class="project-main">
          ${displaySummary?`<p class="project-summary" data-field="projects.${pi}.summary" data-single>${esc(displaySummary)}</p>`:''}
          ${p.keyWork?.length?`<div class="key-work"><span class="label">Key Work</span><ul>${p.keyWork.map((x,ki)=>`<li data-field="projects.${pi}.keyWork.${ki}" data-single data-ve-item="projects.${pi}.keyWork.${ki}" data-ve-kind="chip">${esc(x)}</li>`).join('')}</ul></div>`:''}
          ${p.highlights?.length?`<div class="highlights"><span class="label">Highlights</span><ul>${p.highlights.map((x,hi)=>`<li data-field="projects.${pi}.highlights.${hi}" data-single data-ve-item="projects.${pi}.highlights.${hi}" data-ve-kind="chip">${esc(x)}</li>`).join('')}</ul></div>`:''}
          ${m.externalVideoUrl?`<a class="project-link" href="${esc(m.externalVideoUrl)}" target="_blank" rel="noopener">外部视频 ↗</a>`:''}
          ${m.externalLink?`<a class="project-link" href="${esc(m.externalLink)}" target="_blank" rel="noopener">外部链接 ↗</a>`:''}
        </div>
        ${mediaColumn}
        ${mediaBelow}
      </div>
    </details>`;
  };

  // —— Contact/Links：独立模块，每项 label+value，支持复制 ——
  const rawContact=(d.profile.contactLinks||[]).filter(x=>x&&(x.label||x.value));
  // 向后兼容：旧 contact 对象 {email,location,github} 转成 contactLinks
  const contactItems=rawContact.length?rawContact
    :Object.entries(d.profile.contact||{}).filter(([,v])=>v).map(([k,v])=>({label:k,value:v}));
  // 旧 contact 是对象（无索引数组），只有新版 contactLinks 支持「整项删除」
  const contactDeletable=rawContact.length>0;

  // —— Contact / Links + 技能：移到 About 之外，紧跟一句简介(intro)下方，作为 hero 后的独立区块 ——
  const contactItemsHtml=contactItems.map((x,ci)=>{const src=rawContact.length?'contactLinks':'contact';const del=contactDeletable?` data-ve-item="profile.contactLinks.${ci}" data-ve-kind="contact"`:'';return `<li class="contact-item"${del}><span class="contact-label" data-field="${src}.${ci}.label" data-single>${esc(x.label)}</span><button class="contact-value" data-field="${src}.${ci}.value" data-single data-copy="${esc(x.value)}" title="点击复制">${esc(x.value)}</button></li>`}).join('');
  // —— Links：2026-09-24 起与 Contact 拆开。属性不同 —— 公开链接点击即跳转（不再复制）。
  const rawLinks=(d.profile.publicLinks||[]).filter(x=>x&&(x.label||x.value));
  const linkItemsHtml=rawLinks.map((x,li)=>{const href=FF_absUrl(x.value);return `<li class="contact-item" data-ve-item="profile.publicLinks.${li}" data-ve-kind="contact"><span class="contact-label" data-field="profile.publicLinks.${li}.label" data-single>${esc(x.label)}</span><a class="contact-value link-value" href="${esc(href)}" target="_blank" rel="noopener" data-field="profile.publicLinks.${li}.value" data-single title="点击打开链接">${esc(x.value)}</a></li>`}).join('');
  const contactBlock=contactItemsHtml?`<div class="meta-block meta-block-contact" data-zk="contactLinks"><h4 class="meta-title" data-static>Contact</h4><ul class="contact-list">${contactItemsHtml}</ul></div>`:'';
  const linkBlock=linkItemsHtml?`<div class="meta-block meta-block-links" data-zk="publicLinks"><h4 class="meta-title" data-static>Links</h4><ul class="contact-list">${linkItemsHtml}</ul></div>`:'';
  // ⚠ 2026-09-24：Contact 与 Links 在**同一个区里同时出现**时融合成一块（见下方 FFZ_FUSED）。
  //   用户原话：「Links 和 Contact 可以，它们同时被选中的时候，可以在次展示区里面进行一个结合。
  //   就是不用再像现在这样分两个，还有间隔啊什么的，就是可以直接 Contacts / Links 然后把两个放一起嘛。」
  //   做法：一个 .meta-block、一个标题「Contact / Links」、**一个** .contact-list
  //   （先 Contact 项、再 Links 项）。两条列表合成一条后，中间那两重边框自然并成一条，
  //   视觉上就是"一件事"，不再有区块间距。
  const contactLinksFused=(contactItemsHtml||linkItemsHtml)
    ? `<div class="meta-block meta-block-contact meta-block-links meta-block-fused" data-zk="contactLinks+publicLinks"><h4 class="meta-title" data-static>Contact / Links</h4><ul class="contact-list">${contactItemsHtml}${linkItemsHtml}</ul></div>` : '';
  // 技能：按**内容形态**选渲染，不是一律一种 ——
  //   · 多个词条（Python / JavaScript / HTML / CSS …）→ **词组云**（chips），横向铺开、自动换行。
  //   · 只有一条、而且是一整句（用户在单个字段里塞了一串工具名，如
  //     "工具甲、工具乙、工具丙等。"）
  //     → 仍然是**整行文本行**。一整句塞进小胶囊里会又长又别扭，而"一个词占一行"才是丑的根源。
  // 用户原话：「技能就这么一点字儿，为什么一定要遵循每一个一行呢？它完全可以五个排成一行。」
  //   —— 注意"就这么一点字儿"是判据：**短的**该并排，**一整句**就该自己占一行。
  const skillItems = d.profile.skills || [];
  const skillIsCloud = skillItems.length > 1 || String(skillItems[0] == null ? '' : skillItems[0]).length <= 16;
  const skillsBlock = skillItems.length ? (skillIsCloud
    ? `<div class="meta-block meta-block-skills" data-zk="skills"><h4 class="meta-title" data-static>技能</h4><div class="keyword-block">${skillItems.map((x,si)=>`<span class="kw-chip" data-field="profile.skills.${si}" data-single data-ve-item="profile.skills.${si}" data-ve-kind="chip">${esc(x)}</span>`).join('')}</div></div>`
    : `<div class="meta-block meta-block-skills" data-zk="skills"><h4 class="meta-title" data-static>技能</h4><ul class="about-list">${skillItems.map((x,si)=>`<li data-field="profile.skills.${si}" data-single data-ve-item="profile.skills.${si}" data-ve-kind="chip">${esc(x)}</li>`).join('')}</ul></div>`) : '';
  // ==========================================================================
  // 展示区（Display Zones）—— 2026-09-24 新增的**系统级**能力，对所有模板生效
  //   · 主展示区 hero      ：眉标 / 姓名 / 定位 / 一句话简介，最多 4 项，位置固定、字号不变
  //   · 次展示区 secondary ：hero 下方信息列，最多 4 项（候选人＝资料里除去 resume 的 6 项）
  //   · 没被勾进次展示区的资料 → 自动回落到 About 区块，且 About 自适应重排，不留空洞
  // 配置在 design.displayZones（Template 级），候选清单在根目录 display-zones.js，
  // 展示页与文本编辑共用同一份 —— 绝不在两边各自复制一份清单（THEMES 三处镜像的教训）。
  // ==========================================================================
  const FFZ = window.FF_ZONES || null;
  const ZONE_HERO_ORDER = FFZ ? FFZ.heroOrder : ['eyebrow', 'name', 'role', 'intro'];
  const ZONE_SEC_ORDER = FFZ ? FFZ.secondaryOrder
    : ['contactLinks', 'skills', 'publicLinks', 'education', 'highlights', 'about'];
  const ZONES = FFZ ? FFZ.resolve(design && design.displayZones)
    : { hero: ZONE_HERO_ORDER.slice(), secondary: ['contactLinks', 'skills', 'publicLinks'] };
  const secKeys = ZONE_SEC_ORDER.filter(k => (ZONES.secondary || []).indexOf(k) >= 0);

  // 回落到 About 区块的项：次展示区没选走的那些（ About 正是它们的默认归宿 ）
  // ⚠ 用户原话：「如果我把教育经历勾选到了次展示区的话，那剩下的 about 里面要怎么排版？
  //   他不可能是直接挖走那一个地方就空了，肯定也要有所变动。」
  const aboutKeys = FFZ ? FFZ.fallbackKeys(ZONES) : ['about', 'highlights', 'education'];

  // 次展示区与 About 共用这几段 HTML —— 同一份资料无论在哪个区都长得一样，
  // 也避免"改了展示区、About 忘了改"这类漂移。
  const highlightsBlock = (d.profile.highlights || []).length
    ? `<div class="meta-block meta-block-highlights" data-zk="highlights"><h4 class="meta-title" data-static>Highlights</h4><div class="keyword-block">${d.profile.highlights.map((x, hi) => `<span class="kw-chip" data-field="profile.highlights.${hi}" data-single data-ve-item="profile.highlights.${hi}" data-ve-kind="chip">${esc(x)}</span>`).join('')}</div></div>` : '';
  const educationBlock = (d.profile.education || []).length
    ? `<div class="meta-block meta-block-education" data-zk="education"><h4 class="meta-title" data-static>教育经历</h4><ul class="about-list">${d.profile.education.map((x, ei) => `<li data-field="profile.education.${ei}" data-single data-ve-item="profile.education.${ei}" data-ve-kind="chip">${esc(x)}</li>`).join('')}</ul></div>` : '';
  const aboutTextBlock = d.profile.about
    ? `<div class="meta-block meta-block-about" data-zk="about"><p class="bodycopy" data-field="profile.about" data-single>${esc(d.profile.about)}</p></div>` : '';
  // 音频介绍：data.audioIntro = { url, name }（仿 resume）。只在有 url 时渲染；是否进次展示区由
  // 展示区配置决定，未选则通过 aboutKeys 回落到 About（fallbackKeys 已含 audioIntro），永不进 hero。
  const audioIntroBlock = (d.audioIntro && d.audioIntro.url)
    ? `<div class="meta-block meta-block-audio" data-zk="audioIntro"><h4 class="meta-title" data-static>Audio</h4><div class="audio-intro-wrap"><audio controls src="${esc(d.audioIntro.url)}" class="audio-intro-player"></audio></div></div>` : '';

  const ZONE_BLOCK = {
    contactLinks: () => contactBlock,
    publicLinks: () => linkBlock,
    'contactLinks+publicLinks': () => contactLinksFused,
    skills: () => skillsBlock,
    highlights: () => highlightsBlock,
    education: () => educationBlock,
    about: () => aboutTextBlock,
    audioIntro: () => audioIntroBlock
  };

  // —— 展示区排版：三种形态，按"实测高度"选最优 ——
  // ⚠ 2026-09-24 第七次重做。规则全部来自用户逐条口述，原样记下来免得再猜：
  //   ① 「不是说所有情况下这个次展示区都分为左右两块」——只有 1 个模块时整行铺满，
  //      「不能说受到左区块的限制，它就应该完整展开，一行直接过去」。
  //   ② 「当模块本身内容够长的时候，优先把次展示区看成一个整体，让这个内容自然舒展；
  //      它下方区域的内容如果模块内容不够长的话，那可以在这一个模块下方分左右区」→ span 形态。
  //   ③ 「同时有关于我和 highlights 的话，也不能就是说优先放左区。这种就还是把次展示区
  //      优先认为是一整个区域去放置，就不分左右块」→ 两块默认整宽堆叠（见 soft 罚分）。
  //   ④ 「次展示区它就是看起来左右区要平衡」→ 配平是硬指标，配不平宁可不分栏。
  //   ⑤ 「可以稍微把它们的间距允许会有不一样的情况，但是它这个间距的差距也不能太明显」
  //      → 留 ±FFZ_GAP_SWING 的逐栏微调空间（见 FFZ_tuneGaps）。
  //
  // 三种形态（mode）：
  //   one  : 全部整宽纵向堆叠
  //   cols : 左右两栏
  //   span : 最高的一块整宽铺满，其余块在它**下方**再分左右两栏
  // 目标函数  score = 两栏高度差 + 0.6 ×（本方案总高 − 所有方案里最矮的总高）+ 语义罚分
  //   —— 既要比"左右齐不齐"，也不能让某个方案白白多占一大截竖向空间。
  //
  // 初次渲染按 ZONE_WEIGHT 估算；DOM 落地后 FFZ_rebalanceZones 用**真实 offsetHeight**
  // 重算并重排（跑两遍：第一遍把块搬到位，第二遍按"搬完之后"的真实高度再确认一次），
  // 这才叫「根据实际内容」，不是靠猜。
  const ZONE_WEIGHT = {
    contactLinks: () => 30 + 54 * Math.max(contactItems.length, 1),
    publicLinks:  () => 30 + 54 * Math.max(rawLinks.length, 1),
    // 融合块：两项共用一条列表、去掉一条分隔线，所以比简单相加略矮一点。
    'contactLinks+publicLinks': () => 24 + 54 * Math.max(contactItems.length + rawLinks.length, 1),
    skills:       () => 30 + 30 * Math.max((d.profile.skills || []).length, 1),
    highlights:   () => 30 + 36 * Math.ceil((d.profile.highlights || []).length / 3),
    education:    () => 30 + 46 * Math.max((d.profile.education || []).length, 1),
    about:        () => 26 + 26 * Math.max(Math.ceil(((d.profile.about || '').length * 15) / 460), 1),
    audioIntro:   () => 30 + 54
  };
  // 展示区**内部**块与块的基础间距。⚠ 用户要求：「contact 和 links 之间太远了一点……
  //   次展示区以内不同模块的上下间距可以稍微近一点点，这样才能和次展示区上下的两根横线
  //   之间的间距区分开」。区块外的 42px（见 styles.css 的 .entry-panel）保持不动。
  const FFZ_GAP = 24;
  // 配平微调：单栏内部的块间距允许在 FFZ_GAP ± 这个值内浮动，用来把两栏底边拉齐。
  // 用户：「有一点点这种微调……但它这个间距的差距也不能太明显」→ 上下各 5px，最多差 10px。
  const FFZ_GAP_SWING = 5;
  // 语义约束分「硬」「软」两档：
  //   contactLinks + publicLinks = 紧耦的「对外联系」对 → **硬约束**，必须同栏（拆开毫无意义）；
  //   about + highlights = 「个人描述」族        → **软约束**，默认同栏，配平明显受益时才拆。
  const FFZ_HARD_PAIRS = [['contactLinks', 'publicLinks']];
  const FFZ_SOFT_PAIRS = [['about', 'highlights']];
  // 复合块（fusion）：组内各项**同时存在**时，融合成**一个**块参与排版
  //   （HTML 侧见 contactLinksFused；这里只负责"把两个 key 折成一个单元"）。
  //   ⚠ 与 FFZ_HARD_PAIRS 的区别：HARD_PAIRS 是"两块必须待在同一栏、但仍是两块"，
  //   FUSED 更进一步 —— 直接合成一块，连块间距都不存在。
  const FFZ_FUSED = [['contactLinks', 'publicLinks']];
  const FFZ_FUSED_KEY = g => g.join('+');
  const FFZ_FUSED_MEMBERS = key => (FFZ_FUSED.filter(g => FFZ_FUSED_KEY(g) === key)[0] || []);
  // 拆散 soft 对的代价 —— ⚠ 用**总高的比例**而不是固定像素值，这样整个目标函数对宽度缩放
  //   保持一致：同一份内容在"排版编辑"画布（1280px）和作品集实机（更宽/更窄）里算出的形态一致，
  //   不会因为文字换行数不同就在两边排出两种版式（这正是用户抱怨的"两个地方不一样"）。
  const FFZ_SOFT_RATIO = 0.12;
  // 栏内显示顺序：自我介绍打头、关键词随后；教育经历/技能居中；联系方式收尾。
  const FFZ_DISPLAY_ORDER = ['about', 'highlights', 'education', 'skills', 'contactLinks', 'publicLinks', 'audioIntro'];
  // 融合 key（如 'contactLinks+publicLinks'）按它**首个成员**的顺序定位 —— 免得每加一组融合
  // 都要手写一条顺序表（顺序表只维护"原子块"，融合块自动继承）。
  const FFZ_orderOf = key => {
    const g = FFZ_FUSED_MEMBERS(key);
    const i = FFZ_DISPLAY_ORDER.indexOf(g.length ? g[0] : key);
    return i < 0 ? 99 : i;
  };
  const FFZ_byOrder = (a, b) => FFZ_orderOf(a) - FFZ_orderOf(b);
  // 允许当"整宽主块"的块：成段正文（自我介绍 / 教育经历）。
  // 判据是**形态**不是高度：一段话铺满整行才叫舒展；短行表与词组云并排才叫紧凑。
  const FFZ_SPAN_BLOCKS = ['about', 'education'];

  // 给一组块选最优形态。list: [{k, hF, hH}]
  //   hF = 该块在**整宽**下的高度；hH = 在**半栏宽**下的高度。
  //   ⚠ 为什么要两个宽度：段落块（关于我 / 教育经历）换行数随栏宽变，整宽可能是 2 行、半栏变 4 行。
  //   如果只在"块当前所在位置"量一个高度，规划结果就依赖当前摆放 → 「整宽→判两栏→搬到半栏→
  //   变高→判整宽 span→搬回整宽→变矮→…」来回震荡（同一份内容在不同刷新/不同窗口里排成两种版式）。
  //   两个宽度各量一次，"块放在哪"不再影响评分 → 决策是内容与区宽的函数，天然稳定。
  //   缺省（只给 h 不给 hF/hH）时两者相等 —— 短行表 / 词组云高度基本不随宽度变。
  const FFZ_TWOCOL_MIN = 380 * 2 + 64;    // 与 CSS 的 .zone-col{flex-basis:380px} + 栏间距 64 对应
  const FFZ_planZone = (list, availW) => {
    const items = (list || []).filter(it => it && it.k);
    const n = items.length;
    const allKeys = items.map(it => it.k).sort(FFZ_byOrder);
    const one = { mode: 'one', span: '', cols: [allKeys, []] };
    if (n <= 1) return one;
    if (availW && availW < FFZ_TWOCOL_MIN) return one;
    const HF = {}, HH = {};
    items.forEach(it => {
      const h = Math.max(0, it.h || 0);
      HF[it.k] = Math.max(0, it.hF != null ? it.hF : h);
      HH[it.k] = Math.max(0, it.hH != null ? it.hH : h);
    });
    const SUMH = items.reduce((s, it) => s + HF[it.k], 0);
    const groupH = (ks, H) => ks.reduce((s, k) => s + H[k], 0) + FFZ_GAP * Math.max(ks.length - 1, 0);
    const idx = {}; items.forEach((it, i) => { idx[it.k] = i; });
    const paired = p => idx[p[0]] != null && idx[p[1]] != null;
    const SOFT = FFZ_SOFT_RATIO * SUMH;
    const softOf = (a, b) => {
      let s = 0;
      FFZ_SOFT_PAIRS.forEach(p => {
        if (!paired(p)) return;
        const p0a = a.indexOf(p[0]) >= 0, p0b = b.indexOf(p[0]) >= 0;
        const p1a = a.indexOf(p[1]) >= 0, p1b = b.indexOf(p[1]) >= 0;
        if ((p0a && p1b) || (p0b && p1a)) s += SOFT;
      });
      return s;
    };
    const cands = [];
    // A. 左右两栏：枚举所有二分（两栏都非空）—— 两栏里的块都是**半栏宽**，所以用 HH
    for (let mask = 1; mask < (1 << n) - 1; mask++) {
      const a = [], b = [];
      for (let i = 0; i < n; i++) (((mask >> i) & 1) ? b : a).push(items[i].k);
      if (FFZ_HARD_PAIRS.some(p => paired(p) && (((mask >> idx[p[0]]) & 1) !== ((mask >> idx[p[1]]) & 1)))) continue;
      const ha = groupH(a, HH), hb = groupH(b, HH);
      cands.push({ mode: 'cols', span: '', cols: [a.sort(FFZ_byOrder), b.sort(FFZ_byOrder)],
        bal: Math.abs(ha - hb), h: Math.max(ha, hb), soft: softOf(a, b) });
    }
    // B. 一块整宽 + 其余在下方分栏（主块按高度从高到低尝试，平手时最高的那块当选）
    // ⚠ 只有"本身就该占满一行"的块才配当整宽主块 —— 也就是**成段的正文**
    //   （自我介绍、教育经历是整句）。Contact / Links 是 label+value 短行表、
    //   Highlights / 技能是词组云，它们天生该并排待着，抬到整宽行只会打乱顺序、白占一行。
    const byH = items.map((_, i) => i).sort((x, y) => HF[items[y].k] - HF[items[x].k]);
    byH.forEach(p => {
      const pk = items[p].k;
      if (FFZ_SPAN_BLOCKS.indexOf(pk) < 0) return;
      const rest = items.filter((_, i) => i !== p).map(it => it.k);
      const m = rest.length;
      if (!m) return;
      for (let mask = 0; mask < (1 << m); mask++) {
        const a = [], b = [];
        for (let i = 0; i < m; i++) (((mask >> i) & 1) ? b : a).push(rest[i]);
        // ⚠ span 形态必须**真的**在下方分出两栏。如果只堆在一栏里，那它就是"单栏"，
        //   交给 mode:'one' 处理（那里能保证按 FFZ_DISPLAY_ORDER 的正式顺序排），
        //   否则会出现"联系方式被抬到最上面、技能掉到最后"这种顺序错乱。
        if (!a.length || !b.length) continue;
        // 硬约束：必须同栏的一对，既不能被拆到「下方两栏」的两侧，
        // **也不能一个当整宽主块、另一个留在下方**（2026-09-24 修：这是上一版的漏洞，
        // 结果 Contact 被抬到整宽行、Links 单独留在下面，等于把这对拆了）。
        const pairBroken = FFZ_HARD_PAIRS.some(q => {
          if (!paired(q)) return false;
          const ca = a.indexOf(q[0]) >= 0, cb = b.indexOf(q[0]) >= 0;
          const da = a.indexOf(q[1]) >= 0, db = b.indexOf(q[1]) >= 0;
          if ((ca && db) || (cb && da)) return true;
          return ((q[0] === pk) !== (q[1] === pk));
        });
        if (pairBroken) continue;
        const ha = groupH(a, HH), hb = groupH(b, HH);   // 下方两栏仍是半栏宽
        // tie：同样是"整宽主块"，优先让「关于我」当主角（个人描述的正主）。
        //   按总高的千分之二取 —— 只在近乎平手时才起作用，不会改掉真正的取舍。
        const anchor = (idx['about'] != null && pk !== 'about') ? 0.002 * SUMH : 0;
        cands.push({ mode: 'span', span: pk, cols: [a.sort(FFZ_byOrder), b.sort(FFZ_byOrder)],
          bal: Math.abs(ha - hb),
          h: HF[pk] + FFZ_GAP + Math.max(ha, hb),            // 主块整宽 → 用 HF
          soft: softOf(a, b) + anchor });
      }
    });
    // C. 全部整宽堆叠 —— 全用 HF
    cands.push({ mode: 'one', span: '', cols: [allKeys, []], bal: 0, h: groupH(allKeys, HF), soft: 0 });
    let hmin = Infinity;
    cands.forEach(c => { if (c.h < hmin) hmin = c.h; });
    let best = null;
    cands.forEach(c => {
      // tie：平手时让「关于我」留在左栏（个人描述一边、联系方式一边）。
      //   同样按总高的比例取，保证不随宽度缩放改变倾向。
      const tie = (idx['about'] != null && c.cols[1].indexOf('about') >= 0) ? 0.002 * SUMH : 0;
      const s = c.bal + 0.6 * (c.h - hmin) + c.soft + tie;
      if (!best || s < best.s - 1e-6) best = { s: s, c: c };
    });
    return best ? best.c : one;
  };
  // 兼容旧调用名（测试与外部脚本用得到）
  const FFZ_planColumns = (list) => {
    const p = FFZ_planZone(list);
    return p.mode === 'one' ? [p.cols[0]] : [p.cols[0], p.cols[1]];
  };
  const zoneGrid = (keys, extraCls) => {
    // 0) 融合：把"同时出现"的复合组成员折成一个合成 key（见 FFZ_FUSED / contactLinksFused）。
    const rawKeys = (keys || []).filter(k => ZONE_BLOCK[k]);
    const fuseMap = {};
    FFZ_FUSED.forEach(g => {
      if (g.every(k => rawKeys.indexOf(k) >= 0)) g.forEach(k => { fuseMap[k] = FFZ_FUSED_KEY(g); });
    });
    const blocks = [];
    rawKeys.forEach(k => {
      const key = fuseMap[k] || k;
      if (blocks.some(b => b.k === key)) return;      // 同组成员只放一次
      const fn = ZONE_BLOCK[key];
      const html = fn ? fn() : '';
      if (html) blocks.push({ k: key, html: html, h: (ZONE_WEIGHT[key] ? ZONE_WEIGHT[key]() : 2) });
    });
    if (!blocks.length) return '';
    const plan = FFZ_planZone(blocks.map(b => ({ k: b.k, h: b.h })));
    const byK = {}; blocks.forEach(b => { byK[b.k] = b.html; });
    // ⚠ 固定输出**三个**容器：第一行（整宽 span，通常为空）+ 下方两栏。
    //   这样"实测重排"只需在这三个既有容器之间搬块 + 切类名，不用重建 DOM，稳且幂等；
    //   空容器交给 CSS 的 `.zone-col:empty{display:none}` 收掉，不占位、不产生多余间距。
    const colHtml = (ks) => (ks || []).map(k => byK[k] || '').join('');
    const cls = plan.mode === 'one' ? 'zone-grid-1' : 'zone-grid-2';
    return `<div class="zone-grid ${cls}${extraCls ? ' ' + extraCls : ''}" data-zone>`
      + `<div class="zone-col zone-col-span">${plan.mode === 'span' ? (byK[plan.span] || '') : ''}</div>`
      + `<div class="zone-col">${colHtml(plan.cols[0])}</div>`
      + `<div class="zone-col">${colHtml(plan.cols[1])}</div>`
      + `</div>`;
  };
  // DOM 落地后的「实测重排」：按每块**真实高度**重算形态与分栏，把块搬到该去的位置，并微调栏内间距。
  // 幂等：同高同分法 → 重复调用结果一致（第二次基本是空操作）。
  // ⚠ 2026-09-24 第七版：三种形态都能落地（one / cols / span）。
  //   第一行（.zone-col-span）与下方两栏这三个容器**始终存在**（zoneGrid 固定输出），
  //   所以搬块只是 appendChild + 切类名，不重建 DOM，稳定幂等。
  // ⚠ 每个 grid 跑**两遍**：第一遍按"当前摆放位置"的高度决定形态并把块搬到位；
  //   搬完宽度变了（整宽 vs 半宽），文字换行数随之改变、高度也跟着变，
  //   所以第二遍用"搬完之后"的真实高度再确认一次。两遍即收敛。
  // 量高陷阱：About / 次展示区常常住在**收起的** .entry-panel 里（.entry-panel{display:none}，
  // 只有 .entry.open 才 display:block）。此时子孙后代没有布局盒 → offsetHeight 全是 0，
  // 配平就会拿一堆 0 当权重 → 误判「两列失衡」→ 把本该两列的区块压成单列。
  // （tpl-2 第三张截图就是这么来的：估算权重本来给的是两列，复算时读到 0 又收回了单列。）
  // 解法：量之前把挡路的 display:none 祖先**临时**改成 block。整段是同步执行的，
  // 同步任务结束前浏览器不会绘制 → 用户看不到任何闪动；量完立刻还原。
  const FFZ_forceVisible = (el) => {
    const saved = [];
    let n = el;
    while (n && n !== document.body && n.nodeType === 1) {
      if (getComputedStyle(n).display === 'none') { saved.push([n, n.style.display]); n.style.display = 'block'; }
      n = n.parentElement;
    }
    return () => { for (let i = 0; i < saved.length; i++) saved[i][0].style.display = saved[i][1]; };
  };
  // 逐栏微调块间距，把两栏**底边**尽量拉齐。用户原话：「比如左边多了一点点，
  //   那是否把这个关于我模块和 highlight 模块之间的间距稍微少一点点呢？或者说 links 和 contact
  //   之间的模块间距稍微宽一点点呢……但它这个间距的差距也不能太明显。」
  //   所以只在 FFZ_GAP ± FFZ_GAP_SWING 范围内动，且优先选"离基础值最近"的解。
  const FFZ_tuneGaps = (c0, c1) => {
    const kids = col => [...col.children];
    const sum = els => els.reduce((s, el) => s + el.offsetHeight, 0);
    const g0 = kids(c0), g1 = kids(c1);
    if (!g0.length || !g1.length) { c0.style.rowGap = ''; c1.style.rowGap = ''; return; }
    const a = g0.length - 1, b = g1.length - 1;      // 每栏内的间距个数
    const A = sum(g0), B = sum(g1);
    let best = null;
    for (let x = FFZ_GAP - FFZ_GAP_SWING; x <= FFZ_GAP + FFZ_GAP_SWING; x++) {
      for (let y = FFZ_GAP - FFZ_GAP_SWING; y <= FFZ_GAP + FFZ_GAP_SWING; y++) {
        const diff = Math.abs((A + a * x) - (B + b * y));
        // 主目标：底边差最小；次目标：离基础间距最近（免得"明显不一样"）
        const drift = Math.abs(x - FFZ_GAP) + Math.abs(y - FFZ_GAP);
        if (!best || diff < best.diff || (diff === best.diff && drift < best.drift)) best = { diff: diff, drift: drift, x: x, y: y };
      }
    }
    if (!best) return;
    c0.style.rowGap = (best.x === FFZ_GAP ? '' : best.x + 'px');
    c1.style.rowGap = (best.y === FFZ_GAP ? '' : best.y + 'px');
  };
  // 量高 helper：把每个块在「半栏宽」「整宽」两个宽度下各量一次（两个宽度为什么要分开量，见 FFZ_planZone）。
  //   · 半栏宽 → 用**离屏测量盒**（position:absolute;left:-99999px + 显式宽度）：不进布局、绝不闪动；
  //   · 整宽   → 直接搬进 .zone-col-span（flex:1 1 100% = 整幅）。
  // ⚠ 量完所有块都停在 spanEl 里，由 FFZ_applyZone 的 put() 重新归位；
  //   若高度没量全（整棵子树被隐藏等），按记录的原宿主还原后放弃 —— 绝不拿 0 当权重改写布局。
  const FFZ_measureBlocks = (grid, spanEl) => {
    const els = [...grid.querySelectorAll('.meta-block')];
    if (!els.length) return null;
    const W = grid.clientWidth || 0;
    if (W <= 0) return null;
    const orig = els.map(el => ({ el: el, host: el.parentElement }));
    const half = Math.max(Math.floor((W - 64) / 2), 1);   // 与 CSS 的栏间距 64 对应
    const meas = document.createElement('div');
    meas.className = 'zone-measure';
    meas.setAttribute('aria-hidden', 'true');
    meas.style.cssText = 'position:absolute;left:-99999px;top:0;width:' + half + 'px;display:flex;flex-direction:column;gap:0;';
    grid.appendChild(meas);
    const hH = {}, hF = {};
    els.forEach(el => { meas.appendChild(el); hH[el.getAttribute('data-zk') || ''] = el.offsetHeight; });
    els.forEach(el => { spanEl.appendChild(el); hF[el.getAttribute('data-zk') || ''] = el.offsetHeight; });
    if (meas.parentElement) meas.parentElement.removeChild(meas);
    const blocks = els.map(el => {
      const k = el.getAttribute('data-zk') || '';
      return { el: el, k: k, hF: hF[k] || 0, hH: hH[k] || 0 };
    });
    if (blocks.some(b => b.hF <= 0 && b.hH <= 0)) {
      orig.forEach(o => { if (o.host && o.el.parentElement !== o.host) o.host.appendChild(o.el); });
      return null;
    }
    return blocks;
  };
  const FFZ_applyZone = (grid) => {
    const colEls = [...grid.querySelectorAll(':scope > .zone-col')];
    if (colEls.length !== 3) return;
    const spanEl = colEls[0], c0 = colEls[1], c1 = colEls[2];
    const release = FFZ_forceVisible(grid);
    let blocks;
    try { blocks = FFZ_measureBlocks(grid, spanEl); } finally { release(); }
    if (!blocks) return;
    const plan = FFZ_planZone(blocks.map(b => ({ k: b.k, hF: b.hF, hH: b.hH })), grid.clientWidth || 0);
    const put = (host, ks) => {
      (ks || []).slice().sort(FFZ_byOrder).forEach(k => {
        const b = blocks.filter(x => x.k === k)[0];
        if (b) host.appendChild(b.el);
      });
    };
    put(spanEl, plan.mode === 'span' && plan.span ? [plan.span] : []);
    put(c0, plan.cols[0]);
    put(c1, plan.cols[1]);
    const two = plan.mode !== 'one';
    grid.classList.toggle('zone-grid-2', two);
    grid.classList.toggle('zone-grid-1', !two);
    FFZ_tuneGaps(c0, c1);
  };
  const FFZ_rebalanceZones = (scope) => {
    if (!scope || !scope.querySelectorAll) return;
    scope.querySelectorAll('.zone-grid').forEach(grid => {
      FFZ_applyZone(grid);
      FFZ_applyZone(grid);   // 第二遍：按"搬完之后"的真实高度确认（宽度变了→换行数变了）
    });
  };
  // 视口变宽/变窄后「该两列/该单列」的答案会变（窄屏文字换行多、块变高）——
  // 挂一次防抖 resize 重算，避免「窄屏时收成单列 → 拉回宽屏后一直单列」的残留。全局只绑一次。
  try {
    window.__FFZ_rebalance = FFZ_rebalanceZones;
    if (!window.__ffzResizeBound) {
      window.__ffzResizeBound = true;
      let _ffzT = null;
      window.addEventListener('resize', () => {
        clearTimeout(_ffzT);
        _ffzT = setTimeout(() => {
          try { if (window.__FFZ_rebalance) window.__FFZ_rebalance(document); } catch (_) {}
        }, 180);
      });
    }
  } catch (_) {}

  const metaBand = zoneGrid(secKeys, 'meta-band');

  // —— 分组（Works 层级：Section > Category > Project，两级折叠） ——
  // Category 默认收起，点击才展开看到 Category Summary + Projects；Project 再单独展开
  // 注意：data-field / data-ve-* 必须用「原始数组下标」gi，否则一旦有隐藏分类，改名会写到错的分类上。
  let groupSeen = 0;
  const works=d.projectGroups.map((g,gi)=>{
    if (g.hidden===true) return '';
    const ps=d.projects.filter(x=>x.groupId===g.id && x.hidden!==true);
    if(!ps.length)return '';
    const first = groupSeen++ === 0;
    return `<details class="works-group" ${first?'open':''} data-ve-kind="category" data-ve-group="${esc(g.id)}" data-ve-group-index="${gi}" data-ve-item="projectGroups.${gi}">
      <summary class="works-category-head">
        <span class="works-category" data-field="projectGroups.${gi}.title" data-single>${esc(g.title||ffZ('未命名分类'))}</span>
        <span class="works-count">${ps.length}</span>
        <span class="expand-label"><span class="expand-text">${esc(ffT('public.expand','展开'))}</span><span class="chev" aria-hidden="true"></span></span>
      </summary>
      <div class="works-category-body">
        ${g.description?`<p class="works-intro" data-field="projectGroups.${gi}.description" data-single>${esc(g.description)}</p>`:''}
        ${ps.map(project).join('')}
      </div>
    </details>`;
  }).join('');

  // —— Showreel chapters：projectId 关联，动态读名称/角色 ——
  const buildChapters=(list)=>(list||[]).map((c,ci)=>{
    const proj=byId(c.projectId);
    const title=proj?proj.name:(c.title||'');
    const role=proj?proj.role:(c.role||'');
    return `<button class="chapter" data-start="${secs(c.start)}" data-end="${secs(c.end)}"><span class="ch-index">${String(ci+1).padStart(2,'0')}</span><span class="ch-time">${fmt(secs(c.start))} — ${fmt(secs(c.end))}</span><strong>${esc(title||ffZ('未命名章节'))}</strong><span class="ch-role">${esc(role)}</span></button>`;
  }).join('');

  // —— Showreel：作为顶层一级区块，**不再**套 <details class="works-group">——
  // 之前为了向后兼容把 Showreel 嵌进 Works 分类里，产生了「Showreel 区块里还有一个 Showreel 分类标题」的视觉冗余。
  // 现在 Showreel 默认与 About / 经历 / 作品 同级（来自 design.sectionOrder 或 data.sections），
  // 直接渲染视频 + 章节即可——区块标题由 SECTION_DEFS.showreel.title = 'Showreel' 提供。
  // Showreel 模块构建器：内置 Showreel 区块与用户新增的「Showreel 板块」共用（新增板块自带视频 + 跳转链接）。
  // —— Showreel：一级栏目，下面是多个 Showreel 项目（projects[]），每个项目有自己的视频与章节 ——
  const buildShowreelProject=(sp, spi)=>{
    const u=url(sp.media); const ch=buildChapters(sp.chapters);
    const head=`<div class="srp-head"><h3 class="srp-name" data-field="showreel.projects.${spi}.name" data-single>${esc(sp.name||(ffZ('Showreel 项目')+' '+String(spi+1).padStart(2,'0')))}</h3>${sp.role?`<span class="srp-role" data-field="showreel.projects.${spi}.role" data-single>${esc(sp.role)}</span>`:''}</div>`;
    const src=SHOWREEL_resolveSource(sp, u, ch);
    return `<div class="showreel-project" data-ve-item="showreel.projects.${spi}" data-ve-kind="showreel-project">${head}<div class="showreel">${src.player}<div class="chapters">${ch}</div></div>${src.extra}</div>`;
  };

  const srProjects=(d.showreel.projects||[]);
  const showreelModule=srProjects.length
    ? srProjects.map((sp,spi)=>buildShowreelProject(sp,spi)).join('')
    : `<div class="showreel-empty">${ffZ('Showreel 栏目还没有项目：到「文本编辑 → Showreel」点「＋ 新建 Showreel 项目」。')}</div>`;

  // —— Experience：横向/时间导向，不再显示 Key Work（已合并到 Highlights）——
  // 必须包一层 .experience 容器：CSS 的计数器（01 / 02 / 03…）靠 .experience{counter-reset:exp} 生效，
  // 少了这层，计数器不会重置，每条经历都会显示 01。
  const experience=`<div class="experience">${d.experience.map((x,xi)=>{
    const sourceSummary=(x.structuredContent&&x.structuredContent.summary)!=null?x.structuredContent.summary:(x.summary||'');
    const displaySummary=FF_I18N?FF_I18N.resolveLocalizedSummary(d,'experience',x,sourceSummary):sourceSummary;
    const hl=x.highlights||[];
    // 本地图片（与 C/D/E 同一套媒体布局契约）：experience.N.media.image。
    //   无图 = 文字用完整可用宽度（不再写死 max-width）；有图 = 「文字区(.exp-main) + 媒体区(.exp-media)」两栏。
    //   列宽与 C/D/E 同源：design.imgSizes['experience.N.media'].widthPct（18–70，默认 38）。
    const expImg=url(x.media && x.media.image);
    const hasMedia=!!expImg;
    const hasBody=!!(displaySummary||hl.length||hasMedia);
    const expSizeCfg=(design && design.imgSizes && design.imgSizes['experience.'+xi+'.media']) || {};
    const expW=(expSizeCfg.widthPct!=null)?Math.max(18,Math.min(70,Number(expSizeCfg.widthPct)||38)):38;
    return `<details class="experience-item" data-ve-item="experience.${xi}" data-ve-kind="experience">
      <summary><strong class="exp-company" data-field="experience.${xi}.company" data-single>${esc(x.company||ffZ('未命名经历'))}</strong><span class="exp-position" data-field="experience.${xi}.position" data-single>${esc(x.position)}</span><span class="exp-date" data-field="experience.${xi}.date" data-single>${esc(x.date)}</span>${hasBody?`<span class="expand-label"><span class="expand-text">${esc(ffT('public.expand','展开'))}</span><span class="chev" aria-hidden="true"></span></span>`:''}</summary>
      ${hasBody?`<div class="exp-body${hasMedia?' has-media':' no-media'}"${hasMedia?` style="--exp-pm-w:${expW}%"`:''}>
        <div class="exp-main">
          ${displaySummary?`<p class="exp-summary" data-field="experience.${xi}.summary" data-single>${esc(displaySummary)}</p>`:''}
          ${hl.length?`<div class="exp-hl"><span class="label" data-static>Highlights</span><ul>${hl.map((h,hi2)=>`<li data-field="experience.${xi}.highlights.${hi2}" data-single data-ve-item="experience.${xi}.highlights.${hi2}" data-ve-kind="chip">${esc(h)}</li>`).join('')}</ul></div>`:''}
        </div>
        ${hasMedia?`<div class="exp-media"><img src="${expImg}" alt="${esc(x.company||'')}" loading="lazy" class="ve-resizable" data-ve-media-path="experience.${xi}.media.image"></div>`:''}
      </div>`:''}
    </details>`;
  }).join('')}</div>`;

  const a=d.aiVoices;
  // AI Project 区块已由「单一 Case Study」简化为「总标题 + 若干具体 AI 项目卡片」，
  // 原来的 步骤(sections) / 简介 / Live Demo / GitHub / 媒体 等顶层字段不再展示。

  // 关于我 hero：不重复展示完整 about（仅展示一句话 intro）。about 全文留给 About 面板。
  // —— 关于我 区块正文 ——
  // ⚠ 2026-09-24：这里不再写死"正文 + 关键词 | 教育经历"的两栏结构，而是**按需重排**：
  //   展示区勾走了某项 → About 只渲染剩下的；全被勾走 → 返回空串，上层把整个 About
  //   区块从目录里摘掉，不留一个空壳（用户："肯定也要有所变动，不能直接挖空留洞"）。
  const aboutBody = zoneGrid(aboutKeys);

  // —— AI Voices 区块正文 ——
  // 每个 AI 项目与「AI Voices」主体同一套视觉：编号 + 标题/角色 + 简介 + 技术栈 + Highlights + 链接 + 封面 + 截图网格。
  // AI 项目卡片构建器：可复用于内置 AI Project 区块，也可复用于用户新增的「AI Project 板块」。
  // prefix 决定数据路径与 VE 元素路径（内置 = aiVoices.projects，新增板块 = blocks.N.projects）。
  // —— 项目名称旁的「Logo 点缀图」（2026-09-19 新增需求）——
  // project.logo = { url, pos: 'before'|'after' }：
  //   · url 既可以是纯字符串，也可以是上传接口返回的引用对象 {url,name,...}
  //   · pos 决定 Logo 排在项目名称**前面还是后面**（用户在编辑器里选）
  // 高度/宽度由 CSS（.pf-logo）锁在标题行以内，所以图片再大也不会撑开卡片、不会改变行距。
  // 所有项目类（常规项目 / AI 项目）共用这一个 helper —— 将来新模板只要渲染 logo 字段即可自动生效。
  function logoPair(p, P){
    const lg = p && p.logo;
    const raw = typeof lg === 'string' ? lg : (lg && (lg.url || lg.src)) || '';
    // ⚠ url() 的签名是 m => m?.url || ''，只吃「引用对象」。
    // 纯字符串路径必须直接放行，否则会被它读成空字符串、Logo 永远渲染不出来。
    const src = raw ? (typeof raw === 'string' ? raw : url(raw)) : '';
    if (!src) return { before: '', after: '' };
    // 链路 id：作品集 → 父窗口（文本编辑 / 排版编辑）的定向删除 / 重选
    // P 形如 'aiVoices.projects.0' / 'projects.3'，就是项目记录的字段路径
    const link = P ? ` data-ve-logo-path="${esc(P)}"` : '';
    const img = `<img src="${src}" alt="" class="pf-logo"${link}>`;
    // pos 缺省 = 'after'（名称后面），符合"点缀"的默认观感
    return (lg && lg.pos === 'before') ? { before: img, after: '' } : { before: '', after: img };
  }
  // —— 区块级（Section）Logo 点缀图（2026-09-19 新增需求）——
  // 用户诉求：一个作品集可能只有 About / Experience / Works 三个大区，不再往下细分项目，
  // 那他想在这三个大区块的标题旁边放可视化点缀，现在**没有地方可放**（只有子项目能放）。
  //   · 数据落在 **Content**（portfolio.json）的 sectionLogos[key]，而不是 Design ——
  //     它是"这个区块配什么图"的内容属性，应该跟区块标题（sectionTitles）放在一起，
  //     这样跨模板共享、导出模板时也带走（Design 是模板级、Content 是模板内数据）。
  //   · key 就是 sectionOrder 里的 id（about / experience / works / showreel / aiVoices），
  //     所以**任何模板、任何新增区块、任何重排顺序都自动生效** —— 这里不写死任何区块名。
  //   · 形如 { url, pos:'before'|'after' }，与项目级 logo 完全同构，编辑器控件可复用。
  function sectionLogoPair(secKey, d){
    const lg = (d.sectionLogos || {})[secKey];
    const raw = typeof lg === 'string' ? lg : (lg && (lg.url || lg.src)) || '';
    const src = raw ? (typeof raw === 'string' ? raw : url(raw)) : '';
    if (!src) return { before: '', after: '' };
    const img = `<img src="${src}" alt="" class="pf-logo pf-logo-section" data-ve-section-logo="${esc(secKey)}" data-ve-logo-path="sectionLogos.${esc(secKey)}">`;
    return (lg && lg.pos === 'before') ? { before: img, after: '' } : { before: '', after: img };
  }
  const buildAiProjects = (list, prefix) => (list||[]).filter(p=>p&&p.hidden!==true).map((p,i)=>{
    const P = `${prefix}.${i}`;
    const shots=(p.media&&p.media.screenshots||[]).filter(Boolean).map((s,si)=>`<img src="${url(s)}" alt="${esc(p.name||'AI 项目')} 截图${si+1}" loading="lazy" class="ve-resizable" data-ve-media-path="${P}.media.screenshots.${si}">`).join('');
    const tech=(p.tech||[]).filter(Boolean).map((t,ti)=>`<span class="kw-chip" data-field="${P}.tech.${ti}" data-single data-ve-item="${P}.tech.${ti}" data-ve-kind="chip">${esc(t)}</span>`).join('');
    const hl=(p.highlights||[]).filter(Boolean).map((h,hi)=>`<li data-field="${P}.highlights.${hi}" data-single data-ve-item="${P}.highlights.${hi}" data-ve-kind="chip">${esc(h)}</li>`).join('');
    // ⚠ 2026-09-24：GitHub / Live Demo 原先是两个 <a class="button">。
    //   用户要求「跟次展示区 Links 一样 —— 点击就打开、还能复制」。所以这里**复用**
    //   次展示区 Links 的行式结构（label + 可点开的 value + ↗），右侧再补一个「复制」。
    //   两个区用同一套 class：改一处两处同步，不会再出现"改了这边漏了那边"。
    const linkRow = (label, val) => {
      if (!val) return '';
      const href = FF_absUrl(val);
      return `<li class="contact-item"><span class="contact-label" data-static>${esc(label)}</span>`
        + `<a class="contact-value link-value" href="${esc(href)}" target="_blank" rel="noopener" title="${esc(ffZ('点击打开链接'))}">${esc(val)}</a>`
        + `<button type="button" class="contact-value link-copy" data-copy="${esc(val)}" title="${esc(ffZ('点击复制'))}">${esc(ffZ('复制'))}</button></li>`;
    };
    const links = linkRow('GitHub', p.githubUrl) + linkRow('Live Demo', p.liveDemoUrl);
    const LG = logoPair(p, P);
    // —— AI Project 信息结构（2026-09-26 三次调整；2026-09-27 方案 B 定稿）——
    //   数据映射（绝不可互换）：
    //     positioning  = 项目定位（项目层：这个项目是什么/属于什么方向）→ 标题右侧（竖线装饰已移除）
    //     summary      = 项目简介（具体做什么/解决什么问题）            → 标题下方正文
    //     role         = 我的角色/个人定位（短到长都可变）             → 内联署名行前段（强调粗体）
    //     contribution = 我的贡献（可变长度描述，可多行）             → 内联署名行后段（自然衔接）
    //   公开页不出现任何后台字段标题；结构靠位置/字体/间距/分隔点表达。
    //   role / contribution / positioning 都是可变长度用户文本：不截断、不硬编码、自然换行、
    //   不横向溢出（容器 min-width:0 + pre-wrap），长内容不得挤坏 Keywords / Highlights。
    //   Key words（带空格）/ Highlights 保持英文 data-static 标签，不进翻译系统。
    //   【2026-09-27 方案 B】role+contribution 不再左右两栏（比例失衡根因已除）：
    //   改为一段内联署名行「role（强调粗体）+ 明显分隔点 ·（data-static+aria-hidden，
    //   不参与编辑/翻译/点击）+ contribution」，同段流式文本自然换行。
    //   ⚠ DOM 降级：<p> 不可嵌套 <p>，role/contrib 从 <p> 改为 <span>（同 C 区 .project-role
    //   的 span+data-single 先例），字段路径、data-single 编辑绑定、pre-wrap 兜底（[data-field]
    //   属性选择器）全部不变；ai-project-persona--solo 类保留（只有单字段时输出，样式暂无规则）。
    // —— 媒体布局统一原则（2026-09-27 五次收口，与 C 区 .project-detail 同一套机制）——
    //   【无媒体】媒体栏 DOM 整体不输出，不预留空列；项目文字用完整可用宽度。
    //   【有媒体】形成「文字区(.ai-project-main) + 媒体区(.ai-project-side)」两栏，
    //     项目主体文字（summary / role+contribution / Key words / Highlights / links）
    //     **全部**留在文字区，共同遵守文字区宽度 —— 不允许某一段被单独限宽而跑出布局
    //     （历史上 .ai-project-summary 等写了 max-width:760px、persona 却不限宽 = 断层根因）。
    //   【媒体移除】媒体区整体收回，文字自动恢复完整宽度，无需用户手动调整。
    //   媒体来源 = Text Editor 里该 AI Project 自己的 media.image / media.screenshots（不是 VE 自由图）。
    //   D 区顺序：标题+positioning → summary → role+contribution → Key words → Highlights → links → 媒体区。
    const pos = String(p.positioning || '').trim();
    const contrib = String(p.contribution || '').trim();
    const roleTxt = String(p.role || '').trim();
    const posTag = pos ? `<span class="ai-project-positioning" data-field="${P}.positioning" data-single>${esc(pos)}</span>` : '';
    // 内联署名行：role + · + contribution 同段流式；分隔点只在两者都存在时输出（单字段不出孤儿点）。
    const persona = (roleTxt || contrib) ? `<div class="ai-project-persona${(roleTxt&&contrib)?'':' ai-project-persona--solo'}"><p class="ai-project-persona-line">${roleTxt?`<span class="ai-project-persona-role" data-field="${P}.role" data-single>${esc(roleTxt)}</span>`:''}${(roleTxt&&contrib)?'<span class="ai-project-persona-dot" data-static aria-hidden="true">·</span>':''}${contrib?`<span class="ai-project-persona-contrib" data-field="${P}.contribution" data-single>${esc(contrib)}</span>`:''}</p></div>` : '';
    // 媒体栏宽度：与 C 区同源 —— design.imgSizes[<媒体路径>].widthPct（18–70，默认 38）。
    const sizeCfg=(design && design.imgSizes && design.imgSizes[P + '.media']) || {};
    const pmW=(sizeCfg.widthPct!=null) ? Math.max(18, Math.min(70, Number(sizeCfg.widthPct)||38)) : 38;
    const coverSrc = url(p.media && p.media.image);
    const videoSrc = url(p.media && p.media.video);
    const hasMedia = !!(coverSrc || shots || videoSrc);
    const mediaStack = (coverSrc || shots || videoSrc) ? `<div class="ai-project-media">
        ${coverSrc?`<img src="${coverSrc}" alt="${esc(p.name||'AI 项目')}" class="ai-project-cover ve-resizable" data-ve-media-path="${P}.media.image">`:''}
        ${shots?`<div class="ai-project-shots">${shots}</div>`:''}
        ${videoSrc?`<div class="ai-video"><video controls preload="metadata" playsinline class="pm-video-el ai-project-video ve-resizable" data-ve-media-path="${P}.media.video" data-vurl="${encodeURI(videoSrc)}" data-vname="${esc((p.media.video&&p.media.video.name)||videoSrc.split('/').pop())}" onerror="__veVideoErr(this)" src="${videoSrc}"></video></div>`:''}
      </div>` : '';
    const keywords = tech?`<div class="ai-project-keywords"><span class="label" data-static>Key words</span><div class="ai-project-tech">${tech}</div></div>`:'';
    const hlBlock = hl?`<div class="ai-project-highlights"><span class="label" data-static>Highlights</span><ul>${hl}</ul></div>`:'';
    // 媒体区只装媒体；Key words / Highlights 都是项目主体文字，必须留在文字区里，
    // 否则「上面的文字给图片让位、下面的文字又跑出图片布局」的断层会重现。
    const sideCol = mediaStack ? `<div class="ai-project-side">${mediaStack}</div>` : '';
    return `<article class="ai-project-card" data-ve-kind="ai-project" data-ve-item="${P}">
      <div class="ai-project-head">
        <span class="ai-project-no">${String(i+1).padStart(2,'0')}</span>
        ${LG.before}<h3 data-field="${P}.name" data-single>${esc(p.name||ffZ('未命名 AI 项目'))}</h3>${LG.after}
        ${posTag}
      </div>
      <div class="ai-project-body${hasMedia?' has-media':' no-media'}" style="--ai-pm-w:${pmW}%">
        <div class="ai-project-main">
          ${p.summary?`<p class="ai-project-summary" data-field="${P}.summary" data-single>${esc(p.summary)}</p>`:''}
          ${persona}
          ${keywords}
          ${hlBlock}
          ${links?`<ul class="contact-list ai-project-links">${links}</ul>`:''}
        </div>
        ${sideCol}
      </div>
    </article>`;
  }).join('');
  const aiProjects = buildAiProjects(a.projects, 'aiVoices.projects');
  // 区块标题已由目录项（sectionTitles.aiVoices）承担，正文里不再重复一个标题，避免「AI Project → AI Project → AI Voices」套娃。
  const aiVoicesBody = aiProjects?`<div class="ai-project-list">${aiProjects}</div>`:'';

  // —— 区块定义：标题 + 正文构建器 ——
  const SECTION_DEFS = {
    about:      { title:'About', body:()=>aboutBody },
    experience: { title:'Experience', body:()=>experience },
    works:      { title:'Works', body:()=>works },
    showreel:   { title:'Showreel', body:()=>showreelModule },
    aiVoices:   { title:'AI Project',body:()=>aiVoicesBody },
  };
  // —— 区块顺序：Template(design.sectionOrder) > 旧草稿(data.sections) > 默认 ——
  // AI Project / Showreel 与 About / Experience / Works 是同一级（Section → Project[]），
  // 不存在也不允许「用户新增分类层级」。
  const order = VE_resolveSectionOrder(d, design, SECTION_DEFS);
  // 区块标题优先用用户可直改的 sectionTitles[k]，否则用默认标题
  // 唯一 Section 显示名入口：stable ID 不变；英文只使用用户审核过的名称，否则保留原名。
  const titleOf = k => FF_I18N ? FF_I18N.resolveSectionLabel(d, k) : ((d.sectionTitles && d.sectionTitles[k]) || (SECTION_DEFS[k] && SECTION_DEFS[k].title) || k);
  // —— 区块行：编号 + [Logo前] + 标题 + [Logo后] + 展开 ——
  // Logo 走 sectionLogoPair(k, d)：任何区块（含用户新增 / 重排后）都自动可用。
  const renderDirectory = ord => ord.map((k,i)=>{
    const SL = sectionLogoPair(k, d);
    return `<article class="entry" data-section="${esc(k)}" data-ve-kind="section">
    <div class="entry-btn" data-ve-section-row="${esc(k)}" role="button" tabindex="0"><span class="entry-no">${String(i+1).padStart(2,'0')}</span><span class="entry-title-wrap">${SL.before}<span class="entry-title" data-field="sectionTitles.${esc(k)}" data-single>${esc(titleOf(k))}</span>${SL.after}</span><span class="expand-label"><span class="expand-text">${esc(ffT('public.expand','展开'))}</span><span class="chev" aria-hidden="true"></span></span></div>
    <div class="entry-panel">${SECTION_DEFS[k] ? SECTION_DEFS[k].body() : ''}</div>
  </article>`;
  }).join('');

  // —— hero 主展示区（2026-09-24 可配置）——
  // 用户要求：主展示区「位置就是固定的，包括它的字体大小也是按现在默认的这个来，不用改」。
  // 所以这里**只决定显示哪几项**，顺序永远按 ZONE_HERO_ORDER（眉标→姓名→定位→一句话），
  // 不随配置面板里的勾选先后变化；字号 / 间距全部沿用 .hero 已有样式，一处都没动。
  const HERO_PART = {
    eyebrow: () => VE_isStaticRemoved(design, 'eyebrow-selected-works') ? '' : `<span class="eyebrow" data-ve-item="static:eyebrow-selected-works" data-ve-kind="static" data-static data-static-text="eyebrow-selected-works">${esc(VE_staticText(design, 'eyebrow-selected-works'))}</span>`,
    name: () => d.profile.name ? `<h1 data-field="profile.name" data-single data-ve-kind="heading">${esc(d.profile.name)}</h1>` : '',
    role: () => d.profile.role ? `<p class="role" data-field="profile.role" data-single>${esc(d.profile.role)}</p>` : '',
    intro: () => d.profile.intro ? `<p class="intro" data-field="profile.intro" data-single>${esc(d.profile.intro)}</p>` : ''
  };
  let heroKeys = ZONE_HERO_ORDER.filter(k => (ZONES.hero || []).indexOf(k) >= 0);
  // hero 至少要显示点东西：一项都不剩（理论上 FF_ZONES.resolve 已挡住）就回落到默认 4 项，
  // 免得人名牌位置留下一块空白状的空 hero。
  if (!heroKeys.length) heroKeys = ZONE_HERO_ORDER.slice();
  const heroParts = heroKeys.map(k => HERO_PART[k]()).join('');

  const inStudio = new URLSearchParams(location.search).get('studio') === '1';
  const canPublish = !inStudio && !window.__PUBLIC_VIEWER__ && !document.body.classList.contains('ve-embed');
  // —— Resume：只有创作者上传了文件才显示区块；下载开关受 allowDownload 控制 ——
  const rz=(d.resume)||{}; const rzUrl=rz.url||''; const rzName=rz.name||'Resume';
  const rzExt=(rzName.split('.').pop()||'').toLowerCase();
  const rzIsPdf=rzExt==='pdf';
  const rzIsImg=/^(png|jpe?g|gif|webp|bmp|avif|svg)$/.test(rzExt);
  const rzTypeLabel=rzIsPdf?'PDF':(['doc','docx'].includes(rzExt)?'Word':['ppt','pptx'].includes(rzExt)?'PPT':rzExt?rzExt.toUpperCase():'文件');
  const rzAllow=rz.allowDownload===true;

  // 重建 DOM 期间先关掉指令直通：此刻 postMessage 进来的指令会命中半成品 DOM。
  // 关掉 → 期间到达的指令入队，渲染完由 FFZ_releaseVeQueue() 按序回放。
  FFZ_VE_READY = false;
  root.innerHTML=`<div class="shell">
    <header class="top"><span class="top-brand"><span class="top-brand-name">${esc(d.profile.name)}</span><span class="top-brand-sep">/</span><span class="ff-lockup" title="FolioFold">Folio<em>Fold</em></span></span><span class="top-right">${canPublish?`<button class="publish-open" id="publish-open" title="发布、导出 PDF、公开链接">${esc(ffT('public.publish','发布'))}</button>`:''}<span class="status">${esc(d.profile.role)}</span><span id="ff-public-locale"></span></span></header>
    <section class="hero"><div class="hero-text">${heroParts}</div>${VE_renderPixel(d, design)}</section>
    ${VE_isStaticRemoved(design, 'hero-rule') ? '' : `<div class="hero-rule" data-ve-item="static:hero-rule" data-ve-kind="divider" title="横线（分割线）：元素模式可删除"></div>`}
    ${metaBand}
    <section class="directory">
      ${renderDirectory(order.filter(k => k !== 'about' || aboutBody))}
    </section>
    ${rzUrl?`<section class="resume"><h2>Resume</h2><div class="buttons"><button class="button" id="view-resume-btn" type="button">View Resume</button></div></section>`:''}
    <footer class="footer">${VE_renderFooterBrand(d.profile)}</footer>
    ${rzUrl?`<div class="resume-modal" id="resume-modal" hidden>
      <div class="resume-modal-backdrop" data-resume-close></div>
      <div class="resume-modal-card" id="resume-modal-card" role="dialog" aria-modal="true" aria-label="Resume">
        <div class="resume-modal-head">
          <span class="resume-modal-title">${esc(rzName)}</span>
          <div class="resume-modal-actions">
            ${rzIsPdf?`<div class="resume-mode" role="group" aria-label="查看方式">
              <button type="button" data-resume-mode="width"${ffResumeMode==='width'?' class="active"':''} title="按宽度铺满：字更大更清楚（上下滚动）">适应宽度</button>
              <button type="button" data-resume-mode="page"${ffResumeMode==='page'?' class="active"':''} title="整页看全：一屏看清整页（字会小一些）">整页</button>
            </div>`:''}
            ${rzAllow?`<a class="button resume-download" href="${rzUrl}" download="${esc(rzName)}">下载文件</a>`:`<button class="button resume-download resume-disabled" type="button" disabled>创作者暂未允许下载</button>`}
            <button class="button resume-close" type="button" data-resume-close aria-label="关闭">✕</button>
          </div>
        </div>
        <div class="resume-modal-body" id="resume-modal-body">
          ${rzIsPdf?`<iframe class="resume-frame" src="${FF_resumeSrc(rzUrl)}" title="${esc(rzName)} 预览"></iframe>`
            :rzIsImg?`<img class="resume-image" src="${rzUrl}" alt="${esc(rzName)}">`
            :`<div class="resume-nopreview"><p>此文件类型为 ${esc(rzTypeLabel)}，浏览器无法直接预览。</p><a class="button resume-open-link" href="${rzUrl}" target="_blank" rel="noopener">在新标签页打开 / 下载</a></div>`}
        </div>
      </div>
    </div>`:''}
  </div>`;

  // 分柱落地后，按每块**真实高度**再配平一次（此刻 DOM 已在，offsetHeight 可测）。
  // 两列等宽，搬块不改变块自身高度 → 测量可信、结果稳定。再挂一次 rAF 兜底字体/布局微抖。
  try { FFZ_rebalanceZones(root); } catch (_) {}
  try { requestAnimationFrame(() => { try { FFZ_rebalanceZones(root); } catch (_) {} }); } catch (_) {}

  // 公开页的语言只影响展示层。2026-09-22 起改成**原地重翻**（以前是 location.reload()）：
  // 重载会把滚动位置、展开状态、打开的弹窗全部丢回初始状态，用户描述的就是
  // "点了 English 没反应、要整体刷新一下才变"。现在 i18n.js 的 setLocale 会把当前 DOM
  // 按新语言重算一遍（双向，能切回中文），所以这里不再需要重载整页。
  if (FF_I18N) {
    // 语言控件放在顶栏最右、做成一个小方块下拉 —— 它是个"设置"控件，
    // 以前那种「语言 中文 | English」占了一整块地方，加日韩之后更是要铺一行。
    FF_I18N.mountSwitcher(document.getElementById('ff-public-locale'), { label: 'code' });
    if (FF_I18N.autoTranslate) {
      // ⚠ skip 名单**只列用户内容节点**。以前还多写了 .entry-title-wrap / .directory /
      // .meta-band / .hero-text 这几个容器类，结果把容器里的**界面标签**（区块名、
      // 技能/教育经历这类小节标题、展开/收起）一起跳掉了 —— 英文界面上就夹着中文。
      // 真正的用户内容都带 data-field / data-ve-item，这两个选择器足够保护。
      // content:true → 让画布同时应用"整篇翻译"出来的用户内容译文表。
      // ⚠ 根节点用 document.body 而**不是** #app：底部状态条（#version-bar）是 append 到
      // body 上的、在 #app 之外，用 #app 当根就永远翻不到它 —— 英文模式下「草稿预览 /
      // 文本编辑 / 排版编辑 / 更新」会一直留中文。body 覆盖两者，且 script/style 本来就在
      // SKIP_SEL 里、不会误伤。
      FF_I18N.autoTranslate(document.body, { skip: '[data-field],[data-ve-item]', content: true });
    }
    ffLoadContentDict();
    window.addEventListener('ff-locale-change', ffLoadContentDict);
    window.addEventListener('message', e => {
      const m = e && e.data;
      if (m && (m.type === 'ff-locale' || m.type === 'ff-i18n-updated')) ffLoadContentDict();
    });
  }

  // Resume 弹窗：View Resume 打开（大外框 + 文件按自身比例在框内适配），关闭键 / 背景 / Esc 关闭
  window.__ffResume = rzUrl ? { url: rzUrl, name: rzName } : null;
  if (rzUrl) {
    if (!window.__ffResumeFitBound) {
      window.__ffResumeFitBound = true;
      window.addEventListener('resize', () => {
        const m = document.getElementById('resume-modal');
        if (m && !m.hidden) FF_resumeApplyFit();
      });
    }
  }
  const viewResumeBtn=document.getElementById('view-resume-btn');
  if(viewResumeBtn)viewResumeBtn.onclick=()=>{
    const m=document.getElementById('resume-modal'); if(!m) return;
    m.hidden=false;
    requestAnimationFrame(()=>FF_resumeApplyFit());
  };
  // 下载键：先取到完整数据再存（拿不到就明确报错），见 FF_resumeDownload
  const rzDl=document.querySelector('.resume-download');
  if(rzDl&&rzAllow)rzDl.onclick=(e)=>{
    if(e)e.preventDefault();
    FF_resumeDownload(rzUrl, rzName, rzDl);
  };
  document.querySelectorAll('[data-resume-close]').forEach(el=>el.onclick=()=>{const m=document.getElementById('resume-modal');if(m)m.hidden=true;});
  // 查看方式切换：适应宽度（字大，可滚动）/ 整页（一屏看全）——选择记在 localStorage
  document.querySelectorAll('[data-resume-mode]').forEach(btn=>btn.onclick=()=>{
    ffResumeMode = btn.dataset.resumeMode === 'page' ? 'page' : 'width';
    try{ localStorage.setItem('ffResumeMode', ffResumeMode); }catch(_){}
    document.querySelectorAll('[data-resume-mode]').forEach(b=>b.classList.toggle('active', b.dataset.resumeMode===ffResumeMode));
    FF_resumeApplyFit();
  });
  if(!window.__ffResumeEscBound){
    window.__ffResumeEscBound=true;
    document.addEventListener('keydown',e=>{if(e.key==='Escape'){const m=document.getElementById('resume-modal');if(m&&!m.hidden)m.hidden=true;}});
  }

  // 交互：目录展开 + 展开/收起文案切换
  // setEntryOpen 是唯一入口：工具栏「⌄ 展开」按钮与测试用的 ?expand=1 都走它，
  // 这样在排版编辑画布里可以「点标题=选中/改字、点展开区=展开」两不冲突。
  function setEntryOpen(entry, open){
    if (!entry) return false;
    if (entry.classList.contains('open') === !!open) return false;
    entry.classList.toggle('open', !!open);
    const t = entry.querySelector('.expand-text'); if (t) t.textContent = open ? ffT('public.collapse','收起') : ffT('public.expand','展开');
    if (open) { try { entry.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (_) {} }
    // 展开 / 收起会改变整段正文的行高与自由媒体的落点 → 重新判定「文字让位 / 舒展」。
    try { ffBurstFreeReflow(); } catch (_) {}
    return true;
  }
  // 供父窗口（Visual Editor）直接调用：不能走 .entry-btn.click()，
  // 因为 ve-embed 下那个 handler 只认「点 expand-label」的点击，程序化 click 会被早退拦截 → 展开无效。
  window.__veSetEntryOpen = setEntryOpen;
  document.querySelectorAll('.entry-btn').forEach(b=>{
    b.onclick=(e)=>{
      const entry=b.closest('.entry');
      // 排版编辑画布内（ve-embed）：只有点「展开/收起」文字区域才切换。
      // 其它位置交给元素选择/直接改文字（展开另有工具栏的「⌄ 展开」按钮）。
      if (document.body.classList.contains('ve-embed') && e && e.target && !e.target.closest('.expand-label')) return;
      setEntryOpen(entry, !entry.classList.contains('open'));
    }
  });
  // 项目 details 展开时切换文案
  document.querySelectorAll('.project details').forEach(dt=>{
    const t=dt.querySelector('.expand-text');
    if(t){dt.addEventListener('toggle',()=>t.textContent=dt.open?ffT('public.collapse','收起'):ffT('public.expand','展开'))}
  });
  // Category 折叠展开时切换文案
  document.querySelectorAll('details.works-group').forEach(dt=>{
    const t=dt.querySelector('.expand-text');
    if(t){dt.addEventListener('toggle',()=>t.textContent=dt.open?ffT('public.collapse','收起'):ffT('public.expand','展开'))}
  });
  // 点击复制：**只接管声明了 data-copy 的元素**（Contact 的 value、AI 项目的「复制」）。
  // ⚠ 2026-09-24 修 bug：原来写成 `.contact-value` 无差别 preventDefault —— 而「次展示区 Links」
  //   的 <a class="contact-value link-value"> 自己**没有** data-copy，于是点击被拦下、
  //   跳转失效、复制到的是空字符串（只弹出一个"已复制"的假象，用户以为它只会复制）。
  //   现在：没有 data-copy 的真链接交回浏览器正常跳转。选择器带 [data-copy] 就是这个意思。
  document.querySelectorAll('.contact-value[data-copy]').forEach(btn=>{
    btn.onclick=async e=>{
      e.preventDefault();e.stopPropagation();
      const val=btn.dataset.copy||'';
      try{await navigator.clipboard.writeText(val)}catch(_){/* fallback */}
      const old=btn.textContent;
      btn.textContent=ffT('public.copied','已复制');
      btn.classList.add('copied');
      setTimeout(()=>{btn.textContent=old;btn.classList.remove('copied')},2000);
    };
  });
  // 经历 details 展开时切换文案
  document.querySelectorAll('.experience-item').forEach(dt=>{
    const t=dt.querySelector('.expand-text');
    if(t){dt.addEventListener('toggle',()=>t.textContent=dt.open?ffT('public.collapse','收起'):ffT('public.expand','展开'))}
  });
  // Showreel 章节跳转 + 自动高亮：按「Showreel 项目」各自作用域绑定，
  // 每个项目有自己的视频，章节只控制自己项目的视频，互不串台。
  // ⚠ 用事件委托 + 点击时实时查当前 video：视频若因加载失败被兜底块替换，
  // 旧的 v 引用会断开导致"点了不跳"；实时查能拿到新视频，找不到也不报错。
  document.querySelectorAll('.showreel-project').forEach(scope => {
    const chapters = scope.querySelectorAll('.chapter');
    chapters.forEach(b => b.onclick = () => {
      const v = scope.querySelector('video.pm-video-el');
      // 外部平台来源（B站/腾讯视频等）：章节列表只作记录展示，点击给出明确解释，
      // 而不是"点了没反应"——静默失效是最让人困惑的行为。
      if (scope.querySelector('.showreel-embed') || scope.querySelector('.chapters-inert')) {
        __ffToast && __ffToast('当前视频托管在外部平台，播放器不支持跳转。如需章节跳转请改用直链 MP4。');
        return;
      }
      if (!v || !v.isConnected) {
        __ffToast && __ffToast('视频还没准备好或加载失败，暂时无法跳转到该章节。');
        return;
      }
      try { v.currentTime = +b.dataset.start; v.play(); } catch (_) {}
    });
    const v0 = scope.querySelector('video.pm-video-el');
    if (v0) {
      // 默认音量 50%、倍速 1：观看者仍可用原生控件自行调节。
      // 每次渲染都重设，保证「新加视频 / 切换模板（排版一/二/三）」后也一律 50%（不依赖浏览器默认 1.0）。
      v0.volume = 0.5;
      v0.playbackRate = 1;
      v0.addEventListener('timeupdate', () => {
        scope.querySelectorAll('.chapter').forEach(b => b.classList.toggle('active', v0.currentTime >= +b.dataset.start && v0.currentTime < +b.dataset.end));
      });
    }
  })
  // 所有 .pm-video-el（C 区 Works / E 区 AI Project 等本地视频）统一行为：
  // ① 默认音量 50%、倍速 1（每次渲染重设，覆盖新加视频，不依赖浏览器默认 1.0）；
  // ② 双击全屏播放（VE 画布内交给尺寸模式，不触发全屏）。
  document.querySelectorAll('video.pm-video-el').forEach(v => {
    try { v.volume = 0.5; v.playbackRate = 1; } catch (_) {}
    if (v.__ffDblFs) return;
    v.__ffDblFs = (ev) => {
      if (document.body.classList.contains('ve-embed')) return; // 画布双击=复位尺寸，不抢
      ev.preventDefault();
      try {
        if (v.requestFullscreen) { const p = v.requestFullscreen(); if (p && p.catch) p.catch(()=>{}); }
        else if (v.webkitEnterFullscreen) { v.webkitEnterFullscreen(); }
        if (v.paused) v.play();
      } catch (_) {}
    };
    v.addEventListener('dblclick', v.__ffDblFs);
    // ③ 自由摆放的视频：拿到元数据后用**真实宽高比**修正记录。
    //   转自由摆放那一刻 <video> 还是 300×150 的默认盒子，按它算出的 aspect=2 会把视频拉变形；
    //   loadedmetadata 一到就按 videoWidth/videoHeight 重写并重新摆一次（幂等）。
    if (!v.__ffFixAspect){
      v.__ffFixAspect = () => {
        const id = v.getAttribute && v.getAttribute('data-ve-img');
        if (!id || !v.videoWidth || !v.videoHeight) return;
        const it = (window.__veImages || []).find(i => i && i.id === id);
        if (!it) return;
        const a = v.videoWidth / v.videoHeight;
        if (it.aspect && Math.abs(it.aspect - a) < 0.02) return;
        it.aspect = a;
        try {
          const g = (typeof freeGeomOfEl === 'function') ? freeGeomOfEl(v) : null;
          if (g && typeof applyFreeGeom === 'function') applyFreeGeom(v, it, g.layer);
        } catch (_) {}
        // 画布里改了数据就要落盘；普通作品集页没有父窗口，只调整本次渲染即可。
        if (window.__veApi && window.__veApi.post) window.__veApi.post({ type:'ve-commit-images', images: window.__veImages });
        if (typeof ffScheduleFreeReflow === 'function') ffScheduleFreeReflow();
      };
      v.addEventListener('loadedmetadata', v.__ffFixAspect);
      if (v.readyState >= 1) v.__ffFixAspect();
    }
  });
  /* ===== 自由摆放媒体的「文字让位 / 舒展」——两态简化版（2026-10-01 用户二次需求）=====
   * 用户原话要点：「改成右边如果有图片或者是有视频的话它就收起来，没有图片没有视频的时候
   * 再完全展开，不要再分什么图片在什么位置的话是什么情况。两种状态。」
   *   · 有媒体（图/视频，含自由摆放）→ 文字整体收在左栏（默认两栏），**不再**按媒体位置逐行舒展；
   *   · 没媒体 → 基础布局本来就是满宽（no-media / 单栏），自然舒展，无需额外处理。
   * 因此本函数只做**复位**：清掉历史遗留的 .ff-relax，绝不新增。逐行判定逻辑已移除
   * （v1 实测「有的行铺开、有的行让位」观感不好）。触发时机链路（load / resize / 展开折叠 /
   * 媒体加载）全部保留，未来若要恢复逐行逻辑可直接在此函数内重写。
   */
  function ffFreeMediaReflow(){
    // 排版编辑画布（?ve=1 / body.ve-embed）不参与：拖动过程中文字乱跳会非常难用。
    const isCanvas = document.body.classList.contains('ve-embed')
      || new URLSearchParams(location.search).get('ve') === '1';
    if (isCanvas) return;
    // 幂等复位：媒体被「恢复常规摆放」后必须能退回默认两栏；也清掉旧版本可能留下的舒展态。
    document.querySelectorAll('.ff-relax').forEach(x => { x.classList.remove('ff-relax'); x.style.removeProperty('--ff-grow'); });
  }
  // 暴露给 QA / 父窗口：可手动触发一次让位重算（拖动结束后想立刻看结果时用）。
  window.__ffFreeReflow = ffFreeMediaReflow;
  let _ffFreeReflowT = null;
  function ffScheduleFreeReflow(){
    if (_ffFreeReflowT) clearTimeout(_ffFreeReflowT);
    _ffFreeReflowT = setTimeout(() => { _ffFreeReflowT = null; try { ffFreeMediaReflow(); } catch (_) {} }, 120);
  }
  /* 一次「布局大变」之后按几个时间点补跑几次（展开面板 / 收起面板 / 程序化开合）。
   * 为什么不是单次去抖：区块展开时，面板里的图片视频往往还在陆续加载、滚动是平滑的、
   * 网页字体也可能后到 —— 只跑一次会量到「还没长开的」中间态。多跑几次是幂等的
   * （每轮先整页复位 .ff-relax 再重新判定），不会累积、不会越跑越歪。 */
  function ffBurstFreeReflow(){
    [0, 220, 600, 1100].forEach(d => setTimeout(() => { try { ffFreeMediaReflow(); } catch (_) {} }, d));
  }
  /* ⚠ 2026-10-01 用户实测 bug：宣传页首屏是「折叠的区块」，自动那几轮（load / 150ms / 700ms）
   * 跑的时候所有 rect 都是 0（量不出落点）→ 什么都没有舒展；等用户自己点开区块时，
   * 「展开 / 收起」是切 .entry 的 class（不是 <details>），**一个事件都不触发** →
   * 文字永远停在收起时的窄栏里，用户看到的就是「媒体明明挪走了、右边的字还是没铺开」。
   * 所以两条路都埋上：① setEntryOpen 里主动 burst；② MutationObserver 兜底所有程序化开合
   * （?expand=1 / 打印模式 / 父窗口指令 / 以后新增的入口都走 class 变化）。 */
  let ffEntryObserver = null;
  function ffWatchEntryOpen(){
    if (ffEntryObserver || typeof MutationObserver !== 'function') return;
    ffEntryObserver = new MutationObserver(() => ffBurstFreeReflow());
    document.querySelectorAll('.entry').forEach(en => ffEntryObserver.observe(en, { attributes:true, attributeFilter:['class'] }));
  }

  // —— 版本状态条：让你一眼知道当前看的是草稿还是已发布 ——
  if(!inStudio && new URLSearchParams(location.search).get('print')!=='1' && !window.__PUBLIC_VIEWER__) mountVersionBar(mode, d);
  // 仅在「纯作品集浏览」场景下显示右上角「发布」入口；Studio 外壳 / 排版编辑 / 公开查看器都不显示（避免重复）
  // 测试用：?expand=1 自动展开所有
  if(expandAll){
    document.querySelectorAll('.entry').forEach(en => { if (typeof window.__veSetEntryOpen === 'function') window.__veSetEntryOpen(en, true); else en.classList.add('open'); });
    document.querySelectorAll('details.project,details.experience-item').forEach(d=>d.open=true);
  }
  // 测试用：?scrollY=N 把页面滚到 N 像素
  const y=parseInt(new URLSearchParams(location.search).get('scrollY')||'0',10);
  if(y>0)window.scrollTo(0,y);

  // —— 应用已保存的「间距 / 图片尺寸 / 文本样式」到真实作品集（草稿与已发布都生效）——
  // 视觉编辑器(?ve=1)里拖动间距/图片、或在右侧工具箱调字号颜色后，数值写进 design.json；
  // 这里在普通首页读取并应用，这样在画布里调好、保存、返回作品集，页面就真的变成调整后的样子。
  try {
    window.__veSpacing = Object.assign({}, (design && design.spacing) || {});
    window.__veImgSizes = Object.assign({}, (design && design.imgSizes) || {});
    window.__veMediaLayout = Object.assign({}, (design && design.mediaLayout) || {});
    window.__veImgPos = Object.assign({}, (design && design.imgPos) || {});
    window.__veTextStyles = Object.assign({}, (design && design.textStyles) || {});
    window.__veInlineStyles = Object.assign({}, (design && design.inlineStyles) || {});
    window.__veImages = Array.isArray(design && design.images) ? design.images.slice() : [];
    VE_applySpacingToDom(window.__veSpacing);
    VE_applyImgSizesToDom(window.__veImgSizes);
    VE_applyMediaLayoutToDom(window.__veMediaLayout);
    VE_applyImgPosToDom(window.__veImgPos);
    VE_applyTextStyles(window.__veTextStyles);
    VE_applyInlineHtml();
    VE_renderFreeLayer(false);
  } catch (err) { console.warn('[FolioFold] apply design spacing/imgSizes/textStyles failed', err); }

  // —— Visual Editor 嵌入模式 ?ve=1 ——
  // 当父窗口（/visual-editor/）用 iframe 嵌入本页时启用：把首页改成「可直接编辑的画布」。
  //   - 隐藏底部版本条（VE 父窗口已经有自己的状态条）
  //   - 隐藏顶部「编辑器 / 发布」按钮（VE 父窗口已经有了，避免重复）
  //   - 给每个 .entry 区块右上角加一个「编辑」按钮，点击通过 postMessage 通知父窗口打开对应的编辑面板
  //   - 通知父窗口「我已渲染好了」，父窗口收到后可以更新 sections / theme 等 UI
  // 这样用户在 Visual Editor 里看到的就是 100% 真实的 Portfolio，而不是 GrapesJS 的抽象画布。
  const isEditor = new URLSearchParams(location.search).get('ve') === '1';
  if (isEditor) {
    document.body.classList.add('ve-embed');
    // 通知父窗口准备就绪
    const sendReady = () => { try { window.parent.postMessage({ type: 've-ready', order, theme: d.theme, sections: SECTION_DEFS }, '*'); } catch (_) {} };
    if (document.readyState === 'complete') sendReady(); else window.addEventListener('load', sendReady);

    // 给每个 entry 注入编辑按钮（点 entry 标题也能触发编辑）
    document.querySelectorAll('.entry').forEach(en => {
      const k = en.getAttribute('data-section');
      if (!k) return;
      en.classList.add('ve-section');
      // 编辑按钮
      const btn = document.createElement('button');
      btn.className = 've-edit-btn';
      btn.type = 'button';
      btn.title = '在右侧编辑器中修改';
      btn.textContent = '✎ 编辑';
      btn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); try { window.parent.postMessage({ type: 've-edit-section', section: k }, '*'); } catch (_) {} };
      en.appendChild(btn);
      // 点击标题也触发编辑（不影响展开/收起按钮）
      en.querySelector('.entry-btn').addEventListener('dblclick', () => { try { window.parent.postMessage({ type: 've-edit-section', section: k }, '*'); } catch (_) {} });
    });

    // —— VE 直接编辑层（WYSIWYG：点字直改 / 拖间距 / 拉图片）——
    try {
      window.__veSpacing = Object.assign({}, (design && design.spacing) || {});
      window.__veImgSizes = Object.assign({}, (design && design.imgSizes) || {});
      window.__veMediaLayout = Object.assign({}, (design && design.mediaLayout) || {});
      window.__veImgPos = Object.assign({}, (design && design.imgPos) || {});
      window.__veInlineStyles = Object.assign({}, (design && design.inlineStyles) || {});
      window.__veImages = Array.isArray(design && design.images) ? design.images.slice() : [];
      window.__veDirect = initVEDirect();
      // URL ?ve-mode=text|space|image|addimg 可直接进入指定模式
      const wantMode = new URLSearchParams(location.search).get('ve-mode');
      if (wantMode && ['select','text','space','image','addimg','browse'].includes(wantMode)) window.__veDirect.setMode(wantMode);
      else window.__veDirect.setMode('select');   // 默认进入「元素」模式：点哪改哪
      VE_applyInlineHtml();
    } catch (err) { console.warn('[VE] direct init failed', err); }
  }

  // —— 自由摆放媒体的文字让位 / 舒展：只在真实作品集页做（画布里保持默认两栏）——
  if (!isEditor){
    try { ffFreeMediaReflow(); } catch (_) {}
    setTimeout(ffScheduleFreeReflow, 150);
    setTimeout(ffScheduleFreeReflow, 700);
  }
  // 折叠 / 展开（<details> 的 toggle 不冒泡，用捕获）、图片视频加载完、窗口宽度变化
  // 都会改变行高与落点 → 重新判定让位。
  try {
    window.addEventListener('load', ffScheduleFreeReflow);
    window.addEventListener('resize', ffScheduleFreeReflow);
    document.addEventListener('toggle', ffScheduleFreeReflow, true);
    document.addEventListener('load', ffScheduleFreeReflow, true);
    document.addEventListener('loadedmetadata', ffScheduleFreeReflow, true);
  } catch (_) {}
  // 区块「展开 / 收起」不在上面任何一个事件里（见 ffWatchEntryOpen 注释）→ 单独兜底监听。
  try { ffWatchEntryOpen(); } catch (_) {}

  // —— Pixel 运行时（hover/click 随机动作 + 沿轨迹走动）——
  // 真实作品集：完整走动+hover；VE 画布：只做 hover 随机动作，避免与拖拽冲突。
  try {
    const veCanvas = new URLSearchParams(location.search).get('ve') === '1';
    VE_pixelRuntime(d, design, { wander: !veCanvas, hover: true });
  } catch (_) {}
  // —— 形象在窄屏的尺寸/位置：按正文实际占几行来收，绝不压住文字。
  //    桌面宽度下本函数什么都不做（桌面尺寸是用户自己在右侧面板调的）。——
  try { VE_layoutHeroPixel(); } catch (_) {}
  try {
    let _pixT = null;
    window.addEventListener('resize', () => {
      clearTimeout(_pixT);
      _pixT = setTimeout(() => {
        try { VE_layoutHeroPixel(); } catch (_) {}
        // 自由摆放的图按新宽度重算 —— 只在排版编辑画布里做（普通作品集页不要动它，
        // 那边的自由图由 ve-runtime-fix.js 自己那套负责）。
        if (new URLSearchParams(location.search).get('ve') === '1') { try { VE_relayoutFree(); } catch (_) {} }
      }, 120);
    });
  } catch (_) {}

  // —— 监听来自父窗口（Visual Editor）的指令 ——
  // 指令通道已在**模块加载时**注册一次（见文件顶部 FFZ_applyVeMessage）。
  // 这里只做两件事：① 标记 DOM 已就绪；② 回放"画布还没渲染完就发过来"的指令。
  // （旧写法在这里 addEventListener，导致早到的指令被丢 + 每次 render 多挂一个监听器。）
  try { FFZ_releaseVeQueue(); } catch (_) {}

  // —— PDF 导出：?print=1 隐藏编辑/发布按钮，加载完成后触发浏览器打印 ——
  if(new URLSearchParams(location.search).get('print')==='1'){
    document.body.classList.add('print-mode');
    document.querySelectorAll('.top-actions').forEach(el=>el.style.display='none');
    // 打印前展开所有目录 + 项目，确保内容完整输出
    document.querySelectorAll('.entry').forEach(en=>en.classList.add('open'));
    document.querySelectorAll('details.project,details.experience-item,details.works-group').forEach(dt=>dt.open=true);
    // 文件名：FolioFold-YYYYMMDD.pdf
    const dt=new Date();
    const ymd=''+dt.getFullYear()+String(dt.getMonth()+1).padStart(2,'0')+String(dt.getDate()).padStart(2,'0');
    document.title='FolioFold-'+ymd;
    // 可见但打印时不出现的引导横幅：明确告诉用户这是 PDF 导出、选「另存为 PDF」
    const banner=document.createElement('div');
    banner.id='pdf-banner';
    banner.innerHTML='正在生成 PDF —— 在弹出的打印窗口里，把「目标 / 打印机」改成 <b>「另存为 PDF」</b>，'
      + '文件名已自动设为 <b>FolioFold-'+ymd+'.pdf</b>。';
    document.body.insertBefore(banner, document.body.firstChild);
    const done=()=>{ window.__vePdfDone=true; clearTimeout(window.__vePdfFallback);
      banner.innerHTML='✅ PDF 已在打印窗口生成（请选择「另存为 PDF」保存）。可关闭此页。'; try{setTimeout(()=>window.close(),1500);}catch(_){} };
    window.addEventListener('afterprint', done);
    // ⚠️ 这里必须兼容「load 已经触发过」的情况：
    // main() 里有 await fetch()，等执行到本行时文档往往早已 complete，
    // 此时 addEventListener('load') 注册的监听器永远不会被调用 ——
    // 用户看到的就是「点了生成 PDF 完全没反应」。所以先判断 readyState。
    const firePrint = () => setTimeout(() => {
      try { window.print(); } catch (e) { banner.textContent = '打印失败：' + e.message; }
    }, 350);
    if (document.readyState === 'complete') firePrint();
    else window.addEventListener('load', firePrint);
    // 兜底：极少数情况下 load 在竞态窗口内错过，再补一次
    window.__vePdfFallback = setTimeout(() => {
      if (!window.__vePdfDone) { try { window.print(); } catch (_) {} }
    }, 2500);
  }

  // 右上角「发布」入口 → 打开发布面板（仅在纯作品集浏览场景下）
  if(canPublish){
    const pb=document.getElementById('publish-open');
    if(pb) pb.onclick=()=>openPublishPanel(d);
  }
}

// 测试/调试钩子：暴露模块级函数，便于自动化测试（CDP 注入 evaluate 只能访问全局作用域，
// 而本文件是 ES module，函数默认不在 window 上）与控制台调试。与已暴露的
// window.__veDirect / window.__veSetEntryOpen / window.__veWireFree 同思路。
window.__veDebug = {
  freeContainerFor, freeContainerEl, freeAnchorFromClientPoint, VE_renderFreeLayer,
  // 外部视频来源判定：纯函数，方便在控制台/自动化里逐个 URL 验证归类是否正确。
  SHOWREEL_platformOf, SHOWREEL_resolveSource, SHOWREEL_biliEmbed,
};

main().catch(e=>document.querySelector('#app').textContent=e.message);
