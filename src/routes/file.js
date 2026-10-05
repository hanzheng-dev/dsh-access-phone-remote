// routes/file.js —— 文件传输 + 静态资源
//
//   · GET  /api/file        读文本文件内容（嵌进消息里展开看）
//   · GET  /api/file?raw=1  二进制下载（手机 App "接收电脑推的文件"用；任意后缀，≤50MB）
//   · POST /api/file/save   把编辑后的内容写回（写前自动备份）
//   · POST /api/upload      手机用系统文件选择器上传（手写 multipart，单文件 ≤20MB）
//
//   静态：
//     /uploads/*    上传 / 拉下来的文件（config.uploadsPath）
//     /docs/*       Office 转出来的 PDF 等（config.docsPath）
//     /shots/*      截图（config.shotsPath）
//     /pages/*.html 整页静态 HTML（<项目根>/public/pages）
//     /<图片或图标>  public 根下的图片 / 图标 / css
//     /             public/index.html（把 __DSH_VER__ / __DSJ_VER__ 换成页面版本号）
//
// 安全（open 版收敛）：读写都要求目标落在 `config.allowDirs` + uploads/shots/docs 之内
//   （共用 store.isAllowedDir），另有"可执行文件 / 敏感文件名"两条防手滑规则。
//   ⚠️ 生产版当时是"整盘放行"，open 版按蓝图改回白名单；用户要放宽就往 config.allowDirs 里加。

'use strict';

const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const {
  json, readBody, readBodyRaw, log, htmlVersion, isAllowedDir, addPendingImg,
  fileRef,   // ⭐ 阶段7：二进制下载复用「附件指针」同一份校验（目录/后缀/敏感名/大小）
} = require('../store');

const TEXT_EXT_RE = /\.(md|txt|json|log|csv|js|ts|html|css|ya?ml)$/i;
const READ_MAX = 2 * 1024 * 1024;          // 读：>2MB 不适合手机看
const SAVE_MAX = 2 * 1024 * 1024;          // 写：>2MB 不适合手机编辑
const SAVE_BAK_KEEP = 5;                   // 每个文件最多留最近 5 个 .bak-*
const UPLOAD_MAX = 20 * 1024 * 1024;       // 上传：单文件 ≤20MB

/** 把请求里的 path 变成绝对路径：绝对路径原样，相对路径相对运行期数据根。 */
function resolveInputPath(raw) {
  const s = String(raw || '');
  if (!s) return null;
  try {
    return path.isAbsolute(s) ? path.normalize(s) : path.resolve(config.absRoot, s);
  } catch (e) {
    return null;
  }
}

