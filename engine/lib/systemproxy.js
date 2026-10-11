'use strict';
/** Windows 系统代理（WinINET，HKCU）读写 + 变更通知。 */
const { regQuery, regAddDword, regAddString, ps } = require('./exec');

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const RE_ENABLE = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i;
const RE_SERVER = /ProxyServer\s+REG_SZ\s+(.+)/;

async function read() {
  const enableOut = await regQuery(KEY, 'ProxyEnable');
  const mEnable = String(enableOut.stdout).match(RE_ENABLE);
  const serverOut = await regQuery(KEY, 'ProxyServer');
  const mServer = String(serverOut.stdout).match(RE_SERVER);
  return {
    enable: mEnable ? parseInt(mEnable[1], 16) : 0,
    server: mServer ? mServer[1].trim() : '',
  };
}

async function notify() {
  await ps('notify-proxy.ps1');
}

async function set(enable, server) {
  await regAddDword(KEY, 'ProxyEnable', enable ? 1 : 0);
  if (server) await regAddString(KEY, 'ProxyServer', server);
  await notify();
}

/** 确保系统代理 = 开、指向 server；已一致则不改动 */
async function ensureOn(server) {
  const current = await read();
  if (current.enable === 1 && current.server === server) return { changed: false, current };
  await set(true, server);
  return { changed: true, before: current };
}

/** 关闭系统代理（并通知） */
async function ensureOff() {
  const current = await read();
  if (current.enable === 0) return { changed: false, current };
  await set(false, current.server);
  return { changed: true, before: current };
}

module.exports = { read, set, notify, ensureOn, ensureOff, KEY };
