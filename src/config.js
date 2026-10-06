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

  // ⭐⭐ dsh 会话页 —— 在手机上跟电脑里的 AI 对话。
  //
  //   这是本项目的核心能力，但**默认关闭**：它要求你电脑上装并运行着
  //   DeepSeek Harness（dsh）。没装的用户打开页面不该看到一堆坏入口。
  //
  //   开启后，手机只是**中转**：模型、会话、推理、上下文全在电脑的 dsh 里，
  //   手机不跑模型、不存会话。链路：
  //     手机 → hub → 桥(每消息一个进程) → dsh 的 HTTP RPC / WebSocket → 原路回传
  dsh: {
    enabled: false,
    // dsh web 服务地址（它的 Web GUI 监听在哪）
    base: 'http://127.0.0.1:3080',
    // 鉴权 cookie 绑定的 authority —— 必须和 dsh 实际监听的 host:port 一致
    authority: '127.0.0.1:3080',
    // dsh 的数据目录（含 .credentials.yaml 与 sessions/）
    //   留空 = 自动探测：环境变量 DSH_HOME → 常见位置 → 扫含 .credentials.yaml 的目录
    home: '',
    // 会话的工作目录（新建会话时用）。留空 = dsh 自己的默认值
    cwd: '',
    // dsh web 的启动日志（换票兜底要从里面抓 ?token=）
    //   留空 = 在 home 附近自动找 *.log
    webLog: '',
    // ws 模块路径（逐字流要用）。
    //   留空 = 依次试：dsh 安装目录的 node_modules/ws → require('ws')；
    //   都失败则自动降级为「仅轮询」——功能照常，只是回复一次冒出来而不是逐字
    wsPath: '',
    // 新建共享会话时尝试选择的模型（照生产版默认）。
    //   ⚠️ 你的 dsh 没有这个 provider/model 时**只记一条日志**，继续用 dsh 当前模型（不阻断对话）
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    reasoningEffort: 'high',
    // 新建会话用的 agent 预设。留空 = 不传（开源用户不一定装了这个预设）
    agentPreset: '',
  },

  // ⭐ 可选功能开关 —— 默认全关，想要哪个开哪个。
  //   关掉的功能**连入口都不会出现**（前端按这张表决定显不显示）。
  //   这些原本是作者自用的东西，开源时保留代码但默认隐藏：
  //   别人的 dsh 环境不一定有对应依赖，摆一屏不能用的按钮不如不摆。
  features: {
    cost: false,        // 余额 / 花费统计
    effort: false,      // 思考档位（dsh 的模型档位）
    askUser: false,     // AI 提问 → 手机选择（dsh 的 ask_user_question）
    switches: false,    // 本机开关状态（屏幕 / 代理）
    op: false,          // 任务调度（作者自用的 op 体系）
    agents: false,      // 多 agent 状态与回传
    adb: false,         // 手机联机（adb 推拉文件）
    reminders: false,   // 定时提醒任务
    tavern: false,      // 网页中转（SillyTavern）
    hitchhike: false,   // 剪贴板「搭便车」注入
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
    // ⚠️ dsh 必须**深合并**：顶层是浅合并，用户 config.json 里只写 dsh 的一部分字段时，
    //    其余默认值（authority/home/webLog/wsPath…）会被整个顶掉变 undefined。
    dsh: { ...DEFAULTS.dsh, ...(fileCfg.dsh || {}) },
    // ⚠️ features 同理：用户只想开一个开关（如 { "features": { "effort": true } }）时，
    //    浅合并会把其余开关整个顶掉变 undefined —— 深合并后未写的仍是默认 false。
    features: { ...DEFAULTS.features, ...(fileCfg.features || {}) },
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
  console.log('[dsh-access-phone-remote] 配置加载自:', config.usingExample ? 'config.example.json（未找到 config.json）' : 'config.json');
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