function contentType(f) {
  const ext = path.extname(f).toLowerCase();
  switch (ext) {
    case '.pdf': return 'application/pdf';
    case '.gif': return 'image/gif';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.png': return 'image/png';
    case '.svg': return 'image/svg+xml';
    case '.ico': return 'image/x-icon';
    case '.css': return 'text/css; charset=utf-8';
    case '.html': return 'text/html; charset=utf-8';
    case '.txt': case '.md': case '.log': return 'text/plain; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

// ============================================================
//  /api/* 文件接口
// ============================================================
async function handleApi(req, res, url, p) {
  // ---------- 读文件 ----------
  if (p === '/api/file') {
    const raw = url.searchParams.get('path') || '';
    if (!raw) return json(res, 400, { ok: false, error: '没给 path' }), true;
    const abs = resolveInputPath(raw);
    if (!abs) return json(res, 400, { ok: false, error: '路径不合法' }), true;

    // ⭐⭐ 2026-10-05（APK 阶段 7 op）：`raw=1` = **二进制下载**（手机 App 接收附件用）。
    //   原来的 /api/file 只服务"网页里嵌文本看"（白名单后缀 + ≤2MB + 返回 JSON），
    //   而 App 要收的图 / PDF / zip 全是二进制 ⇒ 加这条：
    //   · 校验共用 `fileRef`（允许目录 + 非可执行 + 非敏感名 + 0 < size ≤ 50MB），
    //     与 /api/push 收附件时**同一份判据**，不会对手机放出电脑上本就不能推的文件
    //   · 流式直出（Content-Length + Content-Disposition），不整读进内存
    //   ⚠️ 不改变无 raw 时的原有行为（网页阅读链路一字不动）
    if (url.searchParams.get('raw') === '1') {
      const meta = fileRef(abs);
      if (!meta) {
        return json(res, 403, { ok: false, error: '文件不可下载（不存在 / 不在允许目录 / 可执行或敏感名 / >50MB）' }), true;
      }
      res.writeHead(200, {
        'Content-Type': contentType(abs),
        'Content-Length': meta.size,
        'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(meta.name),
        'Cache-Control': 'no-store',
      });
      const rs = fs.createReadStream(abs);
      rs.on('error', function () { try { res.destroy(); } catch (e) { /* 已断 */ } });
      rs.pipe(res);
      return true;
    }

    if (!isAllowedDir(abs)) {
      return json(res, 403, { ok: false, error: '不在允许的目录（config.allowDirs / uploads / shots / docs）' }), true;
    }
    if (!TEXT_EXT_RE.test(abs)) return json(res, 403, { ok: false, error: '只支持文本文件' }), true;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) return json(res, 400, { ok: false, error: '不是文件' }), true;
      if (st.size > READ_MAX) return json(res, 413, { ok: false, error: '文件太大（>2MB）' }), true;
      const text = fs.readFileSync(abs, 'utf8');
      return json(res, 200, { ok: true, text, size: st.size, name: path.basename(abs) }), true;
    } catch (e) {
      return json(res, 404, { ok: false, error: '读不到: ' + e.message }), true;
    }
  }

  // ---------- 写回编辑后的内容（写前自动备份） ----------
  if (p === '/api/file/save' && req.method === 'POST') {
    const b = JSON.parse((await readBody(req)) || '{}');
    const abs = resolveInputPath(b.path);
    if (!abs) return json(res, 400, { ok: false, error: '没给 path 或路径不合法' }), true;
    if (!isAllowedDir(abs)) {
      return json(res, 403, { ok: false, error: '不在允许的目录（config.allowDirs / uploads / shots / docs）' }), true;
    }
    const text = String(b.text == null ? '' : b.text);
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) return json(res, 400, { ok: false, error: '不是文件' }), true;
      if (st.size > SAVE_MAX) return json(res, 413, { ok: false, error: '文件太大（>2MB），不适合手机编辑' }), true;
      // 备份：`<原名>.bak-YYYYMMDD-HHMMSS`（备份写不成功 ⇒ 整个保存失败，绝不裸覆盖）
      const ts = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const stamp = ts.getFullYear() + pad(ts.getMonth() + 1) + pad(ts.getDate()) + '-' +
        pad(ts.getHours()) + pad(ts.getMinutes()) + pad(ts.getSeconds());
      const bak = abs + '.bak-' + stamp;
      fs.copyFileSync(abs, bak);
      // 每个文件最多留最近 SAVE_BAK_KEEP 个备份（按名排序，超了删最旧的）
      const dir = path.dirname(abs);
      const base = path.basename(abs);
      let all = [];
      try { all = fs.readdirSync(dir); } catch (e) { all = []; }
      const mine = all
        .filter((n) => n.startsWith(base + '.bak-'))
        .map((n) => path.join(dir, n))
        .sort();
      while (mine.length > SAVE_BAK_KEEP) {
        const oldest = mine.shift();
        try { fs.unlinkSync(oldest); } catch (e) { /* 删不掉就留着 */ }
      }
      // 原样写 UTF-8，行尾不做任何转换（读来什么样就写回什么样）
      fs.writeFileSync(abs, text, 'utf8');
      const now = fs.statSync(abs).size;
      log(`✏️ 文件已保存: ${abs}（备份 ${path.basename(bak)}，size=${now}）`);
      return json(res, 200, { ok: true, path: abs, size: now, backup: path.basename(bak) }), true;
    } catch (e) {
      return json(res, 500, { ok: false, error: '保存失败: ' + e.message }), true;
    }
  }

  // ---------- 上传（手写 multipart，只认单文件） ----------
  if (p === '/api/upload' && req.method === 'POST') {
    const ctype = String(req.headers['content-type'] || '');
    const bm = ctype.match(/boundary=(.+)$/);
    if (!bm) return json(res, 400, { ok: false, error: '不是 multipart' }), true;
    const raw = await readBodyRaw(req, UPLOAD_MAX + 1024);
    if (raw.length > UPLOAD_MAX) return json(res, 413, { ok: false, error: '文件太大（>20MB）' }), true;
    const bnd = Buffer.from('--' + bm[1]);
    const parts = [];
    let idx = raw.indexOf(bnd);
    while (idx >= 0) {
      const next = raw.indexOf(bnd, idx + bnd.length);
      if (next < 0) break;
      parts.push(raw.subarray(idx + bnd.length, next));
      idx = next;
    }
    let saved = null;
    for (const part of parts) {
      const sep = part.indexOf('\r\n\r\n');
      if (sep < 0) continue;
      const head = part.subarray(0, sep).toString('utf8');
      const body = part.subarray(sep + 4);
      const fn = head.match(/filename="([^"]*)"/);
      if (!fn) continue;
      let name = path.basename(fn[1]).replace(/[\\/:*?"<>|]/g, '_');
      if (!name) name = 'upload-' + Date.now();
      fs.mkdirSync(config.uploadsPath, { recursive: true });
      let dst = path.join(config.uploadsPath, name);
      if (fs.existsSync(dst)) dst = path.join(config.uploadsPath, Date.now() + '-' + name);
      // 去掉尾部的 \r\n
      let data = body;
      while (data.length > 1 && data[data.length - 1] === 0x0a) data = data.subarray(0, data.length - 1);
      if (data.length > 1 && data[data.length - 1] === 0x0d) data = data.subarray(0, data.length - 1);
      fs.writeFileSync(dst, data);
      saved = { name: path.basename(dst), size: data.length, url: '/uploads/' + path.basename(dst) };
      break;
    }
    if (!saved) return json(res, 400, { ok: false, error: '没收到文件' }), true;
    log(`📎 收到上传: ${saved.name} (${saved.size} B)`);
    addPendingImg(saved.url, saved.name);   // 手机上传的图 ⇒ 也进搭便车队列
    return json(res, 200, Object.assign({ ok: true }, saved)), true;
  }

  return false;
}

