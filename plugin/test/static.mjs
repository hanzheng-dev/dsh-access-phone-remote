/**
 * 插件静态测试 —— 验证 dsh 插件的结构正确性
 *
 * 不依赖 dsh 运行时，只检查：
 *   1. 语法正确
 *   2. 导出了必要的符号（name / inject / apply）
 *   3. package.json 格式正确
 *   4. cordis.patch.yml 格式正确
 *   5. apply() 能被调用（用 mock ctx）
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pluginDir = join(__dirname, '..')

let pass = 0
let fail = 0

function ok(msg) { console.log('  ✅ ' + msg); pass++ }
function bad(msg) { console.log('  ❌ ' + msg); fail++ }

console.log('\n=== dsj-open 插件静态测试 ===\n')

// ---------- 1. package.json ----------
console.log('[1] package.json')
try {
  const pkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
  pkg.name === 'dsj-open' ? ok('name = dsj-open') : bad('name 不对')
  pkg.type === 'module' ? ok('type = module') : bad('type 不是 module')
  pkg.exports?.['.'] ? ok('exports["."] 存在') : bad('缺 exports["."]')
  pkg.dsh?.bundle?.patch ? ok('dsh.bundle.patch 存在') : bad('缺 dsh.bundle.patch')
  pkg.dsh?.client?.platform === 'web' ? ok('dsh.client.platform = web') : bad('platform 不对')
  pkg.files?.includes('src') ? ok('files 含 src') : bad('files 缺 src')
  !pkg.dependencies ? ok('零依赖') : bad('有 dependencies：' + Object.keys(pkg.dependencies))
} catch (e) {
  bad('package.json 解析失败：' + e.message)
}

// ---------- 2. cordis.patch.yml ----------
console.log('\n[2] cordis.patch.yml')
try {
  const yml = readFileSync(join(pluginDir, 'cordis.patch.yml'), 'utf8')
  yml.includes('insert:') ? ok('含 insert:') : bad('缺 insert:')
  yml.includes('dsj-open') ? ok('含插件 id') : bad('缺插件 id')
} catch (e) {
  bad('读不到：' + e.message)
}

// ---------- 3. host half ----------
console.log('\n[3] src/index.js（host half）')
try {
  const { pathToFileURL } = await import('node:url')
  const mod = await import(pathToFileURL(join(pluginDir, 'src', 'index.js')).href)
  mod.name === 'dsj-open' ? ok(`导出 name = ${mod.name}`) : bad('name 导出不对')
  Array.isArray(mod.inject) ? ok(`导出 inject = [${mod.inject}]`) : bad('inject 不是数组')
  typeof mod.apply === 'function' ? ok('导出 apply 函数') : bad('apply 不是函数')

  // 用 mock ctx 调用 apply
  if (typeof mod.apply === 'function') {
    const routes = []
    const mockCtx = {
      webServer: {
        get(p, h) { routes.push(['GET', p]) },
        post(p, h) { routes.push(['POST', p]) },
      },
      on(evt, fn) { /* dispose */ },
    }
    try {
      mod.apply(mockCtx, {})
      ok(`apply() 调用成功，注册了 ${routes.length} 个路由`)
      routes.forEach(([m, p]) => console.log(`       ${m.padEnd(5)} ${p}`))
      routes.length >= 7 ? ok('路由数量合理（>=7）') : bad('路由太少：' + routes.length)
    } catch (e) {
      bad('apply() 抛异常：' + e.message)
    }
  }
} catch (e) {
  bad('加载失败：' + e.message)
}

// ---------- 4. client half ----------
console.log('\n[4] src/client.js（client half）')
try {
  const src = readFileSync(join(pluginDir, 'src', 'client.js'), 'utf8')
  src.includes('export const name') ? ok('有 name 导出') : bad('缺 name 导出')
  src.includes('export function apply') ? ok('有 apply 导出') : bad('缺 apply 导出')
  src.includes('buildPanel') ? ok('有 buildPanel') : bad('缺 buildPanel')
  // 前端半不能有 node: 导入
  const nodeImports = src.match(/from ['"]node:/g)
  !nodeImports ? ok('无 node: 导入（前端安全）') : bad('有 node: 导入：' + nodeImports.length + ' 处')
} catch (e) {
  bad('读不到：' + e.message)
}

// ---------- 5. 敏感信息 ----------
//
// 这里**不该**出现真实的口令 / IP / 私有路径 —— 插件是要单独发布到 npm 的，
// 把特征值写进测试等于把它们一起发出去。真实值放仓库的 scripts/.secrets.json
// （已 gitignore）；插件被单独安装、拿不到那份清单时，退化成下面那组通用启发式。
console.log('\n[5] 敏感信息扫描')
const files = ['src/index.js', 'src/client.js', 'package.json', 'cordis.patch.yml', 'README.md']

let searcher = null
let localSecrets = []
try {
  searcher = await import('../../scripts/secrets.mjs')
  localSecrets = searcher.loadSecrets(join(__dirname, '..', '..')).list
} catch {
  // 插件单独安装时没有 scripts/ 目录，正常
}

// 通用启发式：不依赖任何本机配置，因此对任何人都能跑
//
// 刻意**不**匹配 127.x / 0.0.0.0 —— 回环地址人人相同，把它当敏感值只会制造
// 噪声（插件的健康检查就必须写 127.0.0.1）。这里要抓的是「只对某一台机器
// 成立」的地址：私有网段和 Tailscale 的 CGNAT 段。
const PRIVATE_IP =
  /\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01])|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/
const GENERIC = [
  [/\b(?:x-auth|token|secret|passwd|password)\b\s*[:=]\s*['"][^'"]{8,}['"]/i, '疑似硬编码凭证'],
  [PRIVATE_IP, '疑似内网 / Tailscale IP'],
  [/C:\\Users\\[A-Za-z0-9_.-]+/i, '疑似 Windows 用户目录'],
]

let hits = 0
for (const f of files) {
  let content
  try { content = readFileSync(join(pluginDir, f), 'utf8') } catch { continue }
  if (searcher && localSecrets.length) {
    for (const label of searcher.scanText(content, localSecrets)) { bad(`${f} 命中「${label}」`); hits++ }
  }
  for (const [re, label] of GENERIC) {
    if (re.test(content)) { bad(`${f} ${label}`); hits++ }
  }
}
if (!hits) {
  ok(localSecrets.length ? '0 命中' : '0 命中（通用启发式；本机 scripts/.secrets.json 未配置）')
}

// ---------- 汇总 ----------
console.log('\n' + '='.repeat(40))
console.log(`通过 ${pass} · 失败 ${fail}`)
console.log('='.repeat(40) + '\n')
process.exit(fail ? 1 : 0)
