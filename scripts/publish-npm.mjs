#!/usr/bin/env node
/**
 * publish-npm.mjs —— 把 plugin/ 发到 npm，并**验证它真的上线了**。
 *
 * 为什么要有这个脚本：
 *   2026-10-06 第一次发布时整条路踩了五个坑，每个都花了不少时间。
 *   那些结论如果只留在对话里，上下文一压缩就没了 —— 所以钉进这里。
 *
 * 用法：
 *   node scripts/publish-npm.mjs                  # 交互式粘贴令牌
 *   NPM_TOKEN=npm_xxx node scripts/publish-npm.mjs
 *   node scripts/publish-npm.mjs --token npm_xxx
 *   node scripts/publish-npm.mjs --revoke <tokenId>   # 发完顺手吊销（id 从 npm token list 拿）
 *   node scripts/publish-npm.mjs --dry-run            # 只打包预览，不发
 *   node scripts/publish-npm.mjs --verify-only        # 只验证当前版本在不在 registry 上
 *
 * ════════════════════════════════════════════════════════════════════
 * 五个坑（全是实测出来的，别再踩）
 * ════════════════════════════════════════════════════════════════════
 *
 * 【坑 1】npm 要求「发布必须过 2FA」，而**新开 TOTP（验证器 App）已不被接受**
 *   服务器原话：
 *     Adding a new TOTP (time-based one-time password) two-factor
 *     authentication is no longer supported. Please visit
 *     https://npmjs.com/settings/<user>/tfa to add a security key 2FA method instead.
 *   ⇒ 只剩一条能自动化的路：网页建一张**勾了 Bypass 2FA 的 Granular Access Token**
 *     Access Tokens → Generate New Token → Granular Access Token
 *       · 勾 Bypass two-factor authentication (2FA)   ← 会弹安全警告，是警告不是阻止
 *       · Permissions 选 "Read and write (publish and stage)"
 *       · Select packages 选 **All packages**
 *
 * 【坑 2】创建令牌时**不能用 `--packages <包名>` 框住还没发布过的包**
 *   回：401 You do not have access to the requested package(s)
 *   —— 那个包还不存在，没东西可授权。⇒ 必须选 All packages。
 *
 * 【坑 3】发布「成功」之后，registry 上可能**看不到你的版本号**
 *   两个原因叠一起，容易误判成失败：
 *     a) npm 首次建包时先放一个占位版本 `0.0.0-stage`
 *        （description 就写着 "Temporary package placeholder for staged publishing"）
 *     b) `registry.npmjs.org/<包名>` 这个 packument 接口**有 CDN 缓存**
 *   ⇒ **判断成没成，不要读 packument。** 正确判据两个，本脚本都用：
 *       ① `GET /<包名>/<版本号>` 返回 200
 *       ② 下载 tarball，SHA1 == `npm publish` 打印的 shasum
 *
 * 【坑 4】`npm token revoke` 只认 **id**，不认 token 值
 *   传值 → Unknown token id or value "npm_***"。id 从 `npm token list` 拿。
 *
 * 【坑 5】本机 npm 的 registry 是镜像（npmmirror）—— 镜像只能装不能发
 *   所以这里每次都显式带 --registry，plugin/package.json 里也钉了
 *   publishConfig.registry 做双保险。
 *
 * 【附带】走代理时 npm 的 git/registry 请求不读系统代理。
 *   本脚本用 HTTPS_PROXY 环境变量（默认 http://127.0.0.1:7897）。
 * ════════════════════════════════════════════════════════════════════
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import https from 'node:https'
import crypto from 'node:crypto'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN_DIR = path.join(ROOT, 'plugin')
const NPMRC = path.join(os.homedir(), '.npmrc')
const REGISTRY = 'https://registry.npmjs.org/'
const PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://127.0.0.1:7897'

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const argOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null }

const DRY = has('--dry-run')
const VERIFY_ONLY = has('--verify-only')
const REVOKE_ID = argOf('--revoke')

const c = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
}
const say = (...a) => console.log(...a)
const step = (n, t) => say(`\n${c.bold('[' + n + ']')} ${t}`)
const die = (m) => { say(c.bad('❌ ' + m)); process.exit(1) }

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env: { ...process.env, HTTPS_PROXY: PROXY, HTTP_PROXY: PROXY },
    ...opts,
  })
}

/**
 * 经 HTTPS 代理取一个 URL。
 * 项目是零 npm 依赖的，所以这里手写 CONNECT 隧道，不引入 undici。
 * 返回 { status, body }；非 2xx 抛错（错误对象带 .status）。
 */
