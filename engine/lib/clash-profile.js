'use strict';
/**
 * Clash 订阅扩展文件维护（节点 / 代理组 / 规则三个槽位）。
 *
 * - 槽位文件名**不写死**：优先用配置里的值；为空时解析 profiles.yaml 的
 *   `option.{proxies,rules,groups}`（当前订阅绑定的扩展文件），解析失败则提示用户在向导里确认。
 * - 内容按出口模式生成（roxy / static / subscription，见 lib/outlet.js）。
 * - 首次覆盖前自动备份原文件（*.gptproxy-backup）；内容一致则不动。
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const outlet = require('./outlet');

const C = config.clash;
const SLOT_KEYS = ['proxies', 'rules', 'groups'];

const HEADER = '# Managed by GPT Proxy Wizard（由向导自动生成，请勿手改；改动会在下次运行时被覆盖）';

/* ---------- profiles.yaml 解析（零依赖、容错） ---------- */

function profilesYamlPath() {
  return path.join(C.dataDir, 'profiles.yaml');
}

function stripQuotes(value) {
  const s = String(value || '').trim();
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) return s.slice(1, -1);
  return s;
}

/**
 * 解析 profiles.yaml：得到 current（当前订阅）与 items 列表、每项 option 里的槽位绑定。
 * 只读少量我们关心的键；解析失败返回 null（调用方降级处理）。
 */
