/* ============================================================================
   FolioFold · 页面结构（Section Registry）—— 系统级，对所有模板生效
   ----------------------------------------------------------------------------
   要解决的问题（用户原话，2026-09-24）：
     「我在模板二里面，它就不叫 AI Project，所以你必须有一个代号 —— 才能对应到
      具体的一个模块，而不会导致模板一改了之后，模板二却因为名字的不同没有识别到。」

   关键区分（这是本文件存在的全部理由）：
     · **id**（about / experience / works / showreel / aiVoices）= 模块身份，唯一事实来源。
       代码里到处用的就是它（sectionOrder、sectionTitles、sectionLogos、sectionVisibility…）。
     · **显示名**（sectionTitles[k]）= 用户可随意改的标签。main 里 works 被显示成
       "Experience"、experience 被显示成 "Works"（两个名字正好互换）；tpl-2 里叫
       Identity / Capabilities / Workflow / In Action / AI Lab。
     · **code**（A–E）= 给人读的稳定别名。按**模块身份**固定分配，与显示名无关、
       与页面顺序无关 —— 所以改名字、换模板、调顺序，代号都不会变。

   ⚠⚠ 2026-09-24 第六次调整（用户明确要求）：
     **不要给模块贴「这是什么区域」的标签，也不要写区域简介。**
     用户原话：「不需要有非常明确的一个称呼，比如说什么个人档案与信息区、任职经历区，
     这些什么都不要，因为我不想给这 5 个结构贴标签……真正要让它作为什么区域，
     是使用者他自己决定的。……不用写具体介绍这是什么区域，直接保留 ABC 代号板块
     加上目前显示名称就行了。」
     → 所以本文件**只提供代号 + 功能点**（功能点 = 这个模块能填什么、能做什么），
       没有任何"它是什么区域"的命名或描述。区域定位完全交给用户（改显示名即可）。

   ⚠ 单一来源：编辑器的「页面结构」直接读这里，不在别处再抄一份。
     本项目已有 THEMES 三处镜像同步的血泪教训，此处不允许重复定义。
   ========================================================================== */
(function (root) {
  'use strict';

  // 顺序 = 默认页面顺序，代号 A–E 依次分配（与「页面结构」面板自上而下的阅读顺序一致）。
  var ORDER = ['about', 'experience', 'works', 'showreel', 'aiVoices'];

  // features = 该模块**能承载什么 / 能做什么**（功能点）。
  // 注意：这里只写能力，不写"这是什么区域"—— 区域定位由用户自己决定。
  var FEATURES = {
    about: [
      '自我介绍', '关键词亮点', '教育经历', '技能', 'Contact', 'Links',
      '区块 Logo', '可分配至主 / 次展示区', '未被选用的项自动回落此处'
    ],
    experience: [
      '组织 / 职位 / 时间', '原始素材', 'AI 文本整理', '介绍 + 亮点', '本地图片',
      '条目增删排序', '译文草稿'
    ],
    works: [
      '分类（Category）', '类别介绍', 'AI 自动整理', '项目介绍', '核心工作', '核心亮点',
      '主视觉', '工作过程图（多张）', '本地视频',
      '本地音频（MP3 / WAV / M4A / AAC / OGG / FLAC）', '外部视频链接', '外部链接',
      '详细 / 简略展示'
    ],
    showreel: [
      '多项目', '本地视频', '外部视频链接', '章节时间轴', '按播放位置取时间点', '章节跳转'
    ],
    aiVoices: [
      '项目名称', '一句简介', '项目定位', '我的角色', '我的贡献',
      '技术栈', 'Highlights',
      'GitHub Link（可打开 / 可复制）', 'Live Demo URL（可打开 / 可复制）',
      '封面', '截图（多张）', '本地视频', '项目 Logo'
    ]
  };

  function codeOf(id) {
    var i = ORDER.indexOf(id);
    return i < 0 ? '' : String.fromCharCode(65 + i);   // 0→A
  }

  /** 取某个模块的元信息（含代号）。未知 id 返回 null —— 调用方必须容错。 */
  function get(id) {
    var feats = FEATURES[id];
    if (!feats) return null;
    return { id: id, code: codeOf(id), features: feats.slice() };
  }

  /** 按代号顺序返回全部模块（新增模块不在 ORDER 里时排到最后，不抛异常）。 */
  function list() {
    var known = ORDER.slice();
    var extra = Object.keys(FEATURES).filter(function (k) { return known.indexOf(k) < 0; });
    return known.concat(extra).map(get).filter(Boolean);
  }

  root.FF_SECTIONS = { order: ORDER.slice(), features: FEATURES, codeOf: codeOf, get: get, list: list };
})(window);
