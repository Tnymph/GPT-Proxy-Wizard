#!/usr/bin/env node
'use strict';
/**
 * 命令行入口（与界面等价的能力，便于排障、自动化与无界面环境使用）。
 *
 * 用法：node app.js <命令> [选项]
 *   start [--dry-run]          一键启动：准备代理环境并打开 ChatGPT
 *   stop  [--dry-run]          一键关闭（需要一次 UAC）
 *   open <目标> [--wait <秒>]  按配置好的位置打开某个软件并核对是否真的起来
 *                             目标：clash | roxy | window（Roxy 指纹窗口）| chatgpt
 *   check [--json] [--quick]   配置检查矩阵（只读；--quick 跳过联网项）
 *   detect [--json]            探测本机已安装的软件与路径（只读）
 *   cleanup [--apply]          清理辅助项：助手任务/系统代理/扩展文件备份（默认只列出）
 *   config path|show|init      查看配置路径 / 查看生效配置（遮罩）/ 生成配置模板
 *   version | help
 *
 * 全局选项：
 *   --config <文件>            使用指定的配置文件（默认 %APPDATA%\GPTProxyWizard\config.json）
 *   --show-sensitive           关闭日志遮罩（显示完整 IP/账号；谨慎使用）
 */
const path = require('path');
const { execFile } = require('child_process');

const VALUE_FLAGS = new Set(['config', 'wait']);

function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--') && VALUE_FLAGS.has(a.slice(2))) {
      flags[a.slice(2)] = argv[i + 1];
      i += 1;
    } else if (a.startsWith('--')) {
      flags[a.slice(2)] = true;
    } else {
      positionals.push(a);
    }
  }
  return { command: positionals[0] || '', rest: positionals.slice(1), flags };
}

const USAGE = `GPT Proxy Wizard · 命令行用法

  node app.js start [--dry-run]          一键启动：准备代理环境并打开 ChatGPT
  node app.js stop  [--dry-run]          一键关闭（需要一次 UAC）
  node app.js open <目标> [--wait <秒>]   打开软件并核对（clash / roxy / window / chatgpt）
  node app.js check [--json] [--quick]   配置检查矩阵（只读）
  node app.js detect [--json]            探测本机已安装的软件与路径（只读）
  node app.js cleanup [--apply]          清理辅助项（默认只列出；--apply 才执行）
  node app.js config path|show|init      配置查看 / 初始化
  node app.js version | help

全局选项：
  --config <文件>       指定配置文件（默认 %APPDATA%\\GPTProxyWizard\\config.json）
  --show-sensitive      关闭日志遮罩（会显示完整 IP/账号，请谨慎）
`;

/** Windows 控制台：尽量切到 UTF-8，避免中文乱码（chcp.com 是系统自带程序） */
function ensureUtf8Console() {
  if (process.platform !== 'win32' || !process.stdout.isTTY) return;
  try {
    execFile('chcp.com', ['65001'], { windowsHide: true }, () => { /* 失败无妨 */ });
  } catch { /* 忽略 */ }
}

