'use strict';
/** 各个软件的启动 / 关闭 / 自启任务处理。 */
const config = require('../config');
const netinfo = require('./netinfo');
const log = require('./log');
const {
  activateStoreApp,
  taskkill,
  taskkillPid,
  schTasksRun,
  ps,
  sleep,
  regQuery,
  regAddDword,
  regAddQword,
  launchClashApp,
  launchRoxyWindow,
} = require('./exec');

const C = config.chatgpt;
const RE_STATE = /State\s+REG_DWORD\s+0x([0-9a-f]+)/i;
const RE_EXE_NAME = /^[A-Za-z0-9_.\-]+\.exe$/;

/* ---------- ChatGPT 桌面应用 ---------- */

async function isChatGPTRunning(force = false) {
  const procs = await netinfo.findProcesses(C.processNames, force);
  return procs.length > 0;
}

async function launchChatGPT() {
  return activateStoreApp(C.launchArg || `shell:AppsFolder\\${C.aumid}`);
}

/** 关闭 ChatGPT（可选连带 Codex 进程）：先温和关闭（有超时保护），再兜底强杀 */
async function closeChatGPT() {
  const names = config.flags.closeCodexProcesses ? C.processNames : ['ChatGPT.exe'];
  log.info('先尝试温和关闭（最多 60 秒）...');
  const graceful = await ps(
    'close-gracefully.ps1',
    ['-Names', names.join(','), '-WaitSeconds', String(config.timeouts.gracefulCloseSec)],
    { timeoutMs: 60000 }
  );
  if (graceful.timedOut) log.warn('温和关闭超时（已终止该步骤），直接强制结束');
  for (const name of names) {
    log.info(`强制结束 ${name} ...`);
    await taskkill(name, { force: true, tree: true });
  }
  return names;
}

/** 读取 ChatGPT 开机自启状态（只读）：{ state, ok, note } */
async function readChatGPTAutostartState() {
  const r = await regQuery(C.startupTaskRegKey, 'State');
  const m = String(r.stdout).match(RE_STATE);
  if (!m) return { state: null, ok: false, note: '未找到起始任务注册表项（应用可能未安装或从未启动）' };
  const state = parseInt(m[1], 16);
  return {
    state,
    ok: state === C.startupTaskStateDisabledByUser,
    enabled: state === C.startupTaskStateEnabled || state === 4,
    note: state === C.startupTaskStateDisabledByUser ? '用户已禁用（目标状态）' : `state=${state}`,
  };
}

/** 确保 ChatGPT 开机自启处于"用户禁用"（State=1）；若为启用（2/4）则关闭 */
async function ensureChatGPTAutostartDisabled() {
  const current = await readChatGPTAutostartState();
  if (current.state === null) return { state: null, changed: false, note: '未找到起始任务注册表项' };
  if (current.state === C.startupTaskStateDisabledByUser) return { state: current.state, changed: false, ok: true };
  if (current.state === C.startupTaskStateEnabled || current.state === 4) {
    await regAddDword(C.startupTaskRegKey, 'UserEnabledStartupOnce', 0);
    await regAddQword(C.startupTaskRegKey, 'LastDisabledTime', Math.floor(Date.now() / 1000));
    await regAddDword(C.startupTaskRegKey, 'State', C.startupTaskStateDisabledByUser);
    return { state: current.state, changed: true, newState: C.startupTaskStateDisabledByUser };
  }
  return { state: current.state, changed: false, note: '当前既非启用也非"用户禁用"，未改动' };
}

/* ---------- Clash Verge ---------- */

async function isClashAppRunning(force = false) {
  return netinfo.isRunning(config.clash.appProcess, force);
}

async function isCoreRunning(force = false) {
  return netinfo.isRunning(config.clash.coreProcess, force);
}

/** 启动 Clash Verge 应用（白名单校验由 exec 层负责）；返回 { ok, pid?, error? } */
async function launchClash() {
  return launchClashApp();
}

const CLASH_CORE_EXIT_WAIT_MS = 8000;

/** 只关闭 Clash Verge 应用本体（保留内核）：用于"重启应用让配置重新生成" */
async function closeClashAppOnly() {
  await taskkill(config.clash.appProcess, { force: true, tree: true });
  const deadline = Date.now() + CLASH_CORE_EXIT_WAIT_MS;
  while (Date.now() < deadline && (await netinfo.isRunning(config.clash.appProcess, true))) {
    await sleep(400);
  }
  return !(await netinfo.isRunning(config.clash.appProcess, true));
}

async function waitProcessGone(imageName, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await netinfo.isRunning(imageName, true))) return true;
    await sleep(500);
  }
  return !(await netinfo.isRunning(imageName, true));
}

/** Clash 后台服务当前状态：RUNNING / STOPPED / NOTFOUND */
async function getClashServiceState() {
  const r = await ps('service-state.ps1', ['-Name', config.clash.serviceName], { timeoutMs: 30000 });
  return (r.stdout || '').trim().toUpperCase();
}

