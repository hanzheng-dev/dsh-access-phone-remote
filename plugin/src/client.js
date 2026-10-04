/**
 * dsj-open — dsh 插件（Client half）
 *
 * 作用：在 dsh 设置页里给 dsj-open 一个管理界面。
 *
 * 设计原则：
 *   · 不用 React（降低依赖，避免版本冲突）
 *   · 用一个自包含的 DOM 面板
 *   · 所有数据走 /api/dsj-open/* 接口
 *
 * 如果 dsh 的客户端插件 API 需要特定导出，这里按最小假设写：
 *   apply(ctx) —— 和 host half 同签名
 */

export const name = 'dsj-open'

/** 声明依赖客户端服务（如果有）。放空数组最安全。 */
export const inject = []

// ---------- 工具 ----------
const PREFIX = '/api/dsj-open'

async function api(path, opts = {}) {
  const r = await fetch(PREFIX + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'x-dsh-plugin': 'dsj-open',
      ...(opts.headers || {}),
    },
  })
  return r.json()
}

function el(tag, props = {}, children = []) {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k === 'style' && typeof v === 'object') Object.assign(n.style, v)
    else if (k === 'onclick') n.onclick = v
    else if (k === 'text') n.textContent = v
    else n.setAttribute(k, v)
  }
  for (const c of [].concat(children)) {
    n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
  }
  return n
}