async function main() {
  const { command, rest, flags } = parseArgs(process.argv.slice(2));
  if (flags.config) {
    // --config 会被拼进提权命令并作为文件路径使用：先做严格校验（绝对路径、不含引号/换行）
    const cfg = String(flags.config);
    if (!path.isAbsolute(cfg) || /["'\r\n]/.test(cfg)) {
      process.stderr.write('--config 必须是绝对路径，且不能包含引号或换行\n');
      return 2;
    }
    process.env.GPTWIZ_CONFIG = cfg;
  }

  if (command === 'help' || command === '' || flags.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  ensureUtf8Console();

  // 注意：配置必须在解析完 --config 之后才 require（lib 模块会读它）
  const config = require('./config');
  const log = require('./lib/log');
  if (flags['show-sensitive']) {
    log.setMasking(false);
    log.warn('已关闭日志遮罩：以下输出可能包含完整 IP / 账号，请勿直接分享');
  }

  if (command === 'version') {
    process.stdout.write(`${config.PRODUCT_NAME} v${require('../package.json').version}（Node ${process.version}）\n`);
    return 0;
  }

  const detect = require('./detect');

  switch (command) {
    case 'start': {
      const auto = await detect.autoFill();
      if (auto.notes.length) for (const n of auto.notes) log.warn(n);
      return require('./start').run({ dryRun: Boolean(flags['dry-run']) });
    }
    case 'stop': {
      const auto = await detect.autoFill();
      if (auto.notes.length) for (const n of auto.notes) log.warn(n);
      return require('./stop').run({ dryRun: Boolean(flags['dry-run']), elevated: Boolean(flags.elevated) });
    }
    case 'open': {
      // 目标名先按白名单收敛（只可能是这四个之一），再交给引擎
      const target = String(rest[0] || '').toLowerCase();
      if (!/^(clash|roxy|window|chatgpt)$/.test(target)) {
        process.stderr.write(`用法：node app.js open clash|roxy|window|chatgpt [--wait <秒>]\n`);
        return 2;
      }
      const auto = await detect.autoFill();
      if (auto.notes.length) for (const n of auto.notes) log.warn(n);
      return require('./open').run({ target, waitSec: flags.wait });
    }
    case 'check': {
      await detect.autoFill();
      return require('./check').run({ json: Boolean(flags.json), quick: Boolean(flags.quick) });
    }
    case 'cleanup': {
      const r = await require('./cleanup').run({ apply: Boolean(flags.apply), restoreBackups: !flags['keep-backups'] });
      return r.code;
    }
    case 'detect': {
      const info = await detect.detectAll();
      if (flags.json) {
        process.stdout.write(log.masked(JSON.stringify(info, null, 2)) + '\n');
      } else {
        const clash = (info.clash && info.clash.best) || '（未找到）';
        const roxy = (info.roxy && info.roxy.best) || '（未找到）';
        const pkgs = (info.chatgpt && info.chatgpt.packages) || [];
        log.blank();
        log.plain('检测结果（只读）：');
        log.plain(`  · Clash Verge ：${clash}`);
        for (const c of (info.clash && info.clash.candidates) || []) {
          if (c.exists && c.path !== clash) log.plain(`      （备选）${c.path}`);
        }
        log.plain(`  · Roxy Browser：${roxy}`);
        log.plain(`  · ChatGPT 桌面端：${pkgs.length ? pkgs.map((p) => `${p.name} ${p.version}`).join('；') : '（未安装）'}`);
        if (info.chatgpt && info.chatgpt.aumid) log.plain(`      AUMID：${info.chatgpt.aumid}`);
        log.plain(`  · Clash 数据目录：${info.dataDirs.clash.path}${info.dataDirs.clash.exists ? '' : '（不存在）'}`);
        log.plain(`  · Roxy 数据目录 ：${info.dataDirs.roxy.path}${info.dataDirs.roxy.exists ? '' : '（不存在）'}`);
        log.plain(`  · 系统：${info.os.caption}（${info.os.version}）`);
        log.blank();
        log.plain('  提示：本命令只探测、不修改任何东西；界面里的"环境自检"用的是同一套探测。');
        log.blank();
      }
      return 0;
    }
    case 'config': {
      const sub = rest[0] || 'path';
      if (sub === 'path') {
        process.stdout.write(`${config.CONFIG_PATH}\n`);
        return 0;
      }
      if (sub === 'show') {
        const clone = JSON.parse(JSON.stringify(config));
        // 不打印任何敏感值（即使关了遮罩，这里也只输出结构摘要）
        for (const key of ['password', 'username', 'host', 'expectedIp', 'expectedStaticIp', 'workspaceId', 'windowName']) {
          const scrub = (obj) => {
            if (!obj || typeof obj !== 'object') return;
            for (const k of Object.keys(obj)) {
              if (k === key && typeof obj[k] === 'string' && obj[k]) obj[k] = '<hidden>';
              else scrub(obj[k]);
            }
          };
          scrub(clone);
        }
        process.stdout.write(log.masked(JSON.stringify(clone, null, 2)) + '\n');
        return 0;
      }
      if (sub === 'init') {
        const fs = require('fs');
        const path = require('path');
        if (fs.existsSync(config.CONFIG_PATH)) {
          process.stdout.write(`配置文件已存在：${config.CONFIG_PATH}\n`);
          return 0;
        }
        const auto = await detect.autoFill();
        const template = {
          outlet: { mode: config.outlet.mode },
          clash: { appExe: config.clash.appExe, dataDir: '' },
          roxy: { appExe: config.roxy.appExe, windowName: '', workspaceId: '', expectedStaticIp: '' },
          ui: { maskSensitive: true, language: 'zh-CN' },
        };
        fs.mkdirSync(path.dirname(config.CONFIG_PATH), { recursive: true });
        fs.writeFileSync(config.CONFIG_PATH, `${JSON.stringify(template, null, 2)}\n`, 'utf8');
        process.stdout.write(`已生成配置模板：${config.CONFIG_PATH}\n`);
        process.stdout.write('（其中 windowName / workspaceId / 静态 IP 等字段需要你自己填写；界面向导会引导你完成）\n');
        if (auto.notes.length) for (const n of auto.notes) process.stdout.write(`  · ${n}\n`);
        return 0;
      }
      process.stderr.write(`未知的 config 子命令：${sub}（可用：path / show / init）\n`);
      return 2;
    }
    default:
      process.stderr.write(`未知命令：${command}\n\n${USAGE}`);
      return 2;
  }
}

main()
  .then((code) => { process.exitCode = code || 0; })
  .catch((e) => {
    process.stderr.write(`未预期的异常：${e && e.stack ? e.stack : e}\n`);
    process.exitCode = 3;
  });
