#!/usr/bin/env node
/**
 * preflight.mjs —— 发布前检查
 *
 * 用法：
 *   node scripts/preflight.mjs
 *
 * 它会把"能不能发布"需要确认的事全跑一遍：
 *   1. 敏感信息扫描（代码 + 文档）
 *   2. 语法检查
 *   3. 三个测试套件
 *   4. package.json 必填字段（repository / author 还是 REPLACE_WITH_ 就报错）
 *   5. git 工作区是否干净
 *   6. 不该进仓库的文件（config.json / .hub-token / APK）
 *
 * 全过 = 可以发布。
 */

import { execSync, spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

let ok = 0, warn = 0, err = 0;
const problems = [];

function pass(m) { console.log('  \x1b[32m✓\x1b[0m ' + m); ok++; }
function note(m) { console.log('  \x1b[33m!\x1b[0m ' + m); warn++; }
function fail(m) { console.log('  \x1b[31m✗\x1b[0m ' + m); err++; problems.push(m); }
function head(m) { console.log('\n\x1b[1m' + m + '\x1b[0m'); }

function sh(cmd, opts = {}) {
  try {
    return { ok: true, out: execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', ...opts }) };
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || '') };
  }
}

console.log('\n\x1b[1mdsj-open 发布前检查\x1b[0m');
console.log('='.repeat(52));

// ---------- 1. 敏感信息 ----------
head('[1] 敏感信息扫描');

const SECRETS = [
  ['Tailscale 电脑 IP', /100\.85\.151\.53/],
  ['Tailscale 手机 IP', /100\.64\.83\.62/],
  ['本机局域网 IP', /192\.168\.2\.(35|39|5)\b/],
  ['推送口令', /<推送口令>/],
  ['QQ 号', /<QQ号>/],
  ['NapCat token', /<NapCat-token>/],
  ['私人路径', /<项目目录>/],
  ['Windows 用户名路径', /C:\\Users\\yhz/i],
];

// 只扫会被发布的文件（git 已跟踪的）
const tracked = sh('git ls-files');
if (!tracked.ok) {
  note('不是 git 仓库，跳过 git ls-files（改成扫全部文件）');
}

const files = tracked.ok
  ? tracked.out.split('\n').filter(Boolean).filter((f) =>
      /\.(js|mjs|ts|json|html|css|md|txt|yml|yaml|sh|py|java|xml)$/i.test(f))
  : [];

let secretHits = 0;
for (const f of files) {
  // ⚠️ 检查脚本自己含「待检测模式表」—— 那是模式，不是真凭证。跳过它们。
  const isCheckerItself =
    /scripts\/preflight\.mjs$/.test(f) ||
    /scripts\/lint-html\.mjs$/.test(f) ||
    /plugin\/test\/static\.mjs$/.test(f);
  if (isCheckerItself) continue;

  let content;
  try { content = readFileSync(join(ROOT, f), 'utf8'); } catch { continue; }
  for (const [label, re] of SECRETS) {
    if (re.test(content)) {
      fail(`${f} 命中「${label}」`);
      secretHits++;
    }
  }
}
if (!secretHits) pass(`已跟踪的 ${files.length} 个文件，0 命中`);

// ---------- 2. 语法 ----------
head('[2] 语法检查');
const srcFiles = sh('git ls-files "src/**/*.js"');
if (srcFiles.ok) {
  let bad = 0;
  for (const f of srcFiles.out.split('\n').filter(Boolean)) {
    const r = spawnSync(process.execPath, ['--check', join(ROOT, f)], { encoding: 'utf8' });
    if (r.status !== 0) { fail(`${f} 语法错误`); bad++; }
  }
  if (!bad) pass(`${srcFiles.out.split('\n').filter(Boolean).length} 个源文件语法正确`);
}

// ---------- 3. 测试 ----------
head('[3] 测试套件');

