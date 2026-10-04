// routes/push.js —— 消息推送
//
//   · GET  /api/events   SSE 长连接（页面订阅它，代替轮询；顺带捎页面版本号）
//   · GET  /api/inbox    增量拉消息（since= 时间戳）
//   · POST /api/push     电脑 → 手机推一条消息
//
// 状态（messages / sseClients / streams / pending）全部来自 store.js，本文件只做 HTTP。
//
// /api/push 支持的载荷：
//   text / image                        纯文本 / 图片（/shots/、/uploads/ 下的静态图）
//   buttons     [{label,value,warn,silent}]   交互按钮（点一下 = 把 value 当消息发回）
//   options     {multi,items,hint,commitLabel} 选项卡（选完当消息发回）
//   web         {url,title}             网页浮层卡片（只收 http/https）
//   file        {path,pdf}              附件指针（内容按需从 /api/file 拉；只存指针不存内容）
//   detail / detailImage                折叠块的完整正文 / 配图
//   hitchhike   {type,text|image,name}   剪贴板「搭便车」入队
//   level       'alert'|'normal'|'silent' 提示级别（透传给手机端）
//   seq / round 落地序号 / 轮次（供消息池按 (round,seq) 排序）
//
// ⚠️ 相对生产版删除的：`agent` / QQ 回话分支（依赖私人桥接服务）、
//    以及 `ask`（问用户选择框）—— 它的答案回收接口已随本次裁剪删除，
//    留着会渲染出点了没反应的死按钮。

'use strict';

const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const {
  messages, sseClients, streams,
  addMessage, addPending, sseSend,
  json, readBody, log, htmlVersion, fileRef,
} = require('../store');

const SSE_PING_MS = 15000;

