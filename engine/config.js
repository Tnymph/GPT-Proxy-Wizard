'use strict';
/**
 * 配置中心：内置默认值（**不含任何私密值**）+ 用户 JSON 配置深度合并。
 *
 * 加载顺序（后者覆盖前者）：
 *   1. 本文件的 baseConfig（公开、可安全提交/分发）
 *   2. 用户配置文件（默认 %APPDATA%\GPTProxyWizard\config.json，由界面向导采集写入；
 *      可用环境变量 GPTWIZ_CONFIG 指向其它文件）
 *   3. 环境变量注入的敏感字段（GPTWIZ_STATIC_PASSWORD；GUI 层可据此让密码不落盘）
 *
 * 隐私约定（见仓库根 README 与 private\README.md）：
 *   - 代码/默认值/文档里只出现占位符（<...>）；
 *   - 真实私密值只存在于：a) 用户机器上的 config.json；b) 本仓库 private\ 目录（已 gitignore）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const PRODUCT_ID = 'GPTProxyWizard';
const PRODUCT_NAME = 'GPT Proxy Wizard';

const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const APP_DIR = process.env.GPTWIZ_HOME || path.join(APPDATA, PRODUCT_ID);
const CONFIG_PATH = process.env.GPTWIZ_CONFIG || path.join(APP_DIR, 'config.json');

const baseConfig = {
  PRODUCT_ID,
  PRODUCT_NAME,

  // .cmd / 启动器窗口标题（程序B 靠它识别"项目相关窗口"）
  WINDOW_TITLES: { start: 'GPT-Proxy-Start', stop: 'GPT-Proxy-Stop' },

  chatgpt: {
    // 为空 = 使用内置兜底（Microsoft Store 版 ChatGPT 桌面端）；探测到别的包时由向导写入
    aumid: '',
    aumidFallback: 'OpenAI.Codex_2p2nqsd0c76g0!App',
    packageFamily: 'OpenAI.Codex_2p2nqsd0c76g0',
    processNames: ['ChatGPT.exe', 'Codex.exe', 'codex.exe'],
    startupTaskStateEnabled: 2,           // 已启用（需关闭）
    startupTaskStateDisabledByUser: 1,    // 用户已禁用（目标状态）
  },

  clash: {
    appExe: '',                           // 空 = 自动探测（engine/detect.js）
    appProcess: 'clash-verge.exe',
    coreProcess: 'verge-mihomo.exe',
    serviceName: 'clash_verge_service',
    // 助手计划任务：停止/启动服务用；由"关闭全部"（提权）注册，日常启动免 UAC 触发
    serviceStartTask: 'GPTProxy-StartClashService',
    mixedPort: 7897,
    dataDir: '',                          // 空 = %APPDATA%\io.github.clash-verge-rev.clash-verge-rev
    pipePrefix: 'verge-mihomo-',
    // 自定义节点 / 代理组（ASCII 名称，避免编码问题）
    nodeName: 'GPT-US-Static',
    groupName: 'GPT-US',
    // 代理组策略：
    //   'select'   = 严格只用所选出口（静态 IP）：静态通道不通时宁可不可用
    //   'fallback' = 所选出口优先；健康检查暂时不通时回退到订阅美国节点（可用性优先）
    groupType: 'select',
    healthCheckUrl: 'https://www.gstatic.com/generate_204',
    healthCheckInterval: 60,
    tunAdapterName: 'Meta',
    // 订阅扩展槽位文件名（如 pYSK1srNIfYO.yaml）。为空 = 从 profiles.yaml 的
    // option.{proxies,rules,groups} 动态读取（推荐，不写死 uid）
    slots: { proxies: '', rules: '', groups: '' },
    // 强制走本通道的规则（顺序敏感：进程规则在前）
    rules: [
      'PROCESS-NAME,ChatGPT.exe,GPT-US',
      'PROCESS-NAME,Codex.exe,GPT-US',
      'PROCESS-NAME,codex.exe,GPT-US',
      'DOMAIN-SUFFIX,chatgpt.com,GPT-US',
      'DOMAIN-SUFFIX,openai.com,GPT-US',
      'DOMAIN-SUFFIX,oaistatic.com,GPT-US',
      'DOMAIN-SUFFIX,oaiusercontent.com,GPT-US',
      // 专用出口校验域名：经 Clash 走 GPT-US 组，返回的即是"当前生效路径"的出口 IP
      'DOMAIN-SUFFIX,ipinfo.io,GPT-US',
    ],
  },

  outlet: {
    mode: 'roxy',   // roxy（Roxy 指纹窗口 + 静态 IP）| static（自备 socks5/http 静态 IP）| subscription（订阅美国节点兜底）
    static: {
      type: 'socks5',                     // socks5 | http
      host: '', port: 0,
      username: '', password: '',
      expectedIp: '',                     // 可选：用于比对提示
    },
    subscription: {
      nodeMatcher: 'US|美国|United States',   // 匹配订阅里美国节点名的正则（不区分大小写）
      selectedNode: '',                       // 用户在向导里选定的节点名（模式 C 生效）
    },
  },

  roxy: {
    appExe: '',                           // 空 = 自动探测
    appProcess: 'RoxyBrowser.exe',
    chromeProcess: 'RoxyChrome.exe',
    roxynetProcess: 'roxynet.exe',
    windowName: '',                       // 指纹窗口名（界面采集）
    workspaceId: '',                      // Roxy 工作区 ID（界面采集）
    expectedStaticIp: '',                 // 预期美国静态 IP（仅比对提示）
    localHttpPort: 45535,                 // Roxy 本地服务（用于确认主程序已起）
    userDataDir: '',                      // 空 = %APPDATA%\RoxyBrowser
    browserCacheDir: '',                  // 空 = userDataDir\browser-cache
    // lumi.conf 解密参数（AES-256-GCM，硬编码于 Roxy 内核；仅用于解析窗口名 ↔ dirId）
    lumiKey: '402ead7d23b43b6d1e0528d4f99c59bd',
    lumiIv: '3a105229aa31',
    roxynetProbeTimeoutMs: 20000,
  },

  timeouts: {
    stepWaitMs: 60000,        // 等待"内核就绪"等关键状态的最长时间
    windowWaitMs: 90000,      // 等待 Roxy 窗口打开的较长时间
    appLaunchWaitMs: 60000,   // 等待 ChatGPT 进程出现
    pollIntervalMs: 1500,
    gracefulCloseSec: 6,
  },

  flags: {
    closeCodexProcesses: true,        // 程序B：是否同时关闭 Codex 相关进程
    guardChatGPTAutostart: true,      // 程序A：确保 ChatGPT 开机自启处于"用户禁用"
    deepVerifyEgress: true,           // 程序A：经规则路径实测出口 IP
    verifyUrl: 'https://ipinfo.io/json',
    staticIpProbeUrl: 'https://ipinfo.io/json',
  },

  ui: {
    maskSensitive: true,              // 日志/界面默认遮罩 IP、用户名等敏感值
    language: 'zh-CN',
  },
};

/* ---------- 合并工具 ---------- */

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, over) {
  if (!isPlainObject(over)) return base;
  const out = { ...base };
  for (const key of Object.keys(over)) {
    out[key] = isPlainObject(base[key]) && isPlainObject(over[key]) ? deepMerge(base[key], over[key]) : over[key];
  }
  return out;
}