/** 程序B（需管理员）：确保"启动服务"助手任务存在，之后程序A 无需提权即可拉起服务 */
async function ensureServiceHelperTask() {
  const r = await ps(
    'ensure-service-task.ps1',
    ['-TaskName', config.clash.serviceStartTask, '-ServiceName', config.clash.serviceName],
    { timeoutMs: 60000 }
  );
  const out = (r.stdout || '').trim();
  if (out === 'task-exists') return { ok: true, created: false };
  if (out === 'task-created') return { ok: true, created: true };
  return { ok: false, created: false, reason: (r.stderr || out || '未知错误').trim() };
}

/** 程序A（无需管理员）：若服务已停止，用助手任务把它拉起来 */
async function ensureClashServiceRunning() {
  const state = await getClashServiceState();
  if (state === 'RUNNING') return { ok: true, state };
  if (state === 'NOTFOUND') return { ok: false, state, reason: '未找到 Clash Verge 服务（可能未安装服务模式）' };

  log.info('Clash 后台服务处于停止状态，正在通过助手任务启动（无需 UAC）...');
  const run = await schTasksRun(config.clash.serviceStartTask);
  if (run.code !== 0) {
    return {
      ok: false,
      state,
      reason: '缺少助手计划任务（先运行一次"关闭全部"会自动创建）或任务执行失败',
    };
  }
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await sleep(1000);
    if ((await getClashServiceState()) === 'RUNNING') return { ok: true, state, started: true };
  }
  return { ok: false, state, reason: '服务启动超时' };
}

/** 程序B（需管理员）：停止服务（连带结束内核），之后内核不会再被自动拉起 */
async function stopClashService() {
  const r = await ps('stop-service.ps1', ['-Name', config.clash.serviceName], { timeoutMs: 60000 });
  const state = (r.stdout || '').trim().toUpperCase();
  return { ok: state === 'STOPPED', state, stderr: (r.stderr || '').trim() };
}

/**
 * 关闭 Clash Verge：应用 → 服务（连带内核）→ 兜底强杀内核。
 * 说明：实测"只杀内核"会被服务自动拉起；因此以"停止服务"为真正手段，
 * 并注册一个助手计划任务供之后免提权把服务拉起来。
 */
async function closeClashAll() {
  const result = { app: false, core: false, service: false, errors: [] };

  const task = await ensureServiceHelperTask();
  if (!task.ok) result.errors.push(`助手任务创建失败：${task.reason}`);
  else result.taskCreated = task.created;

  await taskkill(config.clash.appProcess, { force: true, tree: true });
  result.app = await waitProcessGone(config.clash.appProcess, CLASH_CORE_EXIT_WAIT_MS);
  if (!result.app) result.errors.push('应用进程仍在运行');

  const service = await stopClashService();
  result.service = service.ok;
  if (!service.ok) result.errors.push(`停止服务失败（state=${service.state}）${service.stderr ? '：' + service.stderr : ''}`);

  let gone = await waitProcessGone(config.clash.coreProcess, CLASH_CORE_EXIT_WAIT_MS);
  if (!gone) {
    log.info('服务已停但内核仍在，改用"启用 SeDebugPrivilege"的兜底方式 ...');
    const fallback = await ps('kill-system-process.ps1', ['-ImageNames', config.clash.coreProcess], { timeoutMs: 60000 });
    log.plain(`  · 兜底输出：${(fallback.stdout || '').trim().split('\n').join(' | ')}`);
    gone = await waitProcessGone(config.clash.coreProcess, CLASH_CORE_EXIT_WAIT_MS);
  }
  result.core = gone;
  if (!gone) result.errors.push('内核进程仍在运行');
  return result;
}

/* ---------- Roxy Browser ---------- */

async function isRoxyAppRunning(force = false) {
  return netinfo.isRunning(config.roxy.appProcess, force);
}

async function launchRoxy() {
  const { launchRoxyApp } = require('./exec');
  return launchRoxyApp();
}

/** 打开指纹窗口（需要 workspaceId；调用方负责校验） */
async function openRoxyWindow(dirId) {
  return launchRoxyWindow(dirId, config.roxy.workspaceId);
}

/** 关闭 Roxy 全部进程：窗口（温和→强杀）→ 主程序 → roxynet */
async function closeRoxyAll() {
  log.info('先尝试温和关闭窗口（最多 60 秒）...');
  const graceful = await ps(
    'close-gracefully.ps1',
    ['-Names', `${config.roxy.chromeProcess},${config.roxy.appProcess}`, '-WaitSeconds', String(config.timeouts.gracefulCloseSec)],
    { timeoutMs: 60000 }
  );
  if (graceful.timedOut) log.warn('温和关闭超时（已终止该步骤），直接强制结束');
  for (const name of [config.roxy.chromeProcess, config.roxy.appProcess, config.roxy.roxynetProcess]) {
    log.info(`强制结束 ${name} ...`);
    await taskkill(name, { force: true, tree: true });
  }
  return {
    chrome: !(await netinfo.isRunning(config.roxy.chromeProcess, true)),
    app: !(await netinfo.isRunning(config.roxy.appProcess, true)),
    roxynet: !(await netinfo.isRunning(config.roxy.roxynetProcess, true)),
  };
}

