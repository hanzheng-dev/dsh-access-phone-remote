/**
 * discover-test.mjs —— 验证局域网广播能被收到
 *
 * 模拟手机端：监听 UDP 广播端口，看能不能发现服务。
 */

import dgram from 'node:dgram'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const PORT = 34921
const DISCOVERY_PORT = 30991

console.log('\n=== 局域网自动发现测试 ===\n')

// ---------- 1. 起监听（模拟手机） ----------
const discoveries = []
const listener = dgram.createSocket({ type: 'udp4', reuseAddr: true })

listener.on('message', (msg, rinfo) => {
  try {
    const j = JSON.parse(msg.toString('utf8'))
    if (j.magic !== 'dsh-access-phone-remote/1') return
    discoveries.push({ ...j, from: rinfo.address })
  } catch { }
})

await new Promise((resolve) => {
  listener.bind(DISCOVERY_PORT, () => {
    listener.setBroadcast(true)
    console.log(`[手机端] 监听 UDP ${DISCOVERY_PORT}`)
    resolve()
  })
})

// ---------- 2. 起服务（模拟电脑） ----------
console.log('[电脑端] 启动服务…')
const child = spawn(process.execPath, [join(ROOT, 'src', 'server.js')], {
  cwd: ROOT,
  env: { ...process.env, HUB_PORT: String(PORT), HUB_ROOT: join(ROOT, '.disc-test'), HUB_TOKEN: 'discovery-token-123' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', () => { })
child.stderr.on('data', () => { })

// ---------- 3. 等广播 ----------
console.log('[手机端] 等待广播…\n')
for (let i = 0; i < 12 && !discoveries.length; i++) await sleep(800)

// ---------- 4. 结果 ----------
let pass = 0, fail = 0
if (discoveries.length) {
  const d = discoveries[0]
  console.log('  ✓ 收到广播')
  console.log(`      来源 IP   : ${d.from}`)
  console.log(`      服务端口  : ${d.port}`)
  console.log(`      主机名    : ${d.name}`)
  console.log(`      token     : ${d.token ? d.token.slice(0, 8) + '…' : '(无)'}`)
  console.log(`      时间戳    : ${new Date(d.ts).toLocaleTimeString('zh-CN')}`)
  pass++

  // 校验字段
  if (d.magic === 'dsh-access-phone-remote/1') { console.log('  ✓ magic 标识正确'); pass++ } else { console.log('  ✗ magic 不对'); fail++ }
  if (d.port === PORT) { console.log(`  ✓ 端口匹配（${PORT}）`); pass++ } else { console.log(`  ✗ 端口不匹配：期望 ${PORT}，收到 ${d.port}`); fail++ }
  if (d.token === 'discovery-token-123') { console.log('  ✓ token 正确传递'); pass++ } else { console.log(`  ✗ token 不对（收到: ${JSON.stringify(d.token)}）`); fail++ }

  // 地址列表（手机端靠它挑一个能连的）
  if (Array.isArray(d.addresses) && d.addresses.length) {
    console.log('  ✓ 地址列表: ' + d.addresses.map((a) => `${a.ip}(${a.kind})`).join('  '))
    pass++
    const hasLan = d.addresses.some((a) => a.kind === 'lan')
    if (hasLan) { console.log('  ✓ 含局域网地址（手机能连）'); pass++ }
    else { console.log('  ! 没有局域网地址'); }
    const hasVirtual = d.addresses.some((a) => a.kind === 'virtual')
    if (hasVirtual) console.log('  · 含虚拟网卡（已标注 kind=virtual，手机端应跳过）')
  } else {
    console.log('  ✗ 缺 addresses 字段'); fail++
  }

  // 多次广播
  await sleep(3500)
  console.log(`\n  · 3.5 秒内共收到 ${discoveries.length} 次广播`)
  if (discoveries.length >= 2) { console.log('  ✓ 周期性广播正常'); pass++ }
  else { console.log('  ! 只收到一次（可能间隔更长）'); }
} else {
  console.log('  ✗ 12 秒内没收到任何广播')
  console.log('    可能原因：防火墙拦了 UDP / 网络禁广播 / 服务没起来')
  fail++
}

// ---------- 收尾 ----------
try { child.kill() } catch { }
try { listener.close() } catch { }
await sleep(400)

console.log('\n' + '='.repeat(44))
console.log(`  通过 ${pass} · 失败 ${fail}`)
console.log('='.repeat(44) + '\n')

// 用 exitCode 而不是 process.exit()，让待处理的 IO 自然收尾
process.exitCode = fail ? 1 : 0
