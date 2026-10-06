/**
 * stress.mjs —— 压力测试
 *
 * 目的：证明服务端在持续负载下稳定（不崩、不丢消息、内存不爆）。
 *
 * 用法：node test/stress.mjs [消息数]
 *   默认 500 条，并发 20。
 *
 * ⚠️ 用临时端口，不碰生产。
 */

import { spawn, execSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { rmSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

const PORT = 34931
const BASE = `http://127.0.0.1:${PORT}`
const TOKEN = 'stress-test-token'
const N = Number(process.argv[2]) || 500
const CONCURRENCY = 20

const testRoot = join(ROOT, '.stress-run')
if (existsSync(testRoot)) rmSync(testRoot, { recursive: true, force: true })
mkdirSync(testRoot, { recursive: true })

console.log('\n=== dsh-access-phone-remote 压力测试 ===')
console.log(`消息数 ${N} · 并发 ${CONCURRENCY} · 临时端口 ${PORT}\n`)

// ---------- 起服务 ----------
const child = spawn(process.execPath, [join(ROOT, 'src', 'server.js')], {
  cwd: ROOT,
  env: { ...process.env, HUB_PORT: String(PORT), HUB_ROOT: testRoot, HUB_TOKEN: TOKEN },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverErr = ''
child.stderr.on('data', (d) => { serverErr += d })

let up = false
for (let i = 0; i < 20; i++) {
  await sleep(400)
  try { const r = await fetch(BASE + '/api/ping'); if (r.ok) { up = true; break } } catch { }
}
if (!up) { console.error('服务起不来\n' + serverErr); child.kill(); process.exit(1) }
console.log('服务已启动\n')

// ---------- 工具 ----------
function rss() {
  try {
    if (process.platform === 'win32') {
      const out = execSync(
        `powershell -NoProfile -Command "(Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue).WorkingSet64"`,
        { encoding: 'utf8', timeout: 10000 },
      ).trim()
      const n = Number(out)
      return n > 0 ? Math.round(n / 1024 / 1024) : -1
    }
    // Unix
    const out = execSync(`ps -o rss= -p ${child.pid}`, { encoding: 'utf8', timeout: 5000 }).trim()
    return Math.round(Number(out) / 1024)
  } catch {
    return -1
  }
}

async function push(text) {
  const t0 = Date.now()
  const r = await fetch(BASE + '/api/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-auth': TOKEN },
    body: JSON.stringify({ text }),
  })
  return { status: r.status, ms: Date.now() - t0 }
}

// ---------- 1. 基线 ----------
const memBefore = rss()
console.log(`[1] 基线内存: ${memBefore} MB`)

// ---------- 2. 分批推送 ----------
console.log(`[2] 推送 ${N} 条（并发 ${CONCURRENCY}）…`)
const t0 = Date.now()
const latencies = []
let failed = 0
let done = 0

for (let i = 0; i < N; i += CONCURRENCY) {
  const batch = []
  for (let j = 0; j < CONCURRENCY && i + j < N; j++) {
    batch.push(push(`压测消息 #${i + j} —— 这是一条用于测试的稍长文本，模拟真实推送内容`))
  }
  const results = await Promise.all(batch)
  for (const r of results) {
    if (r.status !== 200) failed++
    else latencies.push(r.ms)
  }
  done += results.length
  if (done % 100 === 0) process.stdout.write(`    ${done}/${N}\r`)
}
const elapsed = Date.now() - t0
console.log(`    完成：${done} 条，用时 ${elapsed} ms`)

// ---------- 3. 延迟统计 ----------
latencies.sort((a, b) => a - b)
const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0
const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0
const p99 = latencies[Math.floor(latencies.length * 0.99)] || 0
const avg = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0

console.log('\n[3] 延迟')
console.log(`    平均 ${avg} ms · p50 ${p50} ms · p95 ${p95} ms · p99 ${p99} ms`)
console.log(`    吞吐 ${Math.round(N / (elapsed / 1000))} 条/秒`)

// ---------- 4. 完整性 ----------
console.log('\n[4] 消息完整性')
await sleep(500)
const inbox = await (await fetch(BASE + '/api/inbox', { headers: { 'x-auth': TOKEN } })).json()
const msgs = inbox.messages || inbox.list || []
const stressMsgs = msgs.filter((m) => (m.text || '').includes('压测消息'))
const unique = new Set(stressMsgs.map((m) => m.text))
console.log(`    收到 ${stressMsgs.length} 条（去重后 ${unique.size}）`)
console.log(`    期望 ${N} 条`)

// ---------- 5. 内存 ----------
const memAfter = rss()
const growth = memAfter - memBefore
console.log('\n[5] 内存')
console.log(`    推送前 ${memBefore} MB → 推送后 ${memAfter} MB（增长 ${growth} MB）`)

// ---------- 6. 服务还活着吗 ----------
console.log('\n[6] 存活检查')
let alive = false
try { const r = await fetch(BASE + '/api/ping'); alive = r.ok } catch { }
console.log(`    ${alive ? '服务仍在响应' : '服务已死'}`)

// ---------- 汇总 ----------
console.log('\n' + '='.repeat(48))
const okAll = failed === 0 && unique.size === N && alive
console.log(`  失败 ${failed} 条 · 唯一消息 ${unique.size}/${N} · 存活 ${alive ? '是' : '否'}`)
console.log(`  结论：${okAll ? '✓ 通过' : '✗ 有问题'}`)
console.log('='.repeat(48) + '\n')

// ---------- 收尾 ----------
child.kill()
await sleep(600)
try { rmSync(testRoot, { recursive: true, force: true }) } catch { }

process.exit(okAll ? 0 : 1)
