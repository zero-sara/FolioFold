#!/usr/bin/env node
/**
 * 永久防线：FolioFold 的所有 .bat 必须是 CRLF 结尾。
 *
 * 背景（真实事故）：写文件工具默认输出 LF。cmd.exe 解析 LF-only 的 .bat 时
 * 会把带括号的 `for ... do ( ... )` 块、`goto`/标签全部解析错乱，变量 %%d
 * 不展开，于是 `if exist ":\FolioFold\server.py"` 报
 * "The system cannot find the drive specified"，最终用户只看到
 * "[Error] FolioFold project not found." —— 看起来像"项目丢了"，
 * 实际只是换行符错了。
 *
 * 本脚本检查两件事：
 *   1) 每个 .bat 全部行以 CRLF 结尾（不允许裸 LF）
 *   2) 每个 `for` 语句都带 `do` 关键字（防止手工压平括号块时漏掉）
 *
 * 用法：node tools/qa-bat-crlf.cjs
 * 退出码：0 = PASS，1 = FAIL
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'release', 'build',
  '_backups', '.folioframe', 'qa',
  '_archive', // 归档的历史脚本，不再随产品发布，不参与检查
]);

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.toLowerCase().endsWith('.bat')) out.push(full);
  }
  return out;
}

const files = walk(ROOT);
// 桌面上的转发器不在仓库内，若存在也一并检查
const desk = process.env.USERPROFILE
  ? [
      path.join(process.env.USERPROFILE, 'Desktop', 'FolioFold 启动.bat'),
      path.join(process.env.USERPROFILE, 'Desktop', 'FolioFold 停止.bat'),
    ]
  : [];
for (const p of desk) if (fs.existsSync(p)) files.push(p);

const problems = [];

for (const p of files) {
  const buf = fs.readFileSync(p);
  const rel = path.relative(ROOT, p) || p;

  const crlf = buf.filter((_, i, a) => a[i] === 0x0d && a[i + 1] === 0x0a).length;
  const lf = buf.filter((b) => b === 0x0a).length;
  const strayLF = lf - crlf;

  if (strayLF > 0) {
    problems.push(`${rel}: ${strayLF} 处裸 LF（非 CRLF）—— cmd.exe 会解析错乱`);
  }
  if (lf === 0 && buf.length > 0) {
    problems.push(`${rel}: 完全没有换行符，文件可能已损坏`);
  }

  // `do` 允许写在本行，也允许写在紧随其后的行（多行 for 块在 CRLF 下是合法的）
  const lines = buf.toString('utf8').split('\r\n');
  lines.forEach((raw, i) => {
    const s = raw.trim();
    if (!/^for\b/i.test(s)) return;
    const here = /\bdo\b/i.test(s);
    const next = lines.slice(i + 1, i + 3).some((l) => /^\s*do\b/i.test(l.trim()));
    if (!here && !next) {
      problems.push(`${rel}:${i + 1}: for 语句缺少 do 关键字 -> ${s}`);
    }
  });

  const status = strayLF > 0 ? 'FAIL' : 'ok  ';
  console.log(`  [${status}] ${rel}  (CRLF=${crlf}, strayLF=${strayLF}, lines=${lf})`);
}

console.log('');
if (problems.length) {
  console.error(`FAIL: ${problems.length} 个问题`);
  problems.forEach((m) => console.error('  - ' + m));
  console.error('\n修复方法（把 .bat 全部转成 CRLF）：');
  console.error('  python -c "import glob,io;[open(p,\'wb\').write(open(p,\'rb\').read().replace(b\'\\r\\n\',b\'\\n\').replace(b\'\\r\',b\'\\n\').replace(b\'\\n\',b\'\\r\\n\')) for p in glob.glob(\'**/*.bat\',recursive=True)]"');
  process.exit(1);
}
console.log(`PASS: ${files.length} 个 .bat 全部为 CRLF，for 语句均含 do。`);