function loadOverrides() {
  try {
    const text = fs.readFileSync(CONFIG_PATH, 'utf8');
    const data = JSON.parse(text);
    return isPlainObject(data) ? data : {};
  } catch (e) {
    if (e && e.code !== 'ENOENT') {
      process.stderr.write(`[config] 读取配置失败（将使用默认值）：${CONFIG_PATH}：${e.message}\n`);
    }
    return {};
  }
}

const config = deepMerge(baseConfig, loadOverrides());

/* ---------- 运行期派生（不允许被配置文件覆盖） ---------- */

config.APP_DIR = APP_DIR;
config.CONFIG_PATH = CONFIG_PATH;
config.STATE_DIR = path.join(APP_DIR, 'state');
config.IS_FIRST_RUN = !fs.existsSync(CONFIG_PATH);

// 数据目录：Clash Verge / Roxy 的标准位置（固定目录名，非私密）
if (!config.clash.dataDir) {
  config.clash.dataDir = path.join(APPDATA, 'io.github.clash-verge-rev.clash-verge-rev');
}
if (!config.roxy.userDataDir) config.roxy.userDataDir = path.join(APPDATA, 'RoxyBrowser');
if (!config.roxy.browserCacheDir) config.roxy.browserCacheDir = path.join(config.roxy.userDataDir, 'browser-cache');

// ChatGPT：AUMID 兜底 + 自启任务注册表键（随包族名派生）
config.chatgpt.aumid = config.chatgpt.aumid || config.chatgpt.aumidFallback;
config.chatgpt.startupTaskRegKey =
  'HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\SystemAppData\\'
  + config.chatgpt.packageFamily + '\\App';

// 敏感字段：允许环境变量注入（GUI 层加密存储时使用，避免密码落盘）
if (process.env.GPTWIZ_STATIC_PASSWORD) {
  config.outlet.static.password = process.env.GPTWIZ_STATIC_PASSWORD;
}

module.exports = config;
