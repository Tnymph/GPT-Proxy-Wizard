'use strict';
/**
 * 打开指定软件（用配置/探测到的安装位置），并**等待它真的出现**——用于"路径配好后先检查一下"，
 * 或"正式启动前把某个软件先打开"。
 *
 * 用法：node app.js open clash|roxy|window|chatgpt [--wait <秒>]
 */
const config = require('./config');
const log = require('./lib/log');
const apps = require('./lib/apps');
const roxynet = require('./lib/roxynet');
const verify = require('./lib/verify');

const TARGETS = {
  clash: 'Clash Verge 主程序',
  roxy: 'Roxy Browser 主程序',
  window: 'Roxy 指纹窗口',
  chatgpt: 'ChatGPT 桌面端',
};

/**
 * 打开目标并核对它是否真的出现（只读核对，不修改任何设置）。
 * @returns {Promise<{ok: boolean, message: string, already?: boolean, appeared?: boolean, pid?: number}>}
 */
async function openTarget(target, { waitMs = 25000 } = {}) {
  if (!TARGETS[target]) {
    return { ok: false, message: `未知目标：${target}（可用：${Object.keys(TARGETS).join(' / ')}）` };
  }

  if (target === 'clash') {
    if (await apps.isClashAppRunning(true)) return { ok: true, already: true, message: 'Clash Verge 已在运行' };
    const r = await apps.launchClash();
    if (!r.ok) return { ok: false, message: `启动失败：${r.error}` };
    const appeared = await verify.waitFor('Clash Verge 进程', waitMs, () => apps.isClashAppRunning(true));
    return {
      ok: true,
      appeared: Boolean(appeared),
      pid: r.pid,
      message: appeared ? 'Clash Verge 已打开' : '已请求启动，但暂未检测到进程（请确认安装位置是否正确，或被安全软件拦截）',
    };
  }

  if (target === 'roxy') {
    if (await apps.isRoxyAppRunning(true)) return { ok: true, already: true, message: 'Roxy Browser 已在运行' };
    const r = await apps.launchRoxy();
    if (!r.ok) return { ok: false, message: `启动失败：${r.error}` };
    const appeared = await verify.waitFor('Roxy 进程', waitMs, () => apps.isRoxyAppRunning(true));
    return {
      ok: true,
      appeared: Boolean(appeared),
      pid: r.pid,
      message: appeared ? 'Roxy Browser 已打开' : '已请求启动，但暂未检测到进程（请确认安装位置是否正确）',
    };
  }

  if (target === 'window') {
    if (!config.roxy.windowName) return { ok: false, message: '尚未配置 Roxy 窗口名（向导第 2 步）' };
    let dirId = null;
    try { dirId = roxynet.findDirIdByWindowName(config.roxy.windowName); } catch { dirId = null; }
    if (!dirId) return { ok: false, message: `本机 Roxy 数据里找不到窗口「${config.roxy.windowName}」（请确认窗口名，或先在 Roxy 里创建窗口）` };
    const existing = await roxynet.findOpenWindow(dirId, config.roxy.windowName, true);
    if (existing) return { ok: true, already: true, message: '指纹窗口已打开' };
    if (!config.roxy.workspaceId) return { ok: false, message: '尚未配置 Roxy 工作区 ID（向导第 2 步）' };
    const r = await apps.openRoxyWindow(dirId);
    if (r.ok === false) return { ok: false, message: `打开窗口失败：${r.error}` };
    const win = await roxynet.waitForWindow(dirId, config.roxy.windowName, waitMs);
    return {
      ok: true,
      appeared: Boolean(win),
      message: win ? '指纹窗口已打开' : '已请求打开窗口，但暂未等到窗口出现（可稍后重试，或在 Roxy 界面里手动打开）',
    };
  }

  // chatgpt
  if (await apps.isChatGPTRunning(true)) return { ok: true, already: true, message: 'ChatGPT 已在运行' };
  try {
    await apps.launchChatGPT();
  } catch (e) {
    return { ok: false, message: `打开 ChatGPT 失败：${e && e.message ? e.message : e}` };
  }
  const appeared = await verify.waitFor('ChatGPT 进程', waitMs, () => apps.isChatGPTRunning(true));
  return {
    ok: true,
    appeared: Boolean(appeared),
    message: appeared ? 'ChatGPT 已打开' : '已请求打开 ChatGPT，但暂未检测到进程（应用可能仍在启动）',
  };
}

async function run(opts = {}) {
  const target = opts.target;
  const logFile = log.initLogFile('open');
  log.blank();
  log.plain('============================================================');
  log.plain(`  打开软件：${TARGETS[target] || target || '（未指定）'}`);
  log.plain(`  日志文件：${logFile}`);
  log.plain('============================================================');
  log.blank();

  const r = await openTarget(target, { waitMs: Math.max(5, Number(opts.waitSec) || 25) * 1000 });
  if (r.ok) log.ok(r.message);
  else log.err(r.message);
  log.blank();
  return r.ok ? 0 : 2;
}

module.exports = { run, openTarget, TARGETS };
