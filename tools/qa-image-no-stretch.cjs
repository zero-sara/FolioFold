#!/usr/bin/env node
/* 永久 QA：确保「发布后图片被压扁（非等比拉伸）」类 bug 不会回归。
 *
 * 校验不变量（针对 public-v2.css 与 styles.css 两份运行时/发布样式）：
 *   1. 全文件没有任何 object-fit:fill（fill = 非等比拉伸，正是「压扁」根因）。
 *   2. 全局防护规则存在：所有内容区图片默认 object-fit:cover（等比裁切，绝不拉伸）。
 *   3. .exp-media img 仍保持 height:auto（图片按自身比例显示，不被强制高度压扁）。
 *   4. 任何「内容图片」规则若同时固定 width+height，必须带 object-fit（否则会被浏览器非等比拉伸）。
 *
 * 用法：node tools/qa-image-no-stretch.cjs
 * 失败以非零退出码退出（CI / 提交前可挂此脚本）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const files = ['public-v2.css', 'styles.css'].map(f => path.join(ROOT, f));

let failures = 0;
const fail = (msg) => { console.error('  ✗ ' + msg); failures++; };
const ok = (msg) => { console.log('  ✓ ' + msg); };

// 去掉 /* ... */ 注释，避免解析器把注释内容当规则
function stripComments(css) { return css.replace(/\/\*[\s\S]*?\*\//g, ''); }

function parseRules(css) {
  const rules = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open === -1) break;
    const close = css.indexOf('}', open);
    if (close === -1) break;
    const sel = css.slice(i, open).trim();
    const body = css.slice(open + 1, close);
    if (sel && !sel.startsWith('@')) rules.push({ sel, body });
    i = close + 1;
  }
  return rules;
}

// 仅「内容图片」选择器才纳入拉伸风险检查（排除 UI 装饰/手柄/图标等）
const CONTENT_SEL = /(exp-media|ai-media|ai-project-media|works-cover|about-media|showreel-media|ve-resizable|experience|\bimg\b|\bimage\b|cover)/i;
const CHROME_SEL = /(handle|chev|guide|snap|draw|pixel|logo|thumb|\bdot\b|ve-free|ve-img|vpb|pf-)/i;
const isContentImg = (sel) => CONTENT_SEL.test(sel) && !CHROME_SEL.test(sel);

const allRules = [];
for (const file of files) {
  if (!fs.existsSync(file)) { console.log('(跳过不存在的 ' + path.basename(file) + ')'); continue; }
  const css = stripComments(fs.readFileSync(file, 'utf8'));
  const name = path.basename(file);
  console.log('== ' + name + ' ==');

  if (/object-fit\s*:\s*fill\b/.test(css)) fail(name + ' 含 object-fit:fill（非等比拉伸根因）');
  else ok(name + ' 无 object-fit:fill');

  const rules = parseRules(css);
  allRules.push(...rules);

  if (name === 'public-v2.css') {
    const expRules = rules.filter(r => /\.exp-media\s+img/.test(r.sel));
    const hasCover = expRules.some(r => /object-fit\s*:\s*cover/.test(r.body));
    const hasAuto = expRules.some(r => /height\s*:\s*auto/.test(r.body));
    if (hasCover) ok(name + ' .exp-media img 有 object-fit:cover'); else fail(name + ' .exp-media img 缺少 object-fit:cover');
    if (hasAuto) ok(name + ' .exp-media img 保持 height:auto'); else fail(name + ' .exp-media img 缺少 height:auto（可能被强制高度压扁）');

    const guard = rules.find(r => /img\.ve-resizable/.test(r.sel) && /object-fit\s*:\s*cover/.test(r.body));
    if (guard) ok(name + ' 含全局 object-fit:cover 防护（覆盖 img.ve-resizable 等内容图片）');
    else fail(name + ' 缺少覆盖 img.ve-resizable 的全局 object-fit:cover 防护');
  }

  // 4. 内容图片 width+height 固定必须带 object-fit
  rules.forEach(r => {
    if (!isContentImg(r.sel)) return;
    const hasFixedH = /height\s*:\s*(?:\d+(?:\.\d+)?(px|rem|em|vh|vw|%)|(?:\d+\s*\/\s*\d+))/.test(r.body) && !/height\s*:\s*auto/.test(r.body);
    const hasFixedW = /width\s*:\s*\d+(?:\.\d+)?(px|rem|em|vh|vw|%)/.test(r.body);
    if (hasFixedH && hasFixedW && !/object-fit/.test(r.body)) {
      fail(name + ' 内容图片规则「' + r.sel + '」同时固定 width+height 却无 object-fit（会非等比拉伸）');
    }
  });
}

// 跨文件汇总：内容图片拉伸风险（避免重复刷屏，只在 allRules 上再查一遍内容选择器）
let chromeOrSafe = true;
allRules.forEach(r => {
  if (!isContentImg(r.sel)) return;
  const hasFixedH = /height\s*:\s*(?:\d+(?:\.\d+)?(px|rem|em|vh|vw|%)|(?:\d+\s*\/\s*\d+))/.test(r.body) && !/height\s*:\s*auto/.test(r.body);
  const hasFixedW = /width\s*:\s*\d+(?:\.\d+)?(px|rem|em|vh|vw|%)/.test(r.body);
  if (hasFixedH && hasFixedW && !/object-fit/.test(r.body)) chromeOrSafe = false;
});
if (chromeOrSafe) ok('无 width+height 无 object-fit 的内容图片拉伸风险规则');

console.log('');
if (failures) { console.error('QA 失败：' + failures + ' 项'); process.exit(1); }
console.log('QA 通过：图片等比裁切防护完好，无压扁风险。');
