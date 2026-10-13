#!/usr/bin/env node
'use strict';
/**
 * 开发自测（不随产物分发）：用 Electron 起一个**不可见**的窗口（show:false）加载真实界面，
 * 用桩 IPC 提供配置，验证「Roxy 缓存根目录」字段的完整链路：
 *   渲染 → 点"自动探测"（把探测结果并入文本框）→ 点"保存设置"（补丁里 browserCacheDirsExtra 必须是数组）。
 *
 * 用法：npx electron tools/dev-ui-smoke.js      （退出码 0 = 全部通过）
 *
 * 说明：只验证渲染逻辑与 IPC 补丁形状，不触碰真实配置、不联网、不弹窗（窗口不可见）。
 */
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const ORIGINAL_WINDOW_NAME = '261011-1';   // 桩值：验证"没动过的敏感字段不会被覆盖"
const savedPatches = [];

// 桩配置：字段形状与 main\main.js 的 config:get 保持一致
const STUB_CONFIG = {
  outlet: { mode: 'roxy', static: { type: 'socks5', host: '', port: 0, username: '', password: '', expectedIp: '' }, subscription: { nodeMatcher: '', selectedNode: '' } },
  clash: { appExe: 'C:\\stub\\clash-verge.exe', dataDir: 'C:\\stub\\clash', groupName: 'GPT-US', nodeName: 'GPT-US-Static', groupType: 'select', slots: { proxies: '', rules: '', groups: '' }, mixedPort: 7897 },
  roxy: { appExe: 'C:\\stub\\RoxyBrowser.exe', userDataDir: 'C:\\stub\\RoxyBrowser', browserCacheDir: 'C:\\stub\\RoxyBrowser\\browser-cache', browserCacheDirsExtra: [], windowName: ORIGINAL_WINDOW_NAME, workspaceId: '111111', expectedStaticIp: '' },
  chatgpt: { aumid: 'stub!App', packageFamily: 'stub' },
  ui: { maskSensitive: true, language: 'zh-CN' },
};

