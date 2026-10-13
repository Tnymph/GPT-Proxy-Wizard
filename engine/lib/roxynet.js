'use strict';
/**
 * Roxy Browser / roxynet 探测（出口模式 A 专用）：
 * - 窗口名 ↔ dirId（从 RoxyChrome 命令行解析，或解密 browser-cache\<dirId>\lumi.conf）；
 * - roxynet 的"混合代理口"（动态端口，用 407+Proxy-Authenticate 特征识别）；
 * - 经 roxynet 验证美国静态 IP 出口。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const config = require('../config');
const netinfo = require('./netinfo');
const { curlGet, sleep } = require('./exec');

const R = config.roxy;

// 窗口主进程的两种形态（不同版本/启动方式）：
//   ① RoxyBrowser.exe --roxy-action launch-browser --dir-id <32hex> --workspace-id <n>   （本机实测）
//   ② --user-data-dir=...\browser-cache\<32hex>                                          （另一形态）
const RE_DIR_ID_CLI = /--dir-id[=\s]+([0-9a-f]{32})/i;
// 任意缓存根都要认（用户可能把 Roxy 的缓存目录改到别的盘，目录名不必含 browser-cache）
const RE_USER_DATA_DIR = /--user-data-dir="?([^"]*[\\/][0-9a-f]{32})"?/;

/** 全部候选缓存根目录（主目录 + 额外候选；去重、只保留真实存在的） */
function cacheRoots() {
  const list = [R.browserCacheDir, ...(Array.isArray(R.browserCacheDirsExtra) ? R.browserCacheDirsExtra : [])];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item) continue;
    const root = path.resolve(String(item));
    const key = root.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (fs.existsSync(root)) out.push(root);
  }
  return out;
}

