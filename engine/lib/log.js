'use strict';
/**
 * 统一日志：带时间戳与等级；控制台（UTF-8）与日志文件双写。
 * 日志文件位置：%APPDATA%\GPTProxyWizard\state\logs\<name>-<时间戳>.log
 *
 * 默认遮罩（config.ui.maskSensitive，默认开启）：
 *   - IPv4 只保留前三段（127.* / 0.* / 255.* 除外）；
 *   - 本机用户名 / 主机名 → <env>；
 *   - 配置里的敏感值（预期静态 IP、上游主机、密码、workspaceId）→ <hidden>；
 *   - 32 位 hex（Roxy dirId）只保留前 4 位。
 * 需要完整值时必须显式关闭遮罩（CLI：--show-sensitive；界面：设置里的开关并给出警告）。
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');

let fileStream = null;
let filePath = null;
let maskEnabled = config.ui.maskSensitive !== false;
let consoleEnabled = true;
const sinks = [];

function setMasking(on) { maskEnabled = Boolean(on); }
function maskingEnabled() { return maskEnabled; }

/** GUI 模式：关闭 stdout 输出（Electron 主进程没有可用的控制台管道） */
function setConsoleEnabled(on) { consoleEnabled = Boolean(on); }

/** 注册输出监听（界面把日志实时显示出来）；返回取消函数 */
function addSink(fn) {
  sinks.push(fn);
  return () => {
    const i = sinks.indexOf(fn);
    if (i >= 0) sinks.splice(i, 1);
  };
}

function mask(text) {
  let out = String(text);
  if (!maskEnabled) return out;
  // IPv4（跳过回环 / 全零 / 广播）
  out = out.replace(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}\b/g, (m, a, b, c) => {
    if (a === '127' || (a === '0' && b === '0') || a === '255') return m;
    return `${a}.${b}.${c}.***`;
  });
  // 环境标识（用户名 / 主机名）
  for (const value of [process.env.USERNAME, process.env.COMPUTERNAME]) {
    if (value && value.length >= 3 && value.toLowerCase() !== 'user') out = out.split(value).join('<env>');
  }
  // 已配置的敏感值（Roxy 身份 / 出口资源 / 凭据）
  const known = [
    config.roxy.expectedStaticIp,
    config.roxy.windowName,
    config.roxy.workspaceId,
    config.outlet.static.expectedIp,
    config.outlet.static.host,
    config.outlet.static.username,
    config.outlet.static.password,
  ];
  for (const value of known) {
    if (!value || String(value).length < 4) continue;
    // 只替换"独立出现"的值（前后不能紧邻字母/数字），避免误伤时间戳等无关文本
    const escaped = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(?<![0-9A-Za-z])${escaped}(?![0-9A-Za-z])`, 'g'), '<hidden>');
  }
  // Roxy dirId（32 位 hex）：只保留前 4 位
  out = out.replace(/\b[0-9a-f]{32}\b/gi, (m) => `${m.slice(0, 4)}…`);
  return out;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fileStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 把输出同时写入日志文件；返回日志文件路径 */
function initLogFile(name) {
  const dir = path.join(config.STATE_DIR, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  filePath = path.join(dir, `${name}-${fileStamp()}.log`);
  fileStream = fs.createWriteStream(filePath, { flags: 'a', encoding: 'utf8' });
  return filePath;
}

function closeLogFile() {
  if (fileStream) {
    try { fileStream.end(); } catch { /* 忽略 */ }
    fileStream = null;
  }
}

function write(text) {
  const masked = mask(text);
  if (consoleEnabled) process.stdout.write(masked);
  if (fileStream) fileStream.write(masked);
  for (const sink of sinks) {
    try { sink(masked); } catch { /* 监听方异常不影响主流程 */ }
  }
}

function line(level, msg) {
  write(`[${stamp()}] [${level}] ${msg}\n`);
}

/** 无前缀输出一行文本 */
function plain(msg) {
  write(`${msg}\n`);
}

/** 逐行输出明细（用于错误提示等） */
function details(items) {
  for (const item of items) plain(`  · ${item}`);
}

/** 只返回遮罩后的文本（供 JSON 输出统一走一遍遮罩） */
function masked(text) {
  return mask(text);
}

module.exports = {
  initLogFile,
  closeLogFile,
  setMasking,
  maskingEnabled,
  setConsoleEnabled,
  addSink,
  masked,
  logFilePath() { return filePath; },
  step(n, msg) { line('步骤', `${String(n).padStart(2)}. ${msg}`); },
  info(msg) { line('信息', msg); },
  ok(msg) { line('成功', msg); },
  warn(msg) { line('警告', msg); },
  err(msg) { line('错误', msg); },
  plain,
  details,
  blank() { write('\n'); },
};
