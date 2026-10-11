'use strict';
/**
 * 命令执行封装（安全版）：
 * - 所有外部命令都经过 child_process 的"参数数组"形式执行，从不使用 shell，
 *   因此不存在把输入拼接成命令行字符串的注入面；
 * - "启动某个已安装的 GUI 程序"这一动作统一交给 engine\tools\launch-app.ps1 执行，
 *   该脚本内部再做一层白名单校验（Node 侧先校验，双层防护）；
 * - 每个可执行文件名（taskkill/reg/curl/powershell/explorer/schtasks）都以字面量出现在调用处；
 * - 变量参数先做白名单格式校验；不提供"任意命令"的通用入口；
 * - 所有外部命令都有超时（默认 45s），超时返回 code=124。
 */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('../config');

// 打包后（asar）脚本位于 app.asar.unpacked 下 —— PowerShell 无法读取 asar 内部路径
const RAW_TOOLS_DIR = path.join(__dirname, '..', 'tools');
const TOOLS_DIR = RAW_TOOLS_DIR.includes('app.asar') ? RAW_TOOLS_DIR.replace('app.asar', 'app.asar.unpacked') : RAW_TOOLS_DIR;

const SAFE_IMAGE_NAME = /^[A-Za-z0-9_.\-]+$/;          // 进程名，如 ChatGPT.exe
const SAFE_SCRIPT_NAME = /^[A-Za-z0-9_.\-]+\.ps1$/;   // tools 目录脚本
const SAFE_SHELL_PATH = /^shell:AppsFolder\\[A-Za-z0-9_.!\-]+$/;
const SAFE_DIR_ID = /^[0-9a-f]{32}$/;                 // Roxy 窗口 dirId
const SAFE_WORKSPACE_ID = /^\d{1,20}$/;

// 允许被"启动"的程序白名单（只按文件名约束；安装目录允许用户指定/自动探测）
const ALLOWED_LAUNCH_IMAGES = ['clash-verge.exe', 'RoxyBrowser.exe', 'RoxyChrome.exe'];

function assert(condition, message) {
  if (!condition) throw new Error(`参数校验失败：${message}`);
}

const DEFAULT_TIMEOUT_MS = 45000; // 任何外部命令都不允许无限等待（超时会被杀掉并作为失败返回）

