/**
 * dsh-access-phone-remote — dsh 插件（Host half）
 *
 * 作用：把 dsh-access-phone-remote 服务端接进 DeepSeek Harness。
 *
 * 设计：
 *   · 服务端本体保持独立（src/server.js，不属于 dsh 也能跑）
 *   · 本插件负责「生命周期管理 + 状态查询 + 配置」
 *   · 用户可以在 dsh 里启动/停止/查看状态
 *
 * 暴露的接口（走 dsh 的 webServer，本机回环）：
 *   GET  /api/dsh-access-phone-remote/status    服务状态
 *   POST /api/dsh-access-phone-remote/start     启动服务
 *   POST /api/dsh-access-phone-remote/stop      停止服务
 *   POST /api/dsh-access-phone-remote/restart   重启服务
 *   GET  /api/dsh-access-phone-remote/config    读配置
 *   POST /api/dsh-access-phone-remote/config    写配置
 *   GET  /api/dsh-access-phone-remote/url       拿到手机访问地址（含二维码数据）
 *   GET  /api/dsh-access-phone-remote/log       读服务端日志（尾部 N 行）
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, networkInterfaces, arch } from 'node:os'
import { request as httpRequest } from 'node:http'

// ---------- 插件标识 ----------
export const name = 'dsh-access-phone-remote'
export const inject = ['webServer']

// ---------- 常量 ----------
const PREFIX = '/api/dsh-access-phone-remote'
/** 自定义头防跨站 POST（同 dsh-session-delete 的做法）。 */
const PLUGIN_HEADER = 'x-dsh-plugin'

// ---------- 状态 ----------
/** 我们起的服务进程（如果有）。 */
let child = null
/** 最近一次启动时间。 */
let startedAt = 0
/** 内存里的日志环（最多 200 行）。 */
const logRing = []
const LOG_MAX = 200

function log(line) {
  const stamp = new Date().toISOString()
  const entry = `[${stamp}] ${line}`
  logRing.push(entry)
  if (logRing.length > LOG_MAX) logRing.shift()
}

// ---------- 配置 ----------
/**
 * 插件自己的配置目录。
 * 用 dsh 家目录，跟别的插件保持一致。
 */
function configDir() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-access-phone-remote')
}

function configFile() {
  return join(configDir(), 'plugin.json')
}

function readConfig() {
  try {
    return JSON.parse(readFileSync(configFile(), 'utf8'))
  } catch {
    return {
      /** dsh-access-phone-remote 项目目录 */
      projectDir: '',
      /** 自动启动 */
      autoStart: false,
      /** 服务端口（用于状态检查） */
      port: 3099,
    }
  }
}

function writeConfig(patch) {
  const cur = readConfig()
  const next = { ...cur, ...patch }
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(configFile(), JSON.stringify(next, null, 2), 'utf8')
  log(`配置已更新: ${JSON.stringify(patch)}`)
  return next
}

// ---------- 服务生命周期 ----------

/** 探测服务是否在跑（HTTP ping）。 */
async function probeRunning(port) {
  return new Promise((resolve) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path: '/api/ping', method: 'GET', timeout: 2000 },
      (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => {
          try {
            const j = JSON.parse(body)
            resolve(j && j.ok === true)
          } catch {
            resolve(false)
          }
        })
      },
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.end()
  })
}

/** 启动服务。 */
function startService() {
  const cfg = readConfig()
  if (!cfg.projectDir) {
    return { ok: false, error: '还没配置项目目录，请先在设置里填 dsh-access-phone-remote 的路径' }
  }
  const entry = join(cfg.projectDir, 'src', 'server.js')
  if (!existsSync(entry)) {
    return { ok: false, error: `找不到入口文件：${entry}` }
  }
  if (child) {
    return { ok: false, error: '服务已经在跑了（由本插件管理）' }
  }

  try {
    child = spawn(process.execPath, [entry], {
      cwd: cfg.projectDir,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    })
    startedAt = Date.now()
    log(`已启动服务：${entry}`)

    child.stdout.on('data', (d) => {
      String(d).split('\n').filter(Boolean).forEach((l) => log(`[out] ${l}`))
    })
    child.stderr.on('data', (d) => {
      String(d).split('\n').filter(Boolean).forEach((l) => log(`[err] ${l}`))
    })
    child.on('exit', (code) => {
      log(`服务退出，code=${code}`)
      child = null
      startedAt = 0
    })

    return { ok: true, pid: child.pid }
  } catch (e) {
    log(`启动失败：${e.message}`)
    return { ok: false, error: e.message }
  }
}

