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
 * 本脚本检查：
 *   1) git tracked 文件里是否出现私人标识关键词
 *   2) 本机发布记录 public-link.json 里是否有指向私人模板（main）的公开发布
 *
 * ⚠ 维护说明：如果新人/新内容引入了新的私人关键词，加进 MARKERS 即可，不要降低阈值。
 *
 * 用法：node tools/qa-privacy-scan.cjs
 * 退出码：0 = PASS，1 = FAIL
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// 私人信息关键词：任何一条出现在 tracked 文件里都要报警
const MARKERS = [
  '全诗越',
  'zerontd@163.com',
  'zerontd',
  'Serment_euy',
  '青岛电影学院',
  '录音艺术学院',
  '宝宝巴士',
  '腾讯QQ短视频',
  '普通话二甲',
  '二等奖学金',
];

// 只扫文本类扩展名，避免二进制误报 / 巨慢
const TEXT_EXT = new Set([
  '.js', '.cjs', '.mjs', '.py', '.html', '.css', '.json', '.md',
  '.bat', '.sh', '.txt', '.yml', '.yaml', '.gitignore', '.gitattributes',
]);

const problems = [];

// ---------- 1) 扫描 git tracked 文件 ----------
let tracked = [];
try {
  tracked = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);
} catch (e) {
  console.error('无法执行 git ls-files：' + e.message);
  process.exit(1);
}

function isBinary(buf) {
  return buf.includes(0);
}

let scanned = 0;
for (const rel of tracked) {
  const ext = path.extname(rel).toLowerCase();
  if (!TEXT_EXT.has(ext)) continue;
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) continue;
  let buf;
  try {
    buf = fs.readFileSync(full);
  } catch {
    continue;
  }
  if (isBinary(buf)) continue;
  const text = buf.toString('utf8');
  scanned++;
  for (const m of MARKERS) {
    const idx = text.indexOf(m);
    if (idx === -1) continue;
    const line = text.slice(0, idx).split('\n').length;
    problems.push(`${rel}:${line} 含私人标识「${m}」`);
    break;
  }
}
console.log(`  扫描 tracked 文本文件：${scanned} 个`);

// ---------- 2) 检查本机发布记录 ----------
const linkPath = path.join(ROOT, 'content', 'public-link.json');
if (fs.existsSync(linkPath)) {
  try {
    const link = JSON.parse(fs.readFileSync(linkPath, 'utf8'));
    const bad = (link.deployments || []).filter(
      (d) => d.tpl === 'main' && ['github', 'cloudbase'].includes(d.provider)
    );
    if (bad.length) {
      for (const d of bad) {
        problems.push(`public-link.json 存在私人模板 main 的公开发布：${d.provider} ${d.url}`);
      }
    }
    const top = (link.url || '') + '';
    if (/\/(main|FolioFold)\/?$/.test(top) && link.provider === 'github') {
      problems.push(`public-link.json 顶层发布目标疑似指向私人页面：${top}`);
    }
    console.log(`  发布记录：${(link.deployments || []).length} 条，当前目标 ${top || '(无)'}`);
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
