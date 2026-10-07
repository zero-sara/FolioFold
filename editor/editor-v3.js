const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)],esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
const I18N=(typeof window==='object'&&window.FF_I18N)?window.FF_I18N:null;
const ui=(key,fallback)=>I18N?I18N.t(key,fallback):fallback;
// 中文当 key 的字典层（i18n.js 的 z / autoTranslate）。界面上七百多条文案逐点包一遍
// 既海量又必漏，改成「中文原文就是 key」+ 观察器自动翻每次重画出来的新文案。
const z=(s)=>I18N?I18N.z(s):s;
let data,view='资料',selected=0,selectedShowreel=0,undo=[],dirty=false,autosaveTimer=null;
// —— IME / 输入保护（2026-10-03 加固）——
// 病状：拼音打一半、候选词还没选，文字就被"拍"进输入框，同时明显卡顿一下。
// 根因链（两条都会重建/夺走输入框，IME 一旦失焦就强制上屏）：
//   ① 合成期间 render() 重建 DOM → textarea 被销毁 → 拼音以字符串形式上屏；
//   ② 合成期间自动保存 → 外壳 Studio 收到 studio-saved → 重载另外两个 iframe →
//      每个 iframe load 都会 applyStudioLocale() → 给编辑器推 ff-locale → 编辑器 render()。
// 所以这里加三道闸：合成中不重渲染 / 输入框聚焦时不重渲染 / 合成中不写数据也不保存。
let _ffComposing=false,_ffPendingRender=false,_videoPre=null;
// 正在被编辑的元素（input / textarea / select / contenteditable）持有焦点时，绝不重建 DOM：
// 重建＝销毁正在打字的框。结构性操作（点按钮）不会触发这条，照常重画。
document.addEventListener('compositionstart',()=>{_ffComposing=true;});
document.addEventListener('compositionend',(ev)=>{
  _ffComposing=false;
  // 合成结束这一刻才把最终文字写进数据（合成中写入会把拼音字母存进去）
  const el=ev&&ev.target;
  if(el&&el.dataset&&el.dataset.key){try{push('k:'+el.dataset.key);set(el.dataset.key,el.value)}catch(_){}}
  if(_ffSaveAfterCompose){_ffSaveAfterCompose=false;scheduleAutosave();}
  if(_ffPendingRender){_ffPendingRender=false;render();}
});
// 兜底：编辑器文档内若未来出现 <form>，任意未声明 type 的按钮都不应触发表单提交导致整页刷新（曾引发闪烁/输入丢失）
document.addEventListener('submit',e=>e.preventDefault());
// 主题预设：从 themes.js 加载
const {THEMES, THEME_PRESETS, resolveTheme, applyTheme} = (typeof window==='object'&&window.THEMES)?window:{THEMES:{},THEME_PRESETS:[],resolveTheme:d=>({ink:'#161616',paper:'#f1eee7',soft:'#ede9df',line:'#cac5ba',accent:'#e64e2e',muted:'#77736b',dark:'#20201e',heroEyebrow:'#e64e2e'}),applyTheme:t=>{}};
// 多模板：所有请求都必须带上当前模板，否则读写的永远是模板一 —— 这是 2026-09-19
// 数据丢失事故的根因之一（在模板二里打开编辑器，读到的却是模板一，保存也写回模板一）。
const TPL_ID=new URLSearchParams(location.search).get('tpl')||'main';
const withTpl=u=>u+((u.indexOf('?')>=0)?'&':'?')+'tpl='+encodeURIComponent(TPL_ID);
const api=(url,o={})=>fetch(withTpl(url),{cache:'no-store',...o}).then(async r=>{const j=await r.json();if(!r.ok)throw Error(j.error||'请求失败');return j});
// —— 统一工作台（Studio）协作：根路径是工作台外壳，作品集在 /portfolio/ ——
// 被外壳嵌着（?studio=1）时，"排版编辑 / 预览作品集"由外壳切标签页；每次保存后通知外壳，
// 好让另外两个面板刷新到同一份最新草稿（三端内容永远一致）。
const IN_STUDIO=new URLSearchParams(location.search).get('studio')==='1';
if(I18N)window.addEventListener('ff-locale-change',()=>{if(data)render()});
function gotoPanel(tab,fallback){if(IN_STUDIO){try{window.parent.postMessage({type:'studio-switch',tab},'*');return}catch(_){}}location.href=fallback}
function notifyStudio(){try{if(window.parent!==window)window.parent.postMessage({type:'studio-saved'},'*')}catch(_){}}
const clone=x=>JSON.parse(JSON.stringify(x)); const stamp=n=>{n=Number(n||0);return `${String(n/3600|0).padStart(2,'0')}:${String((n/60|0)%60).padStart(2,'0')}:${String(n%60|0).padStart(2,'0')}.${String(Math.round(n%1*1000)).padStart(3,'0')}`};
const second=t=>{const p=String(t||'0').split(':').map(Number);return p.length===3?p[0]*3600+p[1]*60+p[2]:p[0]*60+(p[1]||0)};
// —— 撤回栈（2026-09-28 新增「撤回」按钮）——
// 最多保留 15 步。mergeKey 用来把「同一个输入框里的连续打字」合并成一步：
// 否则每敲一个字符就吃掉一步，15 步几秒就用完、撤回一次只退一个字 —— 等于没有撤回。
// 结构性操作（删除 / 新增 / 上移 / 应用 AI 结果等）不传 mergeKey，一律单独占一步。
const UNDO_LIMIT=15;
let undoMergeKey=null,undoMergeAt=0;
const push=(mergeKey)=>{
  const now=Date.now();
  if(mergeKey){
    if(mergeKey===undoMergeKey&&now-undoMergeAt<1500){undoMergeAt=now;dirty=true;updateDirty();scheduleAutosave();return}
    undoMergeKey=mergeKey;undoMergeAt=now;
  }else{undoMergeKey=null;undoMergeAt=0}
  undo.push(clone(data));
  if(undo.length>UNDO_LIMIT)undo.shift();
  dirty=true;updateDirty();scheduleAutosave();
};
// 从服务端重新载入 data 的场合（恢复上一版 / 抢救恢复 / 翻译生成应用等）：
// 内存里的撤回栈已经对不上了，必须清空 —— 否则一点撤回会把用户刚恢复的内容又抹掉。
const resetUndo=()=>{undo.length=0;undoMergeKey=null;undoMergeAt=0;updateUndoBtn()};
const toast=t=>{const e=$('.toast');e.textContent=z(t);e.classList.add('show');setTimeout(()=>e.classList.remove('show'),2200)};
// —— 未保存状态 / 自动保存 / 同步 ——
function updateUndoBtn(){const b=document.getElementById('undo');if(!b)return;const n=undo.length;const label=z(b.dataset.label||'撤回');b.disabled=!n;b.textContent=n?(label+' ('+n+')'):label;b.title=n?(label+'：撤回上一步编辑，还能撤回 '+n+' 步（最多保留 '+UNDO_LIMIT+' 步）'):(label+'：没有可撤回的操作');}
function updateDirty(){const f=document.getElementById('save-flag');if(f)f.textContent=dirty?'● 未保存':'已同步';updateUndoBtn();}
const saveNow=async(silent)=>{try{await api('/api/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});dirty=false;updateDirty();notifyStudio();if(!silent)toast('已保存并同步到作品集');}catch(e){toast('保存失败：'+e.message);}};
function scheduleAutosave(){
  // 合成中不保存：① 拼音字母不该进草稿；② 保存会触发外壳重载另外两个面板造成卡顿。
  if(_ffComposing){_ffSaveAfterCompose=true;return}
  if(autosaveTimer)clearTimeout(autosaveTimer);autosaveTimer=setTimeout(()=>saveNow(true),1500);}
let _ffSaveAfterCompose=false;
// —— 撤回一步：把内存里上一份快照调回来，**并立即同步到作品集** ——
// 为什么撤回必须自带保存：编辑器有 1.5 秒自动保存，误删往往已经落盘了；
// 只改内存不保存的话，一刷新（或切到别的面板）又回到误删状态，看起来像"撤回没生效"。
const undoStep=async()=>{
  if(!undo.length){toast('没有可撤回的操作了');return}
  data=undo.pop();
  undoMergeKey=null;undoMergeAt=0;
  // 索引保护：撤回「新建项目 / 新建 Showreel 项目」之后数组会变短，selected 可能越界
  const pn=(data.projects||[]).length; if(selected>pn-1)selected=Math.max(0,pn-1);
  const sn=((data.showreel&&data.showreel.projects)||[]).length; if(selectedShowreel>sn-1)selectedShowreel=Math.max(0,sn-1);
  render();
  dirty=true;updateDirty();
  await saveNow(true);
  toast('已撤回一步（还可撤回 '+undo.length+' 步）');
};
window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
// —— 「不跟随语言」标记（2026-09-22）——
// 用户诉求原话：「我其实希望有一部分内容，如果本身就是英文专有名词，或者某种语言的专有名词，
// 那在语言改变的时候它不切换本身语言……以设置的方式来确定哪一些进行语言同步、哪一些不同步。」
// 落法：content.localePins[数据路径] = 1。服务端整篇翻译时按同一套路径把这一条**排除在收集之外**
// （见 server.py 的 collect_translatable），所以画布上天然不会翻它，不需要在渲染层到处判断开关。
function dataPath(key){
  const a=String(key||'').split('.');
  if(a[0]==='project'){a[0]='projects';a.splice(1,0,String(selected));}
  else if(a[0]==='chapter'){a[0]='showreel';a.splice(1,0,'projects');a.splice(2,0,String(selectedShowreel));a.splice(3,0,'chapters');}
  else if(a[0]==='ai'){a[0]='aiVoices';}
  else if(a[0]==='category'){a[0]='projectGroups';}
  return a.join('.');
}
const pinMap=()=>(data&&data.localePins)||{};
const isPinned=key=>!!pinMap()[dataPath(key)];
function togglePin(key){
  if(!data)return;
  const path=dataPath(key);
  const pins=Object.assign({},data.localePins||{});
  if(pins[path])delete pins[path];else pins[path]=1;
  push();                      // 进撤销栈 + 标脏 + 触发自动保存
  data.localePins=pins;
  render();
  toast(pins[path]?'此板块已设置为不跟随语言设置切换':'此板块已恢复跟随语言设置');
}
// 板块/字段名的可点击开关：常态是普通标签；点了之后变斜体 + ⊘（样式见 editor-v3.css 的 .pin-toggle）。
function pinLabel(label,key){
  if(!key)return esc(label);
  const on=isPinned(key);
  return `<button type="button" class="pin-toggle${on?' pinned':''}" data-pin="${esc(key)}" aria-pressed="${on}" title="${esc(on?'已设置为不跟随语言；再点一次恢复跟随':'点击设为「不跟随语言」（作品集切语言时这一板保持原样）')}">${esc(label)}</button>`;
}
// ⚠ 从 <label class="field"> 换成 <div class="field"><span class="field-label">：
// 名称本身是个可点的 <button>，塞在 <label> 里会被 label 的默认行为抢走点击。
const field=(label,key,value,area=false)=>`<div class="field"><span class="field-label">${pinLabel(label,key)}</span>${area?`<textarea data-key="${esc(key)}">${esc(value)}</textarea>`:`<input data-key="${esc(key)}" value="${esc(value)}">`}</div>`;
const lines=v=>(v||[]).join('\n');
// ⚠ 2026-09-25：原来是 .map(x=>x.trim())，会把每一行**首尾**的空格一起吃掉 —— 用户为了对齐
//   特意敲的空格一保存就没了（画布那边已经改成 white-space:pre-wrap 原样显示，存的时候再吃掉
//   等于白改）。现在只丢「整行都是空白」的空行，行首 / 行内 / 行尾的空格一律原样保留。
const split=v=>String(v==null?'':v).split('\n').map(x=>x.replace(/[\r\t]+$/,'')).filter(x=>x.trim()!=='');
const mediaUrl=m=>m&&m.url||'';
// Translation writes only localizedContent.en through dedicated endpoints. Chinese source is never posted from this UI.
const TRANSLATION_UNAVAILABLE='尚未配置翻译服务';
function summaryLocalization(entity,kind){
  const fallback={sourceHash:'',sourceLanguage:'zh-CN',targetLanguage:'en',status:'unconfigured',draft:'',reviewed:'',error:TRANSLATION_UNAVAILABLE};
  const key=entity&&entity.localeKey;
  const all=data&&data.localizedContent&&data.localizedContent.en&&data.localizedContent.en[kind];
  const entry=key&&all&&all[key]&&all[key].summary;
  return entry&&typeof entry==='object'?{...fallback,...entry}:fallback;
}
function translationDraftPanel(entity,kind){
  const record=summaryLocalization(entity,kind);
  // 记录状态是服务端数据，不改。但如果翻译服务其实已就绪、只是这一条还没生成，
  // 就不能显示「尚未配置翻译服务」——那是不实信息，用户明确不接受假状态。
  const notGenerated=record.status==='unconfigured'&&translationReady&&!record.draft&&!record.reviewed;
  const status=notGenerated?ui('translation.notGenerated','尚未生成英文 Draft'):({unconfigured:ui('translation.unconfigured','尚未配置翻译服务'),draft:ui('translation.draft','英文草稿待审核'),reviewed:ui('translation.reviewed','英文内容已审核'),stale:ui('translation.stale','原文已更新，英文 Draft 待复核'),failed:ui('translation.failed','翻译请求失败')}[record.status]||record.status);
  const preview=record.draft||record.reviewed||ui('translation.empty','尚未生成英文 Draft。');
  const note=record.status==='stale'?'原始中文已更新；保留旧英文内容仅供审核参考。':(notGenerated?ui('translation.readyHint','翻译服务已就绪；点「生成英文 Draft」开始。'):(record.error||TRANSLATION_UNAVAILABLE));
  const key=entity&&entity.localeKey||'';
  const canApply=record.status==='draft'&&!!record.draft;
  return `<section class="translation-draft" aria-label="${esc(ui('translation.title','英文翻译 Draft'))}"><h4>${esc(ui('translation.title','英文翻译 Draft'))}</h4><p class="translation-source">${esc(ui('translation.flow','当前语言：中文原文 → English Draft'))}</p><p class="translation-status">${esc(status)}</p><textarea readonly aria-label="English Draft preview">${esc(preview)}</textarea><p class="hint translation-note">${esc(note)}</p><div class="translation-actions"><button class="button translation-generate" type="button" data-translation-generate data-translation-kind="${esc(kind)}" data-translation-key="${esc(key)}">${esc(record.draft?ui('translation.regenerate','重新翻译'):ui('translation.generate','生成英文 Draft'))}</button><button class="button primary translation-apply" type="button" data-translation-apply data-translation-kind="${esc(kind)}" data-translation-key="${esc(key)}" ${canApply?'':'disabled'}>${esc(ui('translation.apply','应用 / 审核英文内容'))}</button><button class="button translation-cancel" type="button" data-translation-cancel data-translation-kind="${esc(kind)}" data-translation-key="${esc(key)}" ${record.draft?'':'disabled'}>${esc(ui('translation.cancel','取消'))}</button></div></section>`;
}
// Logo 点缀图：数据形如 project.logo = { url, pos:'before'|'after' }。
// 兼容两种写法：纯字符串，或上传接口返回的引用对象 {url,name,...}。
const logoUrl=p=>{const lg=p&&p.logo;return typeof lg==='string'?lg:((lg&&(lg.url||lg.src))||'')};
const LOGO_MAX_BYTES=2*1024*1024;
// Logo 点缀图控件：上传 ≤2MB + 「名称前 / 名称后」位置选择 + 删除。
// 位置存在同一条记录里（logo.pos），作品集与排版编辑共用，所见即所得。
function logoCard(p,i){
  const u=logoUrl(p);
  const before=!!(p&&p.logo&&p.logo.pos==='before');
  return `<div class="logo-card"><label>Logo 点缀图（≤2MB） <input class="ai-project-logo" data-i="${i}" type="file" accept="image/*"></label>`
    +(u?`<div class="thumb-row"><img class="thumb" src="${esc(u)}"><select class="ai-project-logo-pos" data-i="${i}"><option value="before"${before?' selected':''}>名称前</option><option value="after"${before?'':' selected'}>名称后</option></select><button class="button remove-ai-logo" data-i="${i}">删除 Logo</button></div>`:'')
    +`<p class="hint-inline">显示在项目名称旁边，高度自动贴合标题，不会撑大卡片或改变间距。</p></div>`;
}
// —— 区块级 Logo 控件（2026-09-19）——
// 与项目级完全同一套交互（上传 ≤2MB / 名称前·后 / 删除），只有两点不同：
//   · 图片是宽大于高的"点缀"（用户明说"可视化"），所以提示文案说明会等比缩放、不撑高标题行。
//   · 数据写在 data.sectionLogos[key]，key 就是区块 id，因此新增/重排区块自动可用。
function sectionLogoCard(key,label){
  const lg=(data.sectionLogos||{})[key];
  const u=logoUrl({logo:lg});
  const before=!!(lg&&lg.pos==='before');
  return `<div class="logo-card section-logo-card"><label>区块 Logo 点缀图（≤2MB） <input class="section-logo-file" data-key="${esc(key)}" type="file" accept="image/*"></label>`
    +(u?`<div class="thumb-row"><img class="thumb" src="${esc(u)}"><select class="section-logo-pos" data-key="${esc(key)}"><option value="before"${before?' selected':''}>标题前</option><option value="after"${before?'':' selected'}>标题后</option></select><button class="button remove-section-logo" data-key="${esc(key)}">删除区块 Logo</button></div>`:'')
    +`<p class="hint-inline">显示在「${esc(label)}」这个区块的标题旁边（编号右侧）。图片按自身比例缩放并锁在标题行高度内，任何模板 / 任何区块顺序都自动生效。</p></div>`;
}
// 区块 Logo 数据是否为空（用于"没图就不显示控件预览"）
const sectionLogosEmpty=()=>!data.sectionLogos||!Object.keys(data.sectionLogos).some(k=>logoUrl({logo:data.sectionLogos[k]}));

async function upload(file,kind){
  if(!file)return null;
  const f=new FormData();f.append('file',file);f.append('kind',kind);
  const j=await api('/api/upload',{method:'POST',body:f});
  // warn / probe 是服务端的安全提示，不是作品集数据，绝不能跟着 ref 写进 portfolio.json。
  // 只留在内存里给压缩卡片用，引用本身保持干净。
  const {warn,probe,ok,...ref}=j||{};
  compressLastWarn = warn ? {url:(ref&&ref.url)||'', text:warn} : {url:'', text:''};
  return ref;
}
const SECTION_DEFAULTS={about:'About',experience:'Experience',works:'Works',showreel:'Showreel',aiVoices:'AI Project'};
const DEFAULT_SECTIONS=['about','experience','works','showreel','aiVoices'];
// 唯一的显示名称解析：stable ID 不变，英文只读取用户审核过的 sectionTitleTranslations.en。
function sectionLabel(key){return I18N?I18N.resolveSectionLabel(data,key):((data&&data.sectionTitles&&data.sectionTitles[key])||SECTION_DEFAULTS[key]||key)}
const VIEW_I18N={资料:'section.profile',分类:'section.categories',经历:'section.experience',项目:'section.projects',设置:'section.settings','页面结构':'section.structure'};
function viewLabel(key){return VIEW_I18N[key]?ui(VIEW_I18N[key],key):key}
// 区块顺序属于 Template（design.json），不属于 Content（portfolio.json）。
// 这里读写的目标是 design.json：文本编辑只负责页面里的文字内容，顺序跟着模板走。
let tplSectionOrder=null;
// 主题属于 Template（design.json），不属于 Content（portfolio.json）。
// 这里单独存一份 design.theme，作为「当前主题」的唯一事实源（与排版编辑 visual-editor.js 一致）。
let designTheme=null;
async function loadTplSectionOrder(){try{const dsn=await api('/api/design');if(dsn&&Array.isArray(dsn.sectionOrder)&&dsn.sectionOrder.length)tplSectionOrder=dsn.sectionOrder.slice()}catch(_){}}
// 翻译服务是否真的就绪。面板原先只看记录里存的 status，于是「服务已就绪、只是这条还没生成」
// 会被显示成「尚未配置翻译服务」——那是不实信息。这里向服务端问一次真实状态，
// 只用于决定文案，不回写任何数据（记录里的 status 仍是服务端唯一事实源）。
let translationReady=false;
// ★ 2026-09-22：这个探测**绝不能**拖住面板首屏 —— boot() 里是 await 它的，
// 服务端探 Ollama 有 3s 超时；一旦用户把地址填成 http://localhost:11434（IPv6 ::1 先解析、
// Ollama 只听 IPv4），实测这一跳要 2.1s 才失败，整个编辑器就白屏 2.4s，
// 看着像「排版编辑坏了」。所以这里加个 1s 上限：超时就按「没就绪」处理（照原文显示，
// 不造假），后台那次请求继续跑完也不影响已经渲染出来的界面。
async function loadTranslationStatus(){
  const probe=api('/api/translation/status').then(s=>!!(s&&s.state==='ready')).catch(()=>false);
  const guard=new Promise(r=>setTimeout(()=>r(false),1000));
  translationReady=await Promise.race([probe,guard]);
}
async function saveTplSectionOrder(arr){tplSectionOrder=arr.slice();try{await api('/api/design/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sectionOrder:arr})});notifyStudio()}catch(e){toast('区块顺序保存失败：'+e.message)}}

// 静态元素的可编辑文案（如 Hero 眉标 "Selected works"）：没有 content 数据 backing，
// 所以归 Template，存 design.staticText[id]。这里是文本编辑器侧的读写入口。
const STATIC_TEXT_DEFAULTS={'eyebrow-selected-works':'Selected works'};
let staticText={};
// —— 展示区（Display Zones）—— design.displayZones 的本地镜像。
// ⚠ 存的一份是**原始值**（可能为 null = 还没配置过），渲染时才过 FF_ZONES.resolve 归一。
//   原因：'没配置过'与'用户主动清空次展示区'是两回事，一旦在 load 阶段就归一成默认，
//   用户把次展示区全部取消勾选后一刷新，勾选状态又会自己弹回来（像是"保存没生效"）。
let displayZones=null;
// ⚠ 2026-09-22：这个探测**绝不能**拖住面板首屏 —— boot() 里是 await 它的，
// 服务端探 Ollama 有 3s 超时；一旦用户把地址填成 http://localhost:11434（IPv6 ::1 先解析、
// Ollama 只听 IPv4），实测这一跳要 2.1s 才失败，整个编辑器就白屏 2.4s，
// 看着像「排版编辑坏了」。所以这里加个 1s 上限：超时就按「没就绪」处理（照原文显示，
// 不造假），后台那次请求继续跑完也不影响已经渲染出来的界面。
async function loadStaticText(){try{const d=await api('/api/design');staticText=(d&&d.staticText)||{};designTheme=(d&&d.theme&&d.theme.preset)?d.theme:null;displayZones=(d&&d.displayZones)||null;}catch(_){staticText={};designTheme=null;displayZones=null}}
// 当前生效主题：design.theme 优先（模板级），回落到 content.theme（旧数据兼容），再回落默认 light-01。
function currentTheme(){const t=(designTheme&&designTheme.preset)?designTheme:((data&&data.theme&&data.theme.preset)?data.theme:{mode:'light',preset:'light-01'});return t;}
// 主题写回 design.json（与排版编辑一致），保存后通知工作台让另外两个面板刷新。
async function saveDesignTheme(){try{await api('/api/design/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({theme:designTheme})});}catch(e){toast('主题保存失败：'+e.message)}}
async function saveStaticText(id,value){
  const next=Object.assign({},staticText);
  if(value&&value.trim())next[id]=value.trim();else delete next[id];
  staticText=next;
  try{await api('/api/design/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({staticText:next})});notifyStudio()}catch(e){toast('眉标文字保存失败：'+e.message)}
}
function currentSections(){
  if(Array.isArray(tplSectionOrder)&&tplSectionOrder.length)return tplSectionOrder.slice();
  return (data&&Array.isArray(data.sections)&&data.sections.length)?data.sections.slice():DEFAULT_SECTIONS.slice()}
function nav(){return [[sectionLabel('about'),'资料'],[ui('section.categories','分类'),'分类'],[sectionLabel('experience'),'经历'],[sectionLabel('works'),'项目'],[sectionLabel('showreel'),'Showreel'],[sectionLabel('aiVoices'),sectionLabel('aiVoices')],[ui('section.settings','设置'),'设置'],[ui('section.structure','页面结构'),'页面结构']].map(([label,id])=>`<button class="nav ${view===id?'active':''}" data-view="${esc(id)}">${esc(label)}</button>`).join('')}
function profile(){const p=data.profile;
// ⚠ 2026-09-19 真实 bug 修复：原写法 `(p.contactLinks||[]).filter(x=>x&&(x.label||x.value))`
//   会把**刚点「＋ 添加联系方式」新增的空条目**（{label:'',value:''}）一并滤掉 →
//   用户点按钮「毫无反应」（数据其实push进去了，也自动保存了，只是渲染时被丢弃）。
//   同时 filter 会打乱索引 → data-key="profile.contactLinks.${i}...." 与真实下标错位，
//   编辑/删除会改错行。改为**保留原始下标**，只跳过 null/undefined（占位缺失项）。
const all=(Array.isArray(p.contactLinks)?p.contactLinks:[]);
// 2026-09-24：每条加上「上移 / 下移」——用户要自己决定谁排在上面（原话：
//   「邮箱是在微信的上面，我希望可以在文本编辑里面，删除的旁边还有一个上一件或者是下一件」）。
//   ⚠ 首/末条的对应按钮要 **disabled**，让用户看得见"为什么点不动"，而不是点了没反应。
//   ⚠ 数组里可能有 null 占位（见上面的「保留原始下标」策略）→ 首/末要按**可见行**判断，
//     直接拿 i===0 会在第 0 项是 null 时把第二条也禁掉。
const cIdx=[];all.forEach((x,i)=>{if(x!=null)cIdx.push(i)});
const cFirst=cIdx[0],cLast=cIdx[cIdx.length-1];
const rowsHtml=all.map((x,i)=>(x==null)?'':`<div class="contact-row"><input data-key="profile.contactLinks.${i}.label" value="${esc(x.label||'')}" placeholder="标签（如 邮箱 / 微信）"><input data-key="profile.contactLinks.${i}.value" value="${esc(x.value||'')}" placeholder="值（如 xxx@example.com）"><span class="row-actions"><button class="button move-contact" data-i="${i}" data-dir="-1" title="与上一条交换位置"${i===cFirst?' disabled':''}>上移</button><button class="button move-contact" data-i="${i}" data-dir="1" title="与下一条交换位置"${i===cLast?' disabled':''}>下移</button><button class="button del-contact" data-i="${i}">删除</button></span></div>`).filter(Boolean);
const contactHtml=rowsHtml.length?rowsHtml.join(''):'';
// 2026-09-24：Contact 与 Links 拆成两个独立区块（属性不同：前者是联系方式→点击复制；后者是公开链接→点击跳转）。
// 同一套「保留原始下标」策略，避免新增空条目被滤掉、以及索引错位改错行。
const allLinks=(Array.isArray(p.publicLinks)?p.publicLinks:[]);
// 与 Contact 同一套「上移 / 下移」交互（用户明确说公开链接也要这个功能）。
const lIdx=[];allLinks.forEach((x,i)=>{if(x!=null)lIdx.push(i)});
const lFirst=lIdx[0],lLast=lIdx[lIdx.length-1];
const linkRowsHtml=allLinks.map((x,i)=>(x==null)?'':`<div class="contact-row"><input data-key="profile.publicLinks.${i}.label" value="${esc(x.label||'')}" placeholder="名称（如 GitHub / Bilibili）"><input data-key="profile.publicLinks.${i}.value" value="${esc(x.value||'')}" placeholder="链接（https://...）"><span class="row-actions"><button class="button move-link" data-i="${i}" data-dir="-1" title="与上一条交换位置"${i===lFirst?' disabled':''}>上移</button><button class="button move-link" data-i="${i}" data-dir="1" title="与下一条交换位置"${i===lLast?' disabled':''}>下移</button><button class="button del-link" data-i="${i}">删除</button></span></div>`).filter(Boolean);
const linkHtml=linkRowsHtml.length?linkRowsHtml.join(''):'';
return `<h2>个人资料</h2><div class="fields">${field('姓名','profile.name',p.name)}${field('定位','profile.role',p.role)}${field('一句简介（换行会保留）','profile.intro',p.intro,true)}${field('关于我','profile.about',p.about,true)}${field('教育（每行一项）','profile.education',lines(p.education),true)}${field('技能（每行一项）','profile.skills',lines(p.skills),true)}${field('亮点（每行一项）','profile.highlights',lines(p.highlights),true)}<div class="field"><span class="field-label">${pinLabel('Hero 眉标（姓名上方的小字）','staticText.eyebrow-selected-works')}</span><input data-static-text="eyebrow-selected-works" value="${esc(staticText['eyebrow-selected-works']||STATIC_TEXT_DEFAULTS['eyebrow-selected-works'])}" placeholder="留空恢复默认：Selected works"></div></div><section class="edit-card field"><h3>Contact · 联系方式</h3><p class="hint">邮箱 / 微信等联系方式。作品集中点击 value 即可复制。</p>${contactHtml}<button class="button" id="add-contact">+ 添加联系方式</button></section><section class="edit-card field"><h3>Links · 公开链接</h3><p class="hint">GitHub、Bilibili、作品站等外部链接。作品集中点击即在新标签页打开。</p>${linkHtml}<button class="button" id="add-link">+ 添加链接</button></section>${resumeCard()}${audioIntroCard()}${displayZoneCard()}`}
// ============================================================================
// 展示区（Display Zones）—— 2026-09-24 新增。配置哪些资料被提到 hero / hero 下方的信息列。
// 布局类决策 → 存 design.json（Template 级），**不放 portfolio.json**。
// 因此对**所有模板**生效，也随模板导出/导入一起走。
// 候选清单统一由根目录 display-zones.js 提供（window.FF_ZONES），与展示页共用同一份。
// ============================================================================
async function saveDisplayZones(next){
  displayZones=next;
  try{await api('/api/design/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({displayZones:next})});notifyStudio();}
  catch(e){toast('展示区保存失败：'+e.message)}
}
function displayZoneCard(){
  const FZ=window.FF_ZONES||null;
  // 清单没加载成功时**整块不渲染**，而不是渲染出一个残缺/错配的选项表误导用户。
  if(!FZ||!FZ.resolve) return '';
  const z=FZ.resolve(displayZones), MAX=FZ.MAX;
  const group=(zone,title,desc)=>{
    const keys = zone==='hero'?FZ.heroKeys():FZ.secondaryKeys();
    const picked=z[zone]||[], full=picked.length>=MAX;
    return `<div class="zone-group">
      <div class="zone-group-head"><h4>${esc(title)}</h4><span class="zone-count${full?' is-full':''}">已选 ${picked.length} / ${MAX}</span></div>
      <p class="hint">${desc}</p>
      <div class="zone-opts">${keys.map(k=>{
        const it=FZ.catalog.filter(x=>x.key===k)[0]||{label:k,note:''};
        const on=picked.indexOf(k)>=0;
        // 选满后禁用未勾选项 —— 让用户看得见"为什么点不动"，而不是点了没反应
        const dis=!on&&full;
        // ⚠ 结构上必须把 checkbox 包在自己的 .zone-box 里：编辑器全局有 `input{width:100%}`，
        //   若让 checkbox 直接当 flex item 参与收缩，它会被拉满/挤到行尾，文字也被压成一列
        //   （实测文本宽度只剩 14px → 逐字竖排）。包一层 + flex:0 0 auto + 文字 flex:1 才稳。
        return `<label class="zone-opt${on?' is-on':''}${dis?' is-disabled':''}"><span class="zone-box"><input type="checkbox" data-zone="${zone}" data-zone-key="${esc(k)}"${on?' checked':''}${dis?' disabled':''}></span><span class="zone-opt-text"><span class="zone-opt-label">${esc(it.label)}</span><span class="zone-opt-note">${esc(it.note||'')}</span></span></label>`;
      }).join('')}</div>
    </div>`;
  };
  // ⚠ 与「页面结构」同理：说明文字**每句各占一个文本节点**（不再用 <b> 把一句切成碎片），
  //   否则英文界面里会拼出 "is the name plate area..." 这种读不通的半句。
  return `<h2>展示区</h2><p class="hint">决定哪些资料被提到页面顶部展示。<br>主展示区是人名牌区域，位置与字号固定，最多 ${MAX} 项。<br>次展示区是主展示区下方的信息列，最多 ${MAX} 项。<br>没勾选进次展示区的资料不会消失，会自动回到 About 区块重新排版。</p>
    <section class="edit-card field zone-card">${group('hero','主展示区 · Hero','页面最顶部的人名牌。顺序与字号固定，只决定显示哪几项。')}${group('secondary','次展示区','主展示区下方的信息列。左右两列高度由系统自动配平，不必在意勾选顺序。')}</section>`;
}
function resumeCard(){
  const r=(data&&data.resume)||{};
  const has=!!r.url;
  const name=esc(r.name||'简历文件');
  const ext=(r.name||'').split('.').pop().toLowerCase();
  const typeLabel=(ext==='pdf')?'PDF':(['doc','docx'].includes(ext)?'Word':['ppt','pptx'].includes(ext)?'PPT':ext?ext.toUpperCase():'文件');
  return `<section class="edit-card field"><h3>Resume / 简历</h3>
    <p class="hint">上传你的简历文件（PDF / Word / PPT 等均可）。只有上传后，作品集页面才会显示 Resume 区块与「View Resume」按钮；未上传则不显示。</p>
    <label class="field">上传简历文件 <input id="resume-upload" type="file" accept=".pdf,.doc,.docx,.ppt,.pptx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation"></label>
    ${has?`<div class="media-file-row"><span>${name}</span><button class="button" id="resume-remove" type="button">移除简历</button></div>`:''}
    ${has?`<label class="field detail-toggle"><span class="detail-toggle-label">允许浏览者下载原文件</span><label class="switch"><input type="checkbox" id="resume-allow" ${r.allowDownload?'checked':''}><span class="slider"></span></label><span class="detail-toggle-desc">${r.allowDownload?'已允许：浏览者可在 View Resume 中下载原文件':'未允许：View Resume 中显示「创作者暂未允许下载」'}</span></label>`:''}
  </section>`;
}
function audioIntroCard(){
  // 音频介绍：数据模型仿 resume —— data.audioIntro = { url, name }；
  // 只在「资料」里上传，是否进次展示区由下方「展示区」勾选决定（未选回落 About），永不进主展示区。
  const a=(data&&data.audioIntro)||{};
  const has=!!a.url;
  const name=esc(a.name||'Audio · 音频');
  return `<section class="edit-card field"><h3>Audio · 音频</h3>
    <p class="hint">上传一段自我介绍音频（MP3 / WAV / M4A / AAC / OGG / FLAC / OPUS 等均可）。上传后可在作品集中在线收听；可在下方「展示区」里选择放进次展示区，不选则回落到 About 区块。暂不进主展示区。</p>
    <label class="field">上传音频 <input id="audio-intro-upload" type="file" accept=".mp3,.wav,.m4a,.aac,.ogg,.oga,.opus,.flac,audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/aac,audio/ogg,audio/flac,audio/opus"></label>
    ${has?`<div class="media-file-row"><span>${name}</span><button class="button" id="audio-intro-remove" type="button">移除 Audio</button></div><audio controls src="${esc(a.url)}" class="audio-intro-player"></audio>`:''}
  </section>`;
}
function experience(){return `<h2>${esc(sectionLabel('experience'))}</h2>${data.experience.map((e,i)=>{const content=e.structuredContent||{summary:'',highlights:[]};return `<details class="edit-card" data-exp="${i}"><summary>${esc(e.company||'未命名经历')}</summary><div class="ai-layout"><section class="ai-result"><h3>已应用的经历内容</h3>${field('介绍',`experience.${i}.structuredContent.summary`,content.summary,true)}${translationDraftPanel(e, 'experience')}${field('亮点（每行一项）',`experience.${i}.structuredContent.highlights`,lines(content.highlights),true)}<label>图片 <input class="upload-exp" data-i="${i}" type="file" accept="image/*"></label>${mediaUrl(e.media&&e.media.image)?`<div class="media-preview"><img class="thumb" src="${esc(mediaUrl(e.media.image))}"><button class="button remove-exp-media" data-i="${i}">删除图片</button></div>`:''}</section><section class="ai-source"><h3>原始素材</h3>${field('公司',`experience.${i}.company`,e.company)}${field('职位',`experience.${i}.position`,e.position)}${field('时间',`experience.${i}.date`,e.date)}${field('原始素材',`experience.${i}.rawMaterial`,e.rawMaterial,true)}<button class="button ai-exp" data-i="${i}">AI 文本整理</button><button class="button delete-exp" data-i="${i}">删除</button></section></div></details>`}).join('')}<button class="button" id="add-exp">添加经历</button>`}
function resultPanel(p){const content=p.structuredContent||{summary:'',keyWork:[],highlights:[]};const detailed=p.showDetails!==false;return `<section class="ai-result"><h3>已应用的项目内容</h3>${field('项目名称','project.name',p.name)}<label class="field">分类<select data-group>${data.projectGroups.map(g=>`<option value="${g.id}" ${g.id===p.groupId?'selected':''}>${esc(g.title)}</option>`).join('')}</select></label>${field('时间','project.date',p.date)}${field('类型','project.type',p.type||'')}${field('我的角色', 'project.role',p.role)}<label class="field detail-toggle"><span class="detail-toggle-label">项目展示方式</span><label class="switch"><input type="checkbox" data-show-details ${detailed?'checked':''}><span class="slider"></span></label><span class="detail-toggle-desc">${detailed?'详细展示（可展开完整介绍与媒体）':'简略展示（仅显示名称/时间/角色/Key Work，不可展开）'}</span></label>${field('项目介绍','project.structuredContent.summary',content.summary,true)}${translationDraftPanel(p, 'projects')}${field('核心工作（每行一项）','project.structuredContent.keyWork',lines(content.keyWork),true)}${field('核心亮点（每行一项）','project.structuredContent.highlights',lines(content.highlights),true)}</section>`}
function mediaPanel(p){
  const m=p.media||{};
  const main=mediaUrl(m.mainVisual);
  const processImages=(m.processImages||[]).map((ref,index)=>({ref,url:mediaUrl(ref),index})).filter(item=>item.url);
  const has=!!main||processImages.length||!!m.video||!!m.audio||!!m.externalVideoUrl||!!m.externalLink;
  const fileRow=(label,slot,ref,accept,deleteLabel)=>`<label>${label} <input class="upload-project" data-slot="${slot}" type="file" accept="${accept}"></label>${ref?`<div class="media-file-row"><span>${esc(ref.name||ref.url||'已添加文件')}</span><button class="button remove-media" data-slot="${slot}">${deleteLabel}</button></div>`:''}`;
  return `<section class="edit-card"><details data-media-card="1" ${has?'open':''}><summary>媒体${has?'（已添加）':''}</summary><div class="fields">
    <label>主视觉 <input class="upload-project" data-slot="mainVisual" type="file" accept="image/*"></label>
    ${main?`<div class="media-preview"><img class="thumb" src="${esc(main)}"><button class="button remove-media" data-slot="mainVisual">删除主视觉</button></div>`:''}
    <label>工作过程图（可多选） <input class="upload-project" data-slot="processImages" type="file" accept="image/*" multiple></label>
    ${processImages.map(item=>`<div class="media-preview"><img class="thumb" src="${esc(item.url)}"><button class="button remove-process-image" data-index="${item.index}">删除此过程图</button></div>`).join('')}
    ${fileRow('本地视频（MP4 / WebM / MOV）','video',m.video,'video/mp4,video/webm,video/quicktime','删除视频')}
    ${fileRow('本地音频（MP3 / WAV / M4A / AAC / OGG / FLAC / OPUS）','audio',m.audio,'.mp3,.wav,.m4a,.aac,.ogg,.oga,.opus,.flac,audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/aac,audio/ogg,audio/flac,audio/opus','删除音频')}
    ${m.externalVideoUrl?`${field('外部视频链接','project.media.externalVideoUrl',m.externalVideoUrl)}<button class="button remove-media-text" data-slot="externalVideoUrl">删除外部视频链接</button>`:'<button class="button add-external-video">添加外部视频</button>'}
    ${m.externalLink?`${field('外部链接','project.media.externalLink',m.externalLink)}<button class="button remove-media-text" data-slot="externalLink">删除外部链接</button>`:'<button class="button add-external-link">添加外部链接</button>'}
  </div></details></section>${compressCardHtml('project',selected,m.video)}`
}
function projects(){const p=data.projects[selected]||data.projects[0];if(!p)return '<h2>项目</h2><button class="button" id="add-project">新建项目</button>';return `<h2>项目</h2><div class="project-picker">${data.projects.map((x,i)=>`<button class="button ${i===selected?'primary':''}" data-select="${i}">${esc(x.name||'未命名项目')}</button>`).join('')}<button class="button" id="add-project">新建项目</button></div><div class="ai-layout">${resultPanel(p)}<section class="ai-source"><h3>原始素材</h3><p class="hint">可以直接粘贴完整简历、项目介绍、工作记录或项目笔记，不需要提前分类。</p><textarea id="raw-material">${esc(p.rawMaterial)}</textarea><h3>AI 整理控制</h3><label>整理方向 <select id="ai-style">${(()=>{const d=ffAIDirection();return ['作品集导向','专业简洁','技术导向'].map(o=>'<option value="'+o+'"'+(o===d?' selected':'')+'>'+o+'</option>').join('')})()}</select></label><p class="hint">作品集导向＝讲清作品是什么、创作意图与效果；专业简洁＝只留事实与职责；技术导向＝突出流程、工具规格与难点解法。口水化的素材会被转成书面话术并归到对应字段。</p><div><button class="button primary" id="organize">AI 文本整理</button><button class="button" id="regenerate">重新生成</button></div></section></div>${mediaPanel(p)}<button class="button" id="move-up">上移</button><button class="button" id="move-down">下移</button><button class="button danger" id="delete-project">删除项目</button>`}
function categories(){return `<h2>分类与类别介绍</h2><p class="hint">类别介绍用于说明“这一类作品整体在做什么、共同体现什么能力”，与单个项目介绍区分。留空则该类别在作品集不显示介绍区域。</p>${data.projectGroups.map((g,i)=>`<details class="edit-card cat-card" data-cat="${i}" open><summary>${esc(g.title)} <span class="cat-count">${data.projects.filter(p=>p.groupId===g.id).length} 个项目</span></summary><div class="fields"><label class="field">类别名称<input data-cat-title="${i}" value="${esc(g.title)}"></label>${field('类别介绍（自然语言）',`category.${i}.description`,g.description||'',true)}<div class="cat-actions"><button class="button ai-cat" data-i="${i}">AI 整理类别介绍</button><button class="button danger del-cat" data-i="${i}" title="删除这个分类；分类下还有项目时会先问你怎么处理">🗑 删除分类</button></div></div></details>`).join('')}<button class="button" id="add-category">新建分类</button>`}
// 删除分类。分类是「数量自由」的：新建之外必须能删，否则用户改不动这个数量。
// 两个必须守住的点：① 至少留一个分类（作品集靠分类组织项目，0 个=项目全都不显示）；
// ② 分类下还有项目时不能直接删 —— 否则那些项目的 groupId 指不到任何分类，会在作品集里凭空消失。
// 所以：有项目就先把它们移到另一个分类（先确认），并整体进撤销栈。
function deleteCategory(i){
  const groups=data.projectGroups||[];
  const g=groups[i]; if(!g)return;
  if(groups.length<=1){toast('至少要保留一个分类（作品集靠分类组织项目）');return}
  const moved=data.projects.filter(p=>p.groupId===g.id);
  const target=groups.find((x,j)=>j!==i)||{};
  const msg=moved.length
    ? '删除分类「'+g.title+'」？该分类下的 '+moved.length+' 个项目会移到「'+(target.title||'')+'」。'
    : '删除分类「'+g.title+'」？';
  if(!confirm(z(msg)))return;
  push();
  data.projectGroups.splice(i,1);
  if(moved.length&&target.id)data.projects.forEach(p=>{if(p.groupId===g.id)p.groupId=target.id});
  render();
  toast('已删除分类「'+g.title+'」'+(moved.length?('，'+moved.length+' 个项目已移到「'+(target.title||'')+'」'):''));
}
// 展开状态保持：render() 会把 #editor-app 整块重画，而 <details> 的展开状态是纯 DOM 状态、
// 不在这份数据里 —— 于是任何一次重画（切视图、语言变化、保存后同步、上传完成…）都会把用户
// 正在编辑的卡片合上。用户原话：「每次往下滑，它就自己把展开下拉栏缩起来了，非常影响操作」。
// 做法：重画前按稳定 key 快照，重画后原样还原。这样不管是谁触发的重画都不会丢展开状态。
function openCardKey(d,i){
  if(d.dataset.aiProject!=null)return 'ai:'+d.dataset.aiProject;
  if(d.dataset.cat!=null)return 'cat:'+d.dataset.cat;
  if(d.dataset.exp!=null)return 'exp:'+d.dataset.exp;
  if(d.dataset.mediaCard!=null)return 'media:'+d.dataset.mediaCard;
  return 'i:'+i;
}
function openCardEls(){const app=$('#editor-app');return app?[...app.querySelectorAll('details.edit-card, details.cc-advanced')]:[]}
// key 里带视图名：换视图时不把上一个视图的展开状态套到新视图的卡片上。
function snapshotOpenCards(){const m={};openCardEls().forEach((d,i)=>{m[view+'|'+openCardKey(d,i)]=!!d.open});return m}
function restoreOpenCards(m){if(!m)return;openCardEls().forEach((d,i)=>{if(m[view+'|'+openCardKey(d,i)])d.open=true})}
function showreel(){const sr=data.showreel;sr.projects=Array.isArray(sr.projects)?sr.projects:[];if(selectedShowreel>=sr.projects.length)selectedShowreel=0;const cur=sr.projects[selectedShowreel];
if(!cur)return `<h2>Showreel</h2><p class="hint">Showreel 栏目下可以有多个 Showreel 项目（各自带视频与章节）。</p><button class="button primary" id="add-sr-project">＋ 新建 Showreel 项目</button>`;
const projSel=sr.projects.map((p,j)=>`<option value="${j}" ${j===selectedShowreel?'selected':''}>${esc(p.name||('Showreel 项目 '+(j+1)))}</option>`).join('');
const src=mediaUrl(cur.media)||cur.externalVideoUrl||'';
const chapterCard=(c,i)=>{const pid=c.projectId;const opts=data.projects.map((p,j)=>`<option value="${j}" ${j===pid?'selected':''}>${esc(p.name||'未命名项目')}</option>`).join('');const curP=pid!=null&&data.projects[pid];const title=curP?curP.name:(c.title||'');const role=curP?curP.role:(c.role||'');return `<div class="edit-card chapter-card" data-i="${i}"><div class="fields"><label class="field">选择项目（可选，自动填名称与角色）<select class="chapter-project" data-i="${i}"><option value="">— 选择已有项目 —</option>${opts}</select></label><label class="field">章节名称<input class="chapter-title" data-i="${i}" value="${esc(title)}"></label><label class="field">角色<input class="chapter-role" data-i="${i}" value="${esc(role)}"></label>${field('开始时间',`chapter.${i}.start`,c.start)}${field('结束时间',`chapter.${i}.end`,c.end)}<button type="button" class="button set-time" data-i="${i}" data-kind="start">记录当前位置为开始</button><button type="button" class="button set-time" data-i="${i}" data-kind="end">记录当前位置为结束</button><button class="button chapter-move" data-i="${i}" data-d="-1">上移</button><button class="button chapter-move" data-i="${i}" data-d="1">下移</button><button class="button del-chapter" data-i="${i}">删除章节</button></div></div>`};
return `<h2>Showreel</h2><p class="hint">「新建 Showreel 项目」= 新增一个带自己视频与章节的项目；「添加章节」只在当前项目内部加一章，两者完全不同。</p><div class="fields"><label class="field">当前编辑的 Showreel 项目<select id="sr-select">${projSel}</select></label></div><div class="showreel-actions"><button class="button primary" id="add-sr-project">＋ 新建 Showreel 项目</button><button class="button danger" id="del-sr-project">删除当前项目</button></div><section class="edit-card"><h3>当前项目内容</h3><div class="fields">${field('项目名称',`showreel.projects.${selectedShowreel}.name`,cur.name||'')}${field('角色 / 定位',`showreel.projects.${selectedShowreel}.role`,cur.role||'')}<label class="field">上传本地视频（MP4 / WebM / MOV，H.264 编码可直接播放）<input id="show-upload" type="file" accept="video/mp4,video/webm,video/quicktime"></label>${field('外部视频链接（B 站 / YouTube 播放页等）',`showreel.projects.${selectedShowreel}.externalVideoUrl`,cur.externalVideoUrl||'')}</div>${src?`<p>当前来源：${esc((cur.media&&cur.media.name)||cur.externalVideoUrl)}</p>${cur.media?'<button class="button" id="remove-show-video">删除当前项目本地视频</button>':''}<video id="edit-video" controls src="${esc(src)}"></video><div class="timeline"><input id="edit-seek" type="range" min="0" max="1000" step="1" value="0" aria-label="进度条"><p id="clock">当前时间 00:00:00.000 / 总时长读取中</p></div>`:'<p class="hint">还没上传视频：可上传本地视频文件，或填一个外部视频链接。</p>'}</section>${(cur.chapters||[]).length?`<div class="showreel-actions"><button class="button danger" id="reset-chapters">全部清零当前项目的章节时间点</button><span class="hint-inline">当前项目已有 ${cur.chapters.length} 个章节（换视频不会清掉它们）</span></div>`:''}${(cur.chapters||[]).map(chapterCard).join('')}<div class="showreel-actions"><button class="button" id="add-chapter">添加章节（只在当前项目内）</button></div>${compressCardHtml('showreel',selectedShowreel,cur.media)}`}
function styles(){
  const t=currentTheme();
  const card=(p)=>`<label class="theme-card ${t.preset===p.id?'selected':''}" data-preset="${p.id}"><input type="radio" name="theme-preset" value="${p.id}" ${t.preset===p.id?'checked':''}><span class="theme-swatch" data-mode="${p.mode}" style="--sw-ink:${window.THEMES[p.id].ink};--sw-paper:${window.THEMES[p.id].paper};--sw-accent:${window.THEMES[p.id].accent};--sw-line:${window.THEMES[p.id].line}"></span><span class="theme-card-label">${esc(p.label)}</span></label>`;
  const lights=THEME_PRESETS.filter(p=>p.mode==='light').map(card).join('');
  const darks=THEME_PRESETS.filter(p=>p.mode==='dark').map(card).join('');
  const p=(data&&data.profile)||{};
  const pname=(p.name&&p.name.trim())?p.name.trim():'你的名字';
  const prole=(p.role&&p.role.trim())?p.role.trim():'定位 / 职位';
  const pintro=(p.intro&&p.intro.trim())?p.intro.trim():'一句话简介，介绍你最擅长的方向与代表作。';
  const hl=Array.isArray(p.highlights)?p.highlights.map(x=>String(x==null?'':x).trim()).filter(Boolean):[];
  const chips=hl.length?hl.slice(0,4).map(h=>'<span class="kw-chip">'+esc(h)+'</span>').join(''):'<span class="kw-chip">你的亮点</span><span class="kw-chip">代表技能</span>';
  const isEmpty=!(p.name&&p.name.trim())&&!(p.role&&p.role.trim())&&!(p.intro&&p.intro.trim())&&!hl.length;
  const emptyNote=isEmpty?'<p class="theme-preview-empty">当前模板还没有填写内容，下面用占位文字展示效果。在「资料」里填写后，这里会实时更新为你的信息。</p>':'';
  // —— 「语言设置」段：解释字段级「不跟随语言」开关 + 提供整篇翻译入口 ——
  // 按钮按 i18n.js 的 LANGS 动态生成（排除源语言 zh-CN）；服务端 CONTENT_I18N_LANGS 是最终守门。
  // ⚠ 2026-09-24：「无语言系统」的版本（i18n.js 的 MODE='off'，或本机探测不到翻译服务且
  //   MODE='auto'）里，这里**不能**照常摆几个"将整篇翻译为…"按钮 —— 那就等于承诺了一件做不到的事。
  //   改成如实说明"这个版本没有语言系统"，并给出恢复办法。
  const noLangSys=!!(I18N&&I18N.capable&&!I18N.capable());
  // Phase 3（2026-09-26）：每个语言一行 = 生成（机翻）+ 确认 + 预览草稿。
  // 默认「发布前审核」模式只有「已确认」的译文才会出现在画布和发布页（服务端门控）；
  // 「机器翻译直接使用」模式下生成即可用。顶栏切换语言只应用现成译文，绝不再现场调机翻。
  // Phase 3R（2026-09-26）：翻译模式二选一 —— 这是通用产品机制，存 content.settings.translationMode。
  // UI（2026-09-26 二次调整）：紧凑卡片 = 标题「翻译模式」+ 横向两个选项 + 下方一行说明随选中态切换。
  // ⚠ editor.css 的全局规则 input,textarea,select{width:100%;padding:10px;border:…} 会把 radio
  //   拉成整行宽的大空框（曾经把说明文字挤成竖排的大面积空白），.tr-mode-opt input 必须逐项还原。
  const trMode=((data.settings||{}).translationMode)==='direct'?'direct':'review';
  const trModeDesc=m=>esc(ui(m==='direct'?'tr.modeDirectDesc':'tr.modeReviewDesc',
    m==='direct'?'翻译完成后即可用于作品集和发布，无需逐条确认；之后仍可预览和修改。':'机器翻译完成后，需要你确认翻译内容，确认后才会作为正式翻译显示和发布。'));
  const trQuality=(!noLangSys&&I18N&&Array.isArray(I18N.LANGS))?`<h4 class="tr-q-title">${esc(ui('tr.modeTitle','翻译模式'))}</h4>
    <div class="tr-quality" id="tr-quality" data-mode="${trMode}">
      <div class="tr-mode-switch" role="radiogroup">
        <label class="tr-mode-opt${trMode==='review'?' active':''}"><input type="radio" name="tr-mode" value="review" ${trMode==='review'?'checked':''}><b>${esc(ui('tr.modeReview','发布前审核'))}</b></label>
        <label class="tr-mode-opt${trMode==='direct'?' active':''}"><input type="radio" name="tr-mode" value="direct" ${trMode==='direct'?'checked':''}><b>${esc(ui('tr.modeDirect','机器翻译直接使用'))}</b></label>
      </div>
      <p class="tr-mode-desc" id="tr-mode-desc">${trModeDesc(trMode)}</p>
    </div>`:'';
  const langRows=(!noLangSys&&I18N&&Array.isArray(I18N.LANGS)?I18N.LANGS.filter(l=>l.id!=='zh-CN'):[]).map(l=>'<div class="lang-tr-row">'
    +'<button class="button primary" type="button" data-translate-all="'+l.id+'">将整篇翻译为 '+l.name+'</button>'
    +'<button class="button" type="button" data-review-lang="'+l.id+'">'+esc(ui('tr.approve','确认翻译 ✓'))+'</button>'
    +'<button class="button" type="button" data-preview-draft="'+l.id+'">预览草稿</button>'
    +'<span class="t-status" id="t-status-'+l.id+'" role="status" aria-live="polite"></span></div>').join('');
  const langSection=noLangSys
    ? `<h3>${esc(ui('settings.language','语言设置'))}</h3>
    <p class="hint">这个版本<b>没有包含语言系统</b>：界面固定中文，顶栏也不会出现语言切换按钮 —— 这是刻意的，免得出现一个点不动的入口让人以为坏了。</p>
    <p class="hint">想启用语言切换：在本机装好并运行 Ollama、下载翻译模型，让 FolioFold 的翻译服务处于可用状态，然后刷新这个页面。装好后这里会自动变回可选语言的样子。</p>`
    : `<h3>${esc(ui('settings.language','语言设置'))}</h3>
    <p class="hint">界面语言与内容语言是两套独立的事：顶栏切换<b>界面</b>立刻生效；作品集<b>内容</b>按下面选的翻译质量模式跟随切换 —— 「发布前审核」模式下只有你确认过的译文才会正式显示，「机器翻译直接使用」模式下生成即可用。</p>
    <p class="hint">流程（每个语言一行）：① 「将整篇翻译为…」用本地 Ollama 生成译文；② 「预览草稿」在新窗口检查（含未确认译文）；③ 「确认翻译」把该语言标记为可直接使用。状态一栏会如实显示：未生成 / 翻译草稿 · 待确认 / 已就绪 —— 没有后台审核，一切由你在这里决定。原文修改后该语言会标「需要重新检查」，旧译文保留不删。生成过的译文在重新生成时会原样复用，已验收的内容不会因为重翻而变样。</p>
    <p class="hint">若某些字段是外文专有名词、或你希望保持原文（如片名、技术名词），点该字段的标签即可「钉住」——标签变成斜体并显示 🔒，该字段不再跟随语言切换；再点一次恢复跟随。</p>
    ${translationReady?'':'<p class="hint">⚠ 当前没有探测到可用的翻译服务：已有译文照常显示，但无法生成新译文。语言入口仍保留（本机装了服务后会自动恢复）。</p>'}
    ${trQuality}
    <div class="lang-translate-actions">${langRows}</div>
    <p class="hint">翻译由本地 Ollama（qwen3:4b）完成，只翻译你已经写好、且未钉住的内容；中文原文始终保留，可随时重新生成。</p>`;
  // —— 「主题预设」段：沿用原主题卡片 + 实时预览 ——
  const themeSection=`<h3>${esc(ui('settings.theme','主题预设'))}</h3><p class="hint">主题决定整套作品的视觉系统（正文、背景、强调色、分隔线、Showreel 块）。选择后 <strong>编辑器预览与最终作品集共用同一主题</strong>。</p><div class="theme-grid"><div class="theme-col"><h3>Light</h3><div class="theme-cards">${lights}</div></div><div class="theme-col"><h3>Dark</h3><div class="theme-cards">${darks}</div></div></div><div class="theme-preview"><h3>当前预览</h3>${emptyNote}<div class="theme-preview-bar"><span class="hero-eyebrow">Selected works</span><h1 style="font:500 48px/1 'Playfair Display',serif;margin:8px 0 12px">${esc(pname)}</h1><p style="margin:0 0 8px">${esc(prole)}</p><p style="font-size:14px;line-height:1.7">${esc(pintro)}</p><div style="margin-top:12px;display:flex;gap:8px">${chips}</div></div></div>`;
  // —— Phase 4：环境检查卡（只读体检 + 仅创建缺失目录的安全修复）——
  const envSection=`<h3>${esc(ui('env.title','环境检查'))}</h3>
    <p class="hint">${esc(ui('env.hint','一键体检本机运行环境：Python、依赖、FFmpeg、关键目录、端口与可选组件。检查是只读的；「一键修复」只会创建缺失的空目录，绝不改动内容、媒体与备份。'))}</p>
    <button class="button" type="button" id="env-check-run">${esc(ui('env.run','运行环境检查'))}</button>
    <div id="env-check-out" style="margin-top:10px"></div>`;
  return `<h2>${esc(ui('section.settings','设置'))}</h2><div class="settings-sections"><section class="edit-card">${langSection}</section><section class="edit-card">${themeSection}</section><section class="edit-card">${envSection}</section></div>`}
// —— Phase 4：环境检查（设置页）——
// 结果区只渲染一次按钮点击后的内容；服务器返回的技术细节（版本号、路径）保留原文，便于排障。
async function runEnvCheck(){
  const out=$('#env-check-out'); if(!out) return;
  out.innerHTML='<p class="hint">'+esc(ui('env.checking','正在检查…'))+'</p>';
  let r; try{ r=await api('/api/env-check'); }catch(e){ out.innerHTML='<p class="hint">'+esc(ui('env.checkFailed','环境检查失败'))+'：'+esc(e.message)+'</p>'; return; }
  const badge=s=>s==='ok'?'<span class="env-badge env-ok">'+esc(ui('env.st.ok','正常'))+'</span>'
    :s==='fixable'?'<span class="env-badge env-fix">'+esc(ui('env.st.fixable','可修复'))+'</span>'
    :s==='optional'?'<span class="env-badge env-opt">'+esc(ui('env.st.optional','可选'))+'</span>'
    :'<span class="env-badge env-block">'+esc(ui('env.st.blocked','阻塞'))+'</span>';
  out.innerHTML='<div class="env-rows">'+r.rows.map(x=>'<div class="env-row">'+badge(x.status)
    +'<div class="env-info"><b>'+esc(x.label)+'</b><span>'+esc(x.detail)+'</span></div></div>').join('')+'</div>'
    +(r.counts.fixable
      ?'<button class="button" type="button" id="env-repair-run">'+esc(ui('env.repair','一键修复（仅创建缺失目录）'))+'</button>'
       +'<p class="hint">'+esc(ui('env.repairNote','修复说明：只创建缺失的空目录，不写入、不删除、不覆盖任何文件。'))+'</p>'
      :'')
    +'<p class="hint">'+esc(ui('env.st.ok','正常'))+' '+r.counts.ok+' · '+esc(ui('env.st.fixable','可修复'))+' '+(r.counts.fixable||0)+' · '+esc(ui('env.st.optional','可选'))+' '+(r.counts.optional||0)+' · '+esc(ui('env.st.blocked','阻塞'))+' '+(r.counts.blocked||0)+'</p>';
  const rep=$('#env-repair-run'); if(rep) rep.onclick=async()=>{
    rep.disabled=true;
    try{ const rr=await api('/api/env-repair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})});
      toast(ui('env.repaired','修复完成：新建')+' '+rr.created.length+' 个目录'); runEnvCheck();
    }catch(e){ toast(ui('env.repairFailed','修复失败')+'：'+e.message); rep.disabled=false; }
  };
}
// —— 页面结构：区块名称 / 显示状态是 Content；区块顺序属于 Template（design.json）。——
// ⚠ 2026-09-24：给每个模块挂一个**稳定代号**（A–E）+ **功能说明**。
//   原因（用户原话）：「我在模板二里面它就不叫 ai project，所以你必须有一个代号，
//   才能对应到具体的一个模块，而不会导致模板一改了之后，模板二却因为名字的不同没有识别到。」
//   所以代号按**模块身份**分配（取 /sections.js，不在本文件另抄一份），
//   与显示名无关、与页面顺序无关 —— 改名改到第十遍、在两个模板里叫两个名字，
//   也仍然对得上同一个模块。
// ⚠ 2026-09-24：**不给模块贴区域标签**（用户原话：「不需要有明确称呼，比如个人档案与信息区、
//   任职经历区，这些什么都不要……真正要让它作为什么区域，是使用者他自己决定的」）。
//   所以这里只有：稳定代号 + 当前显示名称（可改）+ 该模块的**功能点**。
//   没有"它是什么区域"的命名，也没有区域简介。
function structCodeCard(k){
  const S=window.FF_SECTIONS;
  const it=(S&&S.get)?S.get(k):null;
  if(!it) return '';
  const feats=(it.features||[]).map(f=>`<span class="struct-feat">${esc(f)}</span>`).join('');
  return `<div class="struct-code">`
    +`<span class="struct-code-badge" title="稳定代号：跟模块身份走，与显示名、页面顺序无关">${esc(it.code)}</span>`
    +`<label class="struct-title"><span class="struct-title-cap">当前显示名称</span>`
    +`<input data-section-title="${k}" value="${esc((data.sectionTitles||{})[k]||SECTION_DEFAULTS[k]||k)}"></label>`
    +`<div class="struct-code-feats" title="该模块可承载 / 可做到的功能">${feats}</div></div>`;
}
function pageStructure(){const list=currentSections(),hidden=(data.settings&&data.settings.sectionVisibility)||{};
  // ⚠ 2026-09-24：这段说明原来夹着 <b> —— 于是界面文案被切成「（A–E），它跟」「稳定代号」
  //   这种**半句碎片**，翻译只能逐片段翻，中英拼起来不成句。现在**每句正文各占一个文本节点**
  //   （用 <br> 换行代替行内加粗），一句一条词条，翻出来才是通顺的外语。
  return `<h2>${esc(ui('section.structure','页面结构'))}</h2><p class="hint">每个模块都有一个稳定代号（A–E），它跟模块身份走、不跟名字走 —— 你可以随时改名，甚至让同一个模块在模板一叫一个名字、在模板二叫另一个名字（例如同一个模块在模板一叫 AI Project、在模板二叫 AI Lab），代号始终不变，便于对照、排查与跨模板同步。<br>名称与显示状态属于内容（portfolio.json）；顺序属于模板（design.json）。</p>`+list.map((k,i)=>`<div class="struct-row">${structCodeCard(k)}<div class="struct-main"><label class="struct-visible"><input type="checkbox" data-section-visible="${k}" ${hidden[k]===false?'':'checked'}> 显示</label><div class="struct-actions"><button class="button struct-up" data-i="${i}" ${i===0?'disabled':''}>↑ 上移</button><button class="button struct-down" data-i="${i}" ${i===list.length-1?'disabled':''}>↓ 下移</button></div></div>${sectionLogoCard(k,sectionLabel(k))}</div>`).join('')+`<button class="button primary" id="save-struct">${esc(ui('action.save','保存草稿'))}</button>`;}
function aiVoices(){const a=data.aiVoices,projects=a.projects||[];const shotsOf=p=>(p.media&&p.media.screenshots||[]).filter(Boolean);const cards=projects.map((p,i)=>`<details class="edit-card" data-ai-project="${i}"><summary>${esc(p.name||'未命名 AI 项目')}</summary><div class="fields">${field('项目名称',`ai.projects.${i}.name`,p.name)}${field('我的角色',`ai.projects.${i}.role`,p.role)}${field('一句简介',`ai.projects.${i}.summary`,p.summary,true)}${field('项目定位',`ai.projects.${i}.positioning`,p.positioning,true)}${field('我的贡献',`ai.projects.${i}.contribution`,p.contribution,true)}${field('技术栈（每行一项）',`ai.projects.${i}.tech`,lines(p.tech),true)}${field('Highlights（每行一项）',`ai.projects.${i}.highlights`,lines(p.highlights),true)}${field('GitHub Link',`ai.projects.${i}.githubUrl`,p.githubUrl||'')}${field('Live Demo URL',`ai.projects.${i}.liveDemoUrl`,p.liveDemoUrl||'')}${logoCard(p,i)}<label>封面图片 <input class="ai-project-upload" data-slot="image" data-i="${i}" type="file" accept="image/*"></label>${mediaUrl(p.media&&p.media.image)?`<div class="thumb-row"><img class="thumb" src="${mediaUrl(p.media.image)}"><button class="button remove-ai-media" data-slot="image" data-i="${i}">删除封面</button></div>`:''}<label>本地视频（MP4 / WebM / MOV）<input class="ai-project-upload" data-slot="video" data-i="${i}" type="file" accept="video/mp4,video/webm,video/quicktime"></label>${mediaUrl(p.media&&p.media.video)?`<div class="thumb-row"><video class="thumb thumb-video" src="${mediaUrl(p.media.video)}" controls preload="metadata"></video><button class="button remove-ai-media" data-slot="video" data-i="${i}">删除视频</button></div>`:''}<label>截图（可多选）<input class="ai-project-shots" data-i="${i}" type="file" accept="image/*" multiple></label>${shotsOf(p).map((s,si)=>`<div class="thumb-row"><img class="thumb" src="${mediaUrl(s)}"><button class="button remove-ai-shot" data-i="${i}" data-si="${si}">删除截图</button></div>`).join('')}<button class="button danger ai-project-delete" data-i="${i}">删除项目</button></div></details>`).join('');return `<p class="hint">四个文字字段的分工：一句简介 = 项目是什么；项目定位 = 项目的定位与特点（项目层信息，不是个人定位）；我的角色 = 我在这个项目中担任的角色（短）；我的贡献 = 我实际完成、参与或负责的工作（正文）。个人角色由「我的角色」表达，具体行动和成果由「我的贡献」表达，不要在这四个之外再加第五个类似字段。其余字段：技术栈 / Highlights / GitHub / Live Demo / 封面 / 截图，保存后作品集与排版编辑同步生效。</p>${cards||'<p class="hint">还没有 AI 项目，点下方按钮添加。</p>'}<button class="button primary" id="add-ai-project">+ 添加 AI 项目</button>`}
function render(){
  // 合成中（拼音候选框开着）绝不重画 —— 这是唯一必须挡住的情况。
  if(_ffComposing){_ffPendingRender=true;return}
  _ffPendingRender=false;
  // 焦点保护：重画会销毁 DOM，正在打字的框要把焦点和光标位置原样找回来
  // （注意：不能靠"有焦点就不重画"来规避 —— 那样程序化点击导航时视图根本切不动）。
  const _fa=document.activeElement;
  const _keep=(_fa&&(_fa.tagName==='TEXTAREA'||_fa.tagName==='INPUT')&&_fa.dataset&&_fa.dataset.key)
    ? {key:_fa.dataset.key,sel:_fa.selectionStart,selE:_fa.selectionEnd}:null;
  const _open=snapshotOpenCards();
  // 视频进度保护：render 会销毁并重建 #edit-video，先把当前进度快照下来，wire() 里据此恢复
  const _ev=document.getElementById('edit-video');
  _videoPre=(_ev&&_ev.src)?{src:_ev.currentSrc||_ev.src,t:_ev.currentTime||0}:null;
  const body={资料:profile,分类:categories,经历:experience,项目:projects,Showreel:showreel,设置:styles,'页面结构':pageStructure};body[sectionLabel('aiVoices')]=aiVoices;const screen=(body[view]||profile)();$('#editor-app').className='';$('#editor-app').innerHTML=`<div class="editor"><aside class="side"><h2 class="brand">FolioFold Editor</h2>${nav()}</aside><main class="main"><header class="bar"><div><span class="eyebrow">${esc(ui('status.draft','当前草稿'))}</span><h1>${esc(viewLabel(view))}</h1></div><div class="actions"><span class="save-flag" id="save-flag"></span><button class="button" id="visual">${esc(ui('nav.visual','排版编辑'))}</button><button class="button" id="restore">${esc(ui('action.restore','恢复上一版'))}</button><button class="button" id="preview">${esc(ui('action.preview','预览作品集'))}</button><button class="button" id="undo" data-label="${esc(ui('action.undo','撤回'))}">${esc(ui('action.undo','撤回'))}</button><button class="button primary" id="save">${esc(ui('action.save','保存草稿'))}</button></div></header>${screen}</main></div><div class="toast"></div>`;if(I18N)I18N.autoTranslate($('#editor-app'));wire();updateDirty();initCompressCards();restoreOpenCards(_open);if(_keep){const el=$$('[data-key]').find(e=>e.dataset.key===_keep.key);if(el){try{el.focus();if(_keep.sel!=null)el.setSelectionRange(_keep.sel,_keep.selE)}catch(_){}}}if(ffRescuedPending.length)restoreRecoveryBanner()}
function set(key,value){const a=key.split('.');if(a[0]==='project')a[0]='projects',a.splice(1,0,String(selected));if(a[0]==='chapter'){a[0]='showreel';a.splice(1,0,'projects');a.splice(2,0,String(selectedShowreel));a.splice(3,0,'chapters');}if(a[0]==='ai')a[0]='aiVoices';if(a[0]==='category')a[0]='projectGroups';let o=data;for(let i=0;i<a.length-1;i++){const k=/^\d+$/.test(a[i])?+a[i]:a[i];if(o[k]==null)o[k]=k==='aiDraft'?{...clone(o.structuredContent||{}),role:o.role||o.position||''}:{};o=o[k]}const k=a.at(-1);o[k]=['keyWork','highlights','responsibilities','education','skills','tech'].includes(k)?split(value):value;if(key.includes('structuredContent')){if(a[0]==='projects'){const p=data.projects[selected];p.summary=p.structuredContent.summary;p.keyWork=p.structuredContent.keyWork;p.highlights=p.structuredContent.highlights}else if(a[0]==='experience'){const e=data.experience[+a[1]];e.summary=e.structuredContent.summary}}}
// 「整理方向」记住上次的选择：页面每次重画都会重建这个下拉框，不记住就永远跳回第一项。
function ffAIDirection(){try{return localStorage.getItem('ff.aiDirection')||'作品集导向'}catch(_){return '作品集导向'}}
function wire(){$$('[data-view]').forEach(b=>b.onclick=()=>{view=b.dataset.view;render()});
$('#ai-style')?.addEventListener('change',e=>{try{localStorage.setItem('ff.aiDirection',e.target.value)}catch(_){}});
// ⚠ 合成进行中（拼音候选框还开着）不写数据：此刻 e.value 里是未上屏的拼音字母，
//   写进去等于把"nihao"当成正式内容存草稿。合成结束由 compositionend 补写。
$$('[data-key]').forEach(e=>e.oninput=()=>{if(_ffComposing)return;push('k:'+e.dataset.key);set(e.dataset.key,e.value)});
// 字段级「不跟随语言」开关：点字段名（pin-toggle 按钮）就钉住/解除该字段。
$$('[data-pin]').forEach(b=>b.onclick=()=>togglePin(b.dataset.pin));
// 整篇翻译：一次把作品集里所有用户文案翻成目标语言（服务端 /api/i18n/content/translate）。
// Phase 3：生成的是「草稿」，要「通过审核」后才会进画布/发布。
$$('[data-translate-all]').forEach(b=>b.onclick=async()=>{const lang=b.dataset.translateAll;const buttons=$$('[data-translate-all]');const st=document.getElementById('t-status-'+lang);buttons.forEach(x=>x.disabled=true);if(st)st.textContent='整篇翻译进行中…（本地模型，可能要几分钟）';try{const j=await api('/api/i18n/content/translate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({lang})});if(!j.ok)throw Error(j.error||'翻译失败');toast('整篇翻译完成（'+lang+'）：共 '+j.count+' 条，更新 '+j.updated+' 条'+(j.failed?('，'+j.failed+' 条失败'):''));const direct=((data.settings||{}).translationMode)==='direct';if(st)st.textContent=direct?('机器翻译 · 已就绪：'+j.count+' 条'):('翻译草稿 · 待确认：'+j.count+' 条')+(j.failed?('，'+j.failed+' 条失败'):'');}catch(e){toast('整篇翻译失败：'+e.message);if(st)st.textContent='翻译失败：'+e.message;}finally{buttons.forEach(x=>x.disabled=false);}});
// Phase 3 审核闸 → Phase 3R：把当前译文标记为「已确认」（发布前审核模式下，确认后画布/发布才用这一版）。
$$('[data-review-lang]').forEach(b=>b.onclick=async()=>{const lang=b.dataset.reviewLang;const st=document.getElementById('t-status-'+lang);b.disabled=true;if(st)st.textContent='确认中…';try{const j=await api('/api/i18n/content/review',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({lang})});if(!j.ok)throw Error(j.error||'确认失败');toast('「'+lang+'」译文已确认：'+j.count+' 条正式生效');if(st)st.textContent=ui('tr.ready','已就绪')+' · '+j.count+' 条';}catch(e){toast('确认失败：'+e.message);if(st)st.textContent='';}finally{b.disabled=false;}});
// 草稿预览：新窗口打开作品集（?i18ndraft=1 会临时包含未确认译文，仅创作端预览用）。
$$('[data-preview-draft]').forEach(b=>b.onclick=()=>{window.open('/portfolio/?mode=draft&i18ndraft=1','_blank');});
// —— 翻译模式切换（2026-09-26）：review=发布前审核 / direct=机器翻译直接使用。
// 存 content.settings.translationMode（任何用户/作品/语言同一机制），即时保存，不写死。
// UI 联动：选项高亮 + 说明文字随选中态切换。
$$('[name="tr-mode"]').forEach(r=>r.onchange=async()=>{push();data.settings=data.settings||{};data.settings.translationMode=r.value;const box=document.getElementById('tr-quality');if(box)box.dataset.mode=r.value;$$('.tr-mode-opt').forEach(o=>{const i=o.querySelector('input');o.classList.toggle('active',!!(i&&i.checked));});const desc=document.getElementById('tr-mode-desc');if(desc)desc.textContent=ui(r.value==='direct'?'tr.modeDirectDesc':'tr.modeReviewDesc',r.value==='direct'?'翻译完成后即可用于作品集和发布，无需逐条确认；之后仍可预览和修改。':'机器翻译完成后，需要你确认翻译内容，确认后才会作为正式翻译显示和发布。');try{await saveNow(false);}catch(e){toast('模式保存失败：'+e.message);return;}toast(r.value==='direct'?'已切换：机器翻译直接使用 —— 生成后即可用于作品集和发布':'已切换：发布前审核 —— 译文需确认后才会正式显示和发布');refreshTrStatus();});
// —— 状态一栏：如实反映「没有人在后台审核」——
// 未生成 / 翻译草稿 · 待确认 / 已就绪 / 机器翻译 · 已就绪（原文改过 → 需要重新检查）。
function refreshTrStatus(){(async()=>{try{const s=await api('/api/i18n/content/status');if(!s||!s.ok)return;const direct=s.mode==='direct';Object.keys(s.langs||{}).forEach(l=>{const st=document.getElementById('t-status-'+l);if(!st)return;const v=s.langs[l];let t;if(!v.count)t=ui('tr.notGenerated','未生成');else if(direct)t=ui('tr.mtReady','机器翻译 · 已就绪');else t=v.reviewed?ui('tr.ready','已就绪'):ui('tr.draftPending','翻译草稿 · 待确认');if(v.stale)t+=' · '+ui('tr.stale','需要重新检查');st.textContent=t+(v.count?(' ('+v.count+')'):'');});}catch(_){}})();}
refreshTrStatus();
$$('[data-translation-generate]').forEach(button=>button.onclick=async()=>{
  const {translationKind:kind,translationKey:localeKey}=button.dataset;if(!localeKey)return;
  const original=button.textContent;button.disabled=true;button.textContent=ui('translation.generating','正在生成…');
  try{await api('/api/translation/draft',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind,localeKey})});data=await api('/api/data');resetUndo();render();toast(ui('translation.generated','英文 Draft 已生成，请预览后明确应用'));}
  catch(e){button.disabled=false;button.textContent=original;toast('翻译失败：'+e.message)}
});
$$('[data-translation-apply]').forEach(button=>button.onclick=async()=>{
  const {translationKind:kind,translationKey:localeKey}=button.dataset;if(!localeKey)return;button.disabled=true;
  try{await api('/api/translation/apply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind,localeKey})});data=await api('/api/data');resetUndo();render();notifyStudio();toast(ui('translation.applied','英文内容已审核：English 浏览者将看到此版本'));}
  catch(e){button.disabled=false;toast('无法应用英文 Draft：'+e.message)}
});
$$('[data-translation-cancel]').forEach(button=>button.onclick=async()=>{
  const {translationKind:kind,translationKey:localeKey}=button.dataset;if(!localeKey)return;button.disabled=true;
  try{await api('/api/translation/cancel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind,localeKey})});data=await api('/api/data');resetUndo();render();toast(ui('translation.cancelled','英文 Draft 已取消，中文原文未改变'));}
  catch(e){button.disabled=false;toast('取消失败：'+e.message)}
});
$('[data-static-text]')?.addEventListener('input',e=>{const id=e.target.dataset.staticText;saveStaticText(id,e.target.value)});
if(view==='资料'){// 上/下移一位：与**相邻可见行**交换（数组里可能有 null 占位，所以先取可见下标表，
  // 不能简单写 i±1 —— 相邻项是 null 时交换过去等于"点了没反应"）。
  const moveRow=(arr,i,dir)=>{const idx=[];arr.forEach((x,k)=>{if(x!=null)idx.push(k)});
    const at=idx.indexOf(i);const to=idx[at+dir];if(at<0||to==null)return false;
    const t=arr[i];arr[i]=arr[to];arr[to]=t;return true;};
  $('#add-contact')?.addEventListener('click',()=>{push();if(!Array.isArray(data.profile.contactLinks))data.profile.contactLinks=[];data.profile.contactLinks.push({label:'',value:''});render()});$$('.del-contact').forEach(b=>b.onclick=()=>{push();data.profile.contactLinks.splice(+b.dataset.i,1);render()});
  $$('.move-contact').forEach(b=>b.onclick=()=>{push();if(moveRow(data.profile.contactLinks,+b.dataset.i,+b.dataset.dir))render()});
  $('#add-link')?.addEventListener('click',()=>{push();if(!Array.isArray(data.profile.publicLinks))data.profile.publicLinks=[];data.profile.publicLinks.push({label:'',value:''});render()});$$('.del-link').forEach(b=>b.onclick=()=>{push();data.profile.publicLinks.splice(+b.dataset.i,1);render()});
  $$('.move-link').forEach(b=>b.onclick=()=>{push();if(moveRow(data.profile.publicLinks,+b.dataset.i,+b.dataset.dir))render()});
  // Resume 上传 / 移除 / 允许下载开关
  $('#resume-upload')?.addEventListener('change',async e=>{const file=e.target.files[0];if(!file)return;push();const ref=await upload(file,'resume');if(!ref||!ref.url){toast('简历上传失败');return;}data.resume={url:ref.url,name:ref.name||file.name,allowDownload:!!(data.resume&&data.resume.allowDownload)};render();toast('简历已上传')});
  $('#resume-remove')?.addEventListener('click',()=>{if(!confirm('移除已上传的简历？作品集将不再显示 Resume 区块。'))return;push();data.resume=null;render();toast('已移除简历')});
  $('#resume-allow')?.addEventListener('change',e=>{push();data.resume=data.resume||{};data.resume.allowDownload=!!e.target.checked;render();toast(e.target.checked?'已允许浏览者下载':'已禁止浏览者下载')});
  // 音频介绍 上传 / 移除（仿 Resume；kind='audioIntro' 走 /api/upload 普通媒体目录，无需服务端改动）
  $('#audio-intro-upload')?.addEventListener('change',async e=>{const file=e.target.files[0];if(!file)return;push();const ref=await upload(file,'audioIntro');if(!ref||!ref.url){toast('音频上传失败');return;}data.audioIntro={url:ref.url,name:ref.name||file.name};render();toast('Audio 已上传')});
  $('#audio-intro-remove')?.addEventListener('click',async()=>{if(!confirm('移除已上传的 Audio？作品集将不再显示该音频，已选入次展示区的记录也会一并取消。'))return;push();data.audioIntro=null;
    // 同步从展示区配置里摘掉 audioIntro，避免它占着次展示区名额却什么都不显示
    const FZ=window.FF_ZONES;
    if(FZ&&FZ.resolve&&displayZones){const cur=FZ.resolve(displayZones);const next={hero:cur.hero,secondary:(cur.secondary||[]).filter(k=>k!=='audioIntro')};await saveDisplayZones(next);}
    render();toast('已移除 Audio')});
  // —— 展示区勾选 ——
  // ⚠ 闭包写法注意：这里用的是 forEach 捕获的 `cb` 自己（`cb.checked`），
  //    不写 `e.target` —— 内层箭头若不带参数再用 e.target.value 会取到 undefined
  //    （本项目 editor-v3.js 曾在这类写法上翻过车，见记忆）。
  $$('.zone-opt input[type=checkbox]').forEach(cb=>{cb.onchange=async()=>{
    const FZ=window.FF_ZONES; if(!FZ||!FZ.resolve) return;
    const zone=cb.dataset.zone, key=cb.dataset.zoneKey;
    const cur=FZ.resolve(displayZones);
    let list=(cur[zone]||[]).slice();
    if(cb.checked){
      if(list.length>=FZ.MAX){cb.checked=false;toast(`每个展示区最多 ${FZ.MAX} 项，请先取消一项再选`);return}
      list.push(key);
    }else{
      // 主展示区不允许清空：一个什么都不显示的人名牌只会留下一块空白
      if(zone==='hero'&&list.length<=1){cb.checked=true;toast('主展示区至少要保留 1 项');return}
      list=list.filter(x=>x!==key);
    }
    const next={hero:cur.hero,secondary:cur.secondary}; next[zone]=list;
    await saveDisplayZones(next);
    render();
    toast(zone==='hero'?'主展示区已更新':'次展示区已更新');
  }});
}$('#undo').onclick=()=>undoStep();
$('#save').onclick=()=>saveNow(false);
$('#visual').onclick=()=>gotoPanel('visual','/visual-editor/');$('#preview').onclick=()=>{if(IN_STUDIO){gotoPanel('portfolio','/portfolio/');return}open('/portfolio/?mode=draft','_blank')}; // 预览当前草稿经保存后的 Portfolio 效果（未发布仍是本地预览）
$('#restore').onclick=async()=>{await api('/api/restore',{method:'POST'});data=await api('/api/data');resetUndo();render();toast('已恢复上一版')};
if(view==='页面结构'){const move=(i,d)=>{const arr=currentSections();const n=i+d;if(n<0||n>=arr.length)return;[arr[n],arr[i]]=[arr[i],arr[n]];saveTplSectionOrder(arr);render();};$$('.struct-up').forEach(b=>b.onclick=()=>move(+b.dataset.i,-1));$$('.struct-down').forEach(b=>b.onclick=()=>move(+b.dataset.i,1));$$('[data-section-title]').forEach(e=>e.oninput=()=>{push('st:'+e.dataset.sectionTitle);data.sectionTitles=data.sectionTitles||{};data.sectionTitles[e.dataset.sectionTitle]=e.value;});$$('[data-section-visible]').forEach(e=>e.onchange=()=>{push();data.settings=data.settings||{};data.settings.sectionVisibility=data.settings.sectionVisibility||{};data.settings.sectionVisibility[e.dataset.sectionVisible]=e.checked;});$('#save-struct')?.addEventListener('click',async()=>{await saveNow(false);toast('区块名称 / 显示状态已保存（顺序属于模板，已即时保存）');});
  // —— 区块级 Logo：上传 / 位置 / 删除 ——
  // 写进 data.sectionLogos[key]，key 为区块 id；保存后作品集与排版编辑共用同一份数据。
  // 不加这层守卫的话，"其它视图"里同名 class 的节点会拿到错误 key。
  $$('.section-logo-file').forEach(e=>e.onchange=async()=>{const file=e.files[0];if(!file)return;if(file.size>LOGO_MAX_BYTES){toast('Logo 不能超过 2MB（当前 '+(file.size/1048576).toFixed(1)+'MB）');e.value='';return;}push();const k=e.dataset.key;const ref=await upload(file,'ai-voices');if(!ref||!ref.url){toast('Logo 上传失败');return;}data.sectionLogos=data.sectionLogos||{};const old=data.sectionLogos[k]||{};data.sectionLogos[k]=Object.assign({},old,{url:ref.url,pos:old.pos==='before'?'before':'after'});render();toast('区块 Logo 已添加')});
  $$('.section-logo-pos').forEach(s=>s.onchange=()=>{push();const k=s.dataset.key;data.sectionLogos=data.sectionLogos||{};const lg=data.sectionLogos[k];if(!lg)data.sectionLogos[k]={url:logoUrl({logo:lg})};data.sectionLogos[k].pos=s.value==='before'?'before':'after';render()});
  $$('.remove-section-logo').forEach(b=>b.onclick=()=>{push();const k=b.dataset.key;if(data.sectionLogos)delete data.sectionLogos[k];render();toast('区块 Logo 已删除')});
}


function styleHandler(e){
  const el=e.target||e;
  push();data.styles[el.dataset.style]=el.value;previewStyle(el.dataset.style,el.value);
  const out=el.nextElementSibling;if(out&&out.tagName==='OUTPUT')out.textContent=el.value+(el.dataset.style==='titleSize'||el.dataset.style==='bodySize'?'px':'')
}
if(view==='项目'){
  const p=data.projects[selected];
  const removeAndPersist=change=>{push();p.media=p.media||{};change();render();saveNow(true)};
  $$('[data-select]').forEach(b=>b.onclick=()=>{selected=+b.dataset.select;render()});
  const group=$('[data-group]'); if(group)group.onchange=e=>{push();p.groupId=e.target.value;render()};
  const sdt=$('[data-show-details]');if(sdt){sdt.onchange=e=>{push();if(e.target.checked)delete p.showDetails;else p.showDetails=false;const desc=$('.detail-toggle-desc');if(desc)desc.textContent=e.target.checked?'详细展示（可展开完整介绍与媒体）':'简略展示（仅显示名称/时间/角色/Key Work，不可展开）';toast(e.target.checked?'已设为详细展示':'已设为简略展示（作品集不显示展开入口）')}};
  const raw=$('#raw-material'); if(raw)raw.oninput=e=>{push('raw:'+selected);p.rawMaterial=e.target.value};
  const add=$('#add-project');if(add)add.onclick=()=>{push();const gid=(data.projects[selected]&&data.projects[selected].groupId)||(data.projectGroups[0]||{}).id||'';data.projects.push({name:'',groupId:gid,date:'',role:'',rawMaterial:'',structuredContent:{summary:'',keyWork:[],highlights:[]},media:{mainVisual:null,processImages:[],video:null,audio:null,externalVideoUrl:'',externalLink:''}});selected=data.projects.length-1;render()};
  const del=$('#delete-project');if(del)del.onclick=()=>{if(!confirm('删除此项目？'))return;push();data.projects.splice(selected,1);selected=Math.max(0,selected-1);render()};
  const up=$('#move-up'),down=$('#move-down');if(up)up.onclick=()=>moveProject(-1);if(down)down.onclick=()=>moveProject(1);
  $$('.upload-project').forEach(e=>e.onchange=async()=>{const files=[...e.files];if(!files.length)return;push();p.media=p.media||{};const refs=(await Promise.all(files.map(f=>upload(f,'projects')))).filter(Boolean);if(e.dataset.slot==='processImages'){p.media.processImages=Array.isArray(p.media.processImages)?p.media.processImages:[];p.media.processImages.push(...refs)}else p.media[e.dataset.slot]=refs[0]||null;render()});
  $$('.remove-media').forEach(b=>b.onclick=()=>removeAndPersist(()=>{p.media[b.dataset.slot]=null}));
  $$('.remove-process-image').forEach(b=>b.onclick=()=>removeAndPersist(()=>{p.media.processImages=Array.isArray(p.media.processImages)?p.media.processImages:[];p.media.processImages.splice(+b.dataset.index,1)}));
  $$('.remove-media-text').forEach(b=>b.onclick=()=>removeAndPersist(()=>{p.media[b.dataset.slot]=''}));
}
if(view==='分类'){$$('[data-cat-title]').forEach(e=>e.oninput=()=>{push('ct:'+e.dataset.catTitle);data.projectGroups[+e.dataset.catTitle].title=e.value});$$('.ai-cat').forEach(b=>b.onclick=(ev)=>{ev.preventDefault();ev.stopImmediatePropagation();const i=+b.dataset.i;const g=data.projectGroups[i];const ps=data.projects.filter(p=>p.groupId===g.id);if(!ps.length){toast('该分类下暂无项目，无法归纳类别介绍');return}openCategoryOrganizer(g,ps)});$('#add-category')?.addEventListener('click',()=>{push();data.projectGroups.push({id:'cat-'+Date.now(),title:'',description:''});render()});$$('.del-cat').forEach(b=>b.onclick=(ev)=>{ev.preventDefault();ev.stopPropagation();deleteCategory(+b.dataset.i)})}if(view==='经历'){$('#add-exp').onclick=()=>{push();data.experience.push({company:'',position:'',date:'',rawMaterial:'',structuredContent:{summary:'',responsibilities:[],highlights:[]},media:{image:null}});render()};$$('.delete-exp').forEach(b=>b.onclick=()=>{push();data.experience.splice(+b.dataset.i,1);render()});$$('.upload-exp').forEach(e=>e.onchange=async()=>{const file=e.files[0];if(!file)return;push();const i=+e.dataset.i;const ex=data.experience[i];ex.media=ex.media||{};const ref=await upload(file,'experience');if(!ref||!ref.url){toast('图片上传失败');return;}ex.media.image=ref;render()});$$('.remove-exp-media').forEach(b=>b.onclick=()=>{push();const i=+b.dataset.i;const ex=data.experience[i];if(ex.media)ex.media.image=null;render()});$$('.apply-exp').forEach(b=>b.onclick=()=>{const e=data.experience[+b.dataset.i],r=e.aiDraft;if(!r)return;e.structuredContent={summary:r.summary,responsibilities:r.responsibilities,highlights:r.highlights};e.summary=r.summary;e.responsibilities=r.responsibilities;e.highlights=r.highlights;if(r.position)e.position=r.position;mergeExperienceKeyWorkToHighlights(e);delete e.aiDraft;render();toast('整理结果已应用（Key Work 已合并到 Highlights）')})}
if(view==='Showreel'){const sr=data.showreel;const cur=sr.projects[selectedShowreel]||sr.projects[0];
  $('#sr-select')?.addEventListener('change',e=>{selectedShowreel=+e.target.value;render()});
  // 新建 Showreel 项目：showreel.projects 里新增一项（不是 Works 项目，也不是章节）
  $('#add-sr-project')?.addEventListener('click',()=>{push();sr.projects=sr.projects||[];sr.projects.push({id:'sr_'+Date.now().toString(36),name:'',role:'',media:null,externalVideoUrl:'',chapters:[]});selectedShowreel=sr.projects.length-1;render();toast('已新建 Showreel 项目：可上传视频、填外部链接、添加章节')});
  $('#del-sr-project')?.addEventListener('click',()=>{if(!sr.projects.length)return;if(!confirm('确定删除这个 Showreel 项目（含其章节）吗？可通过「恢复上一版」撤销。'))return;push();sr.projects.splice(selectedShowreel,1);selectedShowreel=0;render()});
  // 上传视频：只换当前项目的 media，**保留**该项目已有章节时间点
  $('#show-upload')?.addEventListener('change',async e=>{const file=e.target.files[0];if(!file)return;push();const ref=await upload(file,'showreel');const oldN=(cur.chapters||[]).length;cur.media=ref;cur.externalVideoUrl='';render();toast(`视频已更换为 ${ref.name}，当前项目原有 ${oldN} 个章节时间点已保留`)});
  $('#remove-show-video')?.addEventListener('click',()=>{push();cur.media=null;toast('已移除当前项目的本地视频，章节时间点已保留');render()});
  const v=$('#edit-video');const seek=$('#edit-seek');const clock=$('#clock');
  if(v){
    // 同一视频：绝不重新 load（load 会把 currentTime 归零、时间轴跳回 00）。
    // 仅当换视频（src 变了）才 load；否则只把进度恢复到重渲染前的位置。
    if(_videoPre&&(_videoPre.src===v.currentSrc||_videoPre.src===v.src)){
      // 同一视频：立即把进度恢复到重渲染前的位置（元数据就绪时直接生效）；
      // 若新元素尚未就绪，等元数据到达后再 seek 一次（否则首帧为 0，时间轴跳回 00）。
      const restore=()=>{try{v.currentTime=_videoPre.t;}catch(_){}};
      restore();
      if(v.readyState<1) v.addEventListener('loadedmetadata',restore,{once:true});
    }else{v.load();}
  }
  // Showreel 预览视频默认音量 50%、倍速 1（与展示页一致）；观看者可在原生控件自行调节。
  if(v){ v.volume = 0.5; v.playbackRate = 1; }
  v?.addEventListener('timeupdate',()=>{if(clock)clock.textContent=`当前时间 ${stamp(v.currentTime)} / 总时长 ${stamp(v.duration)}`;if(seek&&v.duration&&!seek._dragging)seek.value=Math.round(v.currentTime/v.duration*1000)});
  v?.addEventListener('loadedmetadata',()=>{if(clock)clock.textContent=`当前时间 ${stamp(0)} / 总时长 ${stamp(v.duration)}`});
  if(seek&&v){seek.addEventListener('input',()=>{seek._dragging=true;if(v.duration)v.currentTime=seek.value/1000*v.duration;if(clock)clock.textContent=`当前时间 ${stamp(v.currentTime)} / 总时长 ${stamp(v.duration)}`});seek.addEventListener('change',()=>{seek._dragging=false});}
  // 记录时间：直接写数据+更新对应 input，绝不调用 render()（避免重建 video）
  $$('.set-time').forEach(b=>b.onclick=()=>{if(!v)return;push();const c=cur.chapters[+b.dataset.i];if(!c)return;const t=stamp(v.currentTime);c[b.dataset.kind]=t;const input=document.querySelector(`input[data-key="chapter.${b.dataset.i}.${b.dataset.kind}"]`);if(input)input.value=t;toast(`${b.dataset.kind==='start'?'开始':'结束'}时间已记录为 ${t}，视频未重置`)});
  $$('.chapter-project').forEach(sel=>sel.onchange=()=>{const i=+sel.dataset.i;const c=cur.chapters[i];const val=sel.value;push();if(val===''){delete c.projectId;}else{c.projectId=+val;const p=data.projects[+val];if(p){c.title=p.name;c.role=p.role;}}const card=document.querySelector(`.chapter-card[data-i="${i}"]`);if(card){const ti=card.querySelector('.chapter-title');const ri=card.querySelector('.chapter-role');const p=val!==''?data.projects[+val]:null;if(ti)ti.value=p?p.name:(c.title||'');if(ri)ri.value=p?p.role:(c.role||'');}toast(val===''?'已取消关联':'已关联项目，名称与角色自动填充')});
  $$('.chapter-title').forEach(input=>input.oninput=()=>{const i=+input.dataset.i,c=cur.chapters[i];push('cht:'+i);c.title=input.value;if(c.projectId!=null&&data.projects[c.projectId])data.projects[c.projectId].name=input.value});
  $$('.chapter-role').forEach(input=>input.oninput=()=>{const i=+input.dataset.i,c=cur.chapters[i];push('chr:'+i);c.role=input.value;if(c.projectId!=null&&data.projects[c.projectId])data.projects[c.projectId].role=input.value});
  $('#add-chapter')?.addEventListener('click',()=>{push();cur.chapters=cur.chapters||[];cur.chapters.push({projectId:null,title:'',role:'',start:'00:00:00.000',end:'00:00:00.000'});render()});
  $$('.del-chapter').forEach(b=>b.onclick=()=>{push();cur.chapters.splice(+b.dataset.i,1);render()});
  $$('.chapter-move').forEach(b=>b.onclick=()=>{const i=+b.dataset.i,n=i+(+b.dataset.d);if(n<0||n>=cur.chapters.length)return;push();[cur.chapters[i],cur.chapters[n]]=[cur.chapters[n],cur.chapters[i]];render()});
  $('#reset-chapters')?.addEventListener('click',()=>{if(!(cur.chapters||[]).length){toast('当前项目没有章节可清零');return}if(!confirm(`确定要清除当前项目所有章节时间点吗？

将重置 ${cur.chapters.length} 个章节的 start/end 为 00:00:00.000。

此操作可通过「恢复上一版本」撤销。`))return;push();cur.chapters.forEach(c=>{c.start='00:00:00.000';c.end='00:00:00.000'});toast('已清零当前项目的章节时间点（可通过恢复上一版本撤销）');render()});
}
if(view==='设置'||view==='样式'){$$('[data-preset]').forEach(el=>{el.onclick=async()=>{const id=el.dataset.preset;const t=THEMES[id];if(!t)return;designTheme={mode:t.mode,preset:id};applyTheme(t);await saveDesignTheme();render();notifyStudio();toast(`已切换到 ${t.label}，编辑器预览与作品集共用`)}});}
if(view==='设置'){const runB=$('#env-check-run');if(runB)runB.onclick=()=>runEnvCheck();}
if(view==='项目'){
  // 「添加外部视频 / 外部链接」：点一下应当弹出输入框让用户填链接，而不是把字段置空（置空会让
  // 渲染又回到同一个按钮，看起来像"按了没反应"）。用原生 prompt 收集，是模态、不与编辑器
  // 的 Composition/render 重画抢焦点，IME 也安全。返回 null = 取消，什么都不改。
  $('.add-external-video')?.addEventListener('click',()=>{
    const cur=data.projects[selected]; if(!cur)return; cur.media=cur.media||{};
    const url=window.prompt(z('请输入外部视频链接（B 站 / YouTube 播放页等），可留空清除：'), cur.media.externalVideoUrl||'');
    if(url===null)return;
    push(); cur.media.externalVideoUrl=url.trim(); render();
  });
  $('.add-external-link')?.addEventListener('click',()=>{
    const cur=data.projects[selected]; if(!cur)return; cur.media=cur.media||{};
    const url=window.prompt(z('请输入外部链接（GitHub / 作品站等），可留空清除：'), cur.media.externalLink||'');
    if(url===null)return;
    push(); cur.media.externalLink=url.trim(); render();
  });
}
if(view===sectionLabel('aiVoices')){$('#add-ai-project')?.addEventListener('click',()=>{push();data.aiVoices.projects=data.aiVoices.projects||[];data.aiVoices.projects.push({name:'',summary:'',role:'',positioning:'',contribution:'',tech:[],highlights:[],githubUrl:'',liveDemoUrl:'',media:{image:null,screenshots:[],video:null}});render()});$$('.ai-project-delete').forEach(b=>b.onclick=()=>{push();data.aiVoices.projects.splice(+b.dataset.i,1);render()});$$('.ai-project-upload').forEach(e=>e.onchange=async()=>{const file=e.files[0];if(!file)return;push();const i=+e.dataset.i;const p=data.aiVoices.projects[i];p.media=p.media||{image:null,screenshots:[]};p.media[e.dataset.slot]=await upload(file,'ai-voices');render()});$$('.ai-project-shots').forEach(e=>e.onchange=async()=>{const files=[...e.files];if(!files.length)return;push();const i=+e.dataset.i;const p=data.aiVoices.projects[i];p.media=p.media||{image:null,screenshots:[]};p.media.screenshots=p.media.screenshots||[];const refs=await Promise.all(files.map(f=>upload(f,'ai-voices')));p.media.screenshots.push(...refs);render()});$$('.remove-ai-media').forEach(b=>b.onclick=()=>{push();const i=+b.dataset.i;const p=data.aiVoices.projects[i];p.media=p.media||{};p.media[b.dataset.slot]=null;render()});$$('.remove-ai-shot').forEach(b=>b.onclick=()=>{push();const i=+b.dataset.i,si=+b.dataset.si;const p=data.aiVoices.projects[i];if(p.media&&p.media.screenshots)p.media.screenshots.splice(si,1);render()});
$$('.ai-project-logo').forEach(e=>e.onchange=async()=>{const file=e.files[0];if(!file)return;if(file.size>LOGO_MAX_BYTES){toast('Logo 不能超过 2MB（当前 '+(file.size/1048576).toFixed(1)+'MB）');e.value='';return;}push();const i=+e.dataset.i;const p=data.aiVoices.projects[i];const ref=await upload(file,'ai-voices');if(!ref||!ref.url){toast('Logo 上传失败');return;}p.logo=Object.assign({},p.logo||{},{url:ref.url,pos:(p.logo&&p.logo.pos)==='before'?'before':'after'});render();toast('Logo 已添加')});
$$('.ai-project-logo-pos').forEach(s=>s.onchange=()=>{push();const i=+s.dataset.i;const p=data.aiVoices.projects[i];if(!p.logo)p.logo={url:logoUrl(p)};p.logo.pos=s.value==='before'?'before':'after';render()});
$$('.remove-ai-logo').forEach(b=>b.onclick=()=>{push();const i=+b.dataset.i;const p=data.aiVoices.projects[i];delete p.logo;render();toast('Logo 已删除')})}}
function openCategoryOrganizer(group, projects){
  document.querySelector('#cat-organizer-dialog')?.remove();
  const dialog=document.createElement('dialog');
  dialog.id='cat-organizer-dialog';
  dialog.style.cssText='width:min(760px,90vw);max-height:90vh;overflow:auto;padding:24px;background:#f3f0e9;color:#161616';
  const projectList=projects.map(p=>`<li>${esc(p.name)}${p.role?` · ${esc(p.role)}`:''}</li>`).join('');
  dialog.innerHTML=`<h2>AI 整理类别介绍</h2><p class="hint">类别：<strong>${esc(group.title)}</strong></p><p class="hint">将根据以下 ${projects.length} 个项目的内容归纳共同工作 / 创作特点：</p><ul class="cat-projects">${projectList}</ul><p id="cat-status" role="status" aria-live="polite"></p><button class="button" id="cat-run">开始 AI 整理</button><section id="cat-result" hidden><h3>AI 整理结果（可手动修改）</h3><textarea id="cat-summary" style="min-height:120px;white-space:pre-wrap"></textarea><div style="margin-top:12px"><button class="button primary" id="cat-apply">应用结果</button><button class="button" id="cat-cancel-apply">取消</button></div></section><button class="button" id="cat-close">关闭</button>`;
  document.body.append(dialog);
  const q=s=>dialog.querySelector(s);
  const run=q('#cat-run'),status=q('#cat-status');
  let summary=null,controller=null;
  const close=()=>{controller?.abort();dialog.close();dialog.remove()};
  dialog.addEventListener('cancel',e=>{e.preventDefault();close()});
  q('#cat-close').onclick=close;q('#cat-cancel-apply').onclick=close;
  run.onclick=async()=>{
    controller=new AbortController();run.disabled=true;status.textContent='AI 正在分析该类别项目，归纳共同点……请稍候。';
    try{
      const response=await fetch('/api/ai/category',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({categoryName:group.title,projects:projects.map(p=>({name:p.name,summary:p.summary,role:p.role,keyWork:p.keyWork,highlights:p.highlights}))}),signal:controller.signal});
      const body=await response.json();
      if(!response.ok)throw Error(body.error||'AI 请求失败');
      summary=body.result.categorySummary;
      q('#cat-summary').value=summary||'';
      q('#cat-result').hidden=false;
      status.textContent=summary?'请审核结果，点击「应用结果」后写入类别介绍。':'AI 判断该项目信息不足以归纳共同点，结果留空。';
      run.textContent='重新整理';
    }catch(error){if(error.name!=='AbortError')status.textContent=error.message}
    finally{run.disabled=false}
  };
  q('#cat-apply').onclick=()=>{
    if(summary==null){status.textContent='请先点击「开始 AI 整理」。';return}
    push();
    group.description=q('#cat-summary').value.trim();
    close();render();toast('类别介绍已写入，请保存草稿');
  };
  dialog.showModal();
}
function previewStyle(key,value){const map={text:['--ink'],background:['--paper'],accent:['--accent']};if(map[key]){map[key].forEach(v=>document.documentElement.style.setProperty(v,value))}else if(key==='titleSize')document.documentElement.style.setProperty('--editor-title-size',value+'px');else if(key==='bodySize')document.documentElement.style.setProperty('--editor-body-size',value+'px');else if(key==='font'){const f={'Noto Sans SC':"'Noto Sans SC',sans-serif",Georgia:'Georgia,serif',Arial:'Arial,sans-serif'}[value]||value;document.documentElement.style.setProperty('--editor-font',f)}else if(key==='weight')document.documentElement.style.setProperty('--editor-font-weight',value);else if(key==='spacing'){document.documentElement.style.setProperty('--editor-spacing',{small:'28px',medium:'48px',large:'72px'}[value]||'48px')}}
function moveProject(d){const n=selected+d;if(n<0||n>=data.projects.length)return;push();[data.projects[selected],data.projects[n]]=[data.projects[n],data.projects[selected]];selected=n;render()}
/** Experience：把旧的 keyWork/responsibilities 合并进 highlights（不丢失信息）。 */
function mergeExperienceKeyWorkToHighlights(e){const kw=Array.isArray(e.responsibilities)?e.responsibilities.slice():[];const hl=Array.isArray(e.highlights)?e.highlights.slice():[];if(!kw.length)return;const merged=hl.slice();kw.forEach(k=>{if(!k)return;const exists=merged.some(x=>x&&x.replace(/\s+/g,'')===k.replace(/\s+/g,''));if(!exists)merged.push(k)});e.highlights=merged;e.responsibilities=[]}
async function boot(){try{data=await api('/api/data');data.projects.forEach(p=>{p.structuredContent=p.structuredContent||{summary:p.summary||'',keyWork:p.keyWork||[],highlights:p.highlights||[]};p.media=p.media||{mainVisual:null,processImages:[],video:null,audio:null,externalVideoUrl:'',externalLink:''}});data.experience.forEach(e=>{e.structuredContent=e.structuredContent||{summary:e.summary||'',responsibilities:[],highlights:[]};if(!e.responsibilities)e.responsibilities=Array.isArray(e.keyWork)?e.keyWork:[];mergeExperienceKeyWorkToHighlights(e)});if(!Array.isArray(data.profile.contactLinks)){data.profile.contactLinks=Object.entries(data.profile.contact||{}).filter(([,v])=>v).map(([k,v])=>({label:k,value:v}))}
// 2026-09-24：Contact 与 Links 拆分的一次性迁移 —— 旧数据里 URL 形态的条目归到 Links（点击跳转），
// 其余（邮箱/微信等）留在 Contact（点击复制）。只跑一次：迁移后 publicLinks 已是数组就不再动。
if(!Array.isArray(data.profile.publicLinks)){
  const isUrl=v=>/^(https?:\/\/|\/\/)/i.test(String(v||'').trim());
  const keep=[],moved=[];
  (data.profile.contactLinks||[]).forEach(x=>{ if(x&&isUrl(x.value)) moved.push(x); else keep.push(x); });
  data.profile.contactLinks=keep;
  data.profile.publicLinks=moved;
}data.settings=data.settings||{};data.sectionTitles=data.sectionTitles||{};data.sectionTitleTranslations=data.sectionTitleTranslations||{};data.sectionTitleTranslations.en=data.sectionTitleTranslations.en||{};data.sectionLogos=data.sectionLogos||{};data.aiVoices=data.aiVoices||{};data.aiVoices.projects=Array.isArray(data.aiVoices.projects)?data.aiVoices.projects:[];data.showreel=data.showreel||{};data.showreel.projects=Array.isArray(data.showreel.projects)?data.showreel.projects:[];selectedShowreel=Math.max(0,Math.min(selectedShowreel,data.showreel.projects.length-1));await loadTplSectionOrder();await loadTranslationStatus();await loadStaticText();const t=resolveTheme({theme:currentTheme()});applyTheme(t);render();checkRecovery()}catch(e){$('#editor-app').innerHTML=`<div class="editor-error">编辑器无法加载：${esc(e.message)}</div>`}}
if(I18N)window.addEventListener('ff-locale-change',()=>{if(data)render()});
// 面板里所有界面文案自动跟随语言：首屏 + 之后每次 render() 重画出来的都算。
// 用观察器而不是在 render() 里手插一行 —— 这个文件里还有十几个局部重画入口
// （上传卡片、压缩卡片、翻译面板…），逐个插一定会漏。
if(I18N&&I18N.autoTranslate)I18N.autoTranslate(document.body);
// —— Phase 4：意外关闭恢复 ——
// 启动时查一次「抢救副本」（rescued-*.json，异常关闭/被拦截的保存留下的）。
// 只提示、绝不自动恢复；「放弃」只是本次浏览器会话不再提醒，文件原样保留在磁盘上。
let ffRescuedPending=[];
// ⚠ 键必须带模板：抢救副本是按模板分开的，在 A 里点「放弃」不该让 B 的抢救副本也不再提醒。
const _RECOVERY_KEY='ff.recovery.dismissed.'+TPL_ID;
function _recoveryDismissed(){try{return JSON.parse(sessionStorage.getItem(_RECOVERY_KEY)||'[]')}catch(_){return[]}}
async function checkRecovery(){
  try{
    const r=await api('/api/recovery/status'); if(!r||!r.ok) return;
    ffRescuedPending=(r.rescued||[]).filter(x=>/^portfolio\.rescued-/.test(x.name)&&!/prerestore/.test(x.name));
    restoreRecoveryBanner();
  }catch(_){}
}
function restoreRecoveryBanner(){
  const dismissed=_recoveryDismissed();
  const pending=ffRescuedPending.filter(x=>!dismissed.includes(x.name));
  if(!pending.length) return;
  if(document.getElementById('recovery-banner')) return;
  showRecoveryBanner(pending);
}
function showRecoveryBanner(pending){
  const main=document.querySelector('.editor .main'); if(!main) return;
  const old=document.getElementById('recovery-banner'); if(old) old.remove();
  const div=document.createElement('div'); div.id='recovery-banner'; div.className='recovery-banner';
  div.innerHTML='<div class="rb-text"><b>'+esc(ui('recovery.title','检测到上次未恢复的编辑内容'))+'</b>'
    +'<span>'+esc(ui('recovery.found','找到了上次未正常收尾时自动保存的抢救副本：'))+'</span> '
    +pending.map(x=>'<code>'+esc(x.name)+'</code>').join(' ')+'</div>'
    +'<div class="rb-actions">'
    +'<button class="button small" type="button" data-rb="diff">'+esc(ui('recovery.diff','查看差异'))+'</button>'
    +'<button class="button small primary" type="button" data-rb="restore">'+esc(ui('recovery.restore','恢复最新一份'))+'</button>'
    +'<button class="button small" type="button" data-rb="dismiss">'+esc(ui('recovery.dismiss','放弃'))+'</button></div>'
    +'<div class="rb-diff" hidden></div>';
  main.insertBefore(div, main.firstChild);
  const diffBox=div.querySelector('.rb-diff');
  div.querySelector('[data-rb=diff]').onclick=async()=>{
    if(!diffBox.hidden){diffBox.hidden=true;return;}
    diffBox.hidden=false;
    diffBox.innerHTML='<p class="hint">'+esc(ui('recovery.diffLoading','正在比较…'))+'</p>';
    try{
      const j=await api('/api/recovery/diff?name='+encodeURIComponent(pending[0].name));
      if(!j.ok) throw Error(j.error||'diff failed');
      const stMap={same:['recovery.st.same','一致'],changed:['recovery.st.changed','有改动'],
                   onlyRescued:['recovery.st.onlyRescued','仅备份里有'],onlyDraft:['recovery.st.onlyDraft','仅草稿里有']};
      diffBox.innerHTML='<p class="hint">'+esc(ui('recovery.diffTitle','与当前草稿的差异（顶层摘要）：'))+'</p>'
        +'<div class="rb-diff-rows">'+j.rows.map(row=>{
          const m=stMap[row.state]||stMap.same;
          const titles=[].concat(row.rescuedTitles||[],row.draftTitles||[]).filter(Boolean).slice(0,4).join(' / ');
          return '<div class="rb-diff-row"><code>'+esc(row.key)+'</code><span class="rb-st rb-'+row.state+'">'+esc(ui(m[0],m[1]))+'</span>'
            +(titles?'<em>'+esc(titles)+'</em>':'')+'</div>';
        }).join('')+'</div>';
    }catch(e){ diffBox.innerHTML='<p class="hint">'+esc(e.message)+'</p>'; }
  };
  div.querySelector('[data-rb=restore]').onclick=async()=>{
    const newest=pending[0];
    if(!confirm(ui('recovery.confirm','恢复前会先把当前草稿另存一份新的抢救副本，然后用所选备份覆盖当前草稿（已发布内容、媒体不受影响）。确定恢复「'+newest.name+'」吗？')))return;
    try{
      const j=await api('/api/recovery/restore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:newest.name})});
      if(!j.ok)throw Error(j.error||'restore failed');
      data=await api('/api/data'); resetUndo(); render(); notifyStudio();
      toast(ui('recovery.restored','已恢复')+'：'+(j.restoredFrom||'')+(j.preBackup?('（原草稿已备份为 '+j.preBackup+'）'):''));
      ffRescuedPending=ffRescuedPending.filter(x=>x.name!==newest.name);
      dismissRecovery([newest]);
    }catch(e){ toast(ui('recovery.restoreFailed','恢复失败')+'：'+e.message); }
  };
  div.querySelector('[data-rb=dismiss]').onclick=()=>{ffRescuedPending=ffRescuedPending.filter(x=>!pending.some(p=>p.name===x.name));dismissRecovery(pending)};
}
function dismissRecovery(pending){
  const dismissed=_recoveryDismissed();
  pending.forEach(x=>{if(!dismissed.includes(x.name))dismissed.push(x.name)});
  sessionStorage.setItem(_RECOVERY_KEY,JSON.stringify(dismissed));
  const b=document.getElementById('recovery-banner'); if(b)b.remove();
}
boot();
document.addEventListener('click',event=>{
 const button=event.target.closest('#organize,#regenerate,.ai-exp');
 if(!button)return;
 event.preventDefault();event.stopImmediatePropagation();
 const kind=button.classList.contains('ai-exp')?'experience':'project';
 const record=kind==='experience'?data.experience[+button.dataset.i]:data.projects[selected];
 // 「整理方向」必须真的传下去（以前只是摆着看，后端 PROMPT 写死 → 选什么都一样）。
 // 经历页没有外部方向控件，对话框里会自带一个，默认作品集导向。
 const style=$('#ai-style')?$('#ai-style').value:'';
 openOrganizer(kind,record,kind==='project'?style:'');
},true);
// 媒体删除必须在重绘后依然可用：用委托监听替代只绑定当前 DOM 节点的方式。
// 这也避免“按钮看得到但点击无效”的旧问题。
document.addEventListener('click',event=>{
  const button=event.target.closest('.remove-media,.remove-process-image,.remove-media-text');
  if(!button||view!=='项目')return;
  const p=data&&data.projects&&data.projects[selected];
  if(!p)return;
  event.preventDefault();event.stopImmediatePropagation();
  push();p.media=p.media||{};
  if(button.classList.contains('remove-process-image')){
    p.media.processImages=Array.isArray(p.media.processImages)?p.media.processImages:[];
    p.media.processImages.splice(+button.dataset.index,1);
  }else if(button.classList.contains('remove-media-text')){
    p.media[button.dataset.slot]='';
  }else{
    p.media[button.dataset.slot]=null;
  }
  render();saveNow(true);
},true);

/* ============================================================================
 * 视频压缩（就地转码）
 * ----------------------------------------------------------------------------
 * 为什么必须要有这一步：
 *   GitHub Pages 是能正常内联播放视频的（Pages 按后缀下发 Content-Type: video/mp4，
 *   并且支持 Range 分段请求）。但 Git 单文件硬上限 100MB，超过就只能走 GitHub Release 附件，
 *   而 Release 附件的响应头被 GitHub 固定成
 *       Content-Type: application/octet-stream
 *       Content-Disposition: attachment
 *   浏览器遇到这种响应一律拒绝内联播放（<video> 直接 onerror），只能「下载」。
 *   于是「上传成功、网址能打开、点开视频却提示浏览器解不了」就出现了 ——
 *   真正原因是下发方式，不是编码。唯一解法：压到上限以内，让它回到 Pages 托管。
 *   顺带解决第二个真问题：1920×1440 / H.264 Level 5.0 这种非主流规格，
 *   很多手机和微信内置浏览器没有硬解，压到 1920×1080 以内 / Level 4.x 才是真「到处能播」。
 * ========================================================================== */
const COMPRESS_LIMIT_MB = 90;
const VIDEO_EXT_RE = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;
// 最近一次上传服务端返回的安全提示（只留在内存，不写进数据）。
// ⚠ 必须是「url → 文本」的绑定，不能是一裸字符串：旧实现把同一条警告渲染进**每一张**压缩卡，
//    于是「给某个项目传了个 95MB 的大视频」会让同模板里所有视频卡（含 8MB 的小片）都顶着那条超限警告
//    —— 同一种"状态不属于当前条目"的错误模式，和跨模板串显示是一类病。
let compressLastWarn = { url: '', text: '' };
let compressBusy = false;

function isVideoRef(ref){
  return !!(ref && ref.url) && (VIDEO_EXT_RE.test(ref.url) || String(ref.type||'').startsWith('video'));
}

// 压缩并把结果写回数据（一键压缩 / 手动压缩共用）。失败抛错，由调用方决定怎么提示。
async function compressAndApply(url, preset, kind, i, state, prog){
  if(compressBusy) throw new Error('已有一个压缩任务在跑，等它结束');
  prog.hidden=false; prog.value=0; state.textContent='正在启动…';
  const j=await api('/api/media/compress',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url,preset})});
  if(!j.ok) throw new Error(j.error||'启动失败');
  compressBusy=true;
  try{
    const st=await new Promise((res,rej)=>{
      const t=setInterval(async()=>{
        let s=null;
        try{ s=(await api('/api/media/compress/status')).state; }catch(_){ return; }
        if(!s) return;
        prog.value=s.percent||0;
        state.textContent=`正在压缩 ${s.src} → ${s.out} · ${s.percent||0}% · 已用 ${Math.round(s.elapsed||0)} 秒`;
        if(!s.running){ clearInterval(t); s.error?rej(Error(s.error)):res(s); }
      },1200);
    });
    const outRef={url:st.outUrl,name:st.out,type:'video/mp4'};
    push();
    if(kind==='showreel') data.showreel.projects[+i].media=outRef; else data.projects[+i].media.video=outRef;
    compressLastWarn={url:'',text:''};
    toast(`已压缩：${st.srcMB} MB → ${st.outMB} MB，发布将使用压缩版（原片已保留）`);
    render(); saveNow(true);
  }finally{
    compressBusy=false;
  }
}

function compressCardHtml(kind,i,ref){
  if(!isVideoRef(ref)) return '';
  return `<section class="edit-card compress-card" data-kind="${kind}" data-i="${i}" data-url="${esc(ref.url)}">
    <h3>视频压缩 · 能不能在线播放就看这一步</h3>
    <p class="cc-load hint">正在读取「${esc(ref.name||ref.url)}」的信息…</p>
    <div class="cc-main" hidden></div>
  </section>`;
}

async function initCompressCards(){
  const cards=$$('.compress-card'); if(!cards.length) return;
  for(const card of cards){
    const url=card.dataset.url, kind=card.dataset.kind, i=card.dataset.i;
    const load=card.querySelector('.cc-load'), main=card.querySelector('.cc-main');
    let r=null;
    try{ r=await api('/api/media/probe?url='+encodeURIComponent(url)); }catch(_){}
    if(!r||!r.ok){ load.textContent='读不到这个视频的信息（可能文件已被删除或改过名）。'; continue; }
    const info=r.info, presets=r.presets||[], limit=r.limitMB||COMPRESS_LIMIT_MB;
    const dims=(info.width&&info.height)?` · ${info.width}×${info.height}`:'';
    const dur=info.duration?` · 时长 ${stamp(info.duration)}`:'';
    const cod=(info.vcodec?` · 编码 ${info.vcodec.toUpperCase()}`:'')+(info.acodec?` / ${info.acodec.toUpperCase()}`:'');
    load.hidden=true;     main.hidden=false;
    const over = !!r.warn;                       // 超阈值 / 编码不受支持 → 需要压缩才能在线播放
    const isCompressed = /-web\.(mp4|mov|m4v|webm)$/i.test(url);  // 当前已经是压缩版
    const bal = (presets.find(p=>p.id==='balanced')) || {label:'推荐档位'};
    main.innerHTML=`
      ${isCompressed?`<p class="cc-badge">✓ 已压缩版本（${info.mb} MB）· 发布后浏览器可直接在线播放，原片已保留</p>`:''}
      ${(compressLastWarn.text && compressLastWarn.url===url)?`<p class="cc-warn">⚠️ ${esc(compressLastWarn.text)}</p>`:''}
      <p class="cc-facts">当前文件 <b>${info.mb} MB</b>${dims}${dur}${cod} · 单文件上限 ${limit} MB
        <span class="cc-note">（按 1 MB = 1,000,000 字节算，和手机 / 微信 / 浏览器显示的口径一致）</span></p>
      ${over?`<div class="cc-onetouch">
          <p class="cc-over">⚠️ 这个视频 <b>${info.mb} MB</b> 超过单文件上限 ${limit} MB（或编码浏览器不支持），发布后 GitHub Pages 只能「下载」不能「在线播放」。</p>
          ${r.ffmpeg?`<button class="button primary cc-quick">一键压缩（${esc(bal.label)}，压成可在线播放的版本）</button>
          <p class="cc-note">点一下即开始，原片保留；压完自动改用压缩版并提示你。想自己挑画质可展开下方自定义。</p>`
                     :`<p class="cc-note">装好压缩组件后即可一键压缩（点上方「下载压缩组件」）。</p>`}
        </div>`
              :`<p class="cc-ok">✓ 体积和编码都没问题，发布后浏览器可以直接在线播放。想更小可以再压一下。</p>`}
      ${r.ffmpeg?'':`<p class="cc-warn">⚠️ 本机还没有压缩组件（ffmpeg）。点下面按钮自动装好（约 30MB，只装一次）。</p><p><button class="button cc-getffmpeg">下载压缩组件</button></p>`}
      <details class="cc-advanced" ${over?'open':''}>
        <summary>自定义压缩档位（可选）</summary>
        <div class="cc-presets">${presets.map(p=>`<label class="cc-preset"><input type="radio" name="ccp-${kind}-${i}" value="${p.id}" ${p.id==='balanced'?'checked':''} ${r.ffmpeg?'':'disabled'}><span><b>${esc(p.label)}</b><em>${esc(p.note)}</em></span></label>`).join('')}</div>
        <div class="cc-actions">
          <button class="button cc-plan" ${r.ffmpeg?'':'disabled'}>① 试压 12 秒（看画质 + 预估体积）</button>
          <button class="button primary cc-run" ${r.ffmpeg?'':'disabled'}>② 压缩整片并替换</button>
        </div>
        ${(r.existing && r.existing.url!==url)?`<p class="cc-have">本机已经有一个压好的版本：<b>${esc(r.existing.name)}</b>（${r.existing.mb} MB）。
          <button class="button cc-use">③ 直接用它，不用再压一遍</button></p>`:''}
        <div class="cc-sample" hidden>
          <p class="hint">下面这段就是压缩后的真实画质（前/中/后三段共 12 秒拼成，可直接播放对比）：</p>
          <video class="cc-sample-video" controls playsinline preload="metadata"></video>
          <p class="cc-est"></p>
        </div>
      </details>
      <div class="cc-versions" hidden></div>
      <progress class="cc-progress" max="100" value="0" hidden></progress>
      <p class="cc-state hint"></p>
      <p class="hint">原文件不会被删除，只是作品集改用它。压缩保留时长，章节时间点不受影响。</p>`;

    const presetOf=()=>{const el=main.querySelector(`input[name="ccp-${kind}-${i}"]:checked`);return el?el.value:'balanced';};
    const state=main.querySelector('.cc-state'), prog=main.querySelector('.cc-progress');
    const sample=main.querySelector('.cc-sample'), sv=main.querySelector('.cc-sample-video'), est=main.querySelector('.cc-est');

    main.querySelector('.cc-getffmpeg')?.addEventListener('click',async e=>{
      const b=e.currentTarget; b.disabled=true; b.textContent='下载中…（约 30MB，请稍等）';
      try{
        const j=await api('/api/media/ffmpeg/download',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
        if(!j.ok) throw Error(j.error||'下载失败');
        toast('压缩组件已装好'); initCompressCards();
      }catch(err){ b.disabled=false; b.textContent='下载压缩组件'; toast('组件下载失败：'+err.message); }
    });

    main.querySelector('.cc-use')?.addEventListener('click',()=>{
      push();
      const ref={url:r.existing.url,name:r.existing.name,type:'video/mp4'};
      if(card.dataset.kind==='showreel') data.showreel.projects[+card.dataset.i].media=ref;
      else data.projects[+card.dataset.i].media.video=ref;
      compressLastWarn={url:'',text:''};
      toast(`已改用压缩版 ${r.existing.name}（${r.existing.mb} MB）`);
      render(); saveNow(true);
    });

    main.querySelector('.cc-plan')?.addEventListener('click',async e=>{
      const b=e.currentTarget, old=b.textContent; b.disabled=true; b.textContent='试压中…（约 15 秒）';
      state.textContent='正在压缩前/中/后三段共 12 秒，量真实码率…';
      try{
        const j=await api('/api/media/plan',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({url,preset:presetOf()})});
        if(!j.ok) throw Error(j.error||'试压失败');
        sv.src=j.sampleUrl; sample.hidden=false;
        est.innerHTML=`档位「${esc(j.label)}」：样片 ${j.sampleMB} MB（${j.sampleSecs||12} 秒）→ 整片预估 <b>${j.estMB} MB</b>`
          +`（原 ${j.srcMB} MB），输出分辨率 ${esc(String(j.scale))}。`
          +`<span class="cc-note">（预估是近似值，实际可能差 ±15%，以压完的真实体积为准）</span> `
          +(j.estFits?`<span class="cc-ok"> ✓ 在 ${limit} MB 以内，发布后能在线播放。</span>`
                     :`<span class="cc-bad"> ✗ 仍超过 ${limit} MB，换「最小」档再试。</span>`);
        state.textContent='';
      }catch(err){ state.textContent='试压失败：'+err.message; }
      b.disabled=false; b.textContent=old;
    });

    // 一键压缩：超阈值时最显眼的入口。先 plan 选最合适的档位（balanced 放不下就 smallest），再压。
    main.querySelector('.cc-quick')?.addEventListener('click',async e=>{
      const b=e.currentTarget;
      if(compressBusy) return toast('已有一个压缩任务在跑，等它结束');
      b.disabled=true; const old=b.textContent; b.textContent='分析中…（选最合适的档位）';
      let preset='balanced';
      try{ const p=await api('/api/media/plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url,preset:'balanced'})});
           if(p.ok && !p.estFits) preset='smallest'; }
      catch(_){}
      b.textContent='压缩中…';
      try{ await compressAndApply(url,preset,kind,i,state,prog); }
      catch(err){ b.disabled=false; b.textContent=old; state.textContent='压缩失败：'+err.message; toast('压缩失败：'+err.message); }
    });

    main.querySelector('.cc-run')?.addEventListener('click',async e=>{
      if(compressBusy) return toast('已有一个压缩任务在跑，等它结束');
      if(!confirm('开始压缩整片？\n\n原文件会保留，压缩完成后作品集自动改用它。\n整片大约需要几分钟，期间可以继续编辑其它内容。')) return;
      const b=e.currentTarget;
      try{ await compressAndApply(url,presetOf(),kind,i,state,prog); }
      catch(err){ b.disabled=false; state.textContent='压缩失败：'+err.message; toast('压缩失败：'+err.message); }
    });
    // Web Preview 版本选择：列出同目录下已生成的 -web*.mp4，让用户在能播的版本间选。
    loadWebPreviewVersions(card, url, kind, i);
  }

  // 列出并让用户选择 Web Preview 版本（70MB / 100MB 等）。超 GitHub 单文件上限的版本
  // 明确标「仅可下载」，绝不把它当网页播放地址（对应需求：超限制明确提示、不静默传 Release）。
  async function loadWebPreviewVersions(card, url, kind, i){
    const box=card.querySelector('.cc-versions'); if(!box) return;
    let r=null;
    try{ r=await api('/api/media/web-previews',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})}); }catch(_){ return; }
    if(!r||!r.ok||!r.variants||!r.variants.length) return;
    box.hidden=false;
    const cur=(kind==='showreel'?data.showreel.projects[+i].media:data.projects[+i].media.video)||{};
    const curUrl=cur.url||'';
    box.innerHTML=`<h4>Web Preview 版本</h4><p class="hint">已生成的浏览器友好版本（原片始终保留）。选一个作为线上播放的版本：</p>`+
      r.variants.map(v=>{
        const badge=v.playable?`<span class="vp-ok">✓ 可在线播放</span>`:`<span class="vp-bad">仅可下载（超 ${r.limitMB}MB 单文件上限）</span>`;
        const dim=(v.w&&v.h)?`${v.w}×${v.h}`:'';
        const br=(v.vbr?`视频 ${Math.round(v.vbr/1000)}k`:'')+(v.abr?` / 音频 ${Math.round(v.abr/1000)}k`:'');
        return `<div class="vp-row${curUrl===v.url?' selected':''}" data-url="${esc(v.url)}">
          <div class="vp-info"><b>${esc(v.name)}</b> · ${v.mb} MB${dim?(' · '+dim):''}${br?(' · '+br):''}<br>${badge}</div>
          <button class="button small vp-use">${curUrl===v.url?'当前使用':'选用'}</button>
        </div>`;
      }).join('');
    box.querySelectorAll('.vp-use').forEach(b=>{
      b.onclick=()=>{
        const vu=b.closest('.vp-row').dataset.url;
        push();
        const ref={url:vu,name:vu.split('/').pop(),type:'video/mp4'};
        if(kind==='showreel') data.showreel.projects[+i].media=ref; else data.projects[+i].media.video=ref;
        toast('已选用 '+ref.name+' 作为 Web Preview（原片保留）');
        render(); saveNow(true);
      };
    });
  }
  // 上传完立刻把压缩卡片滚进视野：用户不用自己去找「为什么线上播不了」
  // 只滚「刚上传的那个视频」自己的卡，别把别的视频的卡滚过来
  if(compressLastWarn.text){
    const c=document.querySelector(`.compress-card[data-url="${compressLastWarn.url}"]`)||document.querySelector('.compress-card');
    if(c) setTimeout(()=>c.scrollIntoView({behavior:'smooth',block:'center'}),300);
  }
}
