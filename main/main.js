'use strict';
/**
 * Electron 主进程。
 *
 * 设计：
 * - 引擎（engine/）是零依赖纯 Node 代码，直接在主进程内 require 运行（无需再起子进程）；
 * - 渲染进程只通过 preload 暴露的窄接口访问能力（contextIsolation 开、nodeIntegration 关）；
 * - `--elevate-run <start|stop>`：被 elevate.ps1 以管理员身份重启时的一次性模式 ——
 *   不建窗口，跑一次引擎后退出（结果见应用目录 state\logs 下的日志）。
 */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');

const ROOT = path.join(__dirname, '..');

const argv = process.argv.slice(1);
const elevateIdx = argv.findIndex((a) => a === '--elevate-run');
const ELEVATE_RUN = elevateIdx >= 0 ? String(argv[elevateIdx + 1] || '') : '';

/* ---------- 引擎（进程内，静态 require） ---------- */
const config = require('../engine/config');
const log = require('../engine/lib/log');
const detect = require('../engine/detect');
const checkMod = require('../engine/check');
const apps = require('../engine/lib/apps');
const outlet = require('../engine/lib/outlet');
const roxynet = require('../engine/lib/roxynet');
const clashApi = require('../engine/lib/clash-api');
const startMod = require('../engine/start');
const stopMod = require('../engine/stop');
const cleanupMod = require('../engine/cleanup');
const openMod = require('../engine/open');
const { ps, resolveAllowedApp } = require('../engine/lib/exec');

log.setConsoleEnabled(false); // GUI 模式：不往 stdout 写（由 sink 转发到界面）

/* ---------- 配置读写 ---------- */

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function deepMergeInto(target, patch) {
  for (const key of Object.keys(patch || {})) {
    if (isPlainObject(target[key]) && isPlainObject(patch[key])) deepMergeInto(target[key], patch[key]);
    else target[key] = patch[key];
  }
  return target;
}

/** 只把"用户可编辑"的字段持久化到 config.json（不写运行期派生值） */
function persistConfig() {
  const persisted = {
    outlet: config.outlet,
    clash: {
      appExe: config.clash.appExe,
      dataDir: config.clash.dataDir,
      nodeName: config.clash.nodeName,
      groupName: config.clash.groupName,
      groupType: config.clash.groupType,
      slots: config.clash.slots,
    },
    roxy: {
      appExe: config.roxy.appExe,
      userDataDir: config.roxy.userDataDir,
      browserCacheDir: config.roxy.browserCacheDir,
      browserCacheDirsExtra: config.roxy.browserCacheDirsExtra,
      windowName: config.roxy.windowName,
      workspaceId: config.roxy.workspaceId,
      expectedStaticIp: config.roxy.expectedStaticIp,
    },
    chatgpt: { aumid: config.chatgpt.aumid, packageFamily: config.chatgpt.packageFamily },
    ui: config.ui,
  };
  fs.mkdirSync(path.dirname(config.CONFIG_PATH), { recursive: true });
  fs.writeFileSync(config.CONFIG_PATH, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
}

function applyConfigPatch(patch) {
  deepMergeInto(config, patch || {});
  // 派生值（随包族名 / 数据目录变化重算）
  if (!config.clash.dataDir) {
    config.clash.dataDir = path.join(process.env.APPDATA || '', 'io.github.clash-verge-rev.clash-verge-rev');
  }
  if (!config.roxy.userDataDir) config.roxy.userDataDir = path.join(process.env.APPDATA || '', 'RoxyBrowser');
  if (!config.roxy.browserCacheDir) config.roxy.browserCacheDir = path.join(config.roxy.userDataDir, 'browser-cache');
  config.chatgpt.aumid = config.chatgpt.aumid || config.chatgpt.aumidFallback;
  config.chatgpt.startupTaskRegKey =
    'HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\SystemAppData\\'
    + config.chatgpt.packageFamily + '\\App';
  if (config.ui && typeof config.ui.maskSensitive === 'boolean') log.setMasking(config.ui.maskSensitive);
  persistConfig();
}

/** 全局遮罩：把返回给界面的 JSON 也按遮罩设置处理 */
function maskedJson(value) {
  return JSON.parse(log.masked(JSON.stringify(value)));
}

/* ---------- 单实例运行保护 ---------- */
let running = null; // { kind: 'start'|'stop', promise }

async function runEngine(kind, opts = {}) {
  if (running) throw new Error(`已有任务在执行（${running.kind}），请等待完成`);
  const mod = kind === 'stop' ? stopMod : startMod;
  running = { kind, promise: null };
  const promise = (async () => {
    try {
      // 启动时的探测是异步的（可能还没跑完），执行前再确保一次：路径缺失时自动补上
      const auto = await detect.autoFill();
      // 探测到的提示（例如"自动识别 Roxy 缓存目录"）转发到界面的运行输出里
      if (auto && auto.notes) for (const n of auto.notes) log.warn(n);
      // watchdogExit:false —— 界面模式不因为"看门狗超时"杀掉整个应用（引擎自己会清定时器，这里是第二道保险）
      return await mod.run({ watchdogExit: false, ...opts });
    } finally {
      running = null;
      log.closeLogFile();      // 每次任务结束后关掉日志文件句柄
    }
  })();
  running.promise = promise;
  return promise;
}

/** 提权执行（关闭全部 / 清理辅助项）：以管理员身份重启本应用，用 --elevate-run 跑一次性任务 */
async function runElevated(kind) {
  const exePath = process.execPath;
  const extra = `--elevate-run ${kind}`;
  // 打包后 exe 本身就是应用（不需要 -AppPath）；开发模式才需要把应用目录传进去
  const args = app.isPackaged
    ? ['-ExePath', exePath, '-ExtraArgs', extra]
    : ['-ExePath', exePath, '-AppPath', ROOT, '-ExtraArgs', extra];
  const r = await ps('elevate.ps1', args, { timeoutMs: 300000 });
  const m = String(r.stdout || '').match(/elevated\s+(\d+)/);
  if (r.code !== 0 || !m) {
    return { ok: false, error: (r.stderr || r.stdout || '提权失败（可能取消了 UAC）').trim() };
  }
  return { ok: true, pid: Number(m[1]) };
}

/** 判断进程是否还活着（提权进程可能因权限返回 EPERM，同样视为存活） */
function isProcessAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (e) {
    return Boolean(e && e.code === 'EPERM');
  }
}

