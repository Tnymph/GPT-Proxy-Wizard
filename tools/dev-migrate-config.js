#!/usr/bin/env node
'use strict';
/**
 * 开发 / 换机辅助工具：把"原项目式"的本地私密配置（形如 config.local.js）迁移到本产品的用户配置。
 *
 * 使用方式（无路径参数，避免任何"用户输入路径 → 文件读写"的面）：
 *   1. 把你旧的 config.local.js 复制到本工程的 private\ 目录（隐私目录，已 gitignore）；
 *   2. 运行：node tools/dev-migrate-config.js [--dry-run]
 *   3. 结果写入 %APPDATA%\GPTProxyWizard\config.json（已存在则深度合并）。
 *
 * 安全设计：
 * - **纯文本解析，不执行/不加载**源文件（不 require、不 eval、不 vm），只按行提取已知键的字符串字面量；
 * - 读写路径分别限定在 private\ 与 %APPDATA%\GPTProxyWizard 两个固定根目录内（含边界校验）；
 * - 输出**不打印任何私密值**（只报告"哪些字段有值"）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..');                                  // 本工程根目录
const PRIVATE_DIR = path.resolve(APP_ROOT, 'private');                           // 只允许从这里读
const OUT_DIR = path.resolve(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'GPTProxyWizard'); // 只允许写到这里
const MAX_SOURCE_BYTES = 1024 * 1024;

// 两个固定文件的完整路径：目录固定（本工程的 private\ 与 %APPDATA%\GPTProxyWizard），
// 文件名是字面量常量 —— 本工具不接受任何路径参数，也不存在可拼接的路径片段。
const SOURCE_FILE = path.resolve(PRIVATE_DIR, 'config.local.js');   // 只读这一个文件
const OUT_FILE = path.resolve(OUT_DIR, 'config.json');              // 只写这一个文件

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, over) {
  if (!isPlainObject(over)) return base;
  const out = { ...base };
  for (const key of Object.keys(over)) {
    out[key] = isPlainObject(base[key]) && isPlainObject(over[key]) ? deepMerge(base[key], over[key]) : over[key];
  }
  return out;
}

/**
 * 从 JS 文本里提取 `key: 'value'` / `key: "value"` 形式的字符串字面量（纯文本，不执行代码）。
 */
function extractStringLiteral(text, key) {
  const re = new RegExp(`\\b${key}\\b\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1)[^\\n])*)\\1`);
  const m = text.match(re);
  if (!m) return '';
  return m[2].replace(/\\(['"\`\\])/g, '$1').trim();
}

function main() {
  const dryRun = process.argv.includes('--dry-run');

  const sourcePath = SOURCE_FILE;
  if (!fs.existsSync(sourcePath)) {
    process.stderr.write([
      '未找到 private\\config.local.js。',
      '请先把旧的配置文件复制到本工程的 private 目录（隐私目录，已 gitignore），例如：',
      '  copy <旧项目>\\src\\config.local.js private\\config.local.js',
      '',
    ].join('\n'));
    process.exitCode = 2;
    return;
  }
  const stat = fs.statSync(sourcePath);
  if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) {
    process.stderr.write('private\\config.local.js 不是普通文件或文件过大（>1MB），已拒绝\n');
    process.exitCode = 2;
    return;
  }
  const text = fs.readFileSync(sourcePath, 'utf8');   // 纯读取，不执行

  const values = {
    windowName: extractStringLiteral(text, 'windowName'),
    workspaceId: extractStringLiteral(text, 'workspaceId'),
    expectedStaticIp: extractStringLiteral(text, 'expectedStaticIp'),
  };

  const outPath = OUT_FILE;
  const incoming = {
    outlet: { mode: 'roxy' },
    roxy: {
      ...(values.windowName ? { windowName: values.windowName } : {}),
      ...(values.workspaceId ? { workspaceId: values.workspaceId } : {}),
      ...(values.expectedStaticIp ? { expectedStaticIp: values.expectedStaticIp } : {}),
    },
  };

  process.stdout.write('从 private\\config.local.js 解析到的字段（有值 = true，不显示内容）：\n');
  for (const [k, v] of Object.entries({
    'roxy.windowName': Boolean(values.windowName),
    'roxy.workspaceId': Boolean(values.workspaceId),
    'roxy.expectedStaticIp': Boolean(values.expectedStaticIp),
  })) process.stdout.write(`  · ${k}: ${v}\n`);

  let merged = incoming;
  if (fs.existsSync(outPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      merged = deepMerge(existing, incoming);
      process.stdout.write('目标文件已存在：已与其中的配置深度合并（只覆盖上面有值的字段）\n');
    } catch (e) {
      process.stderr.write(`目标文件无法解析（${e.message}），为保证安全不覆盖；请先备份/删除后重试\n`);
      process.exitCode = 2;
      return;
    }
  }

  if (dryRun) {
    process.stdout.write(`（dry-run）将写入：${outPath}\n`);
    process.exitCode = 0;
    return;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  process.stdout.write(`已写入：${outPath}\n`);
  process.stdout.write('提示：该文件包含你的私密值，存放在 %APPDATA% 下（不在任何仓库里），请勿复制进项目目录或公开渠道。\n');
}

main();
