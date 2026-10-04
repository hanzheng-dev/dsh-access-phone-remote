/**
 * 端到端集成测试 —— 起一个临时实例，验证所有接口
 *
 * ⚠️ 用临时端口（不是 3099），不碰生产
 */

import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')
const PORT = 34899
const BASE = `http://127.0.0.1:${PORT}`

// 测试用的临时数据目录
const testRoot = join(projectRoot, '.test-run')
if (existsSync(testRoot)) rmSync(testRoot, { recursive: true, force: true })
mkdirSync(testRoot, { recursive: true })

let pass = 0
let fail = 0
function ok(m) { console.log('  ✅ ' + m); pass++ }
function bad(m) { console.log('  ❌ ' + m); fail++ }

async function get(path) {
  const r = await fetch(BASE + path)
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch { }
  return { status: r.status, text, json }
}

async function post(path, body, headers = {}) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch { }
  return { status: r.status, text, json }
}

console.log('\n=== dsj-open 端到端测试 ===')
console.log(`临时端口: ${PORT}（不碰生产 3099）\n`)

// ---------- 起服务 ----------
console.log('[0] 启动服务')
const env = {
  ...process.env,
  HUB_PORT: String(PORT),
  HUB_ROOT: testRoot,
  HUB_TOKEN: 'test-token-for-integration',
}

const child = spawn(process.execPath, [join(projectRoot, 'src', 'server.js')], {
  cwd: projectRoot,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
})

let serverLog = ''
child.stdout.on('data', (d) => { serverLog += d })
child.stderr.on('data', (d) => { serverLog += d })

// 等服务起来
let up = false
for (let i = 0; i < 20; i++) {
  await sleep(500)
  try {
    const r = await fetch(BASE + '/api/ping')
    if (r.ok) { up = true; break }
  } catch { }
}

if (!up) {
  bad('服务起不来')
  console.log('\n服务端输出:\n' + serverLog)
  child.kill()
  process.exit(1)
}
ok(`服务已启动（PID ${child.pid}）`)

// ---------- 1. 基础接口 ----------
console.log('\n[1] 基础接口')
{
  const r = await get('/api/ping')
  r.status === 200 && r.json?.ok ? ok('/api/ping → ok') : bad('/api/ping 失败: ' + r.status)

  const v = await get('/api/version')
  v.status === 200 ? ok(`/api/version → ${JSON.stringify(v.json)}`) : bad('/api/version 失败')

  const c = await get('/api/commands')
  const cmds = c.json?.commands || c.json?.list || []
  Array.isArray(cmds) && cmds.length >= 4
    ? ok(`/api/commands → ${cmds.length} 条指令: ${cmds.map((x) => x.id || x).join(', ')}`)
    : bad('/api/commands 异常: ' + JSON.stringify(c.json).slice(0, 100))
}

// ---------- 2. 鉴权 ----------
console.log('\n[2] 鉴权')
{
  // 回环应该免鉴权
  const r = await get('/api/inbox')
  r.status === 200 ? ok('回环免鉴权（/api/inbox 可达）') : bad('/api/inbox 状态 ' + r.status)
}

// ---------- 3. 推送 ----------
console.log('\n[3] 推送')
{
  const r = await post('/api/push', { text: '集成测试消息' }, { 'x-auth': 'test-token-for-integration' })
  r.status === 200 && r.json?.ok ? ok('/api/push → 已入队') : bad('/api/push 失败: ' + r.status + ' ' + r.text.slice(0, 100))

  const inbox = await get('/api/inbox')
  const msgs = inbox.json?.messages || inbox.json?.list || []
  msgs.some((m) => (m.text || '').includes('集成测试'))
    ? ok('消息出现在 /api/inbox')
    : bad('消息没进 inbox: ' + JSON.stringify(inbox.json).slice(0, 150))
}

// ---------- 4. 指令分发 ----------
console.log('\n[4] 指令分发（白名单机制）')
{
  const r = await post('/api/run', { id: 'stop' }, { 'x-auth': 'test-token-for-integration' })
  r.status === 200 && r.json?.ok
    ? ok(`/api/run stop → ${r.json.text}`)
    : bad('/api/run stop 失败: ' + r.status)

  const bad1 = await post('/api/run', { id: 'rm -rf /' }, { 'x-auth': 'test-token-for-integration' })
  bad1.status === 400 || bad1.json?.ok === false
    ? ok('未知指令被拒（白名单生效）')
    : bad('⚠️ 未知指令没被拒！' + JSON.stringify(bad1.json))

  const st = await post('/api/run', { id: 'status' }, { 'x-auth': 'test-token-for-integration' })
  st.json?.ok ? ok(`status → ${(st.json.text || '').slice(0, 60)}...`) : bad('status 失败')
}

// ---------- 5. 静态服务 ----------
console.log('\n[5] 静态服务')
{
  const r = await fetch(BASE + '/')
  const html = await r.text()
  r.status === 200 ? ok(`/ → ${r.status}（${html.length} 字节）`) : bad('/ 返回 ' + r.status)
  html.includes('<html') || html.includes('<!DOCTYPE') ? ok('返回的是 HTML') : bad('返回的不是 HTML')
}

// ---------- 6. 位置接口（需要 key，预期失败但接口要在） ----------
console.log('\n[6] 位置接口')
{
  const r = await get('/api/nav-config')
  r.status === 200 ? ok(`/api/nav-config → ${JSON.stringify(r.json).slice(0, 80)}`) : bad('/api/nav-config 状态 ' + r.status)

  const poi = await get('/api/poi?q=测试&lat=31.23&lng=121.47')
  // 没配 key 应该返回 ok:false，但接口要存在
  poi.status === 200 || poi.status === 500
    ? ok(`/api/poi 存在（没 key 时返回 ${poi.status}）`)
    : bad('/api/poi 状态 ' + poi.status)
}

// ---------- 7. 404 ----------
console.log('\n[7] 未知路由')
{
  const r = await get('/api/this-does-not-exist')
  r.status === 404 ? ok('未知路由 → 404') : bad('未知路由返回 ' + r.status)
}

// ---------- 收尾 ----------
console.log('\n[8] 收尾')
child.kill()
await sleep(800)
if (child.killed || child.exitCode !== null) ok('服务已停止')
else { bad('服务没停'); child.kill('SIGKILL') }

// 清理测试数据
try { rmSync(testRoot, { recursive: true, force: true }) } catch { }

console.log('\n' + '='.repeat(45))
console.log(`通过 ${pass} · 失败 ${fail}`)
console.log('='.repeat(45) + '\n')

process.exit(fail ? 1 : 0)
