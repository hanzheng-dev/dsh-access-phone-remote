// config.js —— 配置加载：config.json + 环境变量覆盖
//
// 加载顺序（后者覆盖前者）：
//   ① 内置 DEFAULTS
//   ② config.json（不存在则回退读 config.example.json，便于首次跑通）
//   ③ 环境变量：HUB_PORT / HUB_HOST / HUB_ROOT / HUB_TOKEN / AMAP_WEB_KEY
//
// 相对路径一律相对「本文件所在目录的上一级」（即项目根目录）解析。
//
// 鉴权 token：config.authToken 留空时，调用 ensureAuthToken() 会
//   ① 先读 <root>/.hub-token，② 没有就随机生成 24 字节 base64url 写进去。
//   （沿用生产版逻辑，避免把口令写进 config.json 进仓库。）

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(PROJECT_ROOT, 'config.json');
const EXAMPLE_FILE = path.join(PROJECT_ROOT, 'config.example.json');

const DEFAULTS = {
  port: 3099,
  listenHost: '0.0.0.0',
  root: '.',
  authToken: '',
  allowDirs: ['./data'],
  uploadsDir: './uploads',
  shotsDir: './shots',
  docsDir: './docs',
  amap: {
    webKey: '',
    jsKey: '',
    jsSecurityCode: '',
  },
  // 局域网自动发现（UDP 广播）—— 手机 App 在同一 WiFi 下自动找到本机
  discovery: {
    enabled: true,
    intervalMs: 3000,
  },
  // ⭐ 自定义动作：让用户不改代码就能加按钮（见 docs/FOR-AI-EXTEND.md）
  //   ⚠️ 默认关闭 —— 开启后配置里的命令会被执行，只在你自己的机器上用
  customActions: {
    enabled: false,
    list: [
      // 示例（删掉注释即可用；JSON 不支持注释，这里是文档）：
      // { "id": "lock_screen", "label": "锁屏", "group": "控制",
      //   "command": "rundll32.exe user32.dll,LockWorkStation",
      //   "desc": "锁定电脑屏幕" }
    ],
  },
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function load() {
  const usingExample = !fs.existsSync(CONFIG_FILE);
  const fileCfg = readJson(usingExample ? EXAMPLE_FILE : CONFIG_FILE) || {};
  const cfg = {
    ...DEFAULTS,
    ...fileCfg,
    amap: { ...DEFAULTS.amap, ...(fileCfg.amap || {}) },
  };

  // ---- 环境变量覆盖 ----
  if (process.env.HUB_PORT) cfg.port = Number(process.env.HUB_PORT);
  if (process.env.HUB_HOST) cfg.listenHost = process.env.HUB_HOST;
  if (process.env.HUB_ROOT) cfg.root = process.env.HUB_ROOT;
  if (process.env.HUB_TOKEN) cfg.authToken = process.env.HUB_TOKEN;
  if (process.env.AMAP_WEB_KEY) cfg.amap.webKey = process.env.AMAP_WEB_KEY;

  // ---- 路径解析 ----
  const absRoot = path.resolve(PROJECT_ROOT, cfg.root);
  cfg.projectRoot = PROJECT_ROOT;
  cfg.configFile = CONFIG_FILE;
  cfg.usingExample = usingExample;
  cfg.absRoot = absRoot;
  cfg.tokenFile = path.join(absRoot, '.hub-token');
  cfg.uploadsPath = path.resolve(absRoot, cfg.uploadsDir);
  cfg.shotsPath = path.resolve(absRoot, cfg.shotsDir);
  cfg.docsPath = path.resolve(absRoot, cfg.docsDir);
  cfg.allowDirPaths = (Array.isArray(cfg.allowDirs) ? cfg.allowDirs : []).map((d) =>
    path.resolve(absRoot, d)
  );

  return cfg;
}

const config = load();

/** 取鉴权 token：config 里有就用；否则读/生成 <root>/.hub-token。 */
function ensureAuthToken() {
  if (config.authToken) return config.authToken;
  let token = '';
  try {
    token = fs.readFileSync(config.tokenFile, 'utf8').trim();
  } catch (e) {
    token = '';
  }
  if (!token) {
    token = crypto.randomBytes(24).toString('base64url');
    try {
      fs.writeFileSync(config.tokenFile, token, 'utf8');
    } catch (e) {
      token = '';
    }
  }
  config.authToken = token;
  return token;
}

module.exports = { config, ensureAuthToken };

// 直接运行 `node src/config.js` 时打印加载结果，便于确认能读到配置。
if (require.main === module) {
  console.log('[dsj-open] 配置加载自:', config.usingExample ? 'config.example.json（未找到 config.json）' : 'config.json');
  console.log(JSON.stringify({
    port: config.port,
    listenHost: config.listenHost,
    root: config.absRoot,
    uploadsDir: config.uploadsPath,
    shotsDir: config.shotsPath,
    docsDir: config.docsPath,
    allowDirs: config.allowDirPaths,
    amap: { webKey: config.amap.webKey ? '***已配置***' : '', jsKey: config.amap.jsKey ? '***已配置***' : '' },
  }, null, 2));
}
