// preview-smoke.js —— 运行期自检：把刚构建出来的产物喂给 SDK 自带的 Previewer，看它到底认不认。
//
// 为什么需要它（2026-10-07 的教训）：
//   `hap-sign-tool verify-app` 通过**只证明「文件格式合法 + 签名有效」**，
//   **完全不证明运行时会接受这份字节码**。实测就是：verify-app 一路 success，
//   而 Previewer 一跑就报
//     Cannot find module 'entry&entry/src/main/ets/pages/Setup&1.0.0',
//     which is application Entry Point
//   —— 因为手工构建链把 modules.abc 的记录名拼错了。
//   所以「能构建」和「能跑」之间必须有一道**真的把它跑起来**的关卡，就是这个脚本。
//
// 用法:
//   node tools/preview-smoke.js <stage目录> [页面=pages/Setup] [秒数=25]
//   环境变量: OHOS_SDK   鸿蒙 SDK 根目录（默认 D:/ohos/sdk）
// 退出码:
//   0 = 渲染成功（拿到非空帧，且日志里没有已知失败标志）
//   1 = 失败（会打印命中的失败标志）
//   2 = 用法/环境错误
//
// 无第三方依赖：只用了 node 内置模块 + 全局 WebSocket（需 Node 22+）。
'use strict';
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const STAGE = process.argv[2];
const PAGE  = process.argv[3] || 'pages/Setup';
const DUR   = parseInt(process.argv[4] || '25', 10);
const SDK   = process.env.OHOS_SDK || 'D:/ohos/sdk';

if (!STAGE) { console.error('用法: node tools/preview-smoke.js <stage目录> [页面] [秒数]'); process.exit(2); }

const BIN = path.join(SDK, 'previewer', 'previewer', 'common', 'bin', 'Previewer.exe');
if (!fs.existsSync(BIN)) { console.error('✗ 找不到 Previewer: ' + BIN); process.exit(2); }
if (!fs.existsSync(path.join(STAGE, 'ets', 'modules.abc'))) {
  console.error('✗ stage 里没有 ets/modules.abc: ' + STAGE); process.exit(2);
}

// ---------- 准备 Previewer 认的目录布局 ----------
// ⚠️ Previewer 不是加载 HAP，而是加载「已解包的 app 目录 + 资源目录」：
//   -j <app目录>：Stage 非卡片模型**不会**去 app/ets 找，modules.abc 必须在**根**
//   -arp <资源目录>：要 module.json / resources.index / resources/
//   -ljPath <loader.json>：多包解析链，同目录还要有 pkgContextInfo.json
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ohos-smoke-'));
const APP = path.join(T, 'app');
const RES = path.join(T, 'res');
const LJ  = path.join(T, 'lj');
for (const d of [APP, RES, LJ]) fs.mkdirSync(d, { recursive: true });

fs.copyFileSync(path.join(STAGE, 'ets', 'modules.abc'), path.join(APP, 'modules.abc'));
for (const f of ['module.json', 'resources.index']) {
  const s = path.join(STAGE, f);
  if (fs.existsSync(s)) fs.copyFileSync(s, path.join(RES, f));
}
fs.cpSync(path.join(STAGE, 'resources'), path.join(RES, 'resources'), { recursive: true });

// loader.json 的四个键缺一不可（缺了报 "Don't find some necessary node in loader.json"）
fs.writeFileSync(path.join(LJ, 'loader.json'), JSON.stringify({
  modulePathMap: { entry: APP },
  projectRootPath: T,
  hspResourcesMap: {},
  hspNameOhmMap: {},
  harNameOhmMap: {},
}, null, 2));
// pkgContextInfo.json 优先用 stage 里打包进去的那份，保证「测的就是打进 HAP 的那份」
const pkgSrc = path.join(STAGE, 'pkgContextInfo.json');
if (fs.existsSync(pkgSrc)) fs.copyFileSync(pkgSrc, path.join(LJ, 'pkgContextInfo.json'));

// ---------- 起命名管道 + spawn Previewer ----------
const PIPE = 'ohos_smoke_' + process.pid;
const PORT = 10600 + (process.pid % 300);
const SID  = crypto.randomBytes(8).toString('hex');   // 16 位 hex；WS 路径必须等于它
const OUT  = path.join(T, 'previewer.out');
const ERR  = path.join(T, 'previewer.err');

const pipeSrv = net.createServer((c) => { c.on('error', () => {}); });
pipeSrv.on('error', () => {});
pipeSrv.listen('\\\\.\\pipe\\' + PIPE, () => {});

const args = [
  '-device', 'phone', '-shape', 'rect',
  '-or', '1080', '2340', '-cr', '1080', '2340',
  '-j', APP, '-n', 'io.github.hanzhengdev.phoneaccess', '-url', PAGE,
  '-s', PIPE, '-lws', String(PORT), '-sid', SID,
  '-pm', 'Stage', '-projectID', 'ohos-smoke',
  '-arp', RES, '-ljPath', path.join(LJ, 'loader.json'),
  '-pages', 'main_pages',            // 只能填 profile 名；Windows 绝对路径会被正则拒（退出码 11）
  '-l', 'zh_CN', '-o', 'portrait', '-cm', 'light', '-av', 'ACE_2_0', '-sd', '480',
];
const outFd = fs.openSync(OUT, 'w');
const errFd = fs.openSync(ERR, 'w');
const child = spawn(BIN, args, { cwd: path.dirname(BIN), stdio: ['ignore', outFd, errFd] });
let exited = null;
child.on('exit', (code) => { exited = code; });

