#!/usr/bin/env node
/**
 * 永久防线：公开源码不得夹带创作者私人资料。
 *
 * 背景（真事故，2026-10-08 收尾审计）：
 *   ① `tools/i18n/build_dict.py` 的 NEVER 集合里硬编码了真实学校 / GPA / 课程 / 技能词表；
 *   ② 私人工作区（main）被误发布到公开的 FolioFrame Pages 仓库 + CloudBase 静态托管，
 *      公开 URL 上直接能看到真实姓名 / 邮箱 / 微信 / 简历全文。
 *   两者都进了公开仓库 —— 违反项目铁律「Sarah 真实个人数据禁止进入公开 GitHub」。
 *
 * ⚠ 设计红线：本文件**不得硬编码任何真实个人信息**（否则等于把私人资料又写了一份进公开仓库）。
 *   私人标识一律从本机 gitignored 的内容文件里**动态提取**。
 *
 * 检查三项：
 *   1) 本机私人内容里出现的标识词，是否漏进了 git tracked 文件
 *   2) tracked 文件里是否出现邮箱 / 手机号等通用个人信息格式
 *   3) public-link.json 是否仍留有 main（私人工作区）的公开发布记录
 *
 * 用法：node tools/qa-privacy-scan.cjs
 * 退出码：0 = PASS，1 = FAIL
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// 本机私人内容来源（全部 gitignore，绝不入库）
const LOCAL_SOURCES = [
  'content/portfolio.json',
  'content/portfolio.published.json',
];

function readJson(rel) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) return null;
  try {
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch {
    return null;
  }
}

/** 从本机私人内容里抽出「能指认到具体个人」的字符串。
 *  分两级：tier1 = 姓名 / 邮箱 / 微信 / 主页链接（极强信号，一律检查）；
 *         tier2 = 职务 / 技能 / 经历（弱信号，过短的专业词会误伤，要求足够长度）。 */
function collectIdentityTokens() {
  const tier1 = new Set();
  const tier2 = new Set();
  const put = (set, v, minLen) => {
    const s = String(v == null ? '' : v).trim();
    if (s.length >= minLen && s.length <= 200) set.add(s);
  };

  for (const rel of LOCAL_SOURCES) {
    const d = readJson(rel);
    if (!d) continue;
    const prof = d.profile || {};
    put(tier1, prof.name, 2);
    const c = prof.contact || {};
    put(tier1, c.email, 4);
    put(tier1, c.location, 2);
    put(tier1, c.github, 4);
    for (const l of prof.contactLinks || []) put(tier1, l && (l.value || l.url), 3);
    for (const p of prof.publicLinks || []) put(tier1, p && (p.value || p.url), 6);
    put(tier2, prof.role, 8);
    for (const e of prof.education || []) put(tier2, e, 8);
    for (const s of prof.skills || []) put(tier2, s, 8);
    for (const h of prof.highlights || []) put(tier2, h, 8);
  }

  return { tier1, tier2 };
}

/** 占位邮箱 / 伪造串不算隐私：模板里的 you@example.com、代码里的 %s@github.com 等 */
function isPlaceholderEmail(email) {
  if (!email) return true;
  const [local, domain = ''] = email.split('@');
  if (local.length < 3) return true;
  if (local.includes('%')) return true;
  const d = domain.toLowerCase();
  if (d === 'github.com') return true;           // 代码里拼出来的用户名占位
  return /(^|\.)(example|test|sample|domain|localhost)\.(com|org|net|edu|io)$/.test(d)
    || d.endsWith('.invalid');
}
const TEXT_EXT = new Set([
  '.js', '.cjs', '.mjs', '.py', '.html', '.css', '.json', '.md',
  '.bat', '.sh', '.txt', '.yml', '.yaml', '.gitignore', '.gitattributes',
]);