/* ---------- 窗口 / 权限 ---------- */

// 只匹配"本项目自己的"命令行特征，避免误伤其它恰好引用了项目目录的终端
const PROJECT_CMDLINE_MARKERS = [
  'GPT-Proxy-',
  'gpt-proxy-wizard',
  'engine\\cli.js',
  'engine/cli.js',
];

/**
 * 找出"项目相关"的窗口进程：
 * - ① 窗口标题含 `GPT-Proxy-*`（本项目启动器给自己设的标题）；
 * - ② 由**用户双击启动**（父进程是 explorer.exe）的 cmd/powershell/node，且命令行含本项目启动器/脚本特征。
 * ②里"父进程必须是 explorer"这条很关键：否则任何命令行里出现过本脚本名的 shell（例如被别的程序调用的终端）
 * 都会被误杀 —— 实测踩过（把调用方的工具 shell 一起关掉了）。
 */
async function findProjectWindows(extraTitles = []) {
  const titles = [...Object.values(config.WINDOW_TITLES), ...extraTitles];
  const list = await netinfo.processes(true);
  const byId = new Map(list.map((p) => [p.Id, p]));
  const shellNames = new Set(['cmd.exe', 'powershell.exe', 'conhost.exe', 'WindowsTerminal.exe', 'wt.exe', 'node.exe']);
  return list.filter((p) => {
    if (p.Title && titles.some((t) => p.Title.includes(t))) return true;
    if (!p.Name || !shellNames.has(p.Name)) return false;
    if (!p.Cmd || !PROJECT_CMDLINE_MARKERS.some((marker) => p.Cmd.includes(marker))) return false;
    const parent = p.Pid2 ? byId.get(p.Pid2) : null;
    return Boolean(parent && parent.Name && parent.Name.toLowerCase() === 'explorer.exe');
  });
}

/**
 * 关闭给定的窗口进程（按进程名强杀）。
 * 跳过：自身、以及自身的祖先进程链（启动器 cmd / 宿主进程），避免误伤调用方。
 */
async function closeWindowProcesses(processes, selfPid) {
  const ancestors = await netinfo.collectAncestorPids(selfPid);
  const protectedPids = new Set([selfPid, ...ancestors]);
  const targets = processes.filter((p) => !protectedPids.has(p.Id));
  const skipped = processes.length - targets.length;
  if (skipped > 0) log.warn(`已跳过 ${skipped} 个受保护进程（本程序自身的启动链）`);
  for (const p of targets) {
    if (p.Name && RE_EXE_NAME.test(p.Name)) {
      await taskkill(p.Name, { force: true, tree: true });
    }
  }
  return targets.length;
}

async function isAdmin() {
  const r = await ps('is-admin.ps1');
  return /ADMIN/.test(r.stdout);
}

/**
 * 接管"上一次卡住的本程序实例"：杀掉它的进程树，并顺手关掉它的提权启动器窗口。
 * 仅在检测到锁被一个存活但没有进展的旧实例持有时调用（要求本实例已提权）。
 */
async function killPreviousStopInstance(pid) {
  const procs = await netinfo.processes(true);
  const me = procs.find((p) => p.Id === Number(pid));
  const parent = me && me.Pid2 ? procs.find((p) => p.Id === me.Pid2) : null;
  log.info(`结束卡住的旧实例（PID ${pid}）及其子进程 ...`);
  const r = await taskkillPid(pid, { force: true, tree: true });
  if (r.code !== 0) log.warn('结束旧实例失败（可能权限不足）');
  if (parent && parent.Name && parent.Name.toLowerCase() === 'cmd.exe') {
    log.info(`关闭旧的启动器窗口（PID ${parent.Id}）...`);
    await taskkillPid(parent.Id, { force: true, tree: true });
  }
  return true;
}

module.exports = {
  isChatGPTRunning,
  launchChatGPT,
  closeChatGPT,
  readChatGPTAutostartState,
  ensureChatGPTAutostartDisabled,
  isClashAppRunning,
  isCoreRunning,
  launchClash,
  closeClashAppOnly,
  closeClashAll,
  getClashServiceState,
  ensureServiceHelperTask,
  ensureClashServiceRunning,
  stopClashService,
  isRoxyAppRunning,
  launchRoxy,
  openRoxyWindow,
  closeRoxyAll,
  findProjectWindows,
  closeWindowProcesses,
  isAdmin,
  killPreviousStopInstance,
};