// ---------- 抓 WS 帧 ----------
let frames = 0, firstSize = 0;
setTimeout(() => {
  let ws;
  try { ws = new WebSocket(`ws://127.0.0.1:${PORT}/${SID}`); } catch (e) { return; }
  ws.binaryType = 'arraybuffer';
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') return;
    const buf = Buffer.from(ev.data);
    frames++;
    if (frames === 1) {
      firstSize = buf.length;
      // 帧 = 40 字节头 + 完整 JPEG；存下来供人眼看
      const i = buf.indexOf(Buffer.from([0xFF, 0xD8, 0xFF]));
      const j = buf.lastIndexOf(Buffer.from([0xFF, 0xD9]));
      if (i >= 0 && j > i) fs.writeFileSync(path.join(STAGE, 'smoke-frame.jpg'), buf.subarray(i, j + 2));
    }
  };
  ws.onerror = () => {};
}, 900);

// ---------- 判定 ----------
setTimeout(() => {
  try { child.kill(); } catch (e) {}
  try { pipeSrv.close(); } catch (e) {}

  const log = readAll(OUT) + '\n' + readAll(ERR);
  // 已知的**硬失败**标志（都是实测撞到过的原话）。
  // ⚠️ 这里**故意不包含** `find asset failed` —— 它在每次正常启动里都会出现 7 条，
  //    全部良性（manifest.json / component_collection.txt / jsMockHmos.abc /
  //    commons.abc / vendors.abc / app.abc：都是"可选资源没找到"的常态警告）。
  //    真正要命的那条长这样：`find asset failed, assetName = pages/Setup.abc`
  //    —— 但靠"名字里带 .abc"分不出来（commons.abc 也带），
  //    所以干脆不用它，改用它**下游**那句一定会出现的 `Cannot find module`。
  const BAD = [
    ['Cannot find module', '模块记录名对不上（不是归一化 ohmurl）'],
    ['Cannot execute module buffer file', '模块字节码没被执行（记录名 / 模块类型不对）'],
    ['is not esmodule', 'es2abc 清单里的模块类型不是 esm'],
    ["Don't find some necessary node in loader.json", 'loader.json 缺键'],
    ['Launch -j parameters abnormal', 'Previewer 参数不全'],
    ['Error message:', 'Ace 层报了错'],
  ];
  const hits = BAD.filter(([pat]) => log.includes(pat));
  const executed = log.includes('ExecuteModuleBuffer');

  // 空白帧的兜底判据（启发式，按本项目实测标定）：
  //   同一页面同一尺寸下，**空白**首帧恒为 40651 B，**渲染出来**是 111286 B。
  //   差了近 3 倍 —— 因为纯白图 JPEG 压得极小。留一道兜底，防止"没报错但其实是白屏"。
  const BLANK_MAX = 60000;
  const blankish = frames > 0 && firstSize > 0 && firstSize < BLANK_MAX;

  console.log('  页面        : ' + PAGE);
  console.log('  抓到帧      : ' + frames + (firstSize ? '（首帧 ' + firstSize + ' B' + (blankish ? ' —— 疑似空白' : '') + '）' : ''));
  console.log('  进入执行    : ' + (executed ? '是（日志有 ExecuteModuleBuffer）' : '否'));
  console.log('  进程退出码  : ' + (exited === null ? '仍在跑' : exited));
  if (fs.existsSync(path.join(STAGE, 'smoke-frame.jpg'))) {
    console.log('  截图        : ' + path.join(STAGE, 'smoke-frame.jpg') + '  ← 部署后自己看一眼，别只信退出码');
  }
  if (hits.length || blankish) {
    console.error('');
    console.error('  ✗ 判定：失败' + (hits.length ? '，命中 ' + hits.length + ' 个已知失败标志' : '，首帧疑似空白'));
    for (const [pat, why] of hits) console.error('     · "' + pat + '"  ⇒ ' + why);
    if (blankish) console.error('     · 首帧仅 ' + firstSize + ' B（< ' + BLANK_MAX + '），大概什么都没画出来');
  }

  const ok = hits.length === 0 && frames > 0 && !blankish;
  console.log('');
  console.log(ok ? '  ✓ 判定：通过（运行时接受了这份 modules.abc）'
                 : '  ✗ 判定：失败');
  if (!ok) {
    console.error('');
    console.error('  —— Previewer 日志末尾 25 行 ——');
    console.error(log.split('\n').slice(-25).map((l) => '    ' + l).join('\n'));
  }

  // 清理本次的临时布局。
  // 失败时**保留**：那时日志和 frame 是唯一的证据，删了就查不下去了。
  // 顺手把上次失败残留的目录也收掉（只动本脚本自己建的 ohos-smoke-*）。
  if (ok) {
    try { fs.rmSync(T, { recursive: true, force: true }); } catch (e) {}
    sweepOldRuns();
  } else {
    console.error('');
    console.error('  （临时目录保留着，供排查：' + T + '）');
  }

  setTimeout(() => process.exit(ok ? 0 : 1), 200);
}, DUR * 1000);

function readAll(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; } }

// 清掉 1 小时前的 ohos-smoke-* 残留（失败的运行会留下它们）
function sweepOldRuns() {
  const base = os.tmpdir();
  const cutoff = Date.now() - 3600 * 1000;
  let n = 0;
  try {
    for (const e of fs.readdirSync(base, { withFileTypes: true })) {
      if (!e.isDirectory() || !e.name.startsWith('ohos-smoke-')) continue;
      const p = path.join(base, e.name);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) { fs.rmSync(p, { recursive: true, force: true }); n++; }
      } catch (err) {}
    }
  } catch (err) {}
  if (n) console.log('  （顺手清掉 ' + n + ' 个 1 小时前的自检残留）');
}
