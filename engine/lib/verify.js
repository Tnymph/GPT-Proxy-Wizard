'use strict';
/** 各项"就绪 / 验证"检查：Clash 就绪、分流证据、出口 IP。 */
const config = require('../config');
const netinfo = require('./netinfo');
const clashApi = require('./clash-api');
const systemproxy = require('./systemproxy');
const outlet = require('./outlet');
const { curlGet, sleep } = require('./exec');

const C = config.clash;

/** 轮询等待条件成立；超时返回 null */
async function waitFor(desc, timeoutMs, fn) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch { /* 轮询期间忽略瞬时错误 */ }
    await sleep(config.timeouts.pollIntervalMs);
  }
  return null;
}

async function checkPort(port) {
  return netinfo.isPortListening(port, true);
}

async function checkTunAdapter() {
  return netinfo.hasAdapter(C.tunAdapterName, true);
}

async function checkSystemProxyOn() {
  const sp = await systemproxy.read();
  return sp.enable === 1 && sp.server.includes(String(C.mixedPort));
}

/** 节点与代理组是否存在；返回 { node, group, groupNow } */
async function checkNodes(nodeName = outlet.expectedNodeName()) {
  if (!nodeName) return null;
  const proxies = await clashApi.getProxies();
  if (!proxies) return null;
  const node = proxies[nodeName];
  const group = proxies[C.groupName];
  if (!node || !group) return null;
  return { node, group, groupNow: group.now };
}

/**
 * 检查"运行中的规则"是否已包含本项目全部规则。
 * 扩展文件写盘 ≠ 内核已加载；内核没重载时必须重启 Clash 应用。
 * @returns {{ ok: boolean, missing: string[] }}
 */
async function checkRunningRules() {
  const rules = await clashApi.getRules();
  if (!rules) return { ok: false, missing: ['（无法读取运行中的规则列表）'] };
  const missing = [];
  for (const rule of C.rules) {
    const parts = rule.split(',');
    const payload = parts[1];
    const proxy = parts[2];
    const found = rules.some((r) => r.payload === payload && r.proxy === proxy);
    if (!found) missing.push(rule);
  }
  return { ok: missing.length === 0, missing };
}

/** 节点测速（默认测 chatgpt.com），带重试；失败返回 null */
async function checkNodeDelay(nodeName = outlet.expectedNodeName(), attempts = 2, url = 'https://chatgpt.com') {
  if (!nodeName) return null;
  for (let i = 0; i < attempts; i += 1) {
    const r = await clashApi.testDelay(nodeName, url, 8000);
    if (r && typeof r.delay === 'number') return r.delay;
    if (i < attempts - 1) await sleep(2500);
  }
  return null;
}

/** 代理组当前实际生效的节点名 */
async function getGroupNow() {
  const g = await clashApi.getProxy(C.groupName);
  return g ? g.now : null;
}

/** 主动触发一次组内健康检查（立即测速所有成员），让 fallback 尽快切回首选节点 */
async function refreshGroupHealth() {
  return clashApi.testGroupDelay(C.groupName, C.healthCheckUrl, 6000);
}

/**
 * 取最近一条命中的连接。
 * 给了 since（>0）时只认"该时刻之后新建立"的连接 —— 已存在的连接不会被改道，
 * 拿旧连接当证据会误导（例如组刚切回静态节点时，旧连接仍挂在备用节点上）。
 */
function newestMatch(list, predicate, since = 0) {
  const hits = list.filter(predicate);
  if (hits.length === 0) return null;
  hits.sort((a, b) => Date.parse(a.start || 0) - Date.parse(b.start || 0));
  if (since > 0) {
    const fresh = hits.filter((c) => Date.parse(c.start || 0) >= since);
    return fresh.length > 0 ? fresh[fresh.length - 1] : null;
  }
  return hits[hits.length - 1];
}

/** 该连接是否走的是本通道（组名或目标节点名出现在 chains 里） */
function viaOurChannel(conn) {
  const chains = (conn && conn.chains) || [];
  const node = outlet.expectedNodeName();
  return chains.includes(C.groupName) || (node && chains.includes(node));
}

/**
 * 分流证据：经 7897 请求 chatgpt.com，并在请求"进行中"轮询 /connections 抓到这条连接的链路。
 * （请求结束后连接会从列表消失，所以必须边发请求边抓。）
 */
