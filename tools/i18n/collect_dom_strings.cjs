/*
 * 抓取「文本编辑面板」真实界面上的全部中文文案，**并合并进** tools/i18n/dom-snapshot.txt。
 *
 * 为什么需要它：dom-snapshot.txt 是覆盖率体检的输入，但它只是一次性抓下来的快照
 * （2026-09-22 那份抓完就没人更新）。新增的界面文案（例如「分类与类别介绍」「新建分类」）
 * 不在快照里 → build_dict.py 就量不到它们没翻译 → 英文模式下一直显示中文，
 * 而覆盖率报告看起来还是"只差 4 条"。用户 2026-09-23 的反馈正是这个：
 * 「英文模式下还有非常多的中文分类与介绍、类别介绍、新建分类」。
 *
 * 用法（需要 3000 服务在跑 + CDP :9222）：
 *   node tools/i18n/collect_dom_strings.cjs
 * 它会**直接把结果并进 dom-snapshot.txt**（并集：老条目保留，可能只是当前数据下没渲染出来），
 * 然后跑 `python tools/i18n/build_dict.py` 看覆盖率。
 *
 * ⚠ 曾经有个坑：面板里一句说明被行内 `<b>` 切开（「每个模块都有一个<b>稳定代号</b>…」），
 *   抓到的就是「稳定代号」这种**半句碎片**。把 HTML 改成"每句各占一个文本节点"之后这些碎片
 *   就不存在了 —— 但它们会一直留在旧快照里当噪声。所以下面有 STALE_FRAGMENTS 显式剔除。
 *   **别改用启发式剪枝**（"是某个新条目的子串就删"）—— 会误删「主展示区」这类真文案。
 *
 * 只收「含中日韩字符」的串，并跳过明显是用户作品内容的区块（画布 iframe 里的正文）。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SITE = 'http://127.0.0.1:3000';
const DEBUG = 'http://127.0.0.1:9222';
const DOM = path.join(__dirname, 'dom-snapshot.txt');

// 已经被 HTML 重构掉的「半句碎片」：它们不再出现在界面里，留在快照里只会污染覆盖率报告。
const STALE_FRAGMENTS = [
  '（A–E），它跟',
  '走、不跟名字走 —— 你可以随时改名，甚至让同一个模块在模板一叫一个名字、在模板二叫另一个名字（例如同一个模块在模板一叫 AI Project、在模板二叫 AI Lab），代号始终不变，便于对照、排查与跨模板同步。名称与显示状态属于内容（portfolio.json）；',
  '，会自动回到 About 区块重新排版。',
  '稳定代号',
  '每个模块都有一个',
  '模块身份',
  '没勾选进次展示区的资料不会消失',
  '是主展示区下方的信息列，最多 4 项。',
  '是人名牌区域，位置与字号固定，最多 4 项；',
  '顺序属于模板（design.json）',
  '名称与显示状态属于内容（portfolio.json）；',
  '第一次切到某个语言要等一会儿',
  '（系统会自动把整篇内容翻译一遍，之后随切随显示）。若某些字段是外文专有名词、或你希望保持原文（如片名、技术名词），点该字段的标签即可「钉住」：标签变成斜体并显示 🔒，该字段不再跟随语言切换；再点一次恢复跟随。',
];

function request(url, method = 'GET', body) {
  const payload = body == null ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, agent: false,
      headers: { Connection: 'close', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) },
    }, res => { let t = ''; res.on('data', d => t += d); res.on('end', () => resolve({ status: res.statusCode, text: t })); });
    req.on('error', reject); if (payload) req.write(payload); req.end();
  });
}
const cdp = (p, m = 'GET') => request(DEBUG + p, m).then(r => r.text);
async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (!m.id || !pending.has(m.id)) return; const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); };
  return { ws, call: (method, params = {}) => new Promise((res, rej) => { const n = ++id; pending.set(n, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: n, method, params })); }) };
}

// 面板自己声明「这些是我的界面文案」，抓取时原样回传
const COLLECT = `(() => {
  const CJK = /[\\u3400-\\u4dbf\\u4e00-\\u9fff\\u3040-\\u30ff\\uac00-\\ud7af]/;
  const out = new Map();
  const push = s => {
    const v = String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
    if (!v || v.length > 400) return;
    if (!CJK.test(v)) return;
    out.set(v, (out.get(v) || 0) + 1);
  };
  const root = document.body;
  if (!root) return [];
  const skip = el => !!(el.closest && el.closest('iframe, script, style, .ve-canvas, [data-ff-i18n-skip]'));
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: n => (n.nodeValue && n.nodeValue.trim() && !skip(n.parentElement)) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
  });
  let n;
  while ((n = walker.nextNode())) push(n.nodeValue);
  root.querySelectorAll('[placeholder],[title],[aria-label],[alt],[value]').forEach(el => {
    if (skip(el)) return;
    ['placeholder', 'title', 'aria-label', 'alt', 'value'].forEach(a => { if (el.hasAttribute(a)) push(el.getAttribute(a)); });
  });
  return [...out.entries()].map(([text, count]) => [text, count, '文本编辑面板']);
})()`;

(async () => {
  let target = null, session = null;
  try {
    target = JSON.parse(await cdp('/json/new?about:blank', 'PUT'));
    session = await connect(target.webSocketDebuggerUrl);
    const ev = async expression => (await session.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
    await session.call('Runtime.enable');
    await session.call('Page.enable');
    await session.call('Network.setCacheDisabled', { cacheDisabled: true });
    await session.call('Page.navigate', { url: SITE + '/editor/index.html' });
    await sleep(3000);

    const views = await ev(`[...document.querySelectorAll('#editor-app .nav[data-view]')].map(b => b.getAttribute('data-view'))`);
    if (!views.length) throw new Error('编辑器导航没渲染出来（#editor-app .nav[data-view] 为空）');

    const merged = new Map();
    for (const view of views) {
      await ev(`document.querySelector('#editor-app .nav[data-view="' + ${JSON.stringify(view)} + '"]')?.click()`);
      await sleep(700);
      // 分类/经历等视图里的卡片是 <details>，全部展开才能抓到卡内文案
      await ev(`[...(document.querySelectorAll('#editor-app details')||[])].forEach(d => { d.open = true })`);
      await sleep(250);
      const rows = await ev(COLLECT) || [];
      for (const [text, count, where] of rows) {
        const prev = merged.get(text);
        if (!prev || count > prev[1]) merged.set(text, [text, count, where]);
      }
      process.stderr.write('  · view=' + view + ' -> ' + rows.length + ' 条\n');
    }
    const list = [...merged.values()].sort((a, b) => a[0].localeCompare(b[0], 'zh'));
    // —— 并进 dom-snapshot.txt（并集 + 显式剔除 STALE_FRAGMENTS）——
    const rowsOf = text => {
      const hit = /JSON=(\[.*\])\s*$/s.exec(text);
      return hit ? JSON.parse(hit[1]) : [];
    };
    const byText = new Map();
    try {
      rowsOf(fs.readFileSync(DOM, 'utf8')).forEach(r => byText.set(r[0], r));
      console.error('  · 旧快照 ' + byText.size + ' 条');
    } catch (_) { console.error('  · 旧快照不存在，按新建处理'); }
    let added = 0;
    list.forEach(r => { if (!byText.has(r[0])) added++; byText.set(r[0], r); });
    STALE_FRAGMENTS.forEach(t => byText.delete(t));
    const out = [...byText.values()].sort((a, b) => a[0].localeCompare(b[0], 'zh'));
    fs.writeFileSync(DOM,
      '/* 真实界面文案快照：由 tools/i18n/collect_dom_strings.cjs 从浏览器里抓取，供 build_dict.py 做\n'
      + ' * 覆盖率体检（不是运行时数据）。合并 = 并集；被行内 <b> 切碎的旧半句由该脚本的\n'
      + ' * STALE_FRAGMENTS 显式剔除（别改成启发式剪枝 —— 会误删「主展示区」这种真文案）。\n'
      + ' * 最近一次更新：' + new Date().toISOString().slice(0, 10) + '\n'
      + ' */\n'
      + 'JSON=' + JSON.stringify(out) + '\n', 'utf8');
    console.log('唯一文案 = ' + list.length + ' 条（新补 ' + added + '），已写入 ' + DOM + '，共 ' + out.length + ' 条');
  } catch (e) {
    console.error('ERR', e.stack || e.message);
    process.exitCode = 1;
  } finally {
    if (target) await cdp('/json/close/' + target.id, 'PUT').catch(() => {});
    if (session) session.ws.close();
  }
})();