function parseProfilesRegistry() {
  let text;
  try {
    text = fs.readFileSync(profilesYamlPath(), 'utf8');
  } catch {
    return null;
  }
  const items = [];
  let currentUid = '';
  let cur = null;
  let inOption = false;
  let optionIndent = -1;

  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    if (!t || t.startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;

    const mUid = t.match(/^-\s*uid:\s*(\S+)/);
    if (mUid) {
      cur = { uid: stripQuotes(mUid[1]), option: {} };
      items.push(cur);
      inOption = false;
      continue;
    }
    const mKV = t.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!mKV) continue;
    const key = mKV[1];
    const value = stripQuotes(mKV[2].replace(/\s+#.*$/, ''));

    if (!cur) {
      if (indent === 0 && key === 'current') currentUid = value;
      continue;
    }
    if (indent <= 1 && key === 'current') { currentUid = value; cur = null; continue; } // 防御：顶层键
    if (key === 'option') { inOption = true; optionIndent = indent; continue; }
    if (inOption && indent > optionIndent) { cur.option[key] = value; continue; }
    inOption = false;
    cur[key] = value;
  }
  return { currentUid, items };
}

/**
 * 解析出三个槽位文件名。
 * @returns {{ files: {proxies: string, rules: string, groups: string}, source: string }}
 */
function resolveSlotFiles() {
  const files = { proxies: '', rules: '', groups: '' };
  const source = { proxies: '', rules: '', groups: '' };
  for (const key of SLOT_KEYS) {
    const fromConfig = C.slots && C.slots[key];
    if (fromConfig) { files[key] = fromConfig; source[key] = 'config'; }
  }
  if (SLOT_KEYS.every((k) => files[k])) return { files, source };

  const reg = parseProfilesRegistry();
  if (reg && reg.currentUid) {
    const current = reg.items.find((i) => i.uid === reg.currentUid);
    if (current) {
      for (const key of SLOT_KEYS) {
        if (files[key]) continue;
        const uid = current.option[key];
        if (!uid) continue;
        const item = reg.items.find((i) => i.uid === uid);
        files[key] = (item && item.file) || `${uid}.yaml`;
        source[key] = 'profiles.yaml';
      }
    }
  }
  return { files, source };
}

/* ---------- 内容生成 ---------- */

function slotPath(fileName) {
  return path.join(C.dataDir, 'profiles', fileName);
}

function yamlQuote(value) {
  const s = String(value);
  if (/^[A-Za-z0-9_.\-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "''")}'`;
}

/** 节点槽位内容；返回 null 表示"本模式不需要自定义节点" */
function buildNodeYaml(runtime = {}) {
  const spec = outlet.nodeSpec(runtime);
  if (!spec) return null;
  const lines = [
    HEADER,
    'prepend:',
    `  - name: ${yamlQuote(spec.name)}`,
    `    type: ${spec.type}`,
    `    server: ${yamlQuote(spec.server)}`,
    `    port: ${Number(spec.port)}`,
  ];
  if (spec.username) lines.push(`    username: ${yamlQuote(spec.username)}`);
  if (spec.password) lines.push(`    password: ${yamlQuote(spec.password)}`);
  lines.push('    udp: true', 'append: []', 'delete: []', '');
  return lines.join('\n');
}

/** 模式 C（订阅节点）下用于"清理我们自己写过的节点"的空内容 */
function buildEmptyManagedYaml() {
  return [HEADER, 'prepend: []', 'append: []', 'delete: []', ''].join('\n');
}

/** 代理组槽位内容；expectedNode 为本通道真正要用的节点 */
function buildGroupYaml(expectedNode, backupNode) {
  const members = [expectedNode];
  if (C.groupType === 'fallback' && backupNode && backupNode !== expectedNode) members.push(backupNode);
  const type = C.groupType === 'fallback' ? 'fallback' : 'select';
  const lines = [
    HEADER,
    'prepend:',
    `  - name: ${yamlQuote(C.groupName)}`,
    `    type: ${type}`,
    `    proxies: [${members.map(yamlQuote).join(', ')}]`,
    `    url: ${C.healthCheckUrl}`,
    `    interval: ${Number(C.healthCheckInterval)}`,
    'append: []',
    'delete: []',
    '',
  ];
  return lines.join('\n');
}

function buildRulesYaml() {
  const lines = [HEADER, 'prepend:'];
  for (const rule of C.rules) lines.push(`  - ${rule}`);
  lines.push('append: []', 'delete: []', '');
  return lines.join('\n');
}

function normalize(text) {
  return String(text).replace(/\r\n/g, '\n').trim();
}

function readSlot(fileName) {
  if (!fileName) return null;
  try {
    return fs.readFileSync(slotPath(fileName), 'utf8');
  } catch {
    return null;
  }
}

function isManagedContent(text) {
  return typeof text === 'string' && text.startsWith(HEADER);
}

/**
 * 计算期望内容（不写盘）。
 * @returns {{ expected: Array<{slot, file, content}>, unresolved: string[], missingFiles: string[] }}
 */
function buildExpected(runtime = {}) {
  const { files } = resolveSlotFiles();
  const expectedNode = outlet.expectedNodeName();
  const expected = [];
  const unresolved = [];
  const missingFiles = [];

  // 节点槽位
  if (files.proxies) {
    const nodeContent = buildNodeYaml(runtime);
    if (nodeContent) expected.push({ slot: 'proxies', file: files.proxies, content: nodeContent });
    else if (isManagedContent(readSlot(files.proxies))) {
      // 从模式 A/B 切到模式 C：把我们写过的节点清掉
      expected.push({ slot: 'proxies', file: files.proxies, content: buildEmptyManagedYaml() });
    }
  } else unresolved.push('proxies');

  // 代理组槽位
  if (files.groups) {
    if (expectedNode) {
      const backup = runtime.backupNode || null;
      expected.push({ slot: 'groups', file: files.groups, content: buildGroupYaml(expectedNode, backup) });
    } else {
      unresolved.push('groups(未选定出口节点)');
    }
  } else unresolved.push('groups');

  // 规则槽位
  if (files.rules) expected.push({ slot: 'rules', file: files.rules, content: buildRulesYaml() });
  else unresolved.push('rules');

  return { expected, unresolved, missingFiles, files };
}

/** 与磁盘现状对比（不写盘）：返回哪些文件需要更新 */
function diffProfile(runtime = {}) {
  const { expected, unresolved, files } = buildExpected(runtime);
  const pending = [];
  const unchanged = [];
  for (const { file, content, slot } of expected) {
    const current = readSlot(file);
    if (current !== null && normalize(current) === normalize(content)) {
      unchanged.push({ slot, file });
    } else {
      pending.push({ slot, file, wouldCreate: current === null });
    }
  }
  return { pending, unchanged, unresolved, files };
}

/**
 * 同步三个扩展文件（写盘，写前备份 *.gptproxy-backup）。
 * @returns {{ changed: string[], unchanged: string[], unresolved: string[] }}
 */
function syncProfile(runtime = {}) {
  const { expected, unresolved } = buildExpected(runtime);
  const changed = [];
  const unchanged = [];
  for (const { file, content } of expected) {
    const current = readSlot(file);
    if (current !== null && normalize(current) === normalize(content)) {
      unchanged.push(file);
      continue;
    }
    const target = slotPath(file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const backup = `${target}.gptproxy-backup`;
    if (fs.existsSync(target) && !fs.existsSync(backup)) fs.copyFileSync(target, backup);
    fs.writeFileSync(target, content, { encoding: 'utf8' });
    changed.push(file);
  }
  return { changed, unchanged, unresolved };
}

module.exports = {
  HEADER,
  profilesYamlPath,
  parseProfilesRegistry,
  resolveSlotFiles,
  slotPath,
  readSlot,
  buildNodeYaml,
  buildGroupYaml,
  buildRulesYaml,
  buildExpected,
  diffProfile,
  syncProfile,
};