async function routingProof() {
  const started = Date.now();
  const pending = curlGet('https://chatgpt.com/', { proxy: `127.0.0.1:${C.mixedPort}`, timeoutSec: 25 });
  let hit = null;
  for (let i = 0; i < 25 && !hit; i += 1) {
    await sleep(300);
    const conns = await clashApi.getConnections();
    hit = newestMatch((conns && conns.connections) || [], viaOurChannel, started - 1500);
  }
  await pending;
  if (!hit) return null;
  return { chains: hit.chains, rule: hit.rule, host: (hit.metadata && hit.metadata.host) || '', start: hit.start };
}

/** ChatGPT 应用自身流量的分流证据（进程名或域名命中，取最近一条） */
async function chatgptAppTrafficProof(since = 0) {
  const conns = await clashApi.getConnections();
  const list = (conns && conns.connections) || [];
  const hit = newestMatch(list, (c) => {
    const meta = c.metadata || {};
    const isGpt = String(meta.process || '').toLowerCase() === 'chatgpt.exe' || /openai|chatgpt|oaistatic|oaiusercontent/.test(String(meta.host || ''));
    return viaOurChannel(c) && isGpt;
  });
  return hit ? { chains: hit.chains, host: (hit.metadata && hit.metadata.host) || '' } : null;
}

/* ---------- 出口 IP 探测 ---------- */

function parseIpInfo(stdout) {
  try {
    const info = JSON.parse(stdout);
    return { ip: info.ip, country: info.country, city: info.city, org: info.org };
  } catch {
    return null;
  }
}

async function egressViaClash(timeoutSec = 25) {
  const r = await curlGet(config.flags.verifyUrl, { proxy: `127.0.0.1:${C.mixedPort}`, timeoutSec });
  if (r.code !== 0 || !r.stdout) return null;
  return parseIpInfo(r.stdout);
}

async function egressDirect() {
  const r = await curlGet(config.flags.verifyUrl, { timeoutSec: 20 });
  if (r.code !== 0 || !r.stdout) return null;
  return parseIpInfo(r.stdout);
}

/**
 * 模式 B（自备静态 IP）：直接经用户提供的代理请求 ipinfo。
 * 目的：在动 Clash 之前先确认"上游静态通道本身是通的、且在美国"。
 */
async function egressViaStaticUpstream(attempts = 2) {
  const s = config.outlet.static;
  if (!s.host || !s.port) return null;
  const scheme = s.type === 'http' ? 'http' : 'socks5h';
  const auth = s.username ? `${encodeURIComponent(s.username)}:${encodeURIComponent(s.password || '')}@` : '';
  const proxy = `${scheme}://${auth}${s.host}:${Number(s.port)}`;
  for (let i = 0; i < attempts; i += 1) {
    const r = await curlGet(config.flags.staticIpProbeUrl, { proxy, timeoutSec: 25 });
    if (r.code === 0 && r.stdout) {
      const info = parseIpInfo(r.stdout);
      if (info) return info;
    }
    if (i < attempts - 1) await sleep(3000);
  }
  return null;
}

/* ---------- 出口校验（无切换、无环路） ---------- */

/**
 * 经"规则路径"实测出口 IP：
 * 规则里 `DOMAIN-SUFFIX,ipinfo.io,GPT-US` 会把该请求送到 GPT-US 组，
 * 因此返回的 IP 就是"当前生效路径"的真实出口；同时取该连接的 chains 作为分流证据。
 * 注意：不要用"全局模式 + 选中本项目组"来测（会造成 roxynet 上游回环）。
 */
async function egressViaGroup() {
  const started = Date.now();
  let info = await egressViaClash(20);
  if (!info) {
    await sleep(1500);
    info = await egressViaClash(20);
  }
  if (!info) return null;
  const conns = await clashApi.getConnections();
  const list = (conns && conns.connections) || [];
  const hit = newestMatch(list, (c) => {
    const host = String((c.metadata && c.metadata.host) || '');
    return viaOurChannel(c) && /ipinfo\.io/.test(host);
  });
  return { ...info, chains: hit ? hit.chains : null, elapsedMs: Date.now() - started };
}

module.exports = {
  waitFor,
  checkPort,
  checkTunAdapter,
  checkSystemProxyOn,
  checkNodes,
  checkRunningRules,
  checkNodeDelay,
  getGroupNow,
  refreshGroupHealth,
  routingProof,
  chatgptAppTrafficProof,
  egressViaClash,
  egressDirect,
  egressViaStaticUpstream,
  egressViaGroup,
};
