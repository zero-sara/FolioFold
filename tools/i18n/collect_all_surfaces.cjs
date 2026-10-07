/*
 * 全 surface 真实界面文案采集（B 线 i18n）——并进 tools/i18n/dom-snapshot.txt。
 *
 * 扫描面（都比照 collect_dom_strings.cjs 的「文本节点 + title/placeholder/aria-label」口径）：
 *   1. /editor/index.html 全部视图                     → 「文本编辑面板」
 *   2. /visual-editor/index.html?studio=1&tpl=main     → 「排版编辑面板」（含主题下拉、三种工具模式）
 *   3. / 外壳顶层文档（排除 .st-frame iframe 内容）      → 「Studio外壳」（顶栏 + 模板区）
 *   4. / 外壳点「发布」后的发布面板                      → 「Studio外壳」
 *
 * 用法（需 3000 服务 + CDP :9222）：node tools/i18n/collect_all_surfaces.cjs
 * 之后跑 python tools/i18n/build_dict.py 看覆盖率。
 * ⚠ 只收含中日韩字符的串；用户作品内容靠排除 iframe 正文 + NEVER 表（build_dict.py）。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SITE = 'http://127.0.0.1:3000';
const DEBUG = 'http://127.0.0.1:9222';
const DOM = path.join(__dirname, 'dom-snapshot.txt');

function request(url, method = 'GET', body) {
  const payload = body == null ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, agent: false,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} },
      r => { let t = ''; r.on('data', d => t += d); r.on('end', () => resolve(t)); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const cdp = (p, m = 'GET', b) => request(DEBUG + p, m, b);
async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pend = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (!m.id || !pend.has(m.id)) return; const q = pend.get(m.id); pend.delete(m.id); m.error ? q.reject(new Error(m.error.message)) : q.resolve(m.result); };
  return { call: (method, params = {}) => new Promise((res, rej) => { const n = ++id; pend.set(n, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: n, method, params })); }), ws };
}

const CJK = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
const COLLECT = where => `(() => {
  const out = new Map();
  const push = t => { t = String(t).replace(/\\s+/g, ' ').trim(); if (t && ${'true'} && out.has(t)) out.set(t, out.get(t) + 1); else if (t) out.set(t, 1); };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const t = n.nodeValue; if (!t || !/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(t)) continue;
    let p = n.parentElement; let skip = false;
    while (p) { if (/^(SCRIPT|STYLE|TEXTAREA|CODE|PRE)$/.test(p.tagName) || p.isContentEditable || p.closest('[contenteditable],[data-ff-pin]')) { skip = true; break; } p = p.parentElement; }
    if (skip) continue;
    push(t);
  }
  document.querySelectorAll('[title],[placeholder],[aria-label]').forEach(el => {
    ['title','placeholder','aria-label'].forEach(a => { const v = el.getAttribute && el.getAttribute(a); if (v && /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(v)) push(v); });
  });
  return [...out.entries()].map(([text, count]) => [text, count, ${JSON.stringify(where)}]);
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
    await session.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

    const merged = new Map();
    const absorb = rows => { for (const [text, count, where] of rows || []) { const prev = merged.get(text); if (!prev || count > prev[1]) merged.set(text, [text, count, where]); } };
    const goto = async (url, wait) => { await session.call('Page.navigate', { url }); await sleep(wait); };

    // 1) 编辑器全部视图
    await goto(SITE + '/editor/index.html', 3000);
    const views = await ev(`[...document.querySelectorAll('#editor-app .nav[data-view]')].map(b => b.getAttribute('data-view'))`) || [];
    for (const view of views) {
      await ev(`document.querySelector('#editor-app .nav[data-view="' + ${JSON.stringify(view)} + '"]')?.click()`);
      await sleep(700);
      await ev(`[...(document.querySelectorAll('#editor-app details')||[])].forEach(d => { d.open = true })`);
      await sleep(250);
      absorb(await ev(COLLECT('文本编辑面板')));
      process.stderr.write('  · editor view=' + view + '\n');
    }

    // 2) VE 面板（基础态 + 逐个工具模式点一遍，让提示语渲染出来）
    await goto(SITE + '/visual-editor/index.html?studio=1&tpl=main', 3500);
    absorb(await ev(COLLECT('排版编辑面板')));
    for (const sel of ['[data-tool="element"]', '[data-tool="spacing"]', '[data-tool="image-size"]', '[data-tool="media-size"]']) {
      await ev(`document.querySelector(${JSON.stringify(sel)})?.click()`);
      await sleep(400);
      absorb(await ev(COLLECT('排版编辑面板')));
    }
    // 主题下拉（<select> 的 option 文本）
    absorb(await ev(`(()=>{const out=[];document.querySelectorAll('select option').forEach(o=>{if(/[\u4e00-\u9fff]/.test(o.textContent))out.push([o.textContent.trim(),1,'排版编辑面板']);});return out;})()`));
    process.stderr.write('  · visual-editor done\n');

    // 3) 外壳顶层文档（排除 iframe 内容）：默认 portfolio 标签 + 逐个点 tab
    await goto(SITE + '/?qa=collect-' + Date.now(), 3500);
    absorb(await ev(COLLECT('Studio外壳')));
    for (const tab of ['editor', 'visual']) {
      await ev(`[...document.querySelectorAll('.st-tab')].find(x=>x.dataset.tab===${JSON.stringify(tab)})?.click()`);
      await sleep(1200);
      absorb(await ev(COLLECT('Studio外壳')));
    }
    // 4) 发布面板（点「发布」相关按钮，若存在）
    await ev(`[...document.querySelectorAll('button,.st-btn')].find(b=>/^\\s*发布/.test(b.textContent||''))?.click()`);
    await sleep(1200);
    absorb(await ev(COLLECT('Studio外壳')));
    // 模板区（生成模板 / 导入模板折叠块全部展开）
    await ev(`[...(document.querySelectorAll('details')||[])].forEach(d=>{d.open=true})`);
    await sleep(400);
    absorb(await ev(COLLECT('Studio外壳')));
    process.stderr.write('  · shell done\n');

    const list = [...merged.values()].sort((a, b) => a[0].localeCompare(b[0], 'zh'));
    const rowsOf = text => { const hit = /JSON=(\[.*\])\s*$/s.exec(text); return hit ? JSON.parse(hit[1]) : []; };
    const byText = new Map();
    try {
      rowsOf(fs.readFileSync(DOM, 'utf8')).forEach(r => byText.set(r[0], r));
      console.error('  · 旧快照 ' + byText.size + ' 条');
    } catch (_) { console.error('  · 旧快照不存在，按新建处理'); }
    let added = 0;
    list.forEach(r => { if (!byText.has(r[0])) added++; byText.set(r[0], r); });
    const out = [...byText.values()].sort((a, b) => a[0].localeCompare(b[0], 'zh'));
    fs.writeFileSync(DOM,
      '/* 真实界面文案快照：由 tools/i18n/collect_dom_strings.cjs / collect_all_surfaces.cjs 从浏览器里抓取，\n'
      + ' * 供 build_dict.py 做覆盖率体检（不是运行时数据）。合并 = 并集。\n'
      + ' * 最近一次更新：' + new Date().toISOString().slice(0, 10) + '（collect_all_surfaces 全 surface 扫描）\n'
      + ' */\n'
      + 'JSON=' + JSON.stringify(out) + '\n', 'utf8');
    console.log('本次唯一文案 = ' + list.length + ' 条（新补 ' + added + '），快照共 ' + out.length + ' 条 → ' + DOM);
  } catch (e) {
    console.error('ERR', e.stack || e.message);
    process.exitCode = 1;
  } finally {
    if (target) await cdp('/json/close/' + target.id, 'PUT').catch(() => {});
    if (session) session.ws.close();
  }
})();
