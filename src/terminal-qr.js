/**
 * terminal-qr.js —— 在终端里打印二维码
 *
 * 为什么：
 *   用户启动服务后，要拿到「手机访问地址」需要开浏览器。
 *   直接在终端里打一个二维码，手机扫一下就完事 —— 少一步操作。
 *
 * 实现：
 *   复用 public/qr.js（那是给浏览器写的 IIFE，Node 里也能跑）。
 *   用 Unicode 半格字符渲染：每个字符表示 2 个垂直像素（▀ ▄ █ 空格）。
 */

const fs = require('fs');
const path = require('path');

let QRLite = null;

/** 载入 public/qr.js（它是 IIFE，挂在 global 上） */
function loadQR() {
  if (QRLite) return QRLite;
  const p = path.join(__dirname, '..', 'public', 'qr.js');
  const src = fs.readFileSync(p, 'utf8');
  const sandbox = {};
  // qr.js 是 (function(global){...})(typeof window !== 'undefined' ? window : globalThis)
  // 在 Node 里用 new Function 把 globalThis 换成 sandbox
  new Function('globalThis', src)(sandbox);
  if (!sandbox.QRLite) throw new Error('qr.js 没导出 QRLite');
  QRLite = sandbox.QRLite;
  return QRLite;
}

/**
 * 把二维码渲染成终端可打印的字符串。
 *
 * @param {string} text  要编码的内容
 * @param {object} [opts]
 * @param {boolean} [opts.compact]  true = 用半格字符（推荐）；false = 用两个字符宽的全块
 * @returns {string}  多行字符串（不含颜色码）
 */
function renderTerminalQR(text, opts) {
  opts = opts || {};
  const Q = loadQR();
  const { matrix } = Q.encode(text);
  const n = matrix.length;
  const quiet = 2;                     // 静区
  const size = n + quiet * 2;
  const lines = [];

  // 上下留白
  for (let i = 0; i < quiet; i++) lines.push('');

  if (opts.compact === false) {
    // 全块模式：每个模块一个「██」或「  」（宽高比不完美，但兼容性最好）
    for (let r = 0; r < size; r++) {
      let line = '';
      for (let c = 0; c < size; c++) {
        const inQR = r >= quiet && r < quiet + n && c >= quiet && c < quiet + n;
        const on = inQR && matrix[r - quiet][c - quiet];
        line += on ? '██' : '  ';
      }
      lines.push(line);
    }
  } else {
    // 半格模式：一个字符表示上下两个模块
    //   ▀ = 上半黑   ▄ = 下半黑   █ = 全黑   空格 = 全白
    for (let r = 0; r < size; r += 2) {
      let line = '';
      for (let c = 0; c < size; c++) {
        const topIn = r >= quiet && r < quiet + n && c >= quiet && c < quiet + n;
        const botIn = (r + 1) >= quiet && (r + 1) < quiet + n && c >= quiet && c < quiet + n;
        const top = topIn && matrix[r - quiet][c - quiet];
        const bot = botIn && matrix[r + 1 - quiet][c - quiet];
        if (top && bot) line += '█';
        else if (top) line += '▀';
        else if (bot) line += '▄';
        else line += ' ';
      }
      lines.push(line);
    }
  }

  for (let i = 0; i < quiet; i++) lines.push('');
  return lines.join('\n');
}

/**
 * 直接打印到 stdout（带缩进，看起来舒服）
 */
function printTerminalQR(text, opts) {
  const indent = '  ';
  const art = renderTerminalQR(text, opts);
  const body = art.split('\n').map((l) => (l ? indent + l : '')).join('\n');
  process.stdout.write(body + '\n');
}

module.exports = { renderTerminalQR, printTerminalQR };