/**
 * 等提权实例跑完，并把它的日志增量转发到界面（提权进程的输出无法直接回传管道）。
 * @returns {Promise<boolean>} true = 已结束；false = 等待超时
 */
async function waitForElevatedRun(pid, timeoutMs = 180000) {
  const logsDir = path.join(config.STATE_DIR, 'logs');
  let file = null;
  let offset = 0;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    try {
      if (!file) {
        const cands = fs.readdirSync(logsDir)
          .filter((f) => f.endsWith('.log'))
          .map((f) => ({ f, m: fs.statSync(path.join(logsDir, f)).mtimeMs }))
          .sort((a, b) => b.m - a.m);
        if (cands.length) file = path.join(logsDir, cands[0].f);
      }
      if (file) {
        const text = fs.readFileSync(file, 'utf8');
        if (text.length > offset) {
          const chunk = text.slice(offset);
          offset = text.length;
          if (win && !win.isDestroyed()) win.webContents.send('engine:log', chunk);
        }
      }
    } catch { /* 读取竞态忽略 */ }
    if (!isProcessAlive(pid)) return true;
  }
  return false;
}

/* ---------- 窗口 ---------- */

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 900,
    minHeight: 620,
    title: config.PRODUCT_NAME,
    backgroundColor: '#111418',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(ROOT, 'ui', 'index.html'));
  win.on('closed', () => { win = null; });

  // 引擎输出实时转发到界面
  log.addSink((chunk) => {
    if (win && !win.isDestroyed()) win.webContents.send('engine:log', chunk);
  });
}

