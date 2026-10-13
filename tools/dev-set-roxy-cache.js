#!/usr/bin/env node
'use strict';
/**
 * 开发 / 换机辅助工具：探测本机的"Roxy 缓存根目录"并写入用户配置（roxy.browserCacheDirsExtra）。
 *
 * 使用方式（无路径参数，避免任何"用户输入路径 → 文件读写"的面）：
 *   1. 在 Roxy 里正常使用（窗口数据已生成）；
 *   2. 运行：node tools/dev-set-roxy-cache.js [--dry-run]
 *   3. 结果写入 %APPDATA%\GPTProxyWizard\config.json（已存在则只更新该字段）。
 *
 * 说明：程序运行期（启动/检查/打开窗口）也会在"找不到配置的窗口"时自动探测一次（内存态）；
 * 本工具的作用是把探测结果**固化**到配置文件里，便于核对与长期稳定。
 *
 * 安全设计：读写路径固定（本工程的探测逻辑 + %APPDATA%\GPTProxyWizard\config.json），
 * 输出不打印任何私密值（只报告路径与字段是否写成功）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const detect = require('../engine/detect');

const OUT_DIR = path.resolve(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'GPTProxyWizard'); // 只允许写到这里
const OUT_FILE = path.resolve(OUT_DIR, 'config.json');  // 只写这一个文件（文件名是字面量常量）

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const found = detect.probeRoxyCacheRoots();

  process.stdout.write('探测到含窗口数据的 Roxy 缓存目录：\n');
  if (!found.length) {
    process.stdout.write('  （无）—— 若你改过 Roxy 的「浏览器缓存目录」，请先在 Roxy 里打开一次窗口再重试；\n');
    process.stdout.write('  也可以直接在界面「设置 → Roxy 缓存根目录」里手动填写。\n');
    process.exitCode = 1;
    return;
  }
  for (const dir of found) process.stdout.write(`  · ${dir}\n`);

  let existing = {};
  if (fs.existsSync(OUT_FILE)) {
    try {
      let text = fs.readFileSync(OUT_FILE, 'utf8');
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);   // 容忍带 BOM 的文件
      existing = JSON.parse(text);
    } catch (e) {
      process.stderr.write(`目标文件无法解析（${e.message}），为保证安全不覆盖；请先备份/删除后重试\n`);
      process.exitCode = 2;
      return;
    }
  }
  const merged = { ...existing };
  if (!isPlainObject(merged.roxy)) merged.roxy = {};
  const prev = Array.isArray(merged.roxy.browserCacheDirsExtra) ? merged.roxy.browserCacheDirsExtra : [];
  const next = [...prev];
  for (const dir of found) {
    if (!next.some((x) => String(x).toLowerCase() === dir.toLowerCase())) next.push(dir);
  }
  const changed = next.length !== prev.length;
  merged.roxy.browserCacheDirsExtra = next;

  if (dryRun) {
    process.stdout.write(`（dry-run）将写入：${OUT_FILE}（当前 ${prev.length} 项 → ${next.length} 项）\n`);
    return;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  process.stdout.write(`已写入：${OUT_FILE}（${changed ? `新增 ${next.length - prev.length} 项` : '内容无变化'}）\n`);
  process.stdout.write('提示：该文件在 %APPDATA% 下（不在任何仓库里），请勿复制进项目目录或公开渠道。\n');
}

main();
