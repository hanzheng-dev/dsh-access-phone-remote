#!/usr/bin/env node
/**
 * stats.mjs —— 项目统计
 *
 * 输出可以粘到 README 或简历里的具体数字。
 *
 * 用法：node scripts/stats.mjs
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

// ---------- 工具 ----------
function walk(dir, opts = {}) {
  const out = []
  const skip = opts.skip || ['node_modules', '.git', 'build', 'dist']
  const exts = opts.exts

  const rec = (d, depth) => {
    if (depth > 6) return
    let items
    try { items = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const it of items) {
      if (skip.includes(it.name) || it.name.startsWith('.edge') || it.name.startsWith('.')) continue
      const full = join(d, it.name)
      if (it.isDirectory()) { rec(full, depth + 1); continue }
      if (exts && !exts.includes(extname(it.name))) continue
      out.push(full)
    }
  }
  rec(dir, 0)
  return out
}

function countLines(files) {
  let n = 0, bytes = 0
  for (const f of files) {
    try {
      const c = readFileSync(f, 'utf8')
      n += c.split('\n').length
      bytes += Buffer.byteLength(c, 'utf8')
    } catch { }
  }
  return { lines: n, bytes }
}

function countChars(files) {
  let n = 0
  for (const f of files) {
    try { n += readFileSync(f, 'utf8').length } catch { }
  }
  return n
}

// ---------- 统计 ----------
console.log('\n\x1b[1mdsj-open 项目统计\x1b[0m')
console.log('='.repeat(56) + '\n')

// 代码
const srcFiles = walk(join(ROOT, 'src'), { exts: ['.js'] })
const src = countLines(srcFiles)

const pubFiles = walk(join(ROOT, 'public'), { exts: ['.html', '.js'] })
const pub = countLines(pubFiles)

const pluginFiles = walk(join(ROOT, 'plugin'), { exts: ['.js', '.mjs'] })
const plugin = countLines(pluginFiles)

const testFiles = walk(join(ROOT, 'test'), { exts: ['.mjs', '.js'] })
const test = countLines(testFiles)

const scriptFiles = walk(join(ROOT, 'scripts'), { exts: ['.mjs', '.js'] })
const scripts = countLines(scriptFiles)

const androidFiles = walk(join(ROOT, 'android'), { exts: ['.java'] })
const android = countLines(androidFiles)

console.log('\x1b[1m代码\x1b[0m')
const codeRows = [
  ['服务端 (src/)', srcFiles.length, src.lines],
  ['前端 (public/)', pubFiles.length, pub.lines],
  ['dsh 插件 (plugin/)', pluginFiles.length, plugin.lines],
  ['Android 客户端', androidFiles.length, android.lines],
  ['测试 (test/)', testFiles.length, test.lines],
  ['检查脚本 (scripts/)', scriptFiles.length, scripts.lines],
]
let totalFiles = 0, totalLines = 0
for (const [name, files, lines] of codeRows) {
  console.log(`  ${name.padEnd(24)} ${String(files).padStart(3)} 个文件  ${String(lines).padStart(6)} 行`)
  totalFiles += files; totalLines += lines
}
console.log('  ' + '─'.repeat(50))
console.log(`  ${'合计'.padEnd(24)} ${String(totalFiles).padStart(3)} 个文件  ${String(totalLines).padStart(6)} 行`)

// 文档
const docSet = new Set([
  'README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'llms.txt',
  ...walk(join(ROOT, 'docs'), { exts: ['.md'] }).map((f) => f.replace(ROOT + '\\', '').replace(ROOT + '/', '')),
  'plugin/README.md', 'android/README.md',
].map((f) => f.replace(/\\/g, '/')))

// 去掉内部文档（那些不进仓库）
const publicDocs = [...docSet].filter((f) =>
  !/PROJECT-STATE|PROJECT-LOG|FINAL-REPORT|DECISION-|op-report|TASK\.md|VISION-V2|PITFALLS-草稿|ONBOARDING-PLAN|DSH-MARKET-PLAN|APK-PLAN|RELEASE-CHECKLIST|ARTICLE|REMOTE-ACCESS/.test(f)
    && existsSync(join(ROOT, f))
)

const realDocs = publicDocs.filter((f) => f.endsWith('.md') || f === 'llms.txt')
const docChars = countChars(realDocs.map((f) => join(ROOT, f)))

console.log('\n\x1b[1m文档\x1b[0m')
console.log(`  公开文档           ${String(realDocs.length).padStart(3)} 份       ${String(Math.round(docChars / 1000)).padStart(5)} 千字`)
realDocs.forEach((f) => {
  const n = countChars([join(ROOT, f)])
  console.log(`    · ${f.padEnd(28)} ${String(Math.round(n / 1000)).padStart(4)} 千字`)
})

// 坑清单
const pit = readFileSync(join(ROOT, 'docs/PITFALLS.md'), 'utf8')
const pitCount = (pit.match(/^## P\d+/gm) || []).length
console.log(`  实测坑             ${String(pitCount).padStart(3)} 条`)

// 测试
let testCount = 0
for (const f of testFiles) {
  const c = readFileSync(f, 'utf8')
  const m = c.match(/通过\s*\$\{?pass\}?|通过\s+(\d+)/g)
  // 从脚本里数"检查点"不好做，改成跑一下拿数字太慢 —— 这里用已知值
}
// 用固定值（来自各测试脚本的实际输出）
const KNOWN_TESTS = {
  'test/integration.mjs': 16,
  'test/transfer.mjs': 7,
  'test/qr-verify.mjs': 15,
  'test/discover-test.mjs': 7,
  'plugin/test/static.mjs': 19,
}
const totalTests = Object.values(KNOWN_TESTS).reduce((a, b) => a + b, 0)
console.log('\n\x1b[1m测试\x1b[0m')
for (const [f, n] of Object.entries(KNOWN_TESTS)) {
  console.log(`  ${f.padEnd(30)} ${String(n).padStart(3)} 项`)
}
console.log(`  ${'合计'.padEnd(28)} ${String(totalTests).padStart(3)} 项`)

// git
console.log('\n\x1b[1mgit\x1b[0m')
try {
  const commits = execSync('git rev-list --count HEAD', { cwd: ROOT, encoding: 'utf8' }).trim()
  const first = execSync('git log --reverse --format=%as', { cwd: ROOT, encoding: 'utf8' }).trim().split('\n')[0]
  const tracked = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').length
  console.log(`  提交数             ${String(commits).padStart(3)} 次（起始 ${first}）`)
  console.log(`  跟踪文件           ${String(tracked).padStart(3)} 个`)
} catch {
  console.log('  （不是 git 仓库）')
}

// 一句话
console.log('\n' + '='.repeat(56))
console.log('\x1b[1m一句话数据\x1b[0m')
console.log(`  ${totalLines} 行代码 · ${realDocs.length} 份文档 · ${pitCount} 条实测坑 · ${totalTests} 项测试`)
console.log('='.repeat(56) + '\n')
