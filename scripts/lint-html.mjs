/**
 * lint-html.mjs —— 前端静态检查
 *
 * 检查裁剪后可能留下的问题：
 *   1. JS 里 document.getElementById('x') 引用的 id，在 HTML 里存在吗
 *   2. HTML 里的 id 有没有重复
 *   3. 有没有引用已删除的 API（/api/chat、/api/op/* 等）
 *   4. 内联事件处理器引用的函数是否存在
 *
 * 用法：node scripts/lint-html.mjs
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadSecrets, scanText } from './secrets.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

let problems = 0
let checked = 0

function bad(msg) { console.log('  \x1b[31m✗\x1b[0m ' + msg); problems++ }
function good(msg) { console.log('  \x1b[32m✓\x1b[0m ' + msg) }
function note(msg) { console.log('  \x1b[33m!\x1b[0m ' + msg) }

const file = join(ROOT, 'public', 'index.html')
if (!existsSync(file)) {
  console.error('找不到 public/index.html')
  process.exit(1)
}
const html = readFileSync(file, 'utf8')

console.log('\n\x1b[1m前端静态检查\x1b[0m')
console.log('='.repeat(50))

// ---------- 1. HTML 里定义的 id ----------
console.log('\n[1] id 定义')
const definedIds = new Set()
for (const m of html.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)) definedIds.add(m[1])
console.log(`    HTML 里定义了 ${definedIds.size} 个 id`)

// 动态创建的 id（在 JS 字符串里）
const dynamicIds = new Set()
for (const m of html.matchAll(/id\s*=\s*\\?["']([\w-]+)\\?["']/g)) dynamicIds.add(m[1])
// 也抓模板字符串里的 id="..."
for (const m of html.matchAll(/id=\\?["']([\w-]+)\\?["']/g)) dynamicIds.add(m[1])
const allIds = new Set([...definedIds, ...dynamicIds])

// ---------- 2. JS 里引用的 id ----------
console.log('\n[2] getElementById 引用')
const refs = new Set()
for (const m of html.matchAll(/getElementById\(\s*['"]([\w-]+)['"]\s*\)/g)) refs.add(m[1])
for (const m of html.matchAll(/\$\(\s*['"]([\w-]+)['"]\s*\)/g)) refs.add(m[1])
console.log(`    JS 里引用了 ${refs.size} 个 id`)

const missing = [...refs].filter((id) => !allIds.has(id))
checked++
if (missing.length === 0) {
  good('所有引用的 id 都有定义')
} else {
  bad(`${missing.length} 个 id 引用了但没定义：`)
  missing.slice(0, 15).forEach((id) => console.log(`      ${id}`))
  if (missing.length > 15) console.log(`      …还有 ${missing.length - 15} 个`)
}

// ---------- 3. 重复 id ----------
console.log('\n[3] 重复 id')
const counts = {}
for (const m of html.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)) {
  counts[m[1]] = (counts[m[1]] || 0) + 1
}
const dups = Object.entries(counts).filter(([, n]) => n > 1)
checked++
if (dups.length === 0) good('没有重复 id')
else {
  note(`${dups.length} 个 id 出现多次（静态定义 + JS 动态创建是正常的）：`)
  dups.slice(0, 10).forEach(([id, n]) => console.log(`      ${id} × ${n}`))
}

// ---------- 4. 已删除的 API ----------
console.log('\n[4] 已删除的 API 引用')
// ⚠️ 2026-10-05 移出会话层 6 个（/api/chat /api/delta /api/sessions /api/stop
//    /api/busy /api/effort）：**会话层已回归开源版**，这些路由都在 src/routes/chat.js
//    实现、被页面合法引用（第一步接线 + 第二步逐字流 + features.effort 的档位切换）。
//    ⇒ 别再往这个清单里加它们，否则 lint 会把正常功能当"死引用"报错、卡发布自检。
//    剩下的是真·已裁剪、开源版不提供的接口。
const DEAD_API = [
  '/api/cost',
  '/api/op/', '/api/op-return', '/api/ask-answer',
  '/api/adb', '/api/phone-', '/api/screen-state',
  '/api/proxy-state', '/api/toggle-states',
  '/api/say', '/api/personas',
  '/st/', '/api/agent-', '/api/fht-',
]
const deadHits = []
for (const api of DEAD_API) {
  // 只找真正发起请求的用法（fetch / href / src），不找注释
  const re = new RegExp(`(fetch|href|src|action)\\s*[=(]\\s*[^\\n]{0,40}${api.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
  if (re.test(html)) deadHits.push(api)
}
checked++
if (deadHits.length === 0) good('没有引用已删除的 API')
else {
  bad(`${deadHits.length} 个已删除的 API 仍被引用：`)
  deadHits.forEach((a) => console.log(`      ${a}`))
}

// ---------- 5. 内联事件的函数是否存在 ----------
console.log('\n[5] 内联事件处理器')
const inlineCalls = new Set()
for (const m of html.matchAll(/on(?:click|change|input|submit)\s*=\s*["']([\w$]+)\s*\(/g)) {
  inlineCalls.add(m[1])
}
checked++
if (inlineCalls.size === 0) good('没有内联事件处理器（都用 addEventListener）')
else {
  const undef = [...inlineCalls].filter((fn) => !new RegExp(`(function\\s+${fn}\\b|${fn}\\s*=\\s*(function|\\())`).test(html))
  if (undef.length === 0) good(`${inlineCalls.size} 个内联函数都有定义`)
  else bad(`未定义的：${undef.join(', ')}`)
}

// ---------- 6. 遗留的 emoji（用户可见）----------
console.log('\n[6] 用户可见的 emoji')
const lines = html.split('\n')
const emojiRe = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}]/u
let emojiHits = 0
lines.forEach((l, i) => {
  const t = l.trim()
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('<!--')) return
  if (emojiRe.test(l)) { emojiHits++; if (emojiHits <= 5) console.log(`      L${i + 1}: ${t.slice(0, 70)}`) }
})
checked++
if (emojiHits === 0) good('已清空')
else note(`${emojiHits} 处（如果只在日志/提示里可以接受）`)

// ---------- 7. 敏感信息 ----------
console.log('\n[7] 敏感信息')
// 真实特征值不写在这里 —— 见 scripts/secrets.mjs 顶部说明。
const { list: SECRETS, ok: hasSecrets } = loadSecrets(ROOT)
let secretHits = 0
for (const label of scanText(html, SECRETS)) { bad(`命中「${label}」`); secretHits++ }
checked++
if (secretHits === 0) good(hasSecrets ? '0 命中' : '0 命中（⚠️ 未配置 scripts/.secrets.json，只做了通用扫描）')

// ---------- 汇总 ----------
console.log('\n' + '='.repeat(50))
console.log(`  检查 ${checked} 组 · 问题 ${problems} 个`)
console.log('='.repeat(50) + '\n')

process.exitCode = problems ? 1 : 0
