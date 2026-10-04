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
// ⚠️ 下面这张表是「待检测的特征值」—— 它们出现在这里是为了**检查插件里有没有**，
//    不是真实凭证（原环境的值早已轮换）。扫描命中说明插件里混进了不该有的东西。
console.log('\n[5] 敏感信息扫描')
const files = ['src/index.js', 'src/client.js', 'package.json', 'cordis.patch.yml', 'README.md']
const patterns = [/100\.85\.151\.53/, /100\.64\.83\.62/, /<推送口令>/, /<QQ号>/, /<NapCat-token>/, /<项目目录>/]
let hits = 0
for (const f of files) {
  try {
    const c = readFileSync(join(pluginDir, f), 'utf8')
    for (const p of patterns) {
      if (p.test(c)) { bad(`${f} 命中 ${p}`); hits++ }
    }
  } catch { }
}
if (!hits) ok('0 命中')

// ---------- 汇总 ----------
console.log('\n' + '='.repeat(40))
console.log(`通过 ${pass} · 失败 ${fail}`)
console.log('='.repeat(40) + '\n')
process.exit(fail ? 1 : 0)
