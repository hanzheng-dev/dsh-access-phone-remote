#!/usr/bin/env node
/**
 * doctor.js —— 环境自检
 *
 * 用法：
 *   node src/doctor.js
 *   或 npm run doctor
 *
 * 作用：
 *   跑一遍，把"能不能用 / 缺什么 / 下一步做什么"一次说清。
 *   不用开浏览器，不用读长文档。
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const net = require('net');

const ROOT = path.join(__dirname, '..');

let okCount = 0;
let warnCount = 0;
let errCount = 0;
const suggestions = [];

function line(sym, label, note, color) {
  const c = { ok: '\x1b[32m', warn: '\x1b[33m', err: '\x1b[31m', dim: '\x1b[90m', rst: '\x1b[0m' };
  const s = { ok: '✓', warn: '!', err: '✗', dim: '·' };
  const useColor = process.stdout.isTTY;
  const symStr = useColor ? c[color] + s[sym] + c.rst : s[sym];
  const labelStr = label.padEnd(24);
  const noteStr = note ? (useColor ? c.dim + note + c.rst : note) : '';
  console.log(`  ${symStr} ${labelStr}${noteStr}`);
}

function ok(label, note) { line('ok', label, note, 'ok'); okCount++; }
function warn(label, note) { line('warn', label, note, 'warn'); warnCount++; }
function err(label, note) { line('err', label, note, 'err'); errCount++; }
function info(label, note) { line('dim', label, note, 'dim'); }

/** 端口是否可用 */
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '0.0.0.0');
  });
}

