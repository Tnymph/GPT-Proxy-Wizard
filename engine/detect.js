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

/**
 * 自动回填运行期配置（仅在配置项为空或路径失效时使用探测结果；内存态，不写配置文件）。
 * @param {{full?: boolean}} opts full=true 时即使路径都有效也强制探测（detect 命令用）
 * @returns {{ clash: {appExe, source}, roxy: {appExe, source}, chatgpt: {aumid, familyName, source}, notes: string[] }}
 */
async function autoFill(opts = {}) {
  const clashOk = fileExists(config.clash.appExe);
  const roxyOk = !require('./lib/outlet').usesRoxy() || fileExists(config.roxy.appExe);
  if (clashOk && roxyOk && !opts.full) {
    return {
      clash: { appExe: config.clash.appExe, source: 'config' },
      roxy: { appExe: config.roxy.appExe, source: 'config' },
      chatgpt: { aumid: config.chatgpt.aumid, familyName: config.chatgpt.packageFamily, source: 'config' },
      notes: [],
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

  summary.raw = info;
  return summary;
}

module.exports = { detectAll, autoFill, fileExists };