/** 在全部候选根里找某个窗口的 lumi.conf */
function lumiPath(dirId) {
  for (const root of cacheRoots()) {
    const file = path.join(root, dirId, 'lumi.conf');
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/* ---------- lumi.conf 解密 ---------- */

function decryptLumi(dirId) {
  const file = lumiPath(dirId);
  if (!file) {
    throw new Error(`未找到窗口数据（dirId=${dirId}）：若你在 Roxy 设置里改过"浏览器缓存目录"，请在设置里把它填进"Roxy 缓存根目录"`);
  }
  const raw = fs.readFileSync(file, 'utf8').trim();
  const buf = Buffer.from(raw, 'base64');
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(0, buf.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(R.lumiKey, 'utf8'), Buffer.from(R.lumiIv, 'utf8'));
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  return JSON.parse(plain);
}

/** 全部候选根里的窗口目录（dirId 集合，跨根去重） */
function listWindowDirs() {
  const ids = new Set();
  for (const root of cacheRoots()) {
    let entries = [];
    try { entries = fs.readdirSync(root); } catch { continue; }
    for (const d of entries) if (/^[0-9a-f]{32}$/.test(d)) ids.add(d);
  }
  return [...ids];
}

/** 解密扫描：windowName → dirId（窗口未打开时也能用） */
function findDirIdByWindowName(windowName) {
  for (const dirId of listWindowDirs()) {
    try {
      const cfg = decryptLumi(dirId);
      if (cfg.windowName === windowName) return dirId;
    } catch { /* 单个目录解密失败不影响其它 */ }
  }
  return null;
}

/** 列出全部窗口名（供向导选择；不含任何密钥） */
function listWindowNames() {
  const names = [];
  for (const dirId of listWindowDirs()) {
    try {
      const cfg = decryptLumi(dirId);
      if (cfg.windowName) names.push({ dirId, windowName: cfg.windowName });
    } catch { /* 忽略无法解密的目录 */ }
  }
  return names;
}

/* ---------- 打开中的窗口 ---------- */

/**
 * 列出当前打开的 Roxy 窗口进程（含由命令行解析出的 dirId）。
 * 同时识别两种主进程形态（chromeProcess / appProcess），并排除 --type= 子进程。
 */
async function listOpenWindows(force = false) {
  const images = [R.chromeProcess, R.appProcess].filter(Boolean);
  const procs = await netinfo.findProcesses(images, force);
  const windows = [];
  for (const p of procs) {
    const cmd = String(p.Cmd || '');
    if (cmd.includes('--type=')) continue; // 只认浏览器主进程（排除 renderer/gpu/utility 子进程）
    let dirId = null;
    const mCli = cmd.match(RE_DIR_ID_CLI);
    if (mCli) dirId = mCli[1].toLowerCase();
    if (!dirId) {
      const mDir = cmd.match(RE_USER_DATA_DIR);
      if (mDir) dirId = path.basename(mDir[1]).toLowerCase();
    }
    if (!dirId) continue;
    windows.push({ dirId, pid: p.Id, title: p.Title || '', image: p.Name });
  }
  return windows;
}

/** 查指定窗口是否已打开：优先按 dirId 匹配（标题可能被页面改写，不可靠） */
async function findOpenWindow(dirId, windowName, force = false) {
  const windows = await listOpenWindows(force);
  const byDir = windows.find((w) => w.dirId === dirId);
  if (byDir) return byDir;
  if (windowName) return windows.find((w) => w.title === windowName) || null;
  return null;
}

/** 等待窗口出现（最多 timeoutMs） */
async function waitForWindow(dirId, windowName, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const win = await findOpenWindow(dirId, windowName, true);
    if (win) return win;
    await sleep(config.timeouts.pollIntervalMs);
  }
  return null;
}

/* ---------- roxynet 端口 ---------- */

async function roxynetPids(force = false) {
  const procs = await netinfo.findProcesses([R.roxynetProcess], force);
  return procs.map((p) => p.Id);
}

async function roxynetListenPorts(force = false) {
  const pids = await roxynetPids(force);
  const list = await netinfo.listeners(force);
  const ports = list.filter((l) => pids.includes(l.Pid)).map((l) => l.Port);
  return [...new Set(ports)];
}

/** 判断某端口是否为 roxynet 的混合代理口（未认证请求应答 407 + realm=roxynet） */
function probeIsProxyPort(port) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: 'http://example.com/', method: 'GET', headers: { Host: 'example.com' } },
      (res) => {
        const auth = String(res.headers['proxy-authenticate'] || '');
        res.resume();
        resolve(res.statusCode === 407 && /roxynet/i.test(auth));
      }
    );
    req.on('error', () => resolve(false));
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

async function findProxyPort() {
  const ports = await roxynetListenPorts(true);
  for (const port of ports) {
    if (await probeIsProxyPort(port)) return port;
  }
  return null;
}

/* ---------- 静态 IP 出口校验 ---------- */

/** 单次尝试：经 roxynet 通道请求 ipinfo */
async function tryStaticEgress(port, dirId) {
  const r = await curlGet(config.flags.staticIpProbeUrl, {
    proxy: `127.0.0.1:${port}`,
    basicAuth: [dirId, dirId],
    timeoutSec: Math.ceil(R.roxynetProbeTimeoutMs / 1000),
  });
  if (r.code !== 0 || !r.stdout) return null;
  try {
    const info = JSON.parse(r.stdout);
    return { ip: info.ip, country: info.country, city: info.city, org: info.org, region: info.region };
  } catch {
    return null;
  }
}

/** 经 roxynet 验证静态 IP 出口（带重试，网络抖动时重试 3 次） */
async function checkStaticEgress(port, dirId, attempts = 3) {
  for (let i = 0; i < attempts; i += 1) {
    const info = await tryStaticEgress(port, dirId);
    if (info) return info;
    if (i < attempts - 1) await sleep(3000);
  }
  return null;
}

module.exports = {
  decryptLumi,
  cacheRoots,
  lumiPath,
  listWindowDirs,
  listWindowNames,
  findDirIdByWindowName,
  listOpenWindows,
  findOpenWindow,
  waitForWindow,
  roxynetPids,
  roxynetListenPorts,
  findProxyPort,
  checkStaticEgress,
};