// 通用个人信息格式（不含任何具体人的真实值）
const PATTERNS = [
  { name: '邮箱地址', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/ },
  { name: '中国大陆手机号', re: /(?<!\d)1[3-9]\d{9}(?!\d)/ },
];

const problems = [];

let tracked = [];
try {
  tracked = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);
} catch (e) {
  console.error('无法执行 git ls-files：' + e.message);
  process.exit(1);
}

const { tier1, tier2 } = collectIdentityTokens();
// 邮箱「@ 前面那段」也算 —— 防止有人把邮箱拆开写进注释来绕过检查
for (const t of [...tier1]) {
  const m = /^([^@\s]{4,})@/.exec(t);
  if (m) tier1.add(m[1]);
}
console.log(`  从本机私人内容提取到强标识 ${tier1.size} 个 / 弱标识 ${tier2.size} 个（来源均已 gitignore）`);

// 项目自身对外就合法的公开链接：README 里的 clone 地址、Demo 的 Pages 地址等。
const PUBLIC_ALLOWLIST = [
  /github\.com\/[A-Za-z0-9_-]+\/(FolioFold|FolioFrame)/i,
  /[A-Za-z0-9_-]+\.github\.io\/(FolioFold|FolioFrame)/i,
  /github\.com\/[A-Za-z0-9_-]+\/(FolioFold|FolioFrame)\.git/i,
];

let scanned = 0;
for (const rel of tracked) {
  if (!TEXT_EXT.has(path.extname(rel).toLowerCase())) continue;
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) continue;
  let text;
  try {
    text = fs.readFileSync(full).toString('utf8');
  } catch {
    continue;
  }
  if (text.includes('\0')) continue;
  scanned++;

  for (const t of tier1) {
    const idx = text.indexOf(t);
    if (idx === -1) continue;
    const line = text.slice(0, idx).split('\n').length;
    const snippet = text.slice(Math.max(0, idx - 30), idx + t.length + 10).replace(/\s+/g, ' ');
    if (PUBLIC_ALLOWLIST.some((re) => re.test(snippet))) continue;
    problems.push(`${rel}:${line} 含本机私人强标识（姓名/联系方式级）`);
    break;
  }
  for (const t of tier2) {
    const idx = text.indexOf(t);
    if (idx === -1) continue;
    const line = text.slice(0, idx).split('\n').length;
    problems.push(`${rel}:${line} 含本机简历正文片段（职务/技能/经历）`);
    break;
  }

  for (const p of PATTERNS) {
    const hit = p.re.exec(text);
    if (!hit) continue;
    if (p.name === '邮箱地址' && isPlaceholderEmail(hit[0])) continue;
    const line = text.slice(0, hit.index).split('\n').length;
    problems.push(`${rel}:${line} 疑似个人信息（${p.name}）`);
  }
}
console.log(`  扫描 tracked 文本文件：${scanned} 个`);

// ---------- 发布记录检查 ----------
const linkPath = path.join(ROOT, 'content', 'public-link.json');
if (fs.existsSync(linkPath)) {
  try {
    const link = JSON.parse(fs.readFileSync(linkPath, 'utf8'));
    const deps = link.deployments || [];
    const bad = deps.filter((d) => d.tpl === 'main' && ['github', 'cloudbase'].includes(d.provider));
    for (const d of bad) problems.push(`public-link.json 仍留有私人模板 main 的公开发布：${d.provider} ${d.url}`);
    console.log(`  发布记录：${deps.length} 条，当前目标 ${link.url || '(无)'}`);
  } catch (e) {
    problems.push('public-link.json 解析失败：' + e.message);
  }
}

console.log('');
if (problems.length) {
  console.error(`FAIL: 发现 ${problems.length} 处隐私风险`);
  problems.forEach((p) => console.error('  - ' + p));
  console.error('\n处理：把私人内容从仓库 / 发布记录中移除后重跑。');
  process.exit(1);
}
console.log('PASS: 公开源码与发布记录中均未发现私人资料。');