function fetchText(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const proxy = new URL(PROXY)
    const connectReq = http.request({
      host: proxy.hostname, port: proxy.port || 80, method: 'CONNECT',
      path: `${u.hostname}:443`, timeout: 20000,
    })
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) return reject(new Error('代理 CONNECT 失败 HTTP ' + res.statusCode))
      const req = https.request({
        socket, servername: u.hostname, path: u.pathname + u.search, method: 'GET',
        headers: { Host: u.hostname, 'User-Agent': 'dsh-publish-script', ...headers },
      }, (r) => {
        let b = ''
        r.setEncoding('binary')
        r.on('data', (d) => (b += d))
        r.on('end', () => {
          if (r.statusCode >= 200 && r.statusCode < 300) resolve({ status: r.statusCode, body: b })
          else reject(Object.assign(new Error('HTTP ' + r.statusCode), { status: r.statusCode, body: b }))
        })
      })
      req.on('error', reject)
      req.end()
    })
    connectReq.on('error', reject)
    connectReq.on('timeout', () => connectReq.destroy(new Error('代理连接超时')))
    connectReq.end()
  })
}

// ---------- 0. 读插件元信息 ----------
const pkgPath = path.join(PLUGIN_DIR, 'package.json')
if (!fs.existsSync(pkgPath)) die('找不到 ' + pkgPath)
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
const NAME = pkg.name
const VERSION = pkg.version

/**
 * 验证某个版本真的在 registry 上（坑 3）。
 * @param expectedSha 发布时打印的 shasum；给 null 表示只验版本号在不在
 */
async function verifyPublished(expectedSha) {
  let verOk = false, hashOk = false, lastErr = null
  for (let i = 1; i <= 12; i++) {
    try {
      const r = await fetchText(`https://registry.npmjs.org/${NAME}/${VERSION}`)
      const doc = JSON.parse(r.body)
      verOk = doc.version === VERSION
      if (verOk) {
        say(`  ① GET /${NAME}/${VERSION} → HTTP 200  ${c.ok('✅')}`)
        if (expectedSha) {
          const tar = await fetchText(doc.dist.tarball)
          const sha1 = crypto.createHash('sha1').update(Buffer.from(tar.body, 'binary')).digest('hex')
          hashOk = sha1 === expectedSha
          say(`  ② tarball SHA1 = ${sha1}`)
          say(`     发布时 shasum = ${expectedSha}`)
          say(hashOk ? '     ' + c.ok('✅ 一致 —— 上线的就是本地这一份') : '     ' + c.bad('⚠️ 不一致！'))
        } else {
          say(`  ② dist.tarball = ${doc.dist.tarball}`)
          say(`     dist.shasum  = ${doc.dist.shasum}`)
          hashOk = true
        }
        break
      }
      lastErr = '版本号对不上（读到 ' + doc.version + '）'
    } catch (e) { lastErr = e.message }
    say(c.dim(`  …第 ${i} 次还没读到（${lastErr}），10 秒后重试`))
    await new Promise((r) => setTimeout(r, 10000))
  }
  return { verOk, hashOk }
}

// ---------- 只验证模式 ----------
if (VERIFY_ONLY) {
  step('V', `只验证 ${c.bold(NAME)}@${c.bold(VERSION)} 在不在 registry 上`)
  const { verOk } = await verifyPublished(null)
  if (!verOk) die('读不到该版本：https://www.npmjs.com/package/' + NAME)
  say(c.ok('\n✅ 在'))
  process.exit(0)
}

step(0, `目标：${c.bold(NAME)}@${c.bold(VERSION)}`)
say(c.dim(`  registry : ${REGISTRY}`))
say(c.dim(`  打包目录 : ${PLUGIN_DIR}`))

// ---------- 1. 打包预览 ----------
step(1, '打包预览（npm pack --dry-run）')
const pack = run('npm', ['pack', '--dry-run'], { cwd: PLUGIN_DIR })
process.stdout.write(pack.stdout || '')
if (pack.status !== 0) die('打包预览失败')
if (DRY) { say('\n--dry-run：到此为止，没有发布。'); process.exit(0) }