async function handle(req, res, url, p) {
  // ---------- SSE 长连接 ----------
  if (p === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('retry: 1000\n\n');
    sseClients.add(res);
    // 连上就送一条 hello（带页面版本号）⇒ 页面据此判断要不要重载；心跳帧也捎版本号。
    try { res.write(`data: ${JSON.stringify({ type: 'hello', version: htmlVersion() })}\n\n`); } catch (e) { /* 断了下面 close 会清 */ }
    log(`⚡ SSE 接入（当前 ${sseClients.size} 个）`);
    const ka = setInterval(() => {
      try { res.write(`data: ${JSON.stringify({ type: 'ping', version: htmlVersion() })}\n\n`); } catch (e) { /* 断了下面 close 会清 */ }
    }, SSE_PING_MS);
    if (ka.unref) ka.unref();
    req.on('close', () => {
      clearInterval(ka);
      sseClients.delete(res);
      log(`⚡ SSE 断开（剩 ${sseClients.size} 个）`);
    });
    return true;
  }

  // ---------- 增量拉消息 ----------
  if (p === '/api/inbox') {
    const since = Number(url.searchParams.get('since') || 0);
    // since 过滤按 ts（客户端用它做增量拉取），但**顺序**已经是 (round,seq)。
    // streaming 标记要"诚实"：只有最近 45 秒内还有 delta 的才算真在流。
    const list = messages
      .filter((m) => m.ts > since)
      .map((m) => (m.streamId && streams.has(m.streamId) && (Date.now() - m.ts < 45000) ? { ...m, streaming: true } : m));
    return json(res, 200, { ok: true, messages: list, now: Date.now() }), true;
  }

  // ---------- 电脑推消息给手机 ----------
  if (p === '/api/push' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const text = String(body.text || '').trim();
    const image = body.image ? String(body.image) : null;

    // 剪贴板「搭便车」入队（下一条对话消息会把它拼进正文前缀）
    if (body.hitchhike) addPending(body.hitchhike);

    const pushSeq = (typeof body.seq === 'number') ? body.seq : undefined;
    const pushRound = (typeof body.round === 'number') ? body.round : undefined;
    const detail = body.detail ? String(body.detail).slice(0, 4000) : null;
    // detailImage：折叠块里的配图，只收 /shots/ 下的静态图
    const detailImage = (body.detailImage && /^\/shots\/[\w.\-]+$/i.test(String(body.detailImage)))
      ? String(body.detailImage) : null;

    // 交互按钮（最多 6 个）
    let buttons = null;
    if (Array.isArray(body.buttons)) {
      buttons = body.buttons
        .filter((b) => b && String(b.label || '').trim())
        .slice(0, 6)
        .map((b) => ({
          label: String(b.label).trim().slice(0, 24),
          value: String(b.value != null ? b.value : b.label).slice(0, 300),
          warn: !!b.warn,
          ...(b.silent ? { silent: true } : {}),
        }));
      if (!buttons.length) buttons = null;
    }

    // 选项卡（最多 8 个）
    let options = null;
    if (body.options && Array.isArray(body.options.items) && body.options.items.length) {
      const items = body.options.items
        .filter((x) => x && String(x.label || '').trim())
        .slice(0, 8)
        .map((x) => ({
          label: String(x.label).trim().slice(0, 60),
          value: String(x.value != null ? x.value : x.label).slice(0, 300),
        }));
      if (items.length) {
        options = { multi: !!body.options.multi, items };
        if (body.options.hint) options.hint = String(body.options.hint).slice(0, 120);
        if (body.options.commitLabel) options.commitLabel = String(body.options.commitLabel).slice(0, 24);
      }
    }

    // 网页浮层：只收 http/https（javascript:/file:/data: 一律拒——注入向量）
    let webRef = null;
    if (body.web && body.web.url) {
      const wu = String(body.web.url).trim();
      if (/^https?:\/\//i.test(wu)) {
        webRef = {
          url: wu.slice(0, 2000),
          title: String(body.web.title || '').trim().slice(0, 60),
        };
      } else {
        log(`⚠ 网页浮层被拒（非 http/https）: ${wu.slice(0, 80)}`);
      }
    }

    // ⚠️ 空消息检查必须看 `body.file`（附件指针在下面才算出来）
    if (!text && !image && !buttons && !options && !(body.file && body.file.path) && !webRef) {
      return json(res, 400, { ok: false, error: '空消息' }), true;
    }

    // 附件指针（只存路径+名字+大小，内容按需从 /api/file 拉）
    let fileMeta = null;
    if (body.file && body.file.path) {
      const fp = String(body.file.path);
      const ref = fileRef(fp);   // 共用 store 的目录白名单 + 后缀/敏感名/大小校验
      if (ref) {
        fileMeta = ref;
        // Office 文档的 PDF 版（事先转好的）—— 页面靠它嵌阅读器
        if (body.file.pdf && /^\/docs\/[\w.\-]+\.pdf$/i.test(String(body.file.pdf))) {
          const pf = path.join(config.docsPath, path.basename(String(body.file.pdf)));
          if (fs.existsSync(pf)) fileMeta.pdf = String(body.file.pdf);
          else log(`⚠ 附件说有 pdf 但文件不在: ${pf}`);
        }
      } else {
        log(`⚠ 附件被拒（目录/后缀/敏感名/大小）: ${fp}`);
      }
    }

    // 兜底:同一段文字在极短时间内被推两遍 = 重复推送，丢弃
    const prev = messages.length ? messages[messages.length - 1] : null;
    if (
      prev && prev.from === 'pc' && !image && !buttons && !fileMeta &&
      prev.text === text && text && Date.now() - prev.ts < 1200
    ) {
      log(`↺ 丢弃重复推送（${Date.now() - prev.ts}ms 内同文）: ${text.slice(0, 40)}`);
      return json(res, 200, { ok: true, deduped: true }), true;
    }

    const extra = {};
    if (image) extra.image = image;
    if (body.level) {
      const lv = String(body.level).toLowerCase();
      if (lv === 'alert' || lv === 'normal' || lv === 'silent') extra.level = lv;
    }
    if (buttons) extra.buttons = buttons;
    if (detail) extra.detail = detail;
    if (detailImage) extra.detailImage = detailImage;
    if (pushSeq !== undefined) extra.seq = pushSeq;
    if (pushRound !== undefined) extra.round = pushRound;
    if (fileMeta) extra.file = fileMeta;
    if (webRef) extra.web = webRef;
    if (options) extra.options = options;

    const m = addMessage('pc', text, body.kind || 'text', extra);
    sseSend({ type: 'new', msg: m });
    log(`← 推送: ${text.slice(0, 60)}${image ? ' [图]' + image : ''}${buttons ? ' [按钮×' + buttons.length + ']' : ''}${detail ? ' [+完整参数 ' + detail.length + ' 字]' : ''}${webRef ? ' [网页浮层 ' + webRef.title + ']' : ''}`);
    return json(res, 200, { ok: true, message: m }), true;
  }

  return false;
}

function register(server, config) {
  server.addRoute(handle);
}

module.exports = { register };
