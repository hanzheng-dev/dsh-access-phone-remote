/**
 * qr.js —— 极简 QR 码生成器（零依赖、纯前端、不联网）
 *
 * 为什么自己写：
 *   用第三方 API（如 api.qrserver.com）会把「手机访问地址 + token」发给别人。
 *   这个项目的前提是「数据不出门」，所以二维码必须本地生成。
 *
 * 能力：
 *   · Byte mode（UTF-8 当字节流）
 *   · 纠错等级 L（屏幕上显示不需要强纠错）
 *   · 版本 1-9（最多 230 字节，URL 完全够用）
 *   · 输出 SVG 字符串
 *
 * 用法：
 *   const svg = QRLite.render('http://192.168.1.100:3099/?t=xxx', 240);
 *   el.innerHTML = svg;
 */
(function (global) {
  'use strict';

  // ---------- GF(256) ----------
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function initTables() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  // ---------- 版本容量表（ECC L，byte mode）----------
  // [版本, 数据码字数, 纠错码字数(每块), 块数]
  const VERSIONS = {
    1:  { data: 19,  ecc: 7,  blocks: 1 },
    2:  { data: 34,  ecc: 10, blocks: 1 },
    3:  { data: 55,  ecc: 15, blocks: 1 },
    4:  { data: 80,  ecc: 20, blocks: 1 },
    5:  { data: 108, ecc: 26, blocks: 1 },
    6:  { data: 136, ecc: 18, blocks: 2 },
    7:  { data: 156, ecc: 20, blocks: 2 },
    8:  { data: 194, ecc: 24, blocks: 2 },
    9:  { data: 232, ecc: 30, blocks: 2 },
  };

  // 对齐图案中心坐标
  const ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46],
  };

  // 版本信息（V7+）
  const VERSION_INFO = {
    7: 0x07c94, 8: 0x085bc, 9: 0x09a99,
  };

  // ---------- Reed-Solomon ----------
  function rsGenPoly(n) {
    let g = [1];
    for (let i = 0; i < n; i++) {
      const ng = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) {
        ng[j] ^= g[j];
        ng[j + 1] ^= gfMul(g[j], EXP[i]);
      }
      g = ng;
    }
    return g;
  }

  function rsEncode(data, eccLen) {
    const gen = rsGenPoly(eccLen);
    const res = new Array(eccLen).fill(0);
    for (let d = 0; d < data.length; d++) {
      const factor = data[d] ^ res[0];
      res.shift();
      res.push(0);
      if (factor !== 0) {
        for (let i = 0; i < eccLen; i++) {
          res[i] ^= gfMul(gen[i + 1], factor);
        }
      }
    }
    return res;
  }

  // ---------- 位缓冲 ----------
  function BitBuf() {
    this.bits = [];
  }
  BitBuf.prototype.put = function (val, len) {
    for (let i = len - 1; i >= 0; i--) this.bits.push((val >>> i) & 1);
  };

  // ---------- 编码数据 ----------
  function encodeData(text, version) {
    const v = VERSIONS[version];
    // UTF-8
    const bytes = [];
    for (let i = 0; i < text.length; i++) {
      let c = text.charCodeAt(i);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) {
        bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      } else {
        bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    }

    const buf = new BitBuf();
    // Mode indicator: byte = 0100
    buf.put(0b0100, 4);
    // Character count（版本 1-9 用 8 位）
    buf.put(bytes.length, 8);
    // 数据
    for (const b of bytes) buf.put(b, 8);

    // 终止符
    const totalDataBits = v.data * 8;
    const term = Math.min(4, totalDataBits - buf.bits.length);
    buf.put(0, term);

    // 补齐到字节边界
    while (buf.bits.length % 8 !== 0) buf.bits.push(0);

    // 转字节
    const dataCw = [];
    for (let i = 0; i < buf.bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | buf.bits[i + j];
      dataCw.push(b);
    }

    // 填充码字
    const PAD = [0xec, 0x11];
    let pi = 0;
    while (dataCw.length < v.data) {
      dataCw.push(PAD[pi % 2]);
      pi++;
    }

    // 分块 + 纠错
    const blocks = [];
    const perBlock = Math.floor(v.data / v.blocks);
    const extra = v.data % v.blocks;
    let off = 0;
    for (let b = 0; b < v.blocks; b++) {
      const len = perBlock + (b >= v.blocks - extra ? 1 : 0);
      const chunk = dataCw.slice(off, off + len);
      off += len;
      blocks.push({ data: chunk, ecc: rsEncode(chunk, v.ecc) });
    }

    // 交织
    const out = [];
    const maxData = Math.max(...blocks.map((b) => b.data.length));
    for (let i = 0; i < maxData; i++) {
      for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
    }
    for (let i = 0; i < v.ecc; i++) {
      for (const b of blocks) out.push(b.ecc[i]);
    }
    return out;
  }

  // ---------- 矩阵 ----------
  function makeMatrix(version) {
    const size = version * 4 + 17;
    const m = [];
    for (let i = 0; i < size; i++) m.push(new Array(size).fill(null));
    return m;
  }

  function placeFinder(m, r, c) {
    for (let i = -1; i <= 7; i++) {
      for (let j = -1; j <= 7; j++) {
        const rr = r + i, cc = c + j;
        if (rr < 0 || rr >= m.length || cc < 0 || cc >= m.length) continue;
        const inRing = (i >= 0 && i <= 6 && (j === 0 || j === 6)) ||
                       (j >= 0 && j <= 6 && (i === 0 || i === 6));
        const inCore = i >= 2 && i <= 4 && j >= 2 && j <= 4;
        m[rr][cc] = (inRing || inCore) ? 1 : 0;
      }
    }
  }

  function placeAlign(m, version) {
    const pos = ALIGN[version];
    for (const r of pos) {
      for (const c of pos) {
        // 跳过与定位图案重叠的
        if ((r === 6 && c === 6) ||
            (r === 6 && c === m.length - 7) ||
            (r === m.length - 7 && c === 6)) continue;
        for (let i = -2; i <= 2; i++) {
          for (let j = -2; j <= 2; j++) {
            const isRing = Math.abs(i) === 2 || Math.abs(j) === 2;
            const isCore = i === 0 && j === 0;
            m[r + i][c + j] = (isRing || isCore) ? 1 : 0;
          }
        }
      }
    }
  }

  function placeTiming(m) {
    const size = m.length;
    for (let i = 8; i < size - 8; i++) {
      const v = i % 2 === 0 ? 1 : 0;
      if (m[6][i] === null) m[6][i] = v;
      if (m[i][6] === null) m[i][6] = v;
    }
  }

  function reserveFormat(m) {
    const size = m.length;
    // 左上
    for (let i = 0; i < 9; i++) {
      if (m[8][i] === null) m[8][i] = 0;
      if (m[i][8] === null) m[i][8] = 0;
    }
    // 右上 / 左下
    for (let i = 0; i < 8; i++) {
      if (m[8][size - 1 - i] === null) m[8][size - 1 - i] = 0;
      if (m[size - 1 - i][8] === null) m[size - 1 - i][8] = 0;
    }
    // 固定暗点
    m[size - 8][8] = 1;
  }

  function reserveVersion(m, version) {
    if (version < 7) return;
    const size = m.length;
    const info = VERSION_INFO[version];
    for (let i = 0; i < 18; i++) {
      const bit = (info >> i) & 1;
      const r = Math.floor(i / 3);
      const c = i % 3;
      m[r][size - 11 + c] = bit;
      m[size - 11 + c][r] = bit;
    }
  }

  function placeData(m, codewords) {
    const size = m.length;
    let bitIdx = 0;
    let upward = true;
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--; // 跳过时序列
      for (let i = 0; i < size; i++) {
        const row = upward ? size - 1 - i : i;
        for (let k = 0; k < 2; k++) {
          const c = col - k;
          if (m[row][c] !== null) continue;
          let bit = 0;
          if (bitIdx < codewords.length * 8) {
            const byte = codewords[bitIdx >> 3];
            bit = (byte >> (7 - (bitIdx & 7))) & 1;
          }
          m[row][c] = bit;
          bitIdx++;
        }
      }
      upward = !upward;
    }
  }

  function maskFn(id, r, c) {
    switch (id) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    }
    return false;
  }

  function isFunctionModule(m, r, c) {
    const size = m.length;
    const version = (size - 17) / 4;
    // 定位图案 + 分隔符 + 格式信息区
    if (r < 9 && c < 9) return true;
    if (r < 9 && c >= size - 8) return true;
    if (r >= size - 8 && c < 9) return true;
    // 时序图案
    if (r === 6 || c === 6) return true;
    // 版本信息（V7+）
    if (version >= 7) {
      if (r < 6 && c >= size - 11 && c < size - 8) return true;
      if (c < 6 && r >= size - 11 && r < size - 8) return true;
    }
    // ⚠️ 对齐图案（曾经漏了这个 ⇒ 对齐图案被掩码 ⇒ 矩阵错）
    const pos = ALIGN[version] || [];
    for (let a = 0; a < pos.length; a++) {
      for (let b = 0; b < pos.length; b++) {
        const ar = pos[a], ac = pos[b];
        // 跟定位图案重叠的跳过（那些位置本来就在定位图案范围里）
        if ((ar === 6 && ac === 6) ||
            (ar === 6 && ac === size - 7) ||
            (ar === size - 7 && ac === 6)) continue;
        if (Math.abs(r - ar) <= 2 && Math.abs(c - ac) <= 2) return true;
      }
    }
    return false;
  }

  function applyMask(m, id) {
    const size = m.length;
    const out = m.map((row) => row.slice());
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (isFunctionModule(m, r, c)) continue;
        if (maskFn(id, r, c)) out[r][c] ^= 1;
      }
    }
    return out;
  }

  function bchFormat(data) {
    let d = data << 10;
    for (let i = 14; i >= 10; i--) {
      if ((d >> i) & 1) d ^= 0x537 << (i - 10);
    }
    return ((data << 10) | d) ^ 0x5412;
  }

  function placeFormat(m, eccBits, maskId) {
    const size = m.length;
    const fmt = bchFormat((eccBits << 3) | maskId);
    for (let i = 0; i < 15; i++) {
      const bit = (fmt >> i) & 1;
      // 左上竖
      if (i < 6) m[i][8] = bit;
      else if (i < 8) m[i + 1][8] = bit;
      else if (i === 8) m[8][7] = bit;
      else m[8][14 - i] = bit;
      // 另一份
      if (i < 8) m[8][size - 1 - i] = bit;
      else m[size - 15 + i][8] = bit;
    }
    m[size - 8][8] = 1;
  }

  function penalty(m) {
    const size = m.length;
    let score = 0;
    // 规则 1：同色连续
    for (let r = 0; r < size; r++) {
      let run = 1;
      for (let c = 1; c < size; c++) {
        if (m[r][c] === m[r][c - 1]) { run++; if (run === 5) score += 3; else if (run > 5) score++; }
        else run = 1;
      }
    }
    for (let c = 0; c < size; c++) {
      let run = 1;
      for (let r = 1; r < size; r++) {
        if (m[r][c] === m[r - 1][c]) { run++; if (run === 5) score += 3; else if (run > 5) score++; }
        else run = 1;
      }
    }
    // 规则 2：2x2 同色
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = m[r][c];
        if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
      }
    }
    return score;
  }

  // ---------- 主函数 ----------
  function encode(text, forcedMask) {
    // 选版本
    let version = 0;
    const len = new TextEncoder().encode(text).length;
    for (let v = 1; v <= 9; v++) {
      // byte mode 开销：4 位 mode + 8 位长度 + 数据
      const capBits = VERSIONS[v].data * 8;
      if (capBits >= 4 + 8 + len * 8) { version = v; break; }
    }
    if (!version) throw new Error('内容太长（超过 9 版容量）');

    const cw = encodeData(text, version);
    const base = makeMatrix(version);
    placeFinder(base, 0, 0);
    placeFinder(base, 0, base.length - 7);
    placeFinder(base, base.length - 7, 0);
    placeAlign(base, version);
    placeTiming(base);
    reserveFormat(base);
    reserveVersion(base, version);
    placeData(base, cw);

    // 指定掩码（测试用）或选最优
    if (forcedMask != null) {
      const m = applyMask(base, forcedMask);
      placeFormat(m, 0b01, forcedMask);
      return { matrix: m, version, mask: forcedMask, codewords: cw };
    }

    let best = null, bestScore = Infinity;
    for (let id = 0; id < 8; id++) {
      const cand = applyMask(base, id);
      placeFormat(cand, 0b01, id); // ECC L = 01
      const s = penalty(cand);
      if (s < bestScore) { bestScore = s; best = { m: cand, id }; }
    }
    return { matrix: best.m, version, mask: best.id, codewords: cw };
  }

  function renderSVG(text, sizePx, opts) {
    opts = opts || {};
    const { matrix } = encode(text);
    const n = matrix.length;
    const quiet = opts.quiet != null ? opts.quiet : 2;
    const total = n + quiet * 2;
    const scale = sizePx / total;

    let path = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (matrix[r][c]) {
          const x = (c + quiet) * scale;
          const y = (r + quiet) * scale;
          path += `M${x.toFixed(2)} ${y.toFixed(2)}h${scale.toFixed(2)}v${scale.toFixed(2)}h-${scale.toFixed(2)}z`;
        }
      }
    }
    const light = opts.light || '#ffffff';
    const dark = opts.dark || '#000000';
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${sizePx}" height="${sizePx}" viewBox="0 0 ${sizePx} ${sizePx}" shape-rendering="crispEdges">` +
      `<rect width="${sizePx}" height="${sizePx}" fill="${light}"/>` +
      `<path d="${path}" fill="${dark}"/>` +
      `</svg>`;
  }

  // ---------- 导出 ----------
  global.QRLite = {
    encode,
    render: renderSVG,

    // ---- 测试钩子（交叉验证用）----
    /** 返回交织后的数据码字（含纠错） */
    _codewords(text) {
      let version = 0;
      const len = new TextEncoder().encode(text).length;
      for (let v = 1; v <= 9; v++) {
        if (VERSIONS[v].data * 8 >= 4 + 8 + len * 8) { version = v; break; }
      }
      if (!version) throw new Error('too long');
      return encodeData(text, version);
    },
    /** 用指定掩码编码 */
    encodeWithMask(text, maskId) {
      return encode(text, maskId);
    },

    /** 便捷：把一个元素的 innerHTML 设成二维码 */
    into(el, text, sizePx, opts) {
      if (!el) return;
      try {
        el.innerHTML = renderSVG(text, sizePx || 240, opts);
      } catch (e) {
        el.textContent = '二维码生成失败：' + e.message;
      }
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
