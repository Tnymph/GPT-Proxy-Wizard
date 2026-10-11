'use strict';
/**
 * 清理辅助项：把本程序在系统里留下的"辅助"还原（只动我们自己做过的三件事）。
 *   1) 删除"启动服务"助手计划任务（本方案注册的 GPTProxy-StartClashService）
 *   2) 若系统代理指向本方案的端口（127.0.0.1:<mixedPort>）则关闭
 *   3) 若扩展文件仍是"我们托管的内容"，用 *.gptproxy-backup 备份还原
 *
 * 默认 **dry-run**（只列出将做什么）；加 --apply 才真正执行。
 * 不会删除：用户配置与日志（位于 %APPDATA%\GPTProxyWizard，如需彻底清理请手动删除该目录）。
 *
 * 用法：node app.js cleanup [--apply] [--keep-backups]
 */
const fs = require('fs');
const config = require('./config');
const log = require('./lib/log');
const systemproxy = require('./lib/systemproxy');
const clashProfile = require('./lib/clash-profile');
const { schTasksQuery, schTasksDelete } = require('./lib/exec');

const SLOT_KEYS = ['proxies', 'rules', 'groups'];

function banner(apply) {
  const logFile = log.initLogFile('cleanup');
  log.blank();
  log.plain('============================================================');
  log.plain('  清理辅助项（还原本方案在系统里留下的辅助设置）');
  log.plain(apply ? '  模式：APPLY（将实际执行下面的动作）' : '  模式：DRY-RUN（只列出将要执行的动作）');
  log.plain(`  日志文件：${logFile}`);
  log.plain('============================================================');
  log.blank();
}

function isManagedContent(text) {
  if (typeof text !== 'string') return false;
  return text.startsWith(clashProfile.HEADER) || /Managed by (HelpUseCodexAndGPTAPI|GPT Proxy Wizard)/i.test(text);
}

async function run(opts = {}) {
  const apply = opts.apply === true;
  const restoreBackups = opts.restoreBackups !== false;
  const facts = { taskExists: null, taskDeleted: null, proxyWasOn: false, proxyOff: false, slots: [], restored: [], wouldRestore: [], skipped: [] };

  banner(apply);

  /* 1) 助手计划任务 */
  log.step(1, '检查"启动服务"助手计划任务');
  const taskName = config.clash.serviceStartTask;
  const q = await schTasksQuery(taskName);
  facts.taskExists = q.code === 0 && !/cannot find|找不到/i.test(`${q.stdout}${q.stderr}`);
  if (!facts.taskExists) {
    log.ok(`未找到助手任务 ${taskName}（无需清理）`);
  } else if (!apply) {
    log.warn(`将删除助手任务：${taskName}（删除后"启动服务免 UAC"能力消失；下次"关闭全部"会重新注册）`);
  } else {
    const r = await schTasksDelete(taskName);
    facts.taskDeleted = r.code === 0;
    if (facts.taskDeleted) log.ok(`已删除助手任务：${taskName}`);
    else {
      log.warn(`删除助手任务失败（可能需要管理员权限）${(r.stderr || '').trim() ? '：' + (r.stderr || '').trim() : ''}`);
      log.details(['可在管理员终端里执行：schtasks /delete /tn ' + taskName + ' /f']);
    }
  }

  /* 2) 系统代理 */
  log.step(2, '检查系统代理是否由本方案设置');
  const sp = await systemproxy.read();
  const port = String(config.clash.mixedPort);
  facts.proxyWasOn = sp.enable === 1 && sp.server.includes(port);
  if (!facts.proxyWasOn) {
    log.ok(`系统代理当前不是本方案的设置（enable=${sp.enable}，server=${sp.server || '(空)'}），不改动`);
  } else if (!apply) {
    log.warn(`将关闭系统代理（当前指向 ${sp.server}）`);
  } else {
    const r = await systemproxy.ensureOff();
    facts.proxyOff = true;
    log.ok(r.changed ? '已关闭系统代理' : '系统代理本就是关闭状态');
  }

  /* 3) 扩展文件备份还原 */
  log.step(3, '检查订阅扩展文件的备份（*.gptproxy-backup）');
  const { files } = clashProfile.resolveSlotFiles();
  let foundBackup = false;
  for (const key of SLOT_KEYS) {
    const file = files[key];
    if (!file) continue;
    const target = clashProfile.slotPath(file);
    const backup = `${target}.gptproxy-backup`;
    if (!fs.existsSync(backup)) continue;
    foundBackup = true;
    const current = clashProfile.readSlot(file);
    const managed = isManagedContent(current);
    facts.slots.push({ file, managed });
    if (!managed) {
      facts.skipped.push(file);
      log.info(`${file}：发现备份，但当前内容不是我们托管的（可能被手动改过）——跳过，不还原`);
      continue;
    }
    if (!restoreBackups) {
      log.info(`${file}：可还原（已按 --keep-backups 跳过）`);
      continue;
    }
    if (!apply) {
      facts.wouldRestore.push(file);
      log.warn(`将还原 ${file}（用备份覆盖当前托管内容）`);
    } else {
      fs.copyFileSync(backup, target);
      facts.restored.push(file);
      log.ok(`已还原 ${file}（备份文件保留在同一目录）`);
    }
  }
  if (!foundBackup) log.ok('未发现扩展文件备份（无需还原）');

  /* 汇总 */
  log.blank();
  log.plain('============================================================');
  if (!apply) {
    log.plain('  结果：DRY-RUN 检查完成 —— 上面每条"将..."就是 --apply 时会执行的动作');
  } else {
    log.plain('  结果：清理完成（详见上文）');
  }
  log.plain('============================================================');
  log.plain(`  · 助手任务     ：${!facts.taskExists ? '不存在' : apply ? (facts.taskDeleted ? '已删除' : '存在（删除失败，见上文）') : '存在（将删除）'}`);
  log.plain(`  · 系统代理     ：${!facts.proxyWasOn ? '非本方案设置（未改动）' : apply ? (facts.proxyOff ? '已关闭' : '未改动，见上文') : '为本方案设置（将关闭）'}`);
  log.plain(`  · 扩展文件还原 ：${facts.restored.length ? facts.restored.join(', ') : facts.wouldRestore.length ? '将还原 ' + facts.wouldRestore.join(', ') : (facts.skipped.length ? '跳过：' + facts.skipped.join(', ') : '无')}`);
  log.plain(`  · 未删除       ：用户配置与日志（${config.APP_DIR}）`);
  log.blank();
  return { code: 0, facts };
}

module.exports = { run };
