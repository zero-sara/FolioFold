/* ============================================================================
   FolioFold · 展示区（Display Zones）—— 系统级能力，对所有模板生效
   ----------------------------------------------------------------------------
   背景（用户原话，2026-09-24）：「这块区域等于说是一个展示区……我希望在文本编辑里
   接在『资料』下面放上『展示区』。这个展示区的内容分为两个：主展示区 + 次展示区。」

     · 主展示区 hero      = 页面最顶部的那个人名牌：眉标 / 姓名 / 定位 / 一句话简介
                            最多 4 项；**位置固定、字号按默认不变**（用户明确要求）
     · 次展示区 secondary = hero 下面那块信息区：自我介绍 / 关键词 / 教育经历 /
                            技能 / Contact / Links，最多 4 项
     · 没被勾进展览区的资料，自动**回落 About 区块**，且 About 自适应重排 —— 挖走后
       不能留一个空洞在那儿。

   候选合计 10 项 = 用户所说「about 里除去 resume 一共也只有 10 项的内容」。

   配置存在 **design.json 的 `displayZones`**（不是 portfolio.json）：
   它回答的是「怎么排」而不是「写了什么」，属于 Template，随模板导出/导入一起走。
    ⇒ 因此这是一次**系统级逻辑修改**，所有模板（main / tpl-2 / 新建）都自动拥有。

   为什么单独一个文件：展示页（app-v3.js）与文本编辑（editor-v3.js）要读同一份清单。
   本项目已有 THEMES 三处镜像同步的血泪教训，这里不允许再开一处重复。
   ========================================================================== */