// ---------- 面板 ----------
function buildPanel() {
  const box = el('div', {
    style: {
      font: '13px/1.6 system-ui, sans-serif',
      padding: '14px',
      maxWidth: '560px',
    },
  })

  const title = el('div', {
    text: 'dsj-open',
    style: { fontWeight: '600', fontSize: '15px', marginBottom: '4px' },
  })
  const sub = el('div', {
    text: '把手机变成你电脑的遥控器（推送 / 文件 / 位置）',
    style: { color: '#888', marginBottom: '14px', fontSize: '12px' },
  })

  // 状态区
  const statusBox = el('div', {
    style: {
      padding: '10px 12px',
      borderRadius: '8px',
      background: '#f5f5f5',
      marginBottom: '12px',
      fontSize: '12.5px',
    },
  })

  // 地址区
  const urlBox = el('div', {
    style: {
      padding: '10px 12px',
      borderRadius: '8px',
      background: '#eef6ff',
      marginBottom: '12px',
      wordBreak: 'break-all',
      fontSize: '12.5px',
    },
  })

  // 按钮区
  const btnRow = el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } })

  function btn(label, fn, primary) {
    const b = el('button', {
      text: label,
      style: {
        padding: '7px 14px',
        borderRadius: '7px',
        border: '1px solid #ccc',
        background: primary ? '#3a382f' : '#fff',
        color: primary ? '#fff' : '#333',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '12.5px',
      },
    })
    b.onclick = async () => {
      b.disabled = true
      b.textContent = '…'
      try {
        await fn()
      } catch (e) {
        alert('出错：' + e.message)
      }
      b.disabled = false
      b.textContent = label
      await refresh()
    }
    return b
  }

  // 配置区
  const cfgBox = el('div', { style: { marginTop: '14px' } })
  const cfgTitle = el('div', {
    text: '配置',
    style: { fontWeight: '600', marginBottom: '8px', fontSize: '13px' },
  })

  const dirInput = el('input', {
    type: 'text',
    placeholder: 'dsj-open 项目目录，例如 D:\\dsj-open',
    style: {
      width: '100%',
      padding: '8px 10px',
      borderRadius: '7px',
      border: '1px solid #ccc',
      font: 'inherit',
      fontSize: '12.5px',
      marginBottom: '8px',
      boxSizing: 'border-box',
    },
  })
  const portInput = el('input', {
    type: 'text',
    placeholder: '端口（默认 3099）',
    style: {
      width: '100%',
      padding: '8px 10px',
      borderRadius: '7px',
      border: '1px solid #ccc',
      font: 'inherit',
      fontSize: '12.5px',
      marginBottom: '8px',
      boxSizing: 'border-box',
    },
  })

  const saveCfg = btn('保存配置', async () => {
    await api('/config', {
      method: 'POST',
      body: JSON.stringify({
        projectDir: dirInput.value.trim(),
        port: Number(portInput.value.trim()) || 3099,
      }),
    })
  })

  // 诊断区
  const diagBtn = btn('复制诊断信息（给 AI）', async () => {
    const d = await api('/diagnose')
    try {
      await navigator.clipboard.writeText(d.text)
      alert('已复制。粘贴给你的 AI 助手即可。')
    } catch {
      alert('复制失败，手动选吧：\n\n' + d.text)
    }
  })

  cfgBox.appendChild(cfgTitle)
  cfgBox.appendChild(dirInput)
  cfgBox.appendChild(portInput)
  cfgBox.appendChild(saveCfg)

  box.appendChild(title)
  box.appendChild(sub)
  box.appendChild(statusBox)
  box.appendChild(urlBox)
  box.appendChild(btnRow)
  box.appendChild(cfgBox)
  box.appendChild(el('div', { style: { marginTop: '12px' } }, [diagBtn]))

  // ---------- 刷新 ----------
  async function refresh() {
    // 配置
    const c = await api('/config')
    if (c.ok) {
      if (document.activeElement !== dirInput) dirInput.value = c.config.projectDir || ''
      if (document.activeElement !== portInput) portInput.value = c.config.port || 3099
    }

    // 状态
    const s = await api('/status')
    if (s.ok) {
      statusBox.innerHTML = ''
      statusBox.appendChild(
        el('div', {
          text: s.running ? '✅ 服务运行中' : '⭕ 服务未运行',
          style: { fontWeight: '600', marginBottom: '4px' },
        }),
      )
      if (s.projectDir) {
        statusBox.appendChild(el('div', { text: '目录：' + s.projectDir, style: { color: '#666', fontSize: '11.5px' } }))
      }
      statusBox.appendChild(el('div', { text: '端口：' + s.port, style: { color: '#666', fontSize: '11.5px' } }))

      // 按钮
      btnRow.innerHTML = ''
      if (!s.running) {
        btnRow.appendChild(btn('启动服务', async () => { await api('/start', { method: 'POST' }) }, true))
      } else {
        btnRow.appendChild(btn('重启服务', async () => { await api('/restart', { method: 'POST' }) }))
        btnRow.appendChild(btn('停止服务', async () => { await api('/stop', { method: 'POST' }) }))
      }
    }

    // 地址
    const u = await api('/url')
    if (u.ok) {
      urlBox.innerHTML = ''
      urlBox.appendChild(el('div', { text: '手机访问地址：', style: { color: '#666', fontSize: '11.5px', marginBottom: '4px' } }))
      urlBox.appendChild(el('div', { text: u.url, style: { fontFamily: 'monospace', fontWeight: '600' } }))
      if (!u.hasToken) {
        urlBox.appendChild(el('div', { text: '（还没生成 token，先启动一次服务）', style: { color: '#a66', fontSize: '11.5px', marginTop: '4px' } }))
      }
    }
  }

  refresh().catch(() => {})
  return box
}

// ---------- 插件入口 ----------
export function apply(ctx) {
  // 尝试注册到设置页（不同 dsh 版本 API 可能不同，做能力探测）
  const settings = ctx.settings || ctx.settingsService
  if (settings && typeof settings.registerPanel === 'function') {
    settings.registerPanel({
      id: 'dsj-open',
      title: 'dsj-open',
      render: () => buildPanel(),
    })
    return
  }

  // 没有设置页 API 时，挂到 window 上以便手动检查
  if (typeof window !== 'undefined') {
    window.__dsjOpenPanel = buildPanel
  }
}