/* ---------- IPC ---------- */

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    productName: config.PRODUCT_NAME,
    version: app.getVersion(),
    configPath: config.CONFIG_PATH,
    appDir: config.APP_DIR,
    logsDir: path.join(config.STATE_DIR, 'logs'),
    maskSensitive: config.ui.maskSensitive !== false,
    // 模式描述里含 Roxy 窗口名，按遮罩设置处理（关闭遮罩后显示完整值）
    mode: maskedJson(outlet.describe()),
    isPackaged: app.isPackaged,
  }));

  ipcMain.handle('detect', async () => {
    try {
      const info = await detect.detectAll();
      return { ok: true, info: maskedJson(info) };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  ipcMain.handle('check:run', async (event, payload) => {
    try {
      const result = await checkMod.collect({ quick: Boolean(payload && payload.quick) });
      return { ok: true, result: maskedJson(result) };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  ipcMain.handle('engine:start', async () => {
    try {
      const code = await runEngine('start', {});
      return { ok: code === 0, code };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  ipcMain.handle('engine:stop', async (event, payload) => {
    try {
      if (!(payload && payload.allowElevate)) {
        const code = await runEngine('stop', {});
        return { ok: code === 0 || code === 10, code };
      }
      const isAdmin = await apps.isAdmin();
      if (isAdmin) {
        const code = await runEngine('stop', { elevated: true });
        return { ok: code === 0, code };
      }
      const r = await runElevated('stop');
      if (!r.ok) return { ok: false, error: r.error };
      const finished = await waitForElevatedRun(r.pid);
      return { ok: true, elevated: true, pid: r.pid, finished };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  // 注意：这里返回的是**原始值** —— 界面按"遮罩显示"开关决定如何展示（敏感输入框默认打码、
  // 留空表示不修改）；这样用户关闭遮罩后才能真正看到/编辑自己的值。日志与检查结果仍然默认遮罩。
  ipcMain.handle('config:get', () => ({
    outlet: config.outlet,
    clash: {
      appExe: config.clash.appExe,
      dataDir: config.clash.dataDir,
      groupName: config.clash.groupName,
      nodeName: config.clash.nodeName,
      groupType: config.clash.groupType,
      slots: config.clash.slots,
      mixedPort: config.clash.mixedPort,
    },
    roxy: {
      appExe: config.roxy.appExe,
      userDataDir: config.roxy.userDataDir,
      browserCacheDir: config.roxy.browserCacheDir,
      browserCacheDirsExtra: Array.isArray(config.roxy.browserCacheDirsExtra) ? config.roxy.browserCacheDirsExtra : [],
      windowName: config.roxy.windowName,
      workspaceId: config.roxy.workspaceId,
      expectedStaticIp: config.roxy.expectedStaticIp,
    },
    chatgpt: { aumid: config.chatgpt.aumid, packageFamily: config.chatgpt.packageFamily },
    ui: config.ui,
  }));

  ipcMain.handle('config:save', async (event, patch) => {
    try {
      applyConfigPatch(patch);
      return { ok: true, configPath: config.CONFIG_PATH };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  // 按配置好的位置打开某个软件，并核对它是否真的出现（用于"先检查一下"或"先打开备用"）
  ipcMain.handle('app:open', async (event, payload) => {
    const target = String((payload && payload.target) || '');
    try {
      const r = await openMod.openTarget(target, { waitMs: 25000 });
      return { ok: r.ok, message: r.message, already: Boolean(r.already), appeared: r.appeared };
    } catch (e) {
      return { ok: false, message: String(e && e.message ? e.message : e) };
    }
  });

  // 校验一个"程序路径"是否可用（选择文件夹后立即提示，避免保存了错路径）
  ipcMain.handle('app:checkPath', (event, payload) => {
    try {
      return { ok: true, resolved: resolveAllowedApp(String((payload && payload.path) || '')) };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  // 清理辅助项（用户点"清理"后调用；任务删除可能需要提权，失败时自动走提权一次性实例）
  ipcMain.handle('engine:cleanup', async (event, payload) => {
    const apply = Boolean(payload && payload.apply);
    try {
      const r = await cleanupMod.run({ apply, restoreBackups: true });
      const needElevate = apply && r.facts.taskExists && !r.facts.taskDeleted;
      if (needElevate && !(await apps.isAdmin())) {
        const e = await runElevated('cleanup');
        if (!e.ok) return { ok: false, error: e.error };
        const finished = await waitForElevatedRun(e.pid);
        return { ok: true, elevated: true, pid: e.pid, finished };
      }
      return { ok: true, facts: r.facts };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  // 订阅里的叶子节点名（供向导"选一个美国节点"用；只读）
  ipcMain.handle('clash:listNodes', async () => {
    try {
      const names = await clashApi.listLeafNames();
      return { ok: true, names: names.slice(0, 500) };
    } catch (e) {
      return { ok: false, error: `读取节点列表失败（Clash 未运行？）：${e && e.message ? e.message : e}` };
    }
  });

  // 导出/导入配置（含私密值：导出时由用户选择保存位置；导入时同名项覆盖）
  ipcMain.handle('config:export', async () => {
    const r = await dialog.showSaveDialog(win, {
      title: '导出配置（文件里含你的私密值，请妥善保管）',
      defaultPath: 'gpt-proxy-wizard-config.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    try {
      persistConfig();
      fs.copyFileSync(config.CONFIG_PATH, r.filePath);
      return { ok: true, path: r.filePath };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  ipcMain.handle('config:import', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '导入配置（同名项将被覆盖）',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    try {
      let text = fs.readFileSync(r.filePaths[0], 'utf8');
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);   // 容忍带 BOM 的导入文件
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: '文件内容不是配置对象' };
      applyConfigPatch(data);
      return { ok: true, keys: Object.keys(data).join('、') };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  ipcMain.handle('roxy:listWindows', () => {
    try {
      // 只返回窗口名（不含 dirId 等敏感细节）
      const names = roxynet.listWindowNames().map((w) => w.windowName);
      return { ok: true, names };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  // 探测 Roxy 的"浏览器缓存根目录"（用户在 Roxy 设置里可能把缓存挪到了别的盘）
  ipcMain.handle('roxy:probeCacheRoots', () => {
    try {
      return { ok: true, roots: detect.probeRoxyCacheRoots() };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  ipcMain.handle('chatgpt:open', async () => {
    try {
      await apps.launchChatGPT();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  ipcMain.handle('logs:list', () => {
    const dir = path.join(config.STATE_DIR, 'logs');
    try {
      const files = fs.readdirSync(dir)
        .filter((f) => f.endsWith('.log'))
        .map((f) => {
          const st = fs.statSync(path.join(dir, f));
          return { name: f, mtime: st.mtimeMs, size: st.size };
        })
        .sort((a, b) => b.mtime - a.mtime);
      return { ok: true, files };
    } catch {
      return { ok: true, files: [] };
    }
  });

  ipcMain.handle('logs:read', (event, name) => {
    const dir = path.resolve(path.join(config.STATE_DIR, 'logs'));   // 固定根目录
    const base = path.basename(String(name || ''));
    if (!base || base.includes('..') || !base.endsWith('.log')) return { ok: false, error: '文件名非法' };
    const target = path.resolve(dir, base);
    if (target !== dir && !target.startsWith(dir + path.sep)) return { ok: false, error: '路径越界' };
    try {
      return { ok: true, content: fs.readFileSync(target, 'utf8') };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  ipcMain.handle('shell:open', (event, which) => {
    const targets = {
      appDir: config.APP_DIR,
      logsDir: path.join(config.STATE_DIR, 'logs'),
      configDir: path.dirname(config.CONFIG_PATH),
    };
    const target = targets[String(which || '')];
    if (!target) return { ok: false, error: '未知目录' };
    shell.openPath(target);
    return { ok: true };
  });

  ipcMain.handle('pick:folder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    return { ok: true, path: r.filePaths[0] };
  });
}

/* ---------- 启动 ---------- */

if (ELEVATE_RUN) {
  // 提权一次性模式：不建窗口，跑一次引擎后退出（日志在 state\logs）
  app.whenReady().then(async () => {
    let code = 3;
    try {
      // 支持 --dry-run：提权实例可以只做只读检查（用于自检/排障，不会改任何设置）
      const elevatedDryRun = argv.includes('--dry-run');
      if (ELEVATE_RUN === 'stop') code = await stopMod.run({ elevated: true, dryRun: elevatedDryRun });
      else if (ELEVATE_RUN === 'start') code = await startMod.run({ dryRun: elevatedDryRun });
      else if (ELEVATE_RUN === 'cleanup') code = (await cleanupMod.run({ apply: true, restoreBackups: true })).code;
      else log.err(`未知的 --elevate-run 动作：${ELEVATE_RUN}`);
    } catch (e) {
      log.err(`提权任务异常：${e && e.stack ? e.stack : e}`);
      code = 3;
    }
    log.closeLogFile();
    app.exit(Number(code) || 0);
  });
} else if (!app.requestSingleInstanceLock()) {
  // 单实例（避免两个界面同时操作同一台机器）
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { win.show(); win.focus(); }
  });
  app.whenReady().then(() => {
    registerIpc();
    createWindow();
    detect.autoFill()
      .then(() => { if (win && !win.isDestroyed()) win.webContents.send('app:refresh'); })
      .catch(() => { /* 探测失败不阻塞界面 */ });
  });
  app.on('window-all-closed', () => app.quit());
}
