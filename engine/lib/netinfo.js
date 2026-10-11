'use strict';
/**
 * 运行态信息采集：调用 tools\probe.ps1（一次性输出 JSON），带 1.5 秒缓存。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { ps } = require('./exec');

let cache = { at: 0, data: null };

async function runProbeOnce() {
  const out = path.join(os.tmpdir(), `gpt-proxy-probe-${crypto.randomBytes(4).toString('hex')}.json`);
  const result = await ps('probe.ps1', ['-OutFile', out]);
  if (result.code !== 0) throw new Error(`probe.ps1 执行失败：${result.stderr || result.stdout}`);
  const text = fs.readFileSync(out, 'utf8');
  fs.unlinkSync(out);
  return JSON.parse(text);
}

async function probe(force = false) {
  if (!force && cache.data && Date.now() - cache.at < 1500) return cache.data;
  let data = await runProbeOnce();
  // WMI 偶发返回空进程列表：稍等后重试一次，避免把"采集失败"当成"没有进程"
  if (!Array.isArray(data.processes) || data.processes.length === 0) {
    await new Promise((r) => setTimeout(r, 800));
    data = await runProbeOnce();
  }
  if (!Array.isArray(data.processes) || data.processes.length === 0) {
    throw new Error('进程信息采集失败（WMI/Get-Process 未返回任何进程）');
  }
  cache = { at: Date.now(), data };
  return data;
}

async function processes(force = false) {
  const data = await probe(force);
  return data.processes || [];
}

/**
 * 从指定 PID 向上回溯父进程链（最多 8 层），返回祖先 PID 集合。
 * 用于避免"关闭项目窗口"时误伤调用本程序的 shell / 宿主进程。
 */
async function collectAncestorPids(startPid, maxDepth = 8) {
  const list = await processes(true);
  const byId = new Map(list.map((p) => [p.Id, p]));
  const ancestors = new Set();
  let current = startPid;
  for (let i = 0; i < maxDepth; i += 1) {
    const proc = byId.get(current);
    if (!proc || !proc.Pid2) break;
    const parent = proc.Pid2;
    if (ancestors.has(parent) || parent === current) break;
    ancestors.add(parent);
    current = parent;
  }
  return ancestors;
}

/** 按进程名（可多个）过滤，返回 [{ Id, Name, Path, Cmd, Title }] */
async function findProcesses(names, force = false) {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  const list = await processes(force);
  return list.filter((p) => p.Name && wanted.has(p.Name.toLowerCase()));
}

async function isRunning(name, force = false) {
  const list = await findProcesses([name], force);
  return list.length > 0;
}

async function listeners(force = false) {
  const data = await probe(force);
  return data.listeners || [];
}

async function isPortListening(port, force = false) {
  const list = await listeners(force);
  return list.some((l) => l.Port === port);
}

async function listenersOfPid(pid, force = false) {
  const list = await listeners(force);
  return list.filter((l) => l.Pid === pid);
}

async function hasAdapter(nameSubstring, force = false) {
  const data = await probe(force);
  return (data.adapters || []).some((a) => a.Name && a.Name.includes(nameSubstring));
}

async function pipeNames(force = false) {
  const data = await probe(force);
  return data.pipes || [];
}

module.exports = {
  probe,
  processes,
  collectAncestorPids,
  findProcesses,
  isRunning,
  listeners,
  isPortListening,
  listenersOfPid,
  hasAdapter,
  pipeNames,
};
