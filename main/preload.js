'use strict';
/** 预加载脚本：只向渲染进程暴露一组固定的能力接口（contextIsolation，无 nodeIntegration）。 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gptw', {
  info: () => ipcRenderer.invoke('app:info'),
  detect: () => ipcRenderer.invoke('detect'),
  check: (payload) => ipcRenderer.invoke('check:run', payload),
  start: () => ipcRenderer.invoke('engine:start'),
  stop: (payload) => ipcRenderer.invoke('engine:stop', payload),
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (patch) => ipcRenderer.invoke('config:save', patch),
  openApp: (payload) => ipcRenderer.invoke('app:open', payload),
  checkPath: (payload) => ipcRenderer.invoke('app:checkPath', payload),
  listRoxyWindows: () => ipcRenderer.invoke('roxy:listWindows'),
  probeRoxyCacheRoots: () => ipcRenderer.invoke('roxy:probeCacheRoots'),
  listClashNodes: () => ipcRenderer.invoke('clash:listNodes'),
  cleanup: (payload) => ipcRenderer.invoke('engine:cleanup', payload),
  exportConfig: () => ipcRenderer.invoke('config:export'),
  importConfig: () => ipcRenderer.invoke('config:import'),
  openChatGPT: () => ipcRenderer.invoke('chatgpt:open'),
  listLogs: () => ipcRenderer.invoke('logs:list'),
  readLog: (name) => ipcRenderer.invoke('logs:read', name),
  openFolder: (which) => ipcRenderer.invoke('shell:open', which),
  pickFolder: () => ipcRenderer.invoke('pick:folder'),
  onLog: (cb) => { ipcRenderer.on('engine:log', (event, chunk) => cb(chunk)); },
  onRefresh: (cb) => { ipcRenderer.on('app:refresh', () => cb()); },
});
