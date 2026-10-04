/**
 * QR 编码器交叉验证 —— 最终版
 *
 * 参考数据由 Python 的 qrcode 库生成（强制 byte mode，禁用模式优化）。
 * 对每个用例，遍历 8 个掩码，检查是否存在逐格一致的矩阵。
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const qrSrc = readFileSync(join(__dirname, '..', 'public', 'qr.js'), 'utf8')
const sandbox = {}
new Function('globalThis', qrSrc)(sandbox)
const QRLite = sandbox.QRLite

const ref = JSON.parse(readFileSync(join(__dirname, 'fixtures/qr-reference.json'), 'utf8'))

let pass = 0, fail = 0

console.log('\n=== QR 交叉验证（JS 实现 vs Python qrcode）===\n')

for (const [text, r] of Object.entries(ref)) {
  const label = text.length > 48 ? text.slice(0, 48) + '…' : text
  console.log(`【${label}】`)

  const mine = QRLite.encode(text)

  // 版本
  if (mine.version === r.version) { console.log(`  ✅ 版本 ${mine.version}`); pass++ }
  else { console.log(`  ❌ 版本 JS=${mine.version} PY=${r.version}`); fail++ }

  // 尺寸
  const n = mine.matrix.length
  if (n === r.size) { console.log(`  ✅ 尺寸 ${n}×${n}`); pass++ }
  else { console.log(`  ❌ 尺寸 JS=${n} PY=${r.size}`); fail++ }

  // 遍历掩码找完全匹配
  let found = -1
  let bestDiff = Infinity
  for (let mp = 0; mp < 8; mp++) {
    const refM = r.masks[String(mp)]
    const jsM = QRLite.encodeWithMask(text, mp).matrix
    let diff = 0
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (jsM[i][j] !== refM[i][j]) diff++
      }
    }
    if (diff === 0) { found = mp; break }
    if (diff < bestDiff) bestDiff = diff
  }

  if (found >= 0) {
    console.log(`  ✅✅ 掩码 ${found} 下矩阵逐格一致（${n * n} 格全对）`)
    pass++
  } else {
    console.log(`  ❌ 没有任何掩码完全匹配（最接近的差 ${bestDiff} 格）`)
    fail++
  }
  console.log('')
}

console.log('='.repeat(48))
console.log(`通过 ${pass} · 失败 ${fail}`)
console.log('='.repeat(48) + '\n')

process.exit(fail ? 1 : 0)
