/**
 * Portfolio Theme Presets
 * --------------------------------------------------------------------
 * 8 套预设主题（4 light + 4 dark），每套定义完整配色系统：
 *   ink       正文/标题颜色
 *   paper     页面背景
 *   soft      次级内容背景（编辑面板次级块、Showreel 之外的强调区）
 *   line      分隔线 / 边框
 *   accent    强调色（章节编号、链接、按钮 hover 等）
 *   muted     次级文字
 *   dark      Showreel 区背景（深色块）
 *   heroEyebrow  Hero 顶部小字
 *
 * 语义 token（2026-09-20 新增，深色下必须提亮）：
 *   surface   面板 / 卡片表面（编辑面板、压缩卡片等）
 *   surface2  更深一层的嵌入表面（侧栏内块、原素材区）
 *   field     输入框背景
 *   card      主题选择卡 / 浮层卡片背景
 *   danger    危险 / 未保存提示文字
 *   ok        成功 / 通过提示文字
 *   warn      警告提示文字
 *
 * ⚠ 2026-09-25 改版：原「Light 03 · 暖灰编辑」与 Light 01 太像、原「Dark 03 · 墨绿暗金」
 *   与 Dark 01 太像（用户原话：「Light 01 和 Light 03 也很像」「Dark 01 和 Dark 03 很像」），
 *   两者已移除；id `light-03` / `dark-03` **改指新的替代主题**，并新增 `light-04` / `dark-04`。
 *   新增的 4 套刻意拉开色相与明度（莫兰迪灰粉 / 森野墨绿 / 酒红丝绒 / 紫夜深空），
 *   每一套都能一眼认出来，不再是同一套配色换个名字。
 *
 * 数据结构（与 portfolio.json 中的 styles 兼容）：
 *   { theme: { mode: "light" | "dark", preset: "light-01" } }
 * 旧数据中裸 ink/paper/accent 仍可被 normalize() 兼容。
 *
 * ⚠ 这份表是全站主题的**唯一事实源**。`app-v3.js` 里有一份用于画布/发布页的镜像副本
 *   （那块不加载本文件），改这里必须同步改那边 —— 两边不一致就会出现「面板说切了、
 *   画布没变」或反过来的漂移。
 */
window.THEMES = {
  // —— Light 01：米白纸面 + 墨黑正文 + 暖红强调（克制、近似当前默认风格）——
  'light-01': {
    label: 'Light 01 · 米白纸面', mode: 'light',
    ink: '#161616', paper: '#f1eee7', soft: '#ede9df', line: '#cac5ba',
    accent: '#e64e2e', muted: '#77736b', dark: '#20201e', heroEyebrow: '#e64e2e',
    surface: '#f8f5ee', surface2: '#efe9dd', field: '#ffffff', card: '#ffffff',
    danger: '#b3261e', ok: '#2f6b46', warn: '#9a6b1e',
  },
  // —— Light 02：冷白 + 深蓝灰正文 + 钴蓝强调（专业、干净）——
  'light-02': {
    label: 'Light 02 · 冷白专业', mode: 'light',
    ink: '#1c2433', paper: '#f4f6fa', soft: '#e9edf3', line: '#d6dce6',
    accent: '#1f4e8c', muted: '#5a6477', dark: '#0f1622', heroEyebrow: '#1f4e8c',
    surface: '#ffffff', surface2: '#eef2f7', field: '#ffffff', card: '#ffffff',
    danger: '#c0392b', ok: '#2f6b46', warn: '#9a6b1e',
  },
  // —— Light 03：莫兰迪灰粉 + 灰褐正文 + 干枯玫瑰强调（低饱和、柔和）——
  //    2026-09-25 替换：旧「暖灰编辑」与 Light 01 几乎同色系，已移除。
  'light-03': {
    label: 'Light 03 · 莫兰迪灰粉', mode: 'light',
    ink: '#3b3533', paper: '#f2edeb', soft: '#eae2de', line: '#d4c8c3',
    accent: '#96706a', muted: '#857a76', dark: '#2b2523', heroEyebrow: '#8a635d',
    surface: '#f9f5f3', surface2: '#efe8e4', field: '#fffdfc', card: '#fffdfc',
    danger: '#a8433a', ok: '#4d6b4f', warn: '#8a6a2f',
  },
  // —— Light 04：米黄纸感 + 墨绿正文 + 森野绿强调（自然、沉稳）——
  //    2026-09-25 新增。刻意避开红 / 蓝 / 粉三系，用绿系拉开区分度。
  'light-04': {
    label: 'Light 04 · 森野墨绿', mode: 'light',
    ink: '#22302a', paper: '#f3f1e9', soft: '#e8e6da', line: '#c9cdbc',
    accent: '#2f6b52', muted: '#5f6b64', dark: '#16211c', heroEyebrow: '#2f6b52',
    surface: '#faf9f3', surface2: '#eceadf', field: '#ffffff', card: '#ffffff',
    danger: '#a8342a', ok: '#2f6b52', warn: '#8a6a1e',
  },
  // —— Dark 01：石墨黑 + 米白正文 + 琥珀强调（影院感）——
  'dark-01': {
    label: 'Dark 01 · 石墨影院', mode: 'dark',
    ink: '#f4f0e8', paper: '#14130f', soft: '#1c1b17', line: '#34332d',
    accent: '#e8a85a', muted: '#a09a8a', dark: '#0a0a08', heroEyebrow: '#e8a85a',
    surface: '#1c1b17', surface2: '#232220', field: '#0d0c0a', card: '#20201d',
    danger: '#ff7b6b', ok: '#7bd08f', warn: '#e8b86a',
  },
  // —— Dark 02：深海蓝 + 冷白正文 + 青绿强调（冷峻、克制）——
  'dark-02': {
    label: 'Dark 02 · 深海蓝', mode: 'dark',
    ink: '#eef1f6', paper: '#0e1a2a', soft: '#152339', line: '#2a3a52',
    accent: '#5fb7c2', muted: '#8593a8', dark: '#08111c', heroEyebrow: '#5fb7c2',
    surface: '#14233a', surface2: '#1b2d48', field: '#0a1422', card: '#16263e',
    danger: '#ff8a7a', ok: '#6fd08a', warn: '#e8c06a',
  },
  // —— Dark 03：酒红丝绒 + 暖白正文 + 玫瑰金强调（浓郁、有质感）——
  //    2026-09-25 替换：旧「墨绿暗金」与 Dark 01 撞色系，已移除。
  'dark-03': {
    label: 'Dark 03 · 酒红丝绒', mode: 'dark',
    ink: '#f6ebe6', paper: '#1a1013', soft: '#241419', line: '#3f252b',
    accent: '#dc9a72', muted: '#a08a8c', dark: '#0f080a', heroEyebrow: '#dc9a72',
    surface: '#241419', surface2: '#2e1a20', field: '#160d10', card: '#291720',
    danger: '#ff8f80', ok: '#84cf95', warn: '#e6bb78',
  },
  // —— Dark 04：紫夜深空 + 冷白正文 + 薰衣草强调（神秘、低饱和紫）——
  //    2026-09-25 新增。暖（石墨/酒红）、冷（深蓝）、紫三系互不撞色。
  'dark-04': {
    label: 'Dark 04 · 紫夜深空', mode: 'dark',
    ink: '#ece9f7', paper: '#14102a', soft: '#1d1840', line: '#332b5e',
    accent: '#ae9ff2', muted: '#9089ae', dark: '#0b0919', heroEyebrow: '#ae9ff2',
    surface: '#1d1840', surface2: '#262052', field: '#100c22', card: '#221c4a',
    danger: '#ff8ba0', ok: '#7fd8b0', warn: '#e8c078',
  },
};

