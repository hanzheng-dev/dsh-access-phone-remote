// commands.js —— 指令白名单表（保留 5 条）
//
// 设计：APK / 页面 → POST /api/run { id, payload } → 这里执行 → 返回文本。
// 从生产 `commands.js`（43 条）裁剪而来，只留通用、与私人服务无关的 5 条：
//   open_web      打开网页（前端特判，服务端 no-op）
//   screenshot    截图（PowerShell 抓屏，写入 config.shotsPath）
//   show_desktop  显示桌面（Win32 Shell.Application.MinimizeAll）
//   stop          停止（占位：接入自己的长任务系统时替换，见下方注释）
//   status        状态查询（通用信息）
//
// ⚠️ screenshot / show_desktop 依赖 PowerShell + Win32 ⇒ 本项目 Windows-only。

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { config } = require('./config');

// ---------- 工具 ----------
/** 跑一段 PowerShell，强制 UTF-8 输出（否则中文按 GBK 出来乱码）。 */
function ps(script, timeout = 20000) {
  return new Promise((resolve) => {
    const wrapped = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' + script;
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', wrapped],
      { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 },
      (e, stdout, stderr) => resolve({ ok: !e, out: (stdout || '').trim(), err: e ? (stderr || e.message) : '' }));
  });
}

// ============================================================
//  功能表
// ============================================================
const COMMANDS = [
  {
    id: 'open_web', label: '浏览器', group: 'control', confirm: false,
    desc: '手机端在浮层里打开网页（前端特判，不经过电脑）',
    // 打开网页是手机端的事 ⇒ 前端对 id==='open_web' 特判；这里留 no-op 占位。
    async run() { return { ok: false, text: '这个按钮由手机前端直接处理' }; },
  },
  {
    id: 'screenshot', label: '桌面截图', group: 'control', confirm: false,
    desc: '截屏并返回图片',
    async run() {
      const hh = new Date().getHours();
      if (hh >= 0 && hh < 7) return { ok: false, text: '凌晨 0-7 点不截图哦（隐私保护）' };
      const out = path.join(config.shotsPath, `shot-${Date.now()}.png`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const r = await ps(`Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b = New-Object System.Drawing.Bitmap([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width, [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height); $g = [System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen(0,0,0,0,$b.Size); $b.Save('${out.replace(/\\/g, '\\\\')}'); $g.Dispose(); $b.Dispose(); 'ok'`, 30000);
      if (!r.ok || !fs.existsSync(out)) return { ok: false, text: '截图失败: ' + (r.err || '文件未生成') };
      return { ok: true, text: '已截图', image: '/shots/' + path.basename(out) };
    },
  },
  {
    id: 'show_desktop', label: '显示桌面', group: 'control', confirm: false,
    desc: '最小化所有窗口（Win+D 效果）',
    async run() {
      const r = await ps(`(New-Object -ComObject Shell.Application).MinimizeAll(); 'ok'`, 12000);
      return (r.ok && r.out.indexOf('ok') >= 0)
        ? { ok: true, text: '已最小化所有窗口' }
        : { ok: false, text: '最小化失败: ' + (r.err || '未知') };
    },
  },
  {
    id: 'stop', label: '停', group: 'control', confirm: false,
    desc: '中断当前任务（开源版占位实现）',
    // ⭐ 占位实现（拍板 (b)）：保留 id，前端不报 400。
    //   接入你自己的长任务 / 中断系统（消息队列、子进程句柄、AI 回合取消…）时，
    //   把这里改成真正的取消逻辑即可。
    async run() { return { ok: true, text: '当前没有进行中的任务' }; },
  },
  {
    id: 'status', label: '状态', group: 'query',
    desc: '服务运行状态（通用信息）',
    async run() {
      const up = Math.round(process.uptime());
      const total = Math.round(os.totalmem() / 1048576);
      const free = Math.round(os.freemem() / 1048576);
      const used = total - free;
      let version = '?';
      try { version = require(path.join(config.projectRoot, 'package.json')).version || '?'; } catch (e) { /* 没有 package.json 就算了 */ }
      return {
        ok: true, text:
          `服务状态\n` +
          `运行: ${Math.floor(up / 3600)}h ${Math.floor(up % 3600 / 60)}m\n` +
          `内存: ${used}/${total} MB（${Math.round(used / total * 100)}%）\n` +
          `平台: ${process.platform} ${process.arch}\n` +
          `Node: ${process.version}\n` +
          `监听: ${config.listenHost}:${config.port}\n` +
          `版本: ${version}\n` +
          `时间: ${new Date().toLocaleString('zh-CN')}`,
      };
    },
  },
];

// ============================================================
//  ⭐ 自定义动作（配置化扩展）
// ============================================================
//
//  为什么有这个：
//    加一个按钮，不该需要改 JavaScript、理解代码结构、再重启服务。
//    普通用户（或他的 AI）改一行 JSON 就该能加。
//
//  用法（config.json）：
//    {
//      "customActions": {
//        "enabled": true,
//        "list": [
//          {
//            "id": "lock_screen",
//            "label": "锁屏",
//            "group": "控制",
//            "command": "rundll32.exe user32.dll,LockWorkStation",
//            "confirm": false,
//            "desc": "锁定电脑屏幕"
//          }
//        ]
//      }
//    }
//
//  ⚠️ 安全：开启后配置里的命令会被**真的执行**。
//     这是给你自己电脑用的功能 —— 别把配置文件发给别人，
//     也别在公网暴露的服务上开。
function loadCustomActions() {
  const cfg = config.customActions || {};
  if (!cfg.enabled) return [];
  const list = Array.isArray(cfg.list) ? cfg.list : [];
  const out = [];
  for (const [i, a] of list.entries()) {
    if (!a || !a.id || !a.command) continue;
    const id = String(a.id).replace(/[^\w\-]/g, '_');
    if (COMMANDS.some((c) => c.id === id)) continue;   // 不覆盖内置
    out.push({
      id,
      label: String(a.label || a.id),
      group: String(a.group || 'custom'),
      confirm: !!a.confirm,
      desc: String(a.desc || `自定义动作（执行：${a.command}）`),
      custom: true,
      async run() {
        const timeout = Math.min(Number(a.timeout) || 20000, 120000);
        return new Promise((resolve) => {
          execFile(
            'cmd',
            ['/d', '/s', '/c', String(a.command)],
            { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
            (e, stdout, stderr) => {
              const outText = (stdout || '').trim();
              const errText = (stderr || '').trim();
              if (e) {
                resolve({ ok: false, text: `执行失败：${errText || e.message}` });
              } else {
                resolve({ ok: true, text: outText || '（执行完成，无输出）' });
              }
            },
          );
        });
      },
    });
  }
  return out;
}

const CUSTOM = loadCustomActions();
if (CUSTOM.length) {
  COMMANDS.push(...CUSTOM);
}

module.exports = { COMMANDS, loadCustomActions };