// ---------- 2. 令牌 ----------
step(2, '取发布令牌')
let token = process.env.NPM_TOKEN || argOf('--token')
if (!token) {
  say(c.dim('  没从环境变量/参数拿到令牌。去这里建一张：'))
  say(c.dim('  https://www.npmjs.com/settings/<用户名>/tokens'))
  say(c.dim('  → Generate New Token → Granular Access Token'))
  say(c.dim('  → 勾 Bypass 2FA → Permissions: Read and write (publish and stage)'))
  say(c.dim('  → Select packages: All packages'))
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  token = await new Promise((res) => rl.question('\n  粘贴令牌（npm_…）：', (a) => { rl.close(); res(a.trim()) }))
}
if (!token || !token.startsWith('npm_')) die('令牌看起来不对（应以 npm_ 开头）')

// ---------- 3. 写 .npmrc（先备份） ----------
step(3, '临时写入 ~/.npmrc（先备份）')
let npmrcBackup = null
if (fs.existsSync(NPMRC)) {
  npmrcBackup = fs.readFileSync(NPMRC, 'utf8')
  const bak = NPMRC + '.bak-publish-' + Date.now()
  fs.writeFileSync(bak, npmrcBackup, 'utf8')
  say(c.dim('  备份 → ' + bak))
}
const lines = (npmrcBackup || '').split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('//registry.npmjs.org/:_authToken'))
lines.push('//registry.npmjs.org/:_authToken=' + token)
fs.writeFileSync(NPMRC, lines.join('\n') + '\n', 'utf8')

const restore = () => {
  try {
    if (npmrcBackup !== null) fs.writeFileSync(NPMRC, npmrcBackup, 'utf8')
    else if (fs.existsSync(NPMRC)) fs.unlinkSync(NPMRC)
    say(c.dim('\n  ~/.npmrc 已还原'))
  } catch (e) { say(c.warn('  ⚠️ ~/.npmrc 还原失败，手动检查：' + e.message)) }
}

try {
  // ---------- 4. 身份确认 ----------
  step(4, '确认身份')
  const who = run('npm', ['whoami', '--registry=' + REGISTRY])
  if (who.status !== 0) die('whoami 失败，令牌可能无效：\n' + (who.stderr || who.stdout))
  say('  登录为 ' + c.bold((who.stdout || '').trim()))

  // ---------- 5. 发布 ----------
  step(5, 'npm publish')
  const pub = run('npm', ['publish', '--registry=' + REGISTRY], { cwd: PLUGIN_DIR })
  process.stdout.write(pub.stdout || '')
  if (pub.status !== 0) { process.stderr.write(pub.stderr || ''); die('发布失败') }
  const shasum = ((pub.stdout || '').match(/shasum:\s*([0-9a-f]{40})/) || [])[1] || null
  if (shasum) say(c.dim('  发布时 shasum = ' + shasum))

  // ---------- 6. 验证真的上线了（坑 3） ----------
  step(6, `验证 ${NAME}@${VERSION} 真的在 registry 上`)
  const { verOk, hashOk } = await verifyPublished(shasum)
  if (!verOk) die('等了 2 分钟仍读不到该版本 —— 去看 https://www.npmjs.com/package/' + NAME)
  if (!hashOk) say(c.warn('⚠️ 哈希对不上：registry 上的内容和本地打包内容不一致，值得查'))
  say(c.ok(`\n✅ ${NAME}@${VERSION} 已发布并验证`))
  say('   https://www.npmjs.com/package/' + NAME + '/v/' + VERSION)

  // ---------- 7. 可选：吊销令牌 ----------
  if (REVOKE_ID) {
    step(7, '吊销令牌 id=' + REVOKE_ID)
    const rv = run('npm', ['token', 'revoke', REVOKE_ID, '--registry=' + REGISTRY])
    process.stdout.write(rv.stdout || '')
    say(rv.status === 0 ? '  ✅ 已吊销' : c.bad('  吊销失败（只认 id，不认 token 值）'))
  } else {
    say(c.dim('\n提示：bypass-2FA 令牌用完应吊销。先 `npm token list` 拿 id，然后：'))
    say(c.dim('     npm token revoke <id> --registry=https://registry.npmjs.org/'))
  }
} finally {
  restore()
}
