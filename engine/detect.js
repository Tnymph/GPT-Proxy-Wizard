'use strict';
/**
 * 安装探测（只读）：调用 engine\tools\detect-apps.ps1，得到
 *   - Clash Verge / Roxy 的候选安装路径（注册表卸载项 / 运行中进程 / 标准目录 / 各盘根目录）
 *   - ChatGPT 桌面端包信息（包族名、AUMID）
 *   - 数据目录位置
 * 并支持"自动回填"：配置里为空时用探测结果填（内存态，不写配置文件）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { ps } = require('./lib/exec');

async function detectAll() {
  const out = path.join(os.tmpdir(), `gptwiz-detect-${crypto.randomBytes(4).toString('hex')}.json`);
  const r = await ps('detect-apps.ps1', ['-OutFile', out], { timeoutMs: 90000 });
  if (r.code !== 0) throw new Error(`detect-apps.ps1 执行失败：${(r.stderr || r.stdout || '').trim()}`);
  try {
    return JSON.parse(fs.readFileSync(out, 'utf8'));
  } finally {
    try { fs.unlinkSync(out); } catch { /* 忽略 */ }
  }
}

function fileExists(p) {
  try { return Boolean(p) && fs.statSync(p).isFile(); } catch { return false; }
}

function isDir(p) {
  try { return Boolean(p) && fs.statSync(p).isDirectory(); } catch { return false; }
}

/** 目录里是否有 Roxy 的窗口子目录（32 位 hex） */
function hasWindowDir(dir) {
  try {
    return fs.readdirSync(dir).some((name) => /^[0-9a-f]{32}$/.test(name));
  } catch {
    return false;
  }
}

/**
 * 探测 Roxy 的"浏览器缓存根目录"：Roxy 允许在设置里把缓存改到别的盘（例如 E:\BrowserCache），
 * 这里按常见位置做一轮有界扫描，返回"确实含窗口子目录"的目录列表。
 */
function probeRoxyCacheRoots() {
  const appdata = process.env.APPDATA || '';
  const candidates = [];
  if (appdata) candidates.push(path.join(appdata, 'RoxyBrowser', 'browser-cache'));

  const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  for (const letter of letters) {
    const root = `${letter}:\\`;
    if (!isDir(root)) continue;
    for (const name of ['BrowserCache', 'browser-cache', 'RoxyBrowserCache']) {
      candidates.push(path.join(root, name));
    }
    for (const app of ['RoxyBrowser', 'RoxyBrowserData', 'Roxy']) {
      for (const name of ['browser-cache', 'BrowserCache']) {
        candidates.push(path.join(root, app, name));
      }
    }
    // 再下探一层：<盘>:\<某个文件夹>\BrowserCache（用户自定义到子目录里的情况）
    let tops = [];
    try {
      tops = fs.readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .slice(0, 60)
        .map((d) => d.name);
    } catch { tops = []; }
    for (const name of tops) {
      candidates.push(path.join(root, name, 'BrowserCache'));
      candidates.push(path.join(root, name, 'browser-cache'));
    }
  }

  const found = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (isDir(candidate) && hasWindowDir(candidate)) found.push(candidate);
  }
  return found;
}

/**
 * 若现有候选缓存根里找不到"配置中的窗口"（常见于用户把 Roxy 缓存改到别的盘，旧目录里只剩过期窗口），
 * 自动探测常见位置并补进 browserCacheDirsExtra（内存态）。
 * @returns {string[]} 本次新补上的目录
 */
function ensureRoxyCacheRoots() {
  const roxynet = require('./lib/roxynet');
  const name = config.roxy.windowName;
  const existingIds = roxynet.listWindowDirs();
  const satisfied = name ? Boolean(roxynet.findDirIdByWindowName(name)) : existingIds.length > 0;
  if (satisfied) return [];   // 现有配置已够用，不做扫描
  const known = [config.roxy.browserCacheDir, ...(config.roxy.browserCacheDirsExtra || [])]
    .map((p) => String(p || '').toLowerCase());
  const added = [];
  for (const root of probeRoxyCacheRoots()) {
    if (known.includes(root.toLowerCase())) continue;
    added.push(root);
  }
  if (added.length) {
    if (!Array.isArray(config.roxy.browserCacheDirsExtra)) config.roxy.browserCacheDirsExtra = [];
    for (const root of added) config.roxy.browserCacheDirsExtra.push(root);
  }
  return added;
}

