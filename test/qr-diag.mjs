/**
 * 精确诊断：对比第三个用例（码字一致）的矩阵，找出差异模式
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const qrSrc = readFileSync(join(__dirname, '..', 'public', 'qr.js'), 'utf8')
const sandbox = {}
new Function('globalThis', qrSrc)(sandbox)
const QRLite = sandbox.QRLite

const ref = JSON.parse(readFileSync(join(__dirname, '_qr_ref.json'), 'utf8'))
const TEXT = "http://127.0.0.1:3099/?t=test-token-for-integration"
const r = ref[TEXT]

console.log(`\n=== 诊断：${TEXT} ===`)
console.log(`Python: version=${r.version} size=${r.size} codewords=${r.codewordCount}`)

const mine = QRLite.encode(TEXT)
console.log(`JS:     version=${mine.version} size=${mine.matrix.length} mask=${mine.mask}`)

// 对比每个掩码
console.log('\n--- 各掩码下的差异格数 ---')
for (let mp = 0; mp < 8; mp++) {
  const refM = r.masks[String(mp)]
  const jsM = QRLite.encodeWithMask(TEXT, mp).matrix
  const n = jsM.length
  let diff = 0
  const diffPos = []
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (jsM[i][j] !== refM[i][j]) {
        diff++
        if (diffPos.length < 8) diffPos.push(`(${i},${j})`)
      }
    }
  }
  console.log(`  掩码 ${mp}: ${diff} 格不同  ${diffPos.join(' ')}`)
}

// 详细看掩码 0
console.log('\n--- 掩码 0 逐行对比（前 12 行）---')
const refM0 = r.masks['0']
const jsM0 = QRLite.encodeWithMask(TEXT, 0).matrix
const n = jsM0.length
console.log('     ' + 'JS' + ' '.repeat(n - 4) + 'PY');
for (let i = 0; i < Math.min(12, n); i++) {
  const jsRow = jsM0[i].map((v) => (v ? '█' : '·')).join('')
  const pyRow = refM0[i].map((v) => (v ? '█' : '·')).join('')
  const mark = jsRow === pyRow ? ' ' : '≠'
  console.log(`  ${String(i).padStart(2)} ${jsRow} ${mark} ${pyRow}`)
}

// 统计：哪些行/列差异最多
console.log('\n--- 差异分布（掩码 0）---')
const rowDiff = new Array(n).fill(0)
const colDiff = new Array(n).fill(0)
for (let i = 0; i < n; i++) {
  for (let j = 0; j < n; j++) {
    if (jsM0[i][j] !== refM0[i][j]) { rowDiff[i]++; colDiff[j]++ }
  }
}
console.log('  行差异: ' + rowDiff.map((v, i) => (v ? `${i}:${v}` : null)).filter(Boolean).join(' '))
console.log('  列差异: ' + colDiff.map((v, i) => (v ? `${i}:${v}` : null)).filter(Boolean).join(' '))

// 检查功能图案是否正确
console.log('\n--- 功能图案检查（掩码 0）---')
const check = (label, i, j) => {
  const js = jsM0[i][j], py = refM0[i][j]
  console.log(`  ${label} (${i},${j}): JS=${js} PY=${py} ${js === py ? '✅' : '❌'}`)
}
check('定位左上', 0, 0)
check('定位右下', n - 1, n - 1)
check('时序横', 6, 10)
check('时序竖', 10, 6)
check('暗模块', n - 8, 8)
check('格式信息', 8, 0)
check('格式信息2', 0, 8)