// ============================================================
//  静态资源
// ============================================================
function serveFile(res, f, type) {
  const buf = fs.readFileSync(f);   // 读成 Buffer（二进制安全）
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
}

function handleStatic(req, res, url, p) {
  // 上传 / 拉下来的文件
  if (p.startsWith('/uploads/')) {
    const f = path.join(config.uploadsPath, path.basename(p));
    if (!fs.existsSync(f)) { res.writeHead(404); res.end('not found'); return true; }
    serveFile(res, f, contentType(f));
    return true;
  }

  // Office 转出来的 PDF / 文档静态文件
  if (p.startsWith('/docs/')) {
    const f = path.join(config.docsPath, path.basename(p));
    if (!fs.existsSync(f)) { res.writeHead(404); res.end('not found'); return true; }
    const ext = path.extname(f).toLowerCase();
    if (!['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.txt', '.md'].includes(ext)) {
      res.writeHead(403); res.end('forbidden'); return true;
    }
    serveFile(res, f, contentType(f));
    return true;
  }

  // 截图 / 图片
  if (p.startsWith('/shots/')) {
    const f = path.join(config.shotsPath, path.basename(p));
    if (!fs.existsSync(f)) { res.writeHead(404); res.end('not found'); return true; }
    serveFile(res, f, contentType(f));
    return true;
  }

  // 整页静态 HTML（public/pages/xxx.html）
  if (/^\/pages\/[\w.\-\u4e00-\u9fa5]+\.html$/i.test(p)) {
    const f = path.join(config.projectRoot, 'public', 'pages', path.basename(decodeURIComponent(p)));
    if (fs.existsSync(f)) { serveFile(res, f, 'text/html; charset=utf-8'); return true; }
  }

  // public 根下的图片 / 图标 / css / js
  {
    const m = /^\/[\w.\-]+\.(jpg|jpeg|png|gif|webp|svg|ico|css|js)$/i.exec(p);
    if (m) {
      const f = path.join(config.projectRoot, 'public', path.basename(p));
      if (fs.existsSync(f)) { serveFile(res, f, contentType(f)); return true; }
    }
  }

  // 首页
  if (p === '/' || p === '/index.html') {
    const f = path.join(config.projectRoot, 'public', 'index.html');
    if (fs.existsSync(f)) {
      let html = fs.readFileSync(f, 'utf8');
      // 把当前版本号烤进 HTML —— 页面拿它对比，不一致就自动重载
      html = html.replace(/__(?:DSH|DSJ)_VER__/g, htmlVersion());
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return true;
    }
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('缺少 public/index.html');
    return true;
  }

  return false;
}

function register(server, config) {
  // 先 API（避免静态路径抢 /api/*），再静态
  server.addRoute(handleApi);
  server.addRoute(handleStatic);
}

module.exports = { register };