function stubHandlers() {
  ipcMain.handle('app:info', () => ({
    productName: 'stub', version: '0.0.0', configPath: 'C:\\stub\\config.json', appDir: 'C:\\stub',
    logsDir: 'C:\\stub\\logs', maskSensitive: true, isPackaged: false,
    mode: { mode: 'roxy', label: 'Roxy 静态 IP（经 roxynet）', static: true, detail: 'stub' },
  }));
  ipcMain.handle('detect', () => ({ ok: true, info: { clash: { best: 'C:\\stub\\clash-verge.exe' }, roxy: { best: 'C:\\stub\\RoxyBrowser.exe' }, chatgpt: { packages: [] } } }));
  ipcMain.handle('check:run', () => ({ ok: true, result: { items: [], mode: { label: 'stub' }, configPath: 'C:\\stub\\config.json', at: '' } }));
  ipcMain.handle('config:get', () => JSON.parse(JSON.stringify(STUB_CONFIG)));
  ipcMain.handle('config:save', (event, patch) => { savedPatches.push(patch); return { ok: true, configPath: 'C:\\stub\\config.json' }; });
  ipcMain.handle('roxy:probeCacheRoots', () => ({ ok: true, roots: ['E:\\BrowserCache'] }));
  ipcMain.handle('roxy:listWindows', () => ({ ok: true, names: ['261011-1'] }));
  ipcMain.handle('clash:listNodes', () => ({ ok: true, names: [] }));
  ipcMain.handle('logs:list', () => ({ ok: true, files: [] }));
  ipcMain.handle('logs:read', () => ({ ok: true, text: '' }));
  ipcMain.handle('app:open', () => ({ ok: true, message: 'stub' }));
  ipcMain.handle('app:checkPath', () => ({ ok: true, resolved: 'C:\\stub' }));
  ipcMain.handle('engine:start', () => ({ ok: true, code: 0 }));
  ipcMain.handle('engine:stop', () => ({ ok: true, code: 0 }));
  ipcMain.handle('engine:cleanup', () => ({ ok: true, code: 0 }));
  ipcMain.handle('config:export', () => ({ ok: false, canceled: true }));
  ipcMain.handle('config:import', () => ({ ok: false, canceled: true }));
  ipcMain.handle('chatgpt:open', () => ({ ok: true }));
  ipcMain.handle('shell:open', () => ({ ok: true }));
  ipcMain.handle('pick:folder', () => ({ ok: false, canceled: true }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  stubHandlers();
  const win = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(ROOT, 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.webContents.on('console-message', (event, level, message) => {
    if (process.env.GPTWIZ_UI_SMOKE_VERBOSE) process.stdout.write(`[renderer] ${message}\n`);
  });
  await win.loadFile(path.join(ROOT, 'ui', 'index.html'));
  await sleep(1200);   // 等 boot() 跑完

  const probe = await win.webContents.executeJavaScript(`(async () => {
    const result = {};
    showPage('settings');
    const page = document.querySelector('#page-settings');
    const findInput = () => Array.from(page.querySelectorAll('input')).find((i) => String(i.placeholder || '').includes('只查默认缓存目录'));
    const findBtn = (text) => Array.from(page.querySelectorAll('button')).find((b) => b.textContent === text);

    result.inputExists = Boolean(findInput());
    result.initialValue = findInput() ? findInput().value : null;
    result.probeBtnExists = Boolean(findBtn('自动探测'));
    const pb = findBtn('自动探测');
    if (pb) pb.click();
    await new Promise((r) => setTimeout(r, 600));
    result.afterProbeValue = findInput() ? findInput().value : null;

    const sb = findBtn('保存设置');
    result.saveBtnExists = Boolean(sb);
    if (sb) sb.click();
    await new Promise((r) => setTimeout(r, 600));

    showPage('wizard');
    const wpage = document.querySelector('#page-wizard');
    result.wizardInputExists = Boolean(Array.from(wpage.querySelectorAll('input')).find((i) => String(i.placeholder || '').includes('只查默认缓存目录')));

    // 第二轮：手填两个目录（其中一个与探测结果重复、且大小写不同）→ 探测后应去重合并
    showPage('settings');
    const page2 = document.querySelector('#page-settings');
    const input2 = Array.from(page2.querySelectorAll('input')).find((i) => String(i.placeholder || '').includes('只查默认缓存目录'));
    const btn2 = Array.from(page2.querySelectorAll('button')).find((b) => b.textContent === '自动探测');
    input2.value = 'D:\\\\ManualCache; e:\\\\browsercache';
    input2.dispatchEvent(new Event('input'));
    btn2.click();
    await new Promise((r) => setTimeout(r, 600));
    const after2 = Array.from(page2.querySelectorAll('input')).find((i) => String(i.placeholder || '').includes('只查默认缓存目录'));
    result.mergedValue = after2.value;
    const save2 = Array.from(document.querySelectorAll('#page-settings button')).find((b) => b.textContent === '保存设置');
    save2.click();
    await new Promise((r) => setTimeout(r, 600));
    return result;
  })()`);

  const failures = [];
  const expect = (name, ok, extra) => {
    process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  —— ${extra}` : ''}\n`);
    if (!ok) failures.push(name);
  };

  expect('设置页存在"Roxy 缓存根目录"输入框', probe.inputExists);
  expect('初始值为空（配置里没有额外目录）', probe.initialValue === '', `value=${JSON.stringify(probe.initialValue)}`);
  expect('存在"自动探测"按钮', probe.probeBtnExists);
  expect('点探测后文本框被填入探测结果', probe.afterProbeValue === 'E:\\BrowserCache', `value=${JSON.stringify(probe.afterProbeValue)}`);
  expect('存在"保存设置"按钮', probe.saveBtnExists);
  const p1 = savedPatches[0];
  expect('保存补丁里有 roxy.browserCacheDirsExtra', Boolean(p1 && p1.roxy), p1 ? Object.keys(p1.roxy).join(',') : '(无补丁)');
  expect('browserCacheDirsExtra 是数组', Boolean(p1 && Array.isArray(p1.roxy.browserCacheDirsExtra)), p1 ? JSON.stringify(p1.roxy.browserCacheDirsExtra) : '');
  expect('数组内容 = 探测到的目录', Boolean(p1 && Array.isArray(p1.roxy.browserCacheDirsExtra) && p1.roxy.browserCacheDirsExtra.length === 1 && p1.roxy.browserCacheDirsExtra[0] === 'E:\\BrowserCache'));
  expect('未动过的敏感字段（窗口名）不被清空', Boolean(p1 && p1.roxy.windowName === ORIGINAL_WINDOW_NAME), p1 ? JSON.stringify(p1.roxy.windowName) : '');
  expect('向导页也有该字段（Roxy 模式）', probe.wizardInputExists);
  expect('手填 + 探测：大小写不同也去重（不重复加入）', probe.mergedValue === 'D:\\ManualCache; e:\\browsercache', `value=${JSON.stringify(probe.mergedValue)}`);
  const p2 = savedPatches[1];
  expect('手填两个目录 → 补丁是两项数组', Boolean(p2 && Array.isArray(p2.roxy.browserCacheDirsExtra) && p2.roxy.browserCacheDirsExtra.length === 2), p2 ? JSON.stringify(p2.roxy.browserCacheDirsExtra) : '(无补丁)');

  process.stdout.write(`\n结果：${failures.length ? `失败 ${failures.length} 项（${failures.join('、')}）` : '全部通过'}\n`);
  win.destroy();
  app.exit(failures.length ? 1 : 0);
}

app.whenReady().then(() => {
  run().catch((e) => {
    process.stderr.write(`自测异常：${e && e.stack ? e.stack : e}\n`);
    app.exit(3);
  });
});