/** 停止服务。 */
function stopService() {
  if (!child) {
    return { ok: false, error: '本插件没有管理任何运行中的服务' }
  }
  try {
    child.kill()
    log('已发送停止信号')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// ---------- 工具 ----------

/** 取本机可被手机访问的地址（Tailscale IP 优先，其次局域网）。 */
function guessHost() {
    const ifaces = networkInterfaces()
  const candidates = []
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue
      // Tailscale 的 CGNAT 段 100.64.0.0/10
      const isTailscale = a.address.startsWith('100.')
      candidates.push({ iface: name, address: a.address, isTailscale })
    }
  }
  // Tailscale 优先
  const ts = candidates.find((c) => c.isTailscale)
  if (ts) return ts.address
  // 其次 192.168 / 10. / 172.
  const lan = candidates.find((c) => /^(192\.168\.|10\.|172\.)/.test(c.address))
  if (lan) return lan.address
  return candidates[0] ? candidates[0].address : '127.0.0.1'
}

/** 读 token。 */
function readToken(projectDir) {
  try {
    return readFileSync(join(projectDir, '.hub-token'), 'utf8').trim()
  } catch {
    return ''
  }
}

// ---------- 响应工具 ----------

function json(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** 校验跨站：非 GET 必须带自定义头。 */
function guard(req, res) {
  if (req.method === 'GET') return true
  if (req.headers[PLUGIN_HEADER] === 'dsh-access-phone-remote') return true
  json(res, 403, { ok: false, error: '缺少自定义头' })
  return false
}

async function readBody(req) {
  return new Promise((resolve) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => resolve(b))
  })
}

// ---------- 插件入口 ----------

export function apply(ctx, pluginConfig) {
  log('dsh-access-phone-remote 插件已加载')

  // 可选：按配置自动启动
  const cfg = readConfig()
  if (cfg.autoStart && cfg.projectDir) {
    setTimeout(() => {
      log('按配置自动启动服务')
      startService()
    }, 2000)
  }

  // ---- 状态 ----
  ctx.webServer.get(`${PREFIX}/status`, async (req, res) => {
    const c = readConfig()
    const running = await probeRunning(c.port)
    json(res, 200, {
      ok: true,
      running,
      managed: !!child,
      pid: child ? child.pid : null,
      uptimeMs: startedAt ? Date.now() - startedAt : 0,
      projectDir: c.projectDir,
      port: c.port,
    })
  })

  // ---- 启动 ----
  ctx.webServer.post(`${PREFIX}/start`, async (req, res) => {
    if (!guard(req, res)) return
    json(res, 200, startService())
  })

  // ---- 停止 ----
  ctx.webServer.post(`${PREFIX}/stop`, async (req, res) => {
    if (!guard(req, res)) return
    json(res, 200, stopService())
  })

  // ---- 重启 ----
  ctx.webServer.post(`${PREFIX}/restart`, async (req, res) => {
    if (!guard(req, res)) return
    stopService()
    await new Promise((r) => setTimeout(r, 800))
    json(res, 200, startService())
  })

  // ---- 读配置 ----
  ctx.webServer.get(`${PREFIX}/config`, async (req, res) => {
    json(res, 200, { ok: true, config: readConfig() })
  })

  // ---- 写配置 ----
  ctx.webServer.post(`${PREFIX}/config`, async (req, res) => {
    if (!guard(req, res)) return
    try {
      const body = JSON.parse((await readBody(req)) || '{}')
      json(res, 200, { ok: true, config: writeConfig(body) })
    } catch (e) {
      json(res, 400, { ok: false, error: e.message })
    }
  })

  // ---- 手机访问地址 ----
  ctx.webServer.get(`${PREFIX}/url`, async (req, res) => {
    const c = readConfig()
    const host = guessHost()
    const token = readToken(c.projectDir)
    const url = `http://${host}:${c.port}/` + (token ? `?t=${token}` : '')
    json(res, 200, {
      ok: true,
      url,
      host,
      port: c.port,
      hasToken: !!token,
      /** 前端可据此渲染二维码 */
      qrData: url,
    })
  })

  // ---- 日志 ----
  ctx.webServer.get(`${PREFIX}/log`, async (req, res) => {
    json(res, 200, { ok: true, lines: logRing })
  })

  // ---- 诊断信息（一键复制给 AI）----
  ctx.webServer.get(`${PREFIX}/diagnose`, async (req, res) => {
    const c = readConfig()
    const running = await probeRunning(c.port)
        json(res, 200, {
      ok: true,
      /** 这段文本用户可以直接复制给 AI */
      text: [
        '【dsh-access-phone-remote 诊断信息】',
        `运行状态: ${running ? '在跑' : '没跑'}`,
        `项目目录: ${c.projectDir || '(未配置)'}`,
        `端口: ${c.port}`,
        `Node: ${process.version}`,
        `平台: ${process.platform} ${arch()}`,
        `DSH_HOME: ${process.env.DSH_HOME || '(未设置)'}`,
        '',
        '【最近日志】',
        ...logRing.slice(-30),
      ].join('\n'),
    })
  })

  // ---- 清理 ----
  ctx.on('dispose', () => {
    log('插件卸载，停止服务')
    stopService()
  })
}