(function (root) {
  'use strict';

  // 每个区最多几项 —— UI 上必须把这个数字说清楚（用户要求"限制个数要说明白"）
  var MAX = 4;

  // 候选清单。zones 声明该项能被放进哪些区；order 决定它在配置面板里的排列顺序。
  var CATALOG = [
    // —— 主展示区候选（4 项）—— hero 的位置与字号固定，所以只放"人名牌"级别的短内容
    { key: 'eyebrow', label: '眉标', note: 'hero 顶部小标签', zones: ['hero'], order: 1 },
    { key: 'name', label: '姓名', note: '大标题', zones: ['hero'], order: 2 },
    { key: 'role', label: '定位', note: '职位 / 一句话身份', zones: ['hero'], order: 3 },
    { key: 'intro', label: '一句话简介', note: '比自我介绍更短', zones: ['hero'], order: 4 },
    // —— 次展示区候选（6 项）—— hero 下面那块信息列
    { key: 'about', label: '自我介绍', note: '正文段落', zones: ['secondary'], order: 5 },
    { key: 'highlights', label: '关键词 / 亮点', note: '胶囊词组云', zones: ['secondary'], order: 6 },
    { key: 'education', label: '教育经历', note: '短行列表', zones: ['secondary'], order: 7 },
    { key: 'skills', label: '技能', note: '词组云', zones: ['secondary'], order: 8 },
    { key: 'contactLinks', label: 'Contact', note: '联系方式 · 点击复制', zones: ['secondary'], order: 9 },
    { key: 'publicLinks', label: 'Links', note: '公开链接 · 点击跳转', zones: ['secondary'], order: 10 },
    // —— 音频介绍（2026-10-04 新增）：只能进次展示区，不能进主展示区；未选则回落 About ——
    //     数据模型仿 resume：data.audioIntro = { url, name }，在线 <audio controls> 收听
    { key: 'audioIntro', label: 'Audio · 音频', note: '在线收听 · 不入主展示区', zones: ['secondary'], order: 11 }
  ];

  // hero 内部渲染顺序**固定**：不随用户在配置面板里的勾选先后变化（位置固定）
  var HERO_ORDER = ['eyebrow', 'name', 'role', 'intro'];
  // 次展示区 / About 回落的默认呈现顺序：先连结性信息，再列表型，最后长段落
  var SECONDARY_ORDER = ['contactLinks', 'skills', 'publicLinks', 'education', 'highlights', 'about', 'audioIntro'];

  var DEFAULT = {
    hero: ['eyebrow', 'name', 'role', 'intro'],
    secondary: ['contactLinks', 'publicLinks', 'skills']
  };

  function keysOf(zone) {
    return CATALOG.filter(function (it) { return it.zones.indexOf(zone) >= 0; })
      .map(function (it) { return it.key; });
  }
  var ALLOWED = { hero: keysOf('hero'), secondary: keysOf('secondary') };

  /**
   * 归一化：容错 + 去重 + 限长。**任何脏数据都要退化到一个能安全渲染的形状，绝不抛异常。**
   * 这儿承接的是用户在配置面板里点出来的数组，也可能是一个模板导进来的旧数据。
   */
  function resolve(raw) {
    var out = {}, zone, i, k, seen, items, src, allowed, dflt;
    if (!raw || typeof raw !== 'object') raw = {};
    for (i = 0; i < 2; i++) {
      zone = i === 0 ? 'hero' : 'secondary';
      allowed = ALLOWED[zone];
      dflt = DEFAULT[zone];
      src = raw[zone];
      // 区分三种情况，别把它们混为一谈：
      //   ① 这个区从来没被配置过（key 缺失 / 不是数组）→ 用默认出厂配置
      //   ② 配了但里面没有有效项 → hero 不允许空（一个人名牌什么都不显示只会留下
      //      一块空白），回落到默认；secondary 允许空 = "统统放回 About"，是合法选择
      //   ③ 正常地配了几项 → 去重 + 剔除非法 key + 限长
      var isArr = Object.prototype.toString.call(src) === '[object Array]';
      if (!isArr) {
        out[zone] = dflt.slice();
      } else if (!src.length) {
        out[zone] = (zone === 'hero') ? dflt.slice() : [];
      } else {
        seen = {}; items = [];
        for (k = 0; k < src.length; k++) {
          // unknown key can never be in allowed, handled by indexOf check below
          var key = String(src[k]);
          if (allowed.indexOf(key) >= 0 && !seen[key]) { seen[key] = 1; items.push(key); }
        }
        // 同一项不能同时出现在两个区 —— hero 优先（它是人名牌，优先级更高）
        if (zone === 'secondary' && out.hero) {
          items = items.filter(function (x) { return out.hero.indexOf(x) < 0; });
        }
        items = items.slice(0, MAX);
        // 过滤完后 hero 一项都不剩（比如配的全是非法 key）→ 同样回落到默认，不留空白
        out[zone] = (zone === 'hero' && !items.length) ? dflt.slice() : items;
      }
    }
    return out;
  }

  /** 把 key 数组整理成该区规范顺序（勾选顺序不影响呈现顺序） */
  function inOrder(zone, list) {
    var order = zone === 'hero' ? HERO_ORDER : SECONDARY_ORDER;
    return order.filter(function (k) { return (list || []).indexOf(k) >= 0; });
  }

  /** 没被任何一个展示区选走的 key：它们要回落到 About 区块 */
  function fallbackKeys(zones) {
    var picked = {}, i;
    for (i = 0; i < (zones.hero || []).length; i++) picked[zones.hero[i]] = 1;
    for (i = 0; i < (zones.secondary || []).length; i++) picked[zones.secondary[i]] = 1;
    return SECONDARY_ORDER.filter(function (k) { return !picked[k]; });
  }

  root.FF_ZONES = {
    MAX: MAX,
    catalog: CATALOG,
    heroKeys: function () { return ALLOWED.hero.slice(); },
    secondaryKeys: function () { return ALLOWED.secondary.slice(); },
    heroOrder: HERO_ORDER,
    secondaryOrder: SECONDARY_ORDER,
    defaultHero: function () { return DEFAULT.hero.slice(); },
    defaultSecondary: function () { return DEFAULT.secondary.slice(); },
    resolve: resolve,
    inOrder: inOrder,
    fallbackKeys: fallbackKeys
  };
})(window);
