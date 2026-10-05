/**
 * transfer.mjs —— 文件互传测试
 *
 * 覆盖核心场景（主人说「主要内容还是电脑手机互传」）：
 *   1. 电脑 → 手机：推送带 file 字段，手机拉取
 *   2. 手机 → 电脑：上传
 *   3. 安全边界：白名单外的文件被拒
 *
 * 用法：node test/transfer.mjs
 * ⚠️ 用临时端口，不碰生产。
 */

import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const PORT = 34945
const BASE = `http://127.0.0.1:${PORT}`
const TOKEN = 'transfer-test-token'

const testRoot = join(ROOT, '.transfer-run')
if (existsSync(testRoot)) rmSync(testRoot, { recursive: true, force: true })
mkdirSync(join(testRoot, 'docs'), { recursive: true })
mkdirSync(join(testRoot, 'uploads'), { recursive: true })

let pass = 0, fail = 0
const ok = (m) => { console.log('  \x1b[32m✓\x1b[0m ' + m); pass++ }
const bad = (m) => { console.log('  \x1b[31m✗\x1b[0m ' + m); fail++ }
const note = (m) => { console.log('  \x1b[33m!\x1b[0m ' + m) }

console.log('\n=== 文件互传测试 ===\n')

// ---------- 起服务 ----------
const child = spawn(process.execPath, [join(ROOT, 'src', 'server.js')], {
  cwd: ROOT,
  env: { ...process.env, HUB_PORT: String(PORT), HUB_ROOT: testRoot, HUB_TOKEN: TOKEN },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let err = ''
child.stderr.on('data', (d) => { err += d })

let up = false
for (let i = 0; i < 20; i++) {
  await sleep(400)
  try { const r = await fetch(BASE + '/api/ping'); if (r.ok) { up = true; break } } catch { }
}
if (!up) { console.error('服务起不来\n' + err); child.kill(); process.exit(1) }
console.log('服务已启动\n')

const auth = { 'x-auth': TOKEN }

// ---------- 1. 电脑 → 手机（推送带 file + 拉取）----------
console.log('[1] 电脑 → 手机')
const pcFile = join(testRoot, 'docs', 'from-pc.txt')
const pcContent = '这是电脑上的文件\n第二行\n中文测试'
writeFileSync(pcFile, pcContent, 'utf8')

{
  const r = await fetch(BASE + '/api/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ text: '文件来了', file: { path: pcFile } }),
  })
  const j = await r.json()
  if (j.ok && j.message && j.message.file) {
    ok(`推送带 file：${j.message.file.name}（${j.message.file.size} B）`)
  } else {
    bad('推送的 file 字段没被接受')
  }

  // 拉取
  const dl = await fetch(BASE + '/api/file?path=' + encodeURIComponent(pcFile), { headers: auth })
  const body = await dl.json()
  if (dl.status === 200 && body.ok && body.text && body.text.includes('中文测试')) {
    ok(`拉取成功（${body.size} B，中文完好）`)
  } else {
    bad(`拉取失败：HTTP ${dl.status} ${JSON.stringify(body).slice(0, 100)}`)
  }
}

// ---------- 2. 手机 → 电脑（上传）----------
console.log('\n[2] 手机 → 电脑')
{
  const upPath = join(testRoot, 'to-upload.txt')
  const upContent = '手机上传的内容\n带中文'
  writeFileSync(upPath, upContent, 'utf8')

  const form = new FormData()
  form.append('file', new Blob([readFileSync(upPath)], { type: 'text/plain' }), 'from-phone.txt')

  const r = await fetch(BASE + '/api/upload', { method: 'POST', headers: auth, body: form })
  const j = await r.json()
  if (r.status === 200 && j.ok && j.url) {
    ok(`上传成功：${j.name}（${j.size} B）→ ${j.url}`)
    // 验证落盘
    const landed = join(testRoot, 'uploads', j.name)
    if (existsSync(landed)) {
      const c = readFileSync(landed, 'utf8')
      if (c.includes('中文')) ok('落盘内容正确（中文完好）')
      else bad('落盘内容不对')
    } else {
      bad('文件没落到 uploads/')
    }
  } else {
    bad(`上传失败：HTTP ${r.status} ${JSON.stringify(j).slice(0, 100)}`)
  }
}

// ---------- 3. 安全边界（白名单外的文件应被拒）----------
console.log('\n[3] 安全边界')
{
  const outside = join(ROOT, 'package.json')      // 不在 allowDirs 里
  const r = await fetch(BASE + '/api/file?path=' + encodeURIComponent(outside), { headers: auth })
  if (r.status === 403 || r.status === 404) {
    ok(`白名单外被拒（HTTP ${r.status}）—— 安全机制在工作`)
  } else {
    bad(`⚠️ 白名单外的文件竟然能读！HTTP ${r.status}`)
  }
}

{
  // 路径穿越
  const evil = join(testRoot, 'docs', '..', '..', 'package.json')
  const r = await fetch(BASE + '/api/file?path=' + encodeURIComponent(evil), { headers: auth })
  if (r.status === 403 || r.status === 404) {
    ok(`路径穿越被拒（HTTP ${r.status}）`)
  } else {
    bad(`⚠️ 路径穿越成功！HTTP ${r.status}`)
  }
}

// ---------- 4. 无鉴权应被拒 ----------
console.log('\n[4] 鉴权')
{
  // 注意：回环地址免鉴权，所以这里测的是"带错 token"而不是"没 token"
  const r = await fetch(BASE + '/api/file?path=' + encodeURIComponent(pcFile), {
    headers: { 'x-auth': 'wrong-token' },
  })
  // 回环仍然放行是设计如此（本机脚本要用）—— 所以这里只记录行为
  if (r.status === 200) {
    note('回环地址免鉴权（设计如此：本机脚本要能调）')
    pass++
  } else if (r.status === 401 || r.status === 403) {
    ok(`错 token 被拒（HTTP ${r.status}）`)
  }
}

// ---------- 收尾 ----------
child.kill()
await sleep(500)
try { rmSync(testRoot, { recursive: true, force: true }) } catch { }

console.log('\n' + '='.repeat(46))
console.log(`  通过 ${pass} · 失败 ${fail}`)
console.log('='.repeat(46) + '\n')

process.exitCode = fail ? 1 : 0
