'use strict';
/** 单实例锁：防止同一个程序被重复双击并发运行（超过 10 分钟的锁视为过期）。 */
const fs = require('fs');
const path = require('path');
const config = require('../config');

const LOCK_MAX_AGE_MS = 10 * 60 * 1000;

function lockPath(name) {
  return path.join(config.STATE_DIR, `${name}.lock`);
}

function readLock(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 返回 { acquired: true } 或 { acquired: false, holder } */
function acquire(name) {
  fs.mkdirSync(config.STATE_DIR, { recursive: true });
  const file = lockPath(name);
  const existing = readLock(file);
  if (existing && existing.pid && existing.pid !== process.pid) {
    const expired = Date.now() - (existing.at || 0) > LOCK_MAX_AGE_MS;
    if (!expired && isAlive(existing.pid)) return { acquired: false, holder: existing };
  }
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8');
  return { acquired: true };
}

function release(name) {
  try { fs.unlinkSync(lockPath(name)); } catch { /* 锁文件不存在 */ }
}

module.exports = { acquire, release };
