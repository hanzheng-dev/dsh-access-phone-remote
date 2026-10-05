/**
 * lint-docs.mjs —— 文档检查
 *
 * 检查：
 *   1. markdown 里的相对链接指向的文件是否存在（死链）
 *   2. 文档里提到的文件路径是否存在
 *   3. 各文档里的「坑数」是否一致（改一条坑要同步好几处）
 *
 * 用法：node scripts/lint-docs.mjs
 */

import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

let problems = 0
let checked = 0

function bad(msg) { console.log('  \x1b[31m✗\x1b[0m ' + msg); problems++ }
function good(msg) { console.log('  \x1b[32m✓\x1b[0m ' + msg) }
function note(msg) { console.log('  \x1b[33m!\x1b[0m ' + msg) }

// ---------- 要检查的文档 ----------
const DOCS = [
  'README.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'CHANGELOG.md',
  'llms.txt',
  'docs/ARCHITECTURE.md',
  'docs/SECURITY.md',
  'docs/PITFALLS.md',
  'docs/TROUBLESHOOT.md',
  'docs/ONBOARDING.md',
  'docs/FOR-AI-EXTEND.md',
  'docs/REMOTE-ACCESS.md',
  'plugin/README.md',
  'android/README.md',
].filter((f) => existsSync(join(ROOT, f)))

console.log('\n\x1b[1m文档检查\x1b[0m')
console.log('='.repeat(52))
console.log(`\n检查 ${DOCS.length} 份文档\n`)

// ---------- 1. 相对链接 ----------
console.log('[1] 相对链接有效性')
const broken = []
let linkCount = 0

for (const doc of DOCS) {
  const content = readFileSync(join(ROOT, doc), 'utf8')
  const baseDir = dirname(join(ROOT, doc))

  // markdown 链接 [text](path) —— 只要相对路径（不含 http、#、mailto）
  for (const m of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    let target = m[1].trim()
    if (/^(https?:|mailto:|#)/.test(target)) continue
    target = target.split('#')[0]           // 去掉锚点
    if (!target) continue
    linkCount++

    const full = resolve(baseDir, target)
    if (!existsSync(full)) {
      broken.push({ doc, target })
    }
  }
}
checked++
if (broken.length === 0) {
  good(`${linkCount} 个相对链接全部有效`)
} else {
  bad(`${broken.length} 个死链（共 ${linkCount} 个链接）：`)
  broken.slice(0, 15).forEach((b) => console.log(`      ${b.doc} → ${b.target}`))
  if (broken.length > 15) console.log(`      …还有 ${broken.length - 15} 个`)
}

// ---------- 2. 文档里提到的代码路径 ----------
console.log('\n[2] 提到的文件是否存在')
const pathRefs = new Set()
for (const doc of DOCS) {
  const content = readFileSync(join(ROOT, doc), 'utf8')
  // 反引号里的路径样式：src/xxx.js、docs/xxx.md、public/xxx
  for (const m of content.matchAll(/`([a-z][\w./-]*\.(js|mjs|json|md|html|sh|yml|py))`/g)) {
    const p = m[1]
    if (p.includes('*') || p.startsWith('http')) continue
    pathRefs.add(p)
  }
}
const missingPath = []
for (const p of pathRefs) {
  // 允许只写文件名（在已知目录里找）
  const candidates = [
    join(ROOT, p),
    join(ROOT, 'src', p),
    join(ROOT, 'docs', p),
    join(ROOT, 'public', p),
    join(ROOT, 'test', p),
    join(ROOT, 'scripts', p),
    join(ROOT, 'plugin', p),
    join(ROOT, 'android', p),
  ]
  if (!candidates.some((c) => existsSync(c))) missingPath.push(p)
}
checked++
if (missingPath.length === 0) {
  good(`${pathRefs.size} 个路径引用全部存在`)
} else {
  note(`${missingPath.length} 个路径没找到（可能是说明性的，比如"改 config.json"）：`)
  missingPath.slice(0, 12).forEach((p) => console.log(`      ${p}`))
}

// ---------- 3. 坑数一致性 ----------
console.log('\n[3] 坑数一致性')
const pit = readFileSync(join(ROOT, 'docs/PITFALLS.md'), 'utf8')
const pitCount = (pit.match(/^## P\d+/gm) || []).length
console.log(`    PITFALLS.md 实际有 ${pitCount} 条`)

const inconsistent = []
for (const doc of DOCS) {
  if (doc === 'docs/PITFALLS.md') continue
  const content = readFileSync(join(ROOT, doc), 'utf8')
  for (const m of content.matchAll(/(\d+)\s*条(?:实测)?坑/g)) {
    const n = Number(m[1])
    if (n !== pitCount) inconsistent.push({ doc, n })
  }
}
checked++
if (inconsistent.length === 0) {
  good('所有文档里的坑数都一致')
} else {
  bad(`${inconsistent.length} 处坑数不一致（应为 ${pitCount}）：`)
  inconsistent.forEach((i) => console.log(`      ${i.doc} 写着 ${i.n} 条`))
}

// ---------- 4. 文档非空 ----------
console.log('\n[4] 文档非空')
const empties = DOCS.filter((f) => {
  try { return statSync(join(ROOT, f)).size < 100 } catch { return true }
})
checked++
if (empties.length === 0) good('没有空文档')
else bad(`过短的文档：${empties.join(', ')}`)

// ---------- 汇总 ----------
console.log('\n' + '='.repeat(52))
console.log(`  检查 ${checked} 组 · 问题 ${problems} 个`)
console.log('='.repeat(52) + '\n')

process.exitCode = problems ? 1 : 0