window.THEME_PRESETS = [
  { id: 'light-01', label: 'Light 01', mode: 'light' },
  { id: 'light-02', label: 'Light 02', mode: 'light' },
  { id: 'light-03', label: 'Light 03', mode: 'light' },
  { id: 'light-04', label: 'Light 04', mode: 'light' },
  { id: 'dark-01', label: 'Dark 01', mode: 'dark' },
  { id: 'dark-02', label: 'Dark 02', mode: 'dark' },
  { id: 'dark-03', label: 'Dark 03', mode: 'dark' },
  { id: 'dark-04', label: 'Dark 04', mode: 'dark' },
];

/** 合法的预设 id 列表（发布前校验、旧数据兜底都用它，绝不在别处再抄一份） */
window.THEME_IDS = window.THEME_PRESETS.map(p => p.id);

/** 从 data.theme + legacy data.styles 解析出最终调色板 */
window.resolveTheme = function(data) {
  const t = (data && data.theme) || {};
  const preset = window.THEMES[t.preset] || window.THEMES['light-01'];
  const legacy = (data && data.styles) || {};
  if (!data.theme && legacy.background) {
    return Object.assign({}, preset, {
      ink: legacy.text || preset.ink,
      paper: legacy.background || preset.paper,
      accent: legacy.accent || preset.accent,
    });
  }
  return preset;
};

/** 将主题写入 CSS 变量（直接 set 到 :root） */
window.applyTheme = function(theme) {
  const root = document.documentElement;
  // 基础 token
  root.style.setProperty('--ink', theme.ink);
  root.style.setProperty('--paper', theme.paper);
  root.style.setProperty('--soft', theme.soft);
  root.style.setProperty('--line', theme.line);
  root.style.setProperty('--accent', theme.accent);
  root.style.setProperty('--muted', theme.muted);
  root.style.setProperty('--dark', theme.dark);
  root.style.setProperty('--hero-eyebrow', theme.heroEyebrow || theme.accent);
  // 语义 token（深色下自动提亮）
  root.style.setProperty('--surface', theme.surface);
  root.style.setProperty('--surface2', theme.surface2);
  root.style.setProperty('--field', theme.field);
  root.style.setProperty('--card', theme.card);
  root.style.setProperty('--danger', theme.danger);
  root.style.setProperty('--ok', theme.ok);
  root.style.setProperty('--warn', theme.warn);
  // ⚠ 2026-09-25：「压在实体色块上的文字色」。原先编辑面板写死 color:#fff，
  //   深色主题下强调色是**浅色**（如琥珀 #e8a85a），白字压上去几乎看不见。
  //   所以抽成 token：浅色主题下用白字；深色主题下用近黑（theme.dark）。
  root.style.setProperty('--on-solid', theme.mode === 'dark' ? theme.dark : '#ffffff');
  // 让原生控件（滚动条、表单控件）跟随深浅色
  root.style.colorScheme = theme.mode || 'light';
  root.setAttribute('data-theme-mode', theme.mode || 'light');
  if (theme.mode === 'dark') {
    root.style.setProperty('--editor-paper-mode', 'dark');
    document.body.style.background = theme.paper;
  } else {
    root.style.setProperty('--editor-paper-mode', 'light');
    document.body.style.background = '';
  }
};
