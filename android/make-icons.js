// make-icons.js —— 生成纯色圆角图标（不依赖任何图形库，手写 PNG）
// 2026-09-15
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------- PNG 编码 ----------
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function makePng(size, pixelFn) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x, y, size);
      raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 画圆角方 + 中间画 ds 的简笔 ----------
function iconPixel(x, y, size) {
  const cx = size / 2, cy = size / 2;
  const r = size * 0.46;           // 外圆半径
  const dist = Math.hypot(x - cx, y - cy);

  // 圆外透明
  if (dist > r) return [0, 0, 0, 0];

  const BG = [18, 18, 18];
  const LINE = [110, 110, 110];

  // 描边圈
  const ring = Math.abs(dist - r * 0.93);
  if (ring < size * 0.035) return [...LINE, 255];

  // 内部：画 "ds" 两个字母
  const n = size / 100;

  // ---- d：左竖线 + 右下圆 ----
  const dBarX = cx - 17 * n;
  const dBarTop = cy - 20 * n, dBarBot = cy + 20 * n;
  if (Math.abs(x - dBarX) < 3 * n && y > dBarTop && y < dBarBot) return [230, 230, 230, 255];
  // d 的圆（右下，圆心在竖线右侧）
  const dBowl = Math.hypot(x - (dBarX + 9 * n), y - (cy + 9 * n));
  if (Math.abs(dBowl - 9.5 * n) < 3 * n) return [230, 230, 230, 255];

  // ---- s：右侧，两个半圆（上开口右、下开口左） ----
  const sTopY = cy - 8 * n, sBotY = cy + 9 * n, sX = cx + 15 * n;
  // s 上半
  const s1 = Math.hypot(x - (sX + 3 * n), y - sTopY);
  if (Math.abs(s1 - 6 * n) < 2.8 * n && (x > sX + 3 * n || y < sTopY)) return [230, 230, 230, 255];
  // s 中间斜线
  if (Math.abs((y - (sTopY + sBotY) / 2)) < 2.8 * n && x > sX - 6 * n && x < sX + 7 * n) return [230, 230, 230, 255];
  // s 下半
  const s2 = Math.hypot(x - (sX - 3 * n), y - sBotY);
  if (Math.abs(s2 - 6 * n) < 2.8 * n && (x < sX - 3 * n || y > sBotY)) return [230, 230, 230, 255];

  return [...BG, 255];
}

// ---------- 生成各尺寸 ----------
const sizes = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
// 图标输出到本脚本旁的 res/（开源版：不再指向作者机器上的绝对路径）
const base = path.join(__dirname, 'res');

for (const [dpi, size] of Object.entries(sizes)) {
  const dir = path.join(base, `mipmap-${dpi}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ic_launcher.png'), makePng(size, iconPixel));
  console.log(`  mipmap-${dpi}/ic_launcher.png  ${size}x${size}`);
  // 背景图（纯深灰，供 adaptive icon 用）
  fs.writeFileSync(path.join(dir, 'ic_launcher_bg.png'),
    makePng(size, () => [18, 18, 18, 255]));
}

// 前景（透明，实际画在上面）
fs.mkdirSync(path.join(base, 'drawable'), { recursive: true });
fs.writeFileSync(path.join(base, 'drawable', 'ic_launcher_fg.png'), makePng(192, iconPixel));

// adaptive icon 配置
fs.mkdirSync(path.join(base, 'mipmap-anydpi-v26'), { recursive: true });
fs.writeFileSync(path.join(base, 'mipmap-anydpi-v26', 'ic_launcher.xml'),
  `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_bg" />
    <foreground android:drawable="@drawable/ic_launcher_fg" />
</adaptive-icon>
`);

console.log('\n图标生成完成');
