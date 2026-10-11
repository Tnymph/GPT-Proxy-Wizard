'use strict';
/**
 * 开发用回归（不随产物分发）：验证"看门狗定时器在任务结束后被清掉"。
 *
 * 背景：看门狗是为了防止外部命令卡死；但它曾经没被清理，导致界面模式（引擎跑在
 * Electron 主进程里）在用过一次「启动 GPT / 关闭全部」之后，10 分钟后整个界面进程被误杀。
 *
 * 做法：在 Electron 主进程里跑一次 dry-run（read-only；故意不传 watchdogExit:false，
 *       走"会强杀"的严格分支），看门狗设 1 分钟；dry-run 结束后再等 75 秒。
 *       若定时器没被清掉，进程会在 1 分钟处被 process.exit(3) 杀掉。
 *
 * 用法：GPTWIZ_WATCHDOG_MIN=1 ./node_modules/electron/dist/electron.exe tools/dev-watchdog-smoke.js
 */
const { app } = require('electron');
const start = require('../engine/start');
const detect = require('../engine/detect');
const log = require('../engine/lib/log');

log.setConsoleEnabled(true);

app.whenReady().then(async () => {
  const t0 = Date.now();
  await detect.autoFill();                 // 与界面一致：先探测安装位置
  const code = await start.run({ dryRun: true });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  process.stdout.write(`[smoke] dry-run 结束 code=${code}，耗时 ${secs}s\n`);
  process.stdout.write('[smoke] 等待超过看门狗时间，验证定时器是否已被清掉…\n');
  setTimeout(() => {
    process.stdout.write('[smoke] PASS：超过看门狗时间仍在运行 → 定时器已清除（不会再误杀界面进程）\n');
    app.exit(0);
  }, Number(process.env.SMOKE_WAIT_MS || '75000'));
});
