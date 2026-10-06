/**
 * discover.js —— 局域网自动发现（UDP 广播）
 *
 * 解决什么问题：
 *   手机第一次连电脑，要手输「http://192.168.1.100:3099/?t=xxx」—— 又长又烦。
 *   有了这个，App 在同一个 WiFi 下能**自动找到电脑**，零配置。
 *
 * 原理：
 *   服务端每隔几秒往局域网广播一个 UDP 包（含服务名 / 端口 / 地址 / token）。
 *   手机端监听这个端口，收到就知道电脑在哪。
 *
 * 为什么不用 mDNS：
 *   mDNS 标准但实现复杂（要手写 DNS 报文）。UDP 广播**零依赖、够用**，
 *   而且在同一网段内比 mDNS 更可靠（不受某些路由器多播限制影响）。
 *
 * 兼容性：
 *   · 同一网段内有效（家里 / 公司 WiFi 通常没问题）
 *   · 有些网络禁广播、或客户端隔离（AP isolation）⇒ 失效
 *   · **所以这是"增强"，不是唯一方式** —— 广播失败仍可手动填地址
 *
 * ⚠️ 安全：广播内容含访问 token，**只在局域网内**。
 *    如果你不放心，把 config.discovery.enabled 设为 false。
 */

const dgram = require('dgram');
const os = require('os');

/** 广播用的端口（手机端监听这个） */
const DISCOVERY_PORT = 30991;

/** 服务标识（客户端靠它过滤，避免认错别的广播） */
const MAGIC = 'dsh-access-phone-remote/1';

let socket = null;
let timer = null;

/** 取本机所有可广播的 IPv4 */
function localIPv4() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) {
        out.push({ ip: a.address, iface: name });
      }
    }
  }
  return out;
}

/** 计算子网广播地址（比 255.255.255.255 更容易穿过某些路由器） */
function subnetBroadcast(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4) return null;
  // 家用场景几乎都是 /24
  return `${parts[0]}.${parts[1]}.${parts[2]}.255`;
}

/**
 * 启动广播。
 *
 * @param {object} config   服务配置（用 port / tokenFile）
 * @param {object} [opts]
 * @param {number} [opts.intervalMs]  广播间隔（默认 3000）
 * @returns {{stop: Function, started: boolean, reason?: string}}
 */
function start(config, opts) {
  const o = opts || {};
  const intervalMs = o.intervalMs || 3000;

  try {
    socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  } catch (e) {
    return { stop() { }, started: false, reason: '创建 UDP socket 失败: ' + e.message };
  }

  socket.on('error', () => {
    // 广播失败不该影响主服务 —— 静默停掉
    try { socket.close(); } catch { }
    socket = null;
  });

  /** 每次现读 token —— ① 配置里显式配了就用它；② 否则读 token 文件（服务刚启动时可能还没生成） */
  const readToken = () => {
    if (config.authToken) return config.authToken;
    try { return require('fs').readFileSync(config.tokenFile, 'utf8').trim(); } catch { return ''; }
  };

  /** 本机所有可给手机用的地址（让手机端自己挑，避免拿到虚拟网卡的 IP） */
  const listAddrs = () => {
    try {
      const list = require('./routes/addresses').listAddresses();
      return list
        .filter((a) => a.kind !== 'loopback')
        .map((a) => ({ ip: a.ip, kind: a.kind }));
    } catch {
      return [];
    }
  };

  const buildPayload = () => JSON.stringify({
    magic: MAGIC,
    port: config.port,
    token: readToken(),
    name: os.hostname(),
    addresses: listAddrs(),
    ts: Date.now(),
  });

  const send = () => {
    if (!socket) return;
    const msg = Buffer.from(buildPayload(), 'utf8');
    const targets = new Set(['255.255.255.255']);
    for (const { ip } of localIPv4()) {
      const b = subnetBroadcast(ip);
      if (b) targets.add(b);
    }
    for (const addr of targets) {
      try {
        socket.send(msg, 0, msg.length, DISCOVERY_PORT, addr, () => { });
      } catch { /* 忽略单个失败 */ }
    }
  };

  try {
    socket.bind(() => {
      try { socket.setBroadcast(true); } catch { }
      send();
    });
  } catch (e) {
    return { stop() { }, started: false, reason: '绑定失败: ' + e.message };
  }

  timer = setInterval(send, intervalMs);
  if (timer.unref) timer.unref();          // 不阻止进程退出

  return {
    started: true,
    port: DISCOVERY_PORT,
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
      if (socket) { try { socket.close(); } catch { } socket = null; }
    },
  };
}

module.exports = { start, DISCOVERY_PORT, MAGIC, localIPv4 };