const SUITES = [
  ['端到端集成', 'test/integration.mjs'],
  ['QR 交叉验证', 'test/qr-verify.mjs'],
  ['插件静态检查', 'plugin/test/static.mjs'],
];

for (const [name, file] of SUITES) {
  if (!existsSync(join(ROOT, file))) { note(`${name}：文件不存在（${file}）`); continue; }
  const r = spawnSync(process.execPath, [join(ROOT, file)], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/通过\s+(\d+)\s*·\s*失败\s+(\d+)/);
  if (r.status === 0 && m) pass(`${name}：${m[1]} 通过 / ${m[2]} 失败`);
  else if (r.status === 0) pass(`${name}：通过`);
  else fail(`${name}：失败（退出码 ${r.status}）`);
}

// ---------- 4. package.json 字段 ----------
head('[4] package.json 必填字段');

for (const [pkgPath, label] of [['package.json', '根'], ['plugin/package.json', '插件']]) {
  const p = join(ROOT, pkgPath);
  if (!existsSync(p)) { note(`${label}：${pkgPath} 不存在`); continue; }
  let j;
  try { j = JSON.parse(readFileSync(p, 'utf8')); }
  catch (e) { fail(`${label}：${pkgPath} 解析失败`); continue; }

  const repo = JSON.stringify(j.repository || '');
  const author = String(j.author || '');
  if (repo.includes('REPLACE_WITH') || author.includes('REPLACE_WITH')) {
    fail(`${label}：repository / author 还是占位符（需要填真实 GitHub 信息）`);
  } else if (!j.repository || !j.author) {
    note(`${label}：缺 repository 或 author`);
  } else {
    pass(`${label}：字段完整`);
  }
}

// ---------- 5. 不该进仓库的文件 ----------
head('[5] 不该进仓库的文件');

const FORBIDDEN = ['config.json', '.hub-token', 'messages.json', 'pending.json'];
for (const f of FORBIDDEN) {
  const r = sh(`git ls-files "${f}"`);
  if (r.ok && r.out.trim()) fail(`${f} 被跟踪了！（应该在 .gitignore 里）`);
  else pass(`${f} 未被跟踪`);
}

// APK 产物
const apkTracked = sh('git ls-files "android/*.apk"');
if (apkTracked.ok && apkTracked.out.trim()) fail('APK 产物被跟踪了');
else pass('APK 产物未被跟踪');

// ---------- 6. git 状态 ----------
head('[6] git 工作区');

const st = sh('git status --porcelain');
if (!st.ok) note('不是 git 仓库');
else if (st.out.trim()) {
  const lines = st.out.trim().split('\n');
  note(`有 ${lines.length} 个未提交的改动（发布前建议提交）`);
} else {
  pass('工作区干净');
}

const log = sh('git log --oneline -1');
if (log.ok && log.out.trim()) pass(`最新提交：${log.out.trim().slice(0, 60)}`);

// ---------- 汇总 ----------
console.log('\n' + '='.repeat(52));
console.log(`  ✓ ${ok} 项通过   ! ${warn} 项注意   ✗ ${err} 项阻塞`);

if (problems.length) {
  console.log('\n\x1b[31m\x1b[1m必须解决：\x1b[0m');
  problems.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
}

console.log('\n\x1b[1m发布步骤：\x1b[0m');
if (err === 0) {
  console.log('  1. 填好 package.json / plugin/package.json 的 repository + author');
  console.log('  2. git remote add origin https://github.com/<你>/dsj-open.git');
  console.log('     git push -u origin main');
  console.log('  3. cd plugin && npm publish --access public');
  console.log('  4. 去 awesome-dsh-plugin 提 PR（见 docs/RELEASE-CHECKLIST.md）');
} else {
  console.log('  先解决上面标 ✗ 的问题。');
}
console.log('  详细清单：docs/RELEASE-CHECKLIST.md\n');

process.exit(err ? 1 : 0);