function wrap(cmdEventArgs) {
  return new Promise((resolve) => {
    const options = {
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      timeout: DEFAULT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      ...cmdEventArgs.options,
    };
    execFile(cmdEventArgs.cmd, cmdEventArgs.args, options, (err, stdout, stderr) => {
      const timedOut = Boolean(err && (err.killed || err.signal));
      if (timedOut && cmdEventArgs.onTimeout) cmdEventArgs.onTimeout();
      resolve({
        code: timedOut ? 124 : err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
        timedOut,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
  });
}

/* ---------- 固定可执行文件的执行函数（字面量命令，参数走数组） ---------- */

function exTaskkill(args, options) {
  return wrap({ cmd: 'taskkill', args, options });
}

function exReg(args, options) {
  return wrap({ cmd: 'reg', args, options });
}

function exCurl(args, options) {
  return wrap({ cmd: 'curl', args, options });
}

function exPowerShell(args, options) {
  return wrap({ cmd: 'powershell', args, options });
}

function exExplorer(args, options) {
  return wrap({ cmd: 'explorer', args, options });
}

function exSchTasks(args, options) {
  return wrap({ cmd: 'schtasks', args, options });
}

/* ---------- 业务封装 ---------- */

/** 运行 engine\tools 下的 PowerShell 脚本（timeoutMs 必填，避免脚本挂起拖死整个流程） */
function ps(scriptName, args = [], { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  assert(SAFE_SCRIPT_NAME.test(scriptName), `脚本名非法：${scriptName}`);
  const script = path.join(TOOLS_DIR, scriptName);
  assert(fs.existsSync(script), `脚本不存在：${script}`);
  return exPowerShell(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], { timeout: timeoutMs });
}

/** taskkill：force=false 时为温和关闭（发 WM_CLOSE） */
function taskkill(imageName, { force = true, tree = true } = {}) {
  assert(SAFE_IMAGE_NAME.test(imageName), `进程名非法：${imageName}`);
  const args = ['/IM', imageName];
  if (tree) args.push('/T');
  if (force) args.push('/F');
  return exTaskkill(args);
}

/** schtasks：运行一个已注册的计划任务（任务名先做白名单校验） */
function schTasksRun(taskName) {
  assert(SAFE_IMAGE_NAME.test(taskName), `任务名非法：${taskName}`);
  return exSchTasks(['/run', '/tn', taskName]);
}

/** schtasks：查询一个计划任务是否存在（只读） */
function schTasksQuery(taskName) {
  assert(SAFE_IMAGE_NAME.test(taskName), `任务名非法：${taskName}`);
  return exSchTasks(['/query', '/tn', taskName]);
}

/** schtasks：删除一个计划任务（用于"清理辅助项"；任务名先做白名单校验） */
function schTasksDelete(taskName) {
  assert(SAFE_IMAGE_NAME.test(taskName), `任务名非法：${taskName}`);
  return exSchTasks(['/delete', '/tn', taskName, '/f']);
}

/** taskkill 按 PID（只接受正整数 PID） */
function taskkillPid(pid, { force = true, tree = true } = {}) {
  const value = Number(pid);
  assert(Number.isInteger(value) && value > 0 && value < 2 ** 31, `PID 非法：${pid}`);
  const args = ['/PID', String(value)];
  if (tree) args.push('/T');
  if (force) args.push('/F');
  return exTaskkill(args);
}

/** 通过资源管理器激活 Store 应用（shell:AppsFolder 形式，格式白名单校验） */
function activateStoreApp(shellPath) {
  assert(SAFE_SHELL_PATH.test(shellPath), 'Store 应用激活路径非法');
  return exExplorer([shellPath]);
}

/**
 * 校验"要启动的程序路径"：
 * - 必须是绝对路径且真实存在的文件；
 * - 文件名必须属于 ALLOWED_LAUNCH_IMAGES 白名单（用户只能改安装目录，不能改程序本身）。
 * 返回规范化后的路径（仅校验，不执行）。
 */
function resolveAllowedApp(exePath) {
  assert(typeof exePath === 'string' && exePath.length > 0 && !exePath.includes('\0'), '可执行文件路径非法');
  const resolved = path.resolve(exePath);
  const base = path.basename(resolved).toLowerCase();   // 比较时统一小写（Windows 文件名不区分大小写）
  const allowed = ALLOWED_LAUNCH_IMAGES.map((name) => name.toLowerCase());
  assert(allowed.includes(base), `不在允许启动的程序清单内：${base}`);
  assert(fs.existsSync(resolved), `可执行文件不存在：${resolved}`);
  assert(fs.statSync(resolved).isFile(), `不是文件：${resolved}`);
  return resolved;
}

/**
 * 启动一个 GUI 程序：Node 侧校验路径之后，交给 launch-app.ps1 启动
 * （工作目录 = 程序自己的安装目录，程序独立存活）。
 * @returns {Promise<{ok: boolean, pid?: number, error?: string}>}
 */
async function launchAllowedApp(exePath, args = []) {
  let exe;
  try {
    exe = resolveAllowedApp(exePath);
    assert(Array.isArray(args) && args.every((a) => typeof a === 'string' && !/[\0\r\n]/.test(a)), '启动参数非法');
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };   // 路径没配好时给出明确原因，而不是抛异常
  }
  const r = await ps('launch-app.ps1', ['-ExePath', exe, '-ArgsJson', JSON.stringify(args)]);
  const m = String(r.stdout || '').match(/launched\s+(\d+)/);
  if (r.code === 0 && m) return { ok: true, pid: Number(m[1]) };
  return { ok: false, error: (r.stderr || r.stdout || 'launch-app.ps1 执行失败').trim() };
}

/** 启动 Clash Verge 主程序（路径来自配置/自动探测，经白名单校验） */
function launchClashApp() {
  return launchAllowedApp(config.clash.appExe);
}

/** 启动 Roxy 主程序（路径来自配置/自动探测，经白名单校验） */
function launchRoxyApp() {
  return launchAllowedApp(config.roxy.appExe);
}

/** 用 Roxy 的未文档化 CLI 打开指定窗口（dirId / workspaceId 格式白名单校验） */
function launchRoxyWindow(dirId, workspaceId) {
  assert(SAFE_DIR_ID.test(dirId), 'dirId 非法');
  assert(SAFE_WORKSPACE_ID.test(workspaceId), 'workspaceId 非法');
  return launchAllowedApp(config.roxy.appExe, ['--roxy-action', 'launch-browser', '--dir-id', dirId, '--workspace-id', workspaceId]);
}

/* ---------- 注册表 ---------- */

function regQuery(keyPath, valueName) {
  return exReg(['query', keyPath, '/v', valueName]);
}

function regAddString(keyPath, valueName, value) {
  return exReg(['add', keyPath, '/v', valueName, '/t', 'REG_SZ', '/d', value, '/f']);
}

function regAddDword(keyPath, valueName, value) {
  return exReg(['add', keyPath, '/v', valueName, '/t', 'REG_DWORD', '/d', String(value), '/f']);
}

function regAddQword(keyPath, valueName, value) {
  return exReg(['add', keyPath, '/v', valueName, '/t', 'REG_QWORD', '/d', String(value), '/f']);
}

/* ---------- 网络 ---------- */

/**
 * GET 请求（可选经本地 HTTP/SOCKS 代理；参数走数组，不经 shell）。
 * proxy 支持两种形式：'host:port'（按 HTTP 代理处理）或完整 URL（如 socks5h://user:pass@host:port）。
 */
function curlGet(url, { proxy = null, basicAuth = null, timeoutSec = 20 } = {}) {
  const args = ['-s', '--max-time', String(timeoutSec)];
  if (proxy) {
    let value = /:\/\//.test(proxy) ? proxy : `http://${proxy}`;
    if (basicAuth) {
      const auth = `${encodeURIComponent(basicAuth[0])}:${encodeURIComponent(basicAuth[1])}@`;
      value = value.replace('://', `://${auth}`);
    }
    args.push('-x', value);
  }
  args.push(url);
  return exCurl(args);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 看门狗：任何脚本的总运行时间上限（默认 10 分钟）。
 * 正常情况不会触发（每个外部命令都有自己的超时）；仅作为极端情况下的兜底。
 */
function installWatchdog(minutes, onFire) {
  const timer = setTimeout(() => onFire(), minutes * 60 * 1000);
  timer.unref();
  return timer;
}

module.exports = {
  ps,
  taskkill,
  taskkillPid,
  schTasksRun,
  schTasksQuery,
  schTasksDelete,
  activateStoreApp,
  resolveAllowedApp,
  launchAllowedApp,
  launchClashApp,
  launchRoxyApp,
  launchRoxyWindow,
  regQuery,
  regAddString,
  regAddDword,
  regAddQword,
  curlGet,
  sleep,
  installWatchdog,
  TOOLS_DIR,
};