/** 端口是否已被自己占用（返回 HTTP 响应就是我们的服务） */
function probeSelf(port) {
  return new Promise((resolve) => {
    const req = require('http').request(
      { hostname: '127.0.0.1', port, path: '/api/ping', method: 'GET', timeout: 1500 },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          try { resolve(JSON.parse(b).product === 'dsh-access-phone-remote'); } catch { resolve(false); }
        });
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

async function main() {
  console.log('\n\x1b[1mdsh-access-phone-remote 环境自检\x1b[0m');
  console.log('='.repeat(52) + '\n');

  // ---- 1. Node 版本 ----
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor >= 20) ok('Node.js', `v${process.versions.node}`);
  else if (nodeMajor >= 18) warn('Node.js', `v${process.versions.node}（建议 ≥20）`);
  else { err('Node.js', `v${process.versions.node} 太旧（需要 ≥18）`); suggestions.push('升级 Node.js 到 20 或以上：https://nodejs.org'); }

  // ---- 2. 平台 ----
  info('平台', `${process.platform} ${process.arch}`);
  if (process.platform !== 'win32') {
    warn('截图 / 显示桌面', '仅 Windows 可用（其他平台这两个指令会失败）');
  }

  // ---- 3. 配置 ----
  const cfgPath = path.join(ROOT, 'config.json');
  const exPath = path.join(ROOT, 'config.example.json');
  let config;
  try {
    if (fs.existsSync(cfgPath)) {
      config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      ok('配置文件', 'config.json');
    } else if (fs.existsSync(exPath)) {
      config = JSON.parse(fs.readFileSync(exPath, 'utf8'));
      warn('配置文件', '没有 config.json，用 config.example.json 的默认值');
      suggestions.push('想改端口/目录：复制 config.example.json 为 config.json 再改');
    } else {
      err('配置文件', '两个都不存在');
      config = { port: 3099, listenHost: '0.0.0.0' };
    }
  } catch (e) {
    err('配置文件', '解析失败：' + e.message);
    config = { port: 3099, listenHost: '0.0.0.0' };
  }

  // ---- 4. 端口 ----
  const port = config.port || 3099;
  const isSelf = await probeSelf(port);
  if (isSelf) {
    ok(`端口 ${port}`, '服务正在运行');
  } else {
    const free = await portFree(port);
    if (free) ok(`端口 ${port}`, '可用');
    else { err(`端口 ${port}`, '被别的程序占用了'); suggestions.push(`换端口：改 config.json 的 "port"，或找出占用程序`); }
  }

  // ---- 5. token ----
  const tokenFile = path.join(ROOT, '.hub-token');
  if (fs.existsSync(tokenFile)) {
    const t = fs.readFileSync(tokenFile, 'utf8').trim();
    ok('访问口令', `.hub-token 已生成（${t.length} 字符）`);
  } else {
    warn('访问口令', '还没生成（首次启动服务时会自动创建）');
  }

  // ---- 6. 网络地址 ----
  let addresses;
  try {
    addresses = require('./routes/addresses').listAddresses();
    const lan = addresses.filter((a) => a.kind === 'lan');
    const ts = addresses.filter((a) => a.kind === 'tailscale');
    if (lan.length) ok('局域网地址', lan.map((a) => a.ip).join(', '));
    else warn('局域网地址', '没找到（手机可能连不上）');
    if (ts.length) {
      ok('Tailscale 地址', ts.map((a) => a.ip).join(', '));
      suggestions.push('Tailscale 出门也能用，但手机也要装并登录同一账号');
    } else {
      info('Tailscale', '未安装（只在家里用的话不需要）');
    }
    const virt = addresses.filter((a) => a.kind === 'virtual');
    if (virt.length) info('虚拟网卡', virt.map((a) => a.ip).join(', ') + '（手机连不上，正常）');
  } catch (e) {
    err('网络地址', '枚举失败：' + e.message);
  }

  // ---- 7. 高德 key（位置功能）----
  const amap = config.amap || {};
  if (amap.webKey && amap.jsKey) {
    ok('高德 key', '已配置（位置功能可用）');
  } else if (amap.webKey || amap.jsKey) {
    warn('高德 key', '只配了一半，位置功能可能不完整');
    suggestions.push('位置功能需要两个 key：Web服务 + Web端JS API，见 AGENTS.md 第 4 步');
  } else {
    info('高德 key', '未配置（位置功能不可用，其他功能正常）');
    suggestions.push('想要「搜附近/看路线」：去 https://lbs.amap.com/ 申请 key，填进 config.json');
  }

  // ---- 8. 写权限 ----
  try {
    const probe = path.join(ROOT, '.doctor-probe');
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    ok('目录写权限', '正常');
  } catch (e) {
    err('目录写权限', '不能写：' + e.message);
    suggestions.push('把项目放到有写权限的目录（不要放在 C:\\Program Files）');
  }

  // ---- 9. public 完整性 ----
  const need = ['public/index.html', 'public/qr.js', 'public/pages/qr.html'];
  const missing = need.filter((f) => !fs.existsSync(path.join(ROOT, f)));
  if (!missing.length) ok('前端资源', '完整');
  else { err('前端资源', '缺少：' + missing.join(', ')); }

  // ---- 10. 依赖检查 ----
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const deps = Object.keys(pkg.dependencies || {});
  if (!deps.length) ok('npm 依赖', '零依赖（不需要 npm install）');
  else info('npm 依赖', deps.join(', '));

  // ---- 汇总 ----
  console.log('\n' + '='.repeat(52));
  console.log(`  ✓ ${okCount} 项正常   ! ${warnCount} 项注意   ✗ ${errCount} 项有问题`);

  if (suggestions.length) {
    console.log('\n\x1b[1m建议：\x1b[0m');
    suggestions.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  }

  console.log('\n\x1b[1m下一步：\x1b[0m');
  if (isSelf) {
    console.log('  服务已在运行。手机扫终端里的二维码，或打开启动时打印的地址。');
  } else if (errCount === 0) {
    console.log('  跑：node src/server.js');
    console.log('  （启动后终端会显示二维码，手机扫一下就连上）');
  } else {
    console.log('  先解决上面标 ✗ 的问题，再跑 node src/server.js');
  }
  console.log('\n  遇到问题：docs/TROUBLESHOOT.md（按症状走决策树）');
  console.log('  给 AI 用：AGENTS.md\n');

  process.exit(errCount ? 1 : 0);
}

main().catch((e) => {
  console.error('自检本身出错了：' + e.message);
  process.exit(1);
});
