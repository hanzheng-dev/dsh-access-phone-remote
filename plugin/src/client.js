/**
 * dsh-access-phone-remote — Client half（dsh 设置页「手机远程」面板）
 *
 * 形状：手写 __ModuleLoader__ 包壳（与 dsh 已安装插件 tsdown 产物同构，零构建）。
 * 参照：dsh-session-delete/src/client.js —— factory 里先造 module/exports，
 *       require('react') 拿 React，用 h(...) 建树（不引入 JSX、零第三方依赖），
 *       最后 exports.apply / exports.inject 再 return module.exports。
 *
 * 槽位：settings.section —— 设置页「手机远程」一页。
 *   · 运行状态（3 秒轮询 /status）+ 启动 / 停止 / 重启
 *   · 手机访问地址（/url）+ 本地生成的二维码（手机直接扫）
 *   · 配置（项目目录 / 端口 → POST /config）
 *   · 一键复制诊断信息（/diagnose）
 * 数据全部来自 Host 半的本机回环接口 /api/dsh-access-phone-remote/*。
 */
window.__ModuleLoader__.load({
  id: 'dsh-access-phone-remote',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState } = React

    /** 本机接口前缀（与 Host 半一致）。 */
    const PREFIX = '/api/dsh-access-phone-remote'
    /** 非 GET 请求必须带的自定义头（Host 半靠它防跨站）。 */
    const HDR = 'x-dsh-plugin'
    /** 与包名 / 槽位 id 一致，Host 半校验这个值。 */
    const PLUGIN_ID = 'dsh-access-phone-remote'
    /** 状态轮询间隔。 */
    const POLL_MS = 3000

    // ---------- 主题色（跟随 dsh 主题变量，与官方设置页观感一致） ----------
    const T = {
      bg: 'var(--dsw-alias-bg-layer-2)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      border: 'var(--dsw-alias-border-l1)',
      label: 'var(--dsw-alias-label-primary)',
      secondary: 'var(--dsw-alias-label-secondary)',
      brand: 'var(--dsw-alias-brand-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      err: 'var(--dsw-alias-state-error-primary)',
    }

    // ---------- 本机 API ----------

    /** 统一的错误原文提取。 */
    function msgOf(e) {
      if (e == null) return '未知错误'
      if (typeof e === 'string') return e
      return String(e.message ?? e)
    }

    /**
     * 调本机接口。
     * Host 半有两种失败姿势：HTTP 非 2xx，以及 HTTP 200 但 body.ok === false。
     * 两种都转成异常，调用方统一 catch 后写进界面。
     */
    async function callApi(path, options) {
      const res = await fetch(PREFIX + path, options)
      let data = {}
      try {
        data = await res.json()
      } catch {
        data = {}
      }
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
      if (data && data.ok === false) throw new Error(data.error ?? '接口返回失败')
      return data
    }

    /** POST 本机接口（自动带自定义头与 JSON 头）。 */
    function post(path, body) {
      return callApi(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [HDR]: PLUGIN_ID },
        body: JSON.stringify(body ?? {}),
      })
    }

    // ---------- 格式化 ----------
    function fmtDuration(ms) {
      const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
      const hh = Math.floor(s / 3600)
      const mm = Math.floor((s % 3600) / 60)
      const ss = s % 60
      return `${hh ? `${hh} 小时 ` : ''}${hh || mm ? `${mm} 分 ` : ''}${ss} 秒`
    }

    // =========================================================================
    // 二维码生成器（内联自项目里的 public/qr.js —— 零依赖、纯前端、不联网）
    //
    // 为什么内联：客户端半能否 require 相对路径没有保证，内联最安全；而且二维码
    // 必须本地生成（用第三方 API 会把「手机访问地址 + token」发给别人）。
    //
    // 相对原文件的改动，只有两处：
    //   1. 去掉最外层 (function (global) { ... })(window) 包壳，改成 IIFE 返回
    //      一个 QRLite 对象，本文件里用 renderQrSvg(text, size) 直接拿 SVG 字符串。
    //   2. 去掉 global.QRLite 挂载、去掉 into(el, ...) 这个直接操作 DOM 的便捷方法
    //      （React 侧改用 dangerouslySetInnerHTML）。
    // 算法部分一字未改：GF(256) 表、Reed-Solomon 纠错、版本 1-9 容量表与对齐图案
    // 表、版本信息(V7+)、格式信息 BCH、8 种掩码 + 罚分选优、SVG 渲染，
    // 以及两个测试钩子 _codewords / encodeWithMask。
    // =========================================================================
    const QRLite = (function createQrRenderer() {
      'use strict'

      // ---------- GF(256) ----------
      const EXP = new Uint8Array(512)
      const LOG = new Uint8Array(256)
      ;(function initTables() {
        let x = 1
        for (let i = 0; i < 255; i++) {
          EXP[i] = x
          LOG[x] = i
          x <<= 1
          if (x & 0x100) x ^= 0x11d
        }
        for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
      })()

      function gfMul(a, b) {
        if (a === 0 || b === 0) return 0
        return EXP[LOG[a] + LOG[b]]
      }

      // ---------- 版本容量表（ECC L，byte mode）----------
      // [版本, 数据码字数, 纠错码字数(每块), 块数]
      const VERSIONS = {
        1: { data: 19, ecc: 7, blocks: 1 },
        2: { data: 34, ecc: 10, blocks: 1 },
        3: { data: 55, ecc: 15, blocks: 1 },
        4: { data: 80, ecc: 20, blocks: 1 },
        5: { data: 108, ecc: 26, blocks: 1 },
        6: { data: 136, ecc: 18, blocks: 2 },
        7: { data: 156, ecc: 20, blocks: 2 },
        8: { data: 194, ecc: 24, blocks: 2 },
        9: { data: 232, ecc: 30, blocks: 2 },
      }

      // 对齐图案中心坐标
      const ALIGN = {
        1: [],
        2: [6, 18],
        3: [6, 22],
        4: [6, 26],
        5: [6, 30],
        6: [6, 34],
        7: [6, 22, 38],
        8: [6, 24, 42],
        9: [6, 26, 46],
      }

      // 版本信息（V7+）
      const VERSION_INFO = { 7: 0x07c94, 8: 0x085bc, 9: 0x09a99 }

      // ---------- Reed-Solomon ----------
      function rsGenPoly(n) {
        let g = [1]
        for (let i = 0; i < n; i++) {
          const ng = new Array(g.length + 1).fill(0)
          for (let j = 0; j < g.length; j++) {
            ng[j] ^= g[j]
            ng[j + 1] ^= gfMul(g[j], EXP[i])
          }
          g = ng
        }
        return g
      }

      function rsEncode(data, eccLen) {
        const gen = rsGenPoly(eccLen)
        const res = new Array(eccLen).fill(0)
        for (let d = 0; d < data.length; d++) {
          const factor = data[d] ^ res[0]
          res.shift()
          res.push(0)
          if (factor !== 0) {
            for (let i = 0; i < eccLen; i++) res[i] ^= gfMul(gen[i + 1], factor)
          }
        }
        return res
      }

      // ---------- 位缓冲 ----------
      function BitBuf() {
        this.bits = []
      }
      BitBuf.prototype.put = function (val, len) {
        for (let i = len - 1; i >= 0; i--) this.bits.push((val >>> i) & 1)
      }

      // ---------- 编码数据 ----------
      function encodeData(text, version) {
        const v = VERSIONS[version]
        // UTF-8
        const bytes = []
        for (let i = 0; i < text.length; i++) {
          const c = text.charCodeAt(i)
          if (c < 0x80) bytes.push(c)
          else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
          else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
        }

        const buf = new BitBuf()
        // Mode indicator: byte = 0100
        buf.put(0b0100, 4)
        // Character count（版本 1-9 用 8 位）
        buf.put(bytes.length, 8)
        // 数据
        for (const b of bytes) buf.put(b, 8)

        // 终止符
        const totalDataBits = v.data * 8
        const term = Math.min(4, totalDataBits - buf.bits.length)
        buf.put(0, term)

        // 补齐到字节边界
        while (buf.bits.length % 8 !== 0) buf.bits.push(0)

        // 转字节
        const dataCw = []
        for (let i = 0; i < buf.bits.length; i += 8) {
          let b = 0
          for (let j = 0; j < 8; j++) b = (b << 1) | buf.bits[i + j]
          dataCw.push(b)
        }

        // 填充码字
        const PAD = [0xec, 0x11]
        let pi = 0
        while (dataCw.length < v.data) {
          dataCw.push(PAD[pi % 2])
          pi++
        }

        // 分块 + 纠错
        const blocks = []
        const perBlock = Math.floor(v.data / v.blocks)
        const extra = v.data % v.blocks
        let off = 0
        for (let b = 0; b < v.blocks; b++) {
          const len = perBlock + (b >= v.blocks - extra ? 1 : 0)
          const chunk = dataCw.slice(off, off + len)
          off += len
          blocks.push({ data: chunk, ecc: rsEncode(chunk, v.ecc) })
        }

        // 交织
        const out = []
        const maxData = Math.max(...blocks.map((b) => b.data.length))
        for (let i = 0; i < maxData; i++) {
          for (const b of blocks) if (i < b.data.length) out.push(b.data[i])
        }
        for (let i = 0; i < v.ecc; i++) {
          for (const b of blocks) out.push(b.ecc[i])
        }
        return out
      }

      // ---------- 矩阵 ----------
      function makeMatrix(version) {
        const size = version * 4 + 17
        const m = []
        for (let i = 0; i < size; i++) m.push(new Array(size).fill(null))
        return m
      }

      function placeFinder(m, r, c) {
        for (let i = -1; i <= 7; i++) {
          for (let j = -1; j <= 7; j++) {
            const rr = r + i
            const cc = c + j
            if (rr < 0 || rr >= m.length || cc < 0 || cc >= m.length) continue
            const inRing =
              (i >= 0 && i <= 6 && (j === 0 || j === 6)) || (j >= 0 && j <= 6 && (i === 0 || i === 6))
            const inCore = i >= 2 && i <= 4 && j >= 2 && j <= 4
            m[rr][cc] = inRing || inCore ? 1 : 0
          }
        }
      }

      function placeAlign(m, version) {
        const pos = ALIGN[version]
        for (const r of pos) {
          for (const c of pos) {
            // 跳过与定位图案重叠的
            if (
              (r === 6 && c === 6) ||
              (r === 6 && c === m.length - 7) ||
              (r === m.length - 7 && c === 6)
            )
              continue
            for (let i = -2; i <= 2; i++) {
              for (let j = -2; j <= 2; j++) {
                const isRing = Math.abs(i) === 2 || Math.abs(j) === 2
                const isCore = i === 0 && j === 0
                m[r + i][c + j] = isRing || isCore ? 1 : 0
              }
            }
          }
        }
      }

      function placeTiming(m) {
        const size = m.length
        for (let i = 8; i < size - 8; i++) {
          const v = i % 2 === 0 ? 1 : 0
          if (m[6][i] === null) m[6][i] = v
          if (m[i][6] === null) m[i][6] = v
        }
      }

      function reserveFormat(m) {
        const size = m.length
        // 左上
        for (let i = 0; i < 9; i++) {
          if (m[8][i] === null) m[8][i] = 0
          if (m[i][8] === null) m[i][8] = 0
        }
        // 右上 / 左下
        for (let i = 0; i < 8; i++) {
          if (m[8][size - 1 - i] === null) m[8][size - 1 - i] = 0
          if (m[size - 1 - i][8] === null) m[size - 1 - i][8] = 0
        }
        // 固定暗点
        m[size - 8][8] = 1
      }

      function reserveVersion(m, version) {
        if (version < 7) return
        const size = m.length
        const info = VERSION_INFO[version]
        for (let i = 0; i < 18; i++) {
          const bit = (info >> i) & 1
          const r = Math.floor(i / 3)
          const c = i % 3
          m[r][size - 11 + c] = bit
          m[size - 11 + c][r] = bit
        }
      }

      function placeData(m, codewords) {
        const size = m.length
        let bitIdx = 0
        let upward = true
        for (let col = size - 1; col > 0; col -= 2) {
          if (col === 6) col-- // 跳过时序列
          for (let i = 0; i < size; i++) {
            const row = upward ? size - 1 - i : i
            for (let k = 0; k < 2; k++) {
              const c = col - k
              if (m[row][c] !== null) continue
              let bit = 0
              if (bitIdx < codewords.length * 8) {
                const byte = codewords[bitIdx >> 3]
                bit = (byte >> (7 - (bitIdx & 7))) & 1
              }
              m[row][c] = bit
              bitIdx++
            }
          }
          upward = !upward
        }
      }

      function maskFn(id, r, c) {
        switch (id) {
          case 0:
            return (r + c) % 2 === 0
          case 1:
            return r % 2 === 0
          case 2:
            return c % 3 === 0
          case 3:
            return (r + c) % 3 === 0
          case 4:
            return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0
          case 5:
            return ((r * c) % 2) + ((r * c) % 3) === 0
          case 6:
            return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0
          case 7:
            return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
        }
        return false
      }

      function isFunctionModule(m, r, c) {
        const size = m.length
        const version = (size - 17) / 4
        // 定位图案 + 分隔符 + 格式信息区
        if (r < 9 && c < 9) return true
        if (r < 9 && c >= size - 8) return true
        if (r >= size - 8 && c < 9) return true
        // 时序图案
        if (r === 6 || c === 6) return true
        // 版本信息（V7+）
        if (version >= 7) {
          if (r < 6 && c >= size - 11 && c < size - 8) return true
          if (c < 6 && r >= size - 11 && r < size - 8) return true
        }
        // 对齐图案（漏了它 ⇒ 对齐图案被掩码 ⇒ 矩阵错）
        const pos = ALIGN[version] || []
        for (let a = 0; a < pos.length; a++) {
          for (let b = 0; b < pos.length; b++) {
            const ar = pos[a]
            const ac = pos[b]
            // 跟定位图案重叠的跳过（那些位置本来就在定位图案范围里）
            if ((ar === 6 && ac === 6) || (ar === 6 && ac === size - 7) || (ar === size - 7 && ac === 6))
              continue
            if (Math.abs(r - ar) <= 2 && Math.abs(c - ac) <= 2) return true
          }
        }
        return false
      }

      function applyMask(m, id) {
        const size = m.length
        const out = m.map((row) => row.slice())
        for (let r = 0; r < size; r++) {
          for (let c = 0; c < size; c++) {
            if (isFunctionModule(m, r, c)) continue
            if (maskFn(id, r, c)) out[r][c] ^= 1
          }
        }
        return out
      }

      function bchFormat(data) {
        let d = data << 10
        for (let i = 14; i >= 10; i--) {
          if ((d >> i) & 1) d ^= 0x537 << (i - 10)
        }
        return ((data << 10) | d) ^ 0x5412
      }

      function placeFormat(m, eccBits, maskId) {
        const size = m.length
        const fmt = bchFormat((eccBits << 3) | maskId)
        for (let i = 0; i < 15; i++) {
          const bit = (fmt >> i) & 1
          // 左上竖
          if (i < 6) m[i][8] = bit
          else if (i < 8) m[i + 1][8] = bit
          else if (i === 8) m[8][7] = bit
          else m[8][14 - i] = bit
          // 另一份
          if (i < 8) m[8][size - 1 - i] = bit
          else m[size - 15 + i][8] = bit
        }
        m[size - 8][8] = 1
      }

      function penalty(m) {
        const size = m.length
        let score = 0
        // 规则 1：同色连续
        for (let r = 0; r < size; r++) {
          let run = 1
          for (let c = 1; c < size; c++) {
            if (m[r][c] === m[r][c - 1]) {
              run++
              if (run === 5) score += 3
              else if (run > 5) score++
            } else run = 1
          }
        }
        for (let c = 0; c < size; c++) {
          let run = 1
          for (let r = 1; r < size; r++) {
            if (m[r][c] === m[r - 1][c]) {
              run++
              if (run === 5) score += 3
              else if (run > 5) score++
            } else run = 1
          }
        }
        // 规则 2：2x2 同色
        for (let r = 0; r < size - 1; r++) {
          for (let c = 0; c < size - 1; c++) {
            const v = m[r][c]
            if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3
          }
        }
        return score
      }

      // ---------- 主函数 ----------
      function encode(text, forcedMask) {
        // 选版本
        let version = 0
        const len = new TextEncoder().encode(text).length
        for (let v = 1; v <= 9; v++) {
          // byte mode 开销：4 位 mode + 8 位长度 + 数据
          const capBits = VERSIONS[v].data * 8
          if (capBits >= 4 + 8 + len * 8) {
            version = v
            break
          }
        }
        if (!version) throw new Error('内容太长（超过 9 版容量）')

        const cw = encodeData(text, version)
        const base = makeMatrix(version)
        placeFinder(base, 0, 0)
        placeFinder(base, 0, base.length - 7)
        placeFinder(base, base.length - 7, 0)
        placeAlign(base, version)
        placeTiming(base)
        reserveFormat(base)
        reserveVersion(base, version)
        placeData(base, cw)

        // 指定掩码（测试用）或选最优
        if (forcedMask != null) {
          const m = applyMask(base, forcedMask)
          placeFormat(m, 0b01, forcedMask)
          return { matrix: m, version, mask: forcedMask, codewords: cw }
        }

        let best = null
        let bestScore = Infinity
        for (let id = 0; id < 8; id++) {
          const cand = applyMask(base, id)
          placeFormat(cand, 0b01, id) // ECC L = 01
          const s = penalty(cand)
          if (s < bestScore) {
            bestScore = s
            best = { m: cand, id }
          }
        }
        return { matrix: best.m, version, mask: best.id, codewords: cw }
      }

      function renderSVG(text, sizePx, opts) {
        opts = opts || {}
        const { matrix } = encode(text)
        const n = matrix.length
        const quiet = opts.quiet != null ? opts.quiet : 2
        const total = n + quiet * 2
        const scale = sizePx / total

        let path = ''
        for (let r = 0; r < n; r++) {
          for (let c = 0; c < n; c++) {
            if (matrix[r][c]) {
              const x = (c + quiet) * scale
              const y = (r + quiet) * scale
              path += `M${x.toFixed(2)} ${y.toFixed(2)}h${scale.toFixed(2)}v${scale.toFixed(2)}h-${scale.toFixed(2)}z`
            }
          }
        }
        const light = opts.light || '#ffffff'
        const dark = opts.dark || '#000000'
        return (
          `<svg xmlns="http://www.w3.org/2000/svg" width="${sizePx}" height="${sizePx}" viewBox="0 0 ${sizePx} ${sizePx}" shape-rendering="crispEdges">` +
          `<rect width="${sizePx}" height="${sizePx}" fill="${light}"/>` +
          `<path d="${path}" fill="${dark}"/>` +
          `</svg>`
        )
      }

      // ---------- 导出（原文件挂在 global.QRLite 上的那一份） ----------
      return {
        encode,
        render: renderSVG,

        // ---- 测试钩子（交叉验证用）----
        /** 返回交织后的数据码字（含纠错） */
        _codewords(text) {
          let version = 0
          const len = new TextEncoder().encode(text).length
          for (let v = 1; v <= 9; v++) {
            if (VERSIONS[v].data * 8 >= 4 + 8 + len * 8) {
              version = v
              break
            }
          }
          if (!version) throw new Error('too long')
          return encodeData(text, version)
        },
        /** 用指定掩码编码 */
        encodeWithMask(text, maskId) {
          return encode(text, maskId)
        },
      }
    })()

    /**
     * 把一个字符串渲染成二维码 SVG（本地生成，不联网）。
     * @param {string} text 要编码的内容
     * @param {number} size 边长像素
     * @returns {string} SVG 字符串，可直接塞进 dangerouslySetInnerHTML
     */
    function renderQrSvg(text, size) {
      return QRLite.render(String(text ?? ''), size || 220)
    }

    /** 二维码小缓存：3 秒轮询会反复重渲染，同样的地址只算一次。 */
    const qrCache = new Map()
    function renderQrCached(text, size) {
      const key = `${size}|${text}`
      if (qrCache.has(key)) return qrCache.get(key)
      const svg = renderQrSvg(text, size)
      if (qrCache.size > 20) qrCache.clear()
      qrCache.set(key, svg)
      return svg
    }

    // ---------- 样式片段 ----------
    const btnBase = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      padding: '5px 12px',
      border: `1px solid ${T.border}`,
      borderRadius: 6,
      background: 'transparent',
      color: T.label,
      fontSize: 13,
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    }
    const btnPrimary = { ...btnBase, borderColor: T.brand, background: T.brand, color: '#fff' }
    const inputStyle = {
      padding: '5px 9px',
      border: `1px solid ${T.border}`,
      borderRadius: 6,
      background: T.layer1,
      color: T.label,
      fontSize: 13,
      outline: 'none',
      width: '100%',
      boxSizing: 'border-box',
    }
    const cardStyle = {
      border: `1px solid ${T.border}`,
      borderRadius: 8,
      padding: '10px 12px',
      background: T.bg,
      marginBottom: 10,
    }
    const hdStyle = { fontSize: 13, fontWeight: 600, color: T.label, marginBottom: 6 }
    const rowStyle = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }
    const mutedStyle = { fontSize: 12, color: T.secondary, lineHeight: '18px' }
    const errBoxStyle = {
      border: `1px solid ${T.err}`,
      borderRadius: 8,
      padding: '8px 10px',
      marginBottom: 10,
      fontSize: 12.5,
      color: T.err,
      background: 'transparent',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
    }
    const noticeBoxStyle = { ...errBoxStyle, borderColor: T.ok, color: T.ok }

    // =========================================================================
    // 面板
    // =========================================================================

    /** 「手机远程」设置区。 */
    function PhoneRemoteSection() {
      const [status, setStatus] = useState(null)
      const [urlInfo, setUrlInfo] = useState(null)
      const [config, setConfig] = useState(null)
      const [error, setError] = useState(null)
      const [notice, setNotice] = useState(null)
      const [busy, setBusy] = useState(null)
      const [dirInput, setDirInput] = useState('')
      const [portInput, setPortInput] = useState('')

      /**
       * 刷新「状态 + 访问地址」。
       * 每一步各自 try/catch：一个接口挂了不影响另一个，错误写到界面上。
       */
      async function refreshLive() {
        try {
          const s = await callApi('/status')
          setStatus(s)
        } catch (e) {
          setError(`读取运行状态失败：${msgOf(e)}`)
        }
        try {
          const u = await callApi('/url')
          setUrlInfo(u)
        } catch (e) {
          setError(`读取手机访问地址失败：${msgOf(e)}`)
        }
      }

      /** 读配置（只在挂载时和保存配置后调用，避免和输入框抢焦点）。 */
      async function refreshConfig() {
        try {
          const c = await callApi('/config')
          setConfig(c.config ?? null)
          setDirInput(String(c.config?.projectDir ?? ''))
          setPortInput(String(c.config?.port ?? ''))
        } catch (e) {
          setError(`读取配置失败：${msgOf(e)}`)
        }
      }

      // 挂载：全量拉一次 + 每 3 秒轮询状态；卸载清掉定时器。
      useEffect(() => {
        let cancelled = false

        async function boot() {
          await refreshConfig()
          if (cancelled) return
          await refreshLive()
        }
        boot()

        const timer = setInterval(() => {
          if (cancelled) return
          refreshLive()
        }, POLL_MS)

        return () => {
          cancelled = true
          clearInterval(timer)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      /** 包一层：执行动作 → 立刻刷新状态；任何异常都落到界面上。 */
      async function runAction(name, label, fn, doneText) {
        setBusy(name)
        setError(null)
        setNotice(null)
        try {
          await fn()
          setNotice(doneText ?? `${label}完成`)
          await refreshLive()
        } catch (e) {
          setError(`${label}失败：${msgOf(e)}`)
        } finally {
          setBusy(null)
        }
      }

      const startBtn = h(
        'button',
        {
          key: 'start',
          type: 'button',
          style: busy ? { ...btnPrimary, opacity: 0.6 } : btnPrimary,
          disabled: !!busy,
          onClick: () =>
            runAction('start', '启动服务', () => post('/start'), '已发起启动，稍等几秒服务就起来了'),
        },
        busy === 'start' ? '启动中…' : '启动服务',
      )

      const restartBtn = h(
        'button',
        {
          key: 'restart',
          type: 'button',
          style: busy ? { ...btnBase, opacity: 0.6 } : btnBase,
          disabled: !!busy,
          onClick: () => runAction('restart', '重启服务', () => post('/restart'), '已发起重启'),
        },
        busy === 'restart' ? '重启中…' : '重启服务',
      )

      const stopBtn = h(
        'button',
        {
          key: 'stop',
          type: 'button',
          style: busy ? { ...btnBase, opacity: 0.6 } : btnBase,
          disabled: !!busy,
          onClick: () => runAction('stop', '停止服务', () => post('/stop'), '服务已停止'),
        },
        busy === 'stop' ? '停止中…' : '停止服务',
      )

      const refreshBtn = h(
        'button',
        {
          key: 'refresh',
          type: 'button',
          style: busy ? { ...btnBase, opacity: 0.6 } : btnBase,
          disabled: !!busy,
          onClick: () => runAction('refresh', '刷新', async () => { await refreshConfig(); await refreshLive() }, '已刷新'),
        },
        '刷新',
      )

      const saveBtn = h(
        'button',
        {
          key: 'save',
          type: 'button',
          style: busy ? { ...btnPrimary, opacity: 0.6 } : btnPrimary,
          disabled: !!busy,
          onClick: () =>
            runAction(
              'config',
              '保存配置',
              async () => {
                const port = Number(String(portInput).trim()) || 3099
                const r = await post('/config', {
                  projectDir: String(dirInput).trim(),
                  port,
                  autoStart: !!config?.autoStart,
                })
                // 以服务端返回的最新配置为准回填输入框
                setConfig(r.config ?? null)
                setDirInput(String(r.config?.projectDir ?? ''))
                setPortInput(String(r.config?.port ?? ''))
              },
              '配置已保存',
            ),
        },
        busy === 'config' ? '保存中…' : '保存配置',
      )

      const diagBtn = h(
        'button',
        {
          key: 'diag',
          type: 'button',
          style: busy ? { ...btnBase, opacity: 0.6 } : btnBase,
          disabled: !!busy,
          onClick: () =>
            runAction(
              'diag',
              '复制诊断信息',
              async () => {
                const d = await callApi('/diagnose')
                const text = String(d.text ?? '')
                let copied = false
                try {
                  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
                    await navigator.clipboard.writeText(text)
                    copied = true
                  }
                } catch {
                  copied = false
                }
                if (!copied) {
                  // 剪贴板不可用（非安全上下文 / 权限被拒）：退化成手选复制
                  try {
                    window.prompt('复制失败，请手动全选复制：', text)
                  } catch {
                    /* prompt 也被禁用时忽略，正文已经没法更优雅地给出了 */
                  }
                }
              },
              '诊断信息已复制，粘贴给 AI 即可',
            ),
        },
        busy === 'diag' ? '处理中…' : '复制诊断信息',
      )

      // ---------- 二维码 ----------
      let qrSvg = null
      let qrError = null
      const qrText = urlInfo ? String(urlInfo.qrData || urlInfo.url || '') : ''
      if (urlInfo && urlInfo.hasToken && qrText) {
        try {
          qrSvg = renderQrCached(qrText, 220)
        } catch (e) {
          qrError = `二维码生成失败：${msgOf(e)}`
        }
      }

      return h(
        'div',
        { style: { fontSize: 13, lineHeight: '20px', color: T.label, maxWidth: 640 } },

        h(
          'div',
          { key: 'hd', style: { marginBottom: 10 } },
          h('div', { style: { fontSize: 15, fontWeight: 600, marginBottom: 3 } }, '手机远程'),
          h(
            'div',
            { style: mutedStyle },
            '在手机上跟你电脑里的 AI 对话，顺便遥控这台电脑：推送 / 传文件 / 位置。数据全留在本机。',
          ),
        ),

        error ? h('div', { key: 'err', style: errBoxStyle }, h('div', { style: { fontWeight: 600 } }, '出错了'), error) : null,
        notice ? h('div', { key: 'ntc', style: noticeBoxStyle }, notice) : null,

        // ---- 运行状态 ----
        h(
          'div',
          { key: 'status', style: cardStyle },
          h('div', { style: hdStyle }, '运行状态'),
          !status
            ? h('div', { style: mutedStyle }, '正在读取状态…')
            : h(
                'div',
                null,
                h(
                  'div',
                  { style: { fontWeight: 600, color: status.running ? T.ok : T.warn } },
                  status.running ? '服务运行中' : '服务未运行',
                ),
                h('div', { style: mutedStyle }, `项目目录：${status.projectDir || '（未配置）'}`),
                h('div', { style: mutedStyle }, `端口：${status.port ?? '—'}`),
                status.running && status.pid
                  ? h(
                      'div',
                      { style: mutedStyle },
                      `进程 PID：${status.pid}（${status.managed ? '本插件管理' : '外部启动'}）`,
                    )
                  : null,
                status.running && status.uptimeMs
                  ? h('div', { style: mutedStyle }, `已运行：${fmtDuration(status.uptimeMs)}`)
                  : null,
              ),
          h(
            'div',
            { style: { ...rowStyle, marginTop: 10 } },
            ...(status && status.running ? [restartBtn, stopBtn] : [startBtn]),
            refreshBtn,
          ),
        ),

        // ---- 手机访问地址 + 二维码 ----
        h(
          'div',
          { key: 'url', style: cardStyle },
          h('div', { style: hdStyle }, '手机访问地址'),
          !urlInfo
            ? h('div', { style: mutedStyle }, '正在读取地址…')
            : h(
                'div',
                null,
                h(
                  'div',
                  {
                    style: {
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      fontSize: 12.5,
                      wordBreak: 'break-all',
                      marginBottom: 8,
                    },
                  },
                  urlInfo.url || '（暂不可用）',
                ),
                urlInfo.hasToken
                  ? h(
                      'div',
                      null,
                      qrError
                        ? h('div', { style: { ...mutedStyle, color: T.err } }, qrError)
                        : h('div', {
                            // 本地生成的 SVG，直接内联；不联网、不外发地址与 token
                            style: {
                              width: 220,
                              height: 220,
                              background: '#ffffff',
                              padding: 4,
                              borderRadius: 8,
                              boxSizing: 'content-box',
                              display: 'inline-block',
                            },
                            dangerouslySetInnerHTML: { __html: qrSvg || '' },
                          }),
                      h('div', { style: { ...mutedStyle, marginTop: 6 } }, '用手机相机 / 扫一扫直接扫这个码即可打开。'),
                    )
                  : h(
                      'div',
                      { style: { ...mutedStyle, color: T.warn } },
                      '先启动一次服务生成 token，之后这里会显示二维码。',
                    ),
                h(
                  'div',
                  { style: { ...mutedStyle, marginTop: 6 } },
                  `主机：${urlInfo.host ?? '—'}　端口：${urlInfo.port ?? '—'}　token：${urlInfo.hasToken ? '已生成' : '未生成'}`,
                ),
              ),
        ),

        // ---- 配置 ----
        h(
          'div',
          { key: 'config', style: cardStyle },
          h('div', { style: hdStyle }, '配置'),
          h('div', { style: { ...mutedStyle, marginBottom: 4 } }, '项目目录'),
          h('input', {
            key: 'dir',
            type: 'text',
            value: dirInput,
            placeholder: 'dsh-access-phone-remote 项目目录，例如 D:\\dsj-open',
            spellCheck: false,
            style: { ...inputStyle, marginBottom: 8 },
            onChange: (ev) => setDirInput(ev.target.value),
          }),
          h('div', { style: { ...mutedStyle, marginBottom: 4 } }, '端口'),
          h('input', {
            key: 'port',
            type: 'text',
            inputMode: 'numeric',
            value: portInput,
            placeholder: '端口（默认 3099）',
            spellCheck: false,
            style: { ...inputStyle, marginBottom: 8, maxWidth: 200 },
            onChange: (ev) => setPortInput(ev.target.value),
          }),
          h('div', { style: rowStyle }, saveBtn),
        ),

        // ---- 诊断 ----
        h(
          'div',
          { key: 'diag', style: cardStyle },
          h('div', { style: hdStyle }, '出问题的时候'),
          h('div', { style: { ...mutedStyle, marginBottom: 8 } }, '把诊断信息复制出来，粘给 AI 助手看。'),
          h('div', { style: rowStyle }, diagBtn),
        ),
      )
    }

    /** 渲染兜底：把「一片空白」变成看得见的错误 + 重试按钮。 */
    class SectionErrorBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error }
      }
      componentDidCatch(error) {
        console.error('[dsh-access-phone-remote] 设置页渲染失败:', error)
      }
      render() {
        if (this.state.error !== null) {
          return h(
            'div',
            { style: { fontSize: 13, color: T.err, lineHeight: '20px', padding: '12px 0' } },
            [
              h('div', { key: 't', style: { fontWeight: 600 } }, '「手机远程」页渲染失败'),
              h('div', { key: 'm', style: { color: T.secondary } }, String(this.state.error?.message ?? this.state.error)),
              h(
                'button',
                {
                  key: 'r',
                  type: 'button',
                  style: { ...btnBase, marginTop: 8 },
                  onClick: () => this.setState({ error: null }),
                },
                '重试',
              ),
            ],
          )
        }
        return this.props.children
      }
    }

    /** 注册进 settings.section 的组件（外面套一层错误边界）。 */
    function AccessPhoneRemoteSection() {
      return h(SectionErrorBoundary, null, h(PhoneRemoteSection, null))
    }

    // ---------- 注册 ----------
    function apply(ctx) {
      try {
        ctx.effect(() =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: PLUGIN_ID, order: 30, label: () => '手机远程' },
              AccessPhoneRemoteSection,
            ),
          ),
        )
      } catch (e) {
        // 注册失败也不要把宿主设置页带崩：只留一条日志。
        console.error('[dsh-access-phone-remote] 设置页注册失败:', e)
      }
    }

    exports.apply = apply
    exports.inject = ['slots']
    exports.PhoneRemoteSection = PhoneRemoteSection
    exports.AccessPhoneRemoteSection = AccessPhoneRemoteSection
    return module.exports
  },
})
