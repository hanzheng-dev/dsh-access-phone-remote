// routes/addresses.js —— 本机可用访问地址
//
// 为什么要这个：
//   手机要访问这台电脑，该用哪个 IP？
//     · 局域网 IP（192.168.x / 10.x / 172.x）—— 同一 WiFi 下最快，不用装任何东西
//     · Tailscale IP（100.64.x ~ 100.127.x）—— 在外面也能用，但手机要装 Tailscale
//     · 回环（127.0.0.1）—— 只有电脑自己能用
//
//   如果只给一个地址，用户可能拿到"手机连不上的那个"。
//   所以这里把所有可能都列出来，并给出推荐顺序。

const os = require('os');

// Tailscale 用的 CGNAT 段（100.64.0.0/10）
function isTailscale(ip) {
  const m = /^100\.(\d+)\./.exec(ip);
  if (!m) return false;
  const second = Number(m[1]);
  return second >= 64 && second <= 127;
}

function isPrivateLan(ip) {
  return /^192\.168\./.test(ip) || /^10\./.test(ip) ||
         /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

// 虚拟网卡识别。
// ⚠️ Node 的 os.networkInterfaces() 只给"网卡名"（中文系统上可能是「以太网 2」），
//    拿不到 InterfaceDescription（那才写着 VirtualBox）。所以双管齐下：
//    ① 按网卡名匹配（英文系统 / Linux 有效）
//    ② 按已知虚拟网段匹配（VirtualBox 默认 192.168.56.x / NAT 10.0.2.x 等）
const VIRTUAL_IFACE = /virtualbox|vmware|vethernet|hyper-?v|wsl|docker|vbox|loopback|\btap\b|\btun\b/i;
const VIRTUAL_SUBNET = [
  /^192\.168\.56\./,   // VirtualBox Host-Only 默认
  /^192\.168\.99\./,   // VirtualBox NAT 常见
  /^10\.0\.2\./,       // VirtualBox NAT 默认
  /^172\.17\./,        // WSL / Docker 常见
  /^172\.2[0-9]\./,    // Hyper-V 默认段
];

function looksVirtual(ifaceName, ip) {
  if (VIRTUAL_IFACE.test(ifaceName)) return true;
  // Tailscale 有自己的 kind，不算虚拟
  if (isTailscale(ip)) return false;
  return VIRTUAL_SUBNET.some((re) => re.test(ip));
}

/**
 * 列出本机所有可用 IPv4。
 * @returns {Array<{ip, iface, kind, label, recommend}>}
 */
function listAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      const ip = a.address;
      let kind, label;
      if (a.internal || ip === '127.0.0.1') {
        kind = 'loopback';
        label = '本机';
      } else if (isTailscale(ip)) {
        kind = 'tailscale';
        label = 'Tailscale（出门也能用，手机需装 Tailscale）';
      } else if (isPrivateLan(ip)) {
        // ⚠️ 虚拟网卡的局域网 IP 要单独标出来（手机连不上它们）
        const virtual = looksVirtual(name, ip);
        kind = virtual ? 'virtual' : 'lan';
        label = virtual
          ? `虚拟网卡（${name}，手机通常连不上）`
          : '局域网（同一 WiFi，推荐）';
      } else {
        kind = 'public';
        label = '公网地址';
      }
      out.push({
        ip,
        iface: name,
        kind,
        label,
        // 推荐顺序：局域网 > Tailscale > 公网 > 虚拟网卡 > 回环
        recommend: kind === 'lan' ? 0
          : kind === 'tailscale' ? 1
          : kind === 'public' ? 2
          : kind === 'virtual' ? 8
          : 9,
      });
    }
  }
  // 去重（不同网卡可能拿到同一个 IP）
  const seen = new Set();
  const uniq = [];
  for (const a of out) {
    if (seen.has(a.ip)) continue;
    seen.add(a.ip);
    uniq.push(a);
  }
  uniq.sort((a, b) => a.recommend - b.recommend || a.ip.localeCompare(b.ip));
  return uniq;
}

function register(server, config) {
  server.addRoute(async (req, res, url, p) => {
    if (p !== '/api/addresses') return false;
    if (req.method !== 'GET') return false;

    const token = (() => {
      try {
        const fs = require('fs');
        return fs.readFileSync(config.tokenFile, 'utf8').trim();
      } catch { return ''; }
    })();

    const list = listAddresses().map((a) => ({
      ...a,
      url: `http://${a.ip}:${config.port}/` + (token ? `?t=${token}` : ''),
    }));

    const body = JSON.stringify({
      ok: true,
      port: config.port,
      hasToken: !!token,
      addresses: list,
      /** 推荐的那个（局域网优先） */
      recommended: list.find((a) => a.kind !== 'loopback') || list[0] || null,
    });

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
    return true;
  });
}

module.exports = { register, listAddresses };