/**
 * 自动回填运行期配置（仅在配置项为空或路径失效时使用探测结果；内存态，不写配置文件）。
 * @param {{full?: boolean}} opts full=true 时即使路径都有效也强制探测（detect 命令用）
 * @returns {{ clash: {appExe, source}, roxy: {appExe, source}, chatgpt: {aumid, familyName, source}, notes: string[] }}
 */
async function autoFill(opts = {}) {
  // Roxy 缓存根目录：只在"现有候选里找不到配置的窗口"时自动探测补全（内存态）
  const addedRoots = ensureRoxyCacheRoots();
  const clashOk = fileExists(config.clash.appExe);
  const roxyOk = !require('./lib/outlet').usesRoxy() || fileExists(config.roxy.appExe);
  if (clashOk && roxyOk && !opts.full) {
    const notes = addedRoots.length ? [`已自动识别 Roxy 缓存目录：${addedRoots.join('；')}`] : [];
    return {
      clash: { appExe: config.clash.appExe, source: 'config' },
      roxy: { appExe: config.roxy.appExe, source: 'config' },
      chatgpt: { aumid: config.chatgpt.aumid, familyName: config.chatgpt.packageFamily, source: 'config' },
      notes,
    };
  }
  const info = await detectAll();
  const summary = { clash: { appExe: config.clash.appExe, source: 'config' }, roxy: { appExe: config.roxy.appExe, source: 'config' }, chatgpt: { aumid: config.chatgpt.aumid, familyName: config.chatgpt.packageFamily, source: 'config' }, notes: [] };

  if (!fileExists(config.clash.appExe)) {
    if (config.clash.appExe) summary.notes.push(`配置里的 Clash Verge 路径无效：${config.clash.appExe}`);
    const best = info.clash && info.clash.best;
    if (best) {
      config.clash.appExe = best;
      summary.clash = { appExe: best, source: 'detect' };
    } else {
      config.clash.appExe = '';
      summary.clash = { appExe: '', source: 'none' };
      summary.notes.push('未在本机找到 Clash Verge（可稍后在设置里手动指定安装文件夹）');
    }
  }

  if (!fileExists(config.roxy.appExe)) {
    if (config.roxy.appExe) summary.notes.push(`配置里的 Roxy 路径无效：${config.roxy.appExe}`);
    const best = info.roxy && info.roxy.best;
    if (best) {
      config.roxy.appExe = best;
      summary.roxy = { appExe: best, source: 'detect' };
    } else {
      config.roxy.appExe = '';
      summary.roxy = { appExe: '', source: 'none' };
    }
  }

  const pkg = info.chatgpt && Array.isArray(info.chatgpt.packages) ? info.chatgpt.packages[0] : null;
  if (pkg && pkg.aumid) {
    if (config.chatgpt.aumid !== pkg.aumid || config.chatgpt.packageFamily !== pkg.familyName) {
      config.chatgpt.aumid = pkg.aumid;
      config.chatgpt.packageFamily = pkg.familyName;
      config.chatgpt.startupTaskRegKey =
        'HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\SystemAppData\\'
        + pkg.familyName + '\\App';
      summary.chatgpt = { aumid: pkg.aumid, familyName: pkg.familyName, source: 'detect' };
    }
  } else {
    summary.notes.push('未检测到 ChatGPT 桌面端（Microsoft Store 包），请在向导第 3 步安装');
  }

  if (addedRoots.length) {
    summary.notes.push(`已自动识别 Roxy 缓存目录：${addedRoots.join('；')}`);
  } else if (require('./lib/outlet').usesRoxy() && config.roxy.windowName
      && !require('./lib/roxynet').findDirIdByWindowName(config.roxy.windowName)) {
    summary.notes.push('本机数据里找不到配置的 Roxy 窗口：若你在 Roxy 设置里改过「浏览器缓存目录」，请在「设置 → Roxy 缓存根目录」里填写新位置');
  }

  summary.raw = info;
  return summary;
}

module.exports = { detectAll, autoFill, fileExists, probeRoxyCacheRoots, ensureRoxyCacheRoots };
