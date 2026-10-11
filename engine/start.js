'use strict';
/**
 * 程序A：一键启动 GPT。
 * 把网络环境准备到"ChatGPT 全程走所选出口（静态 IP 优先）"的状态，然后打开 ChatGPT 桌面应用，最后打印验证结果。
 * 步骤顺序（重要）：先把 Clash 与系统代理准备好，再启动 Roxy/打开窗口 ——
 * 因为 roxynet 建立"上游跳板链路"时会用到当时的系统代理，顺序错了静态通道会不通（会自动重启 Roxy 自愈）。
 * 用法：node app.js start [--dry-run]
 */
const config = require('./config');
const log = require('./lib/log');
const lock = require('./lib/lock');
const apps = require('./lib/apps');
const clashApi = require('./lib/clash-api');
const clashProfile = require('./lib/clash-profile');
const roxynet = require('./lib/roxynet');
const systemproxy = require('./lib/systemproxy');
const verify = require('./lib/verify');
const outlet = require('./lib/outlet');
const { installWatchdog } = require('./lib/exec');

function banner(dryRun) {
  const logFile = log.initLogFile('start');
  log.blank();
  log.plain('============================================================');
  log.plain('  GPT Proxy Wizard · 启动 GPT（自动配置网络代理 → 打开 ChatGPT）');
  log.plain(`  出口模式：${outlet.describe().label}（${outlet.describe().detail}）`);
  if (dryRun) log.plain('  模式：DRY-RUN（只检查与汇报，不做任何修改）');
  log.plain(`  日志文件：${logFile}`);
  log.plain('============================================================');
  log.blank();
}

/** 打印错误与提示，返回退出码 2 */
function fatal(message, hints = []) {
  log.err(message);
  log.details(hints);
  return 2;
}

/** 是否配置了真实的"预期静态 IP"（占位符/空则跳过比对） */
function expectedStaticIp() {
  const values = [config.roxy.expectedStaticIp, config.outlet.static.expectedIp];
  for (const value of values) {
    const v = value || '';
    if (v.length > 0 && !v.startsWith('<')) return v;
  }
  return '';
}

async function openRoxyWindowWithChecks(dirId, dryRun) {
  if (!config.roxy.workspaceId) {
    return fatal('缺少 Roxy 工作区 ID，无法自动打开窗口', [
      '在界面向导的"出口来源"里填写 Roxy 工作区 ID，或手动打开该窗口后重试',
    ]);
  }
  if (dryRun) {
    log.warn(`（dry-run）窗口未打开；实际运行时会自动启动 Roxy 并用 dirId 打开窗口`);
    return false;
  }
  log.info('正在请求打开指纹窗口 ...');
  const launched = await apps.openRoxyWindow(dirId);
  if (launched && launched.ok === false) {
    return fatal(`启动 Roxy 失败：${launched.error}`, ['请在设置里确认 Roxy 的安装文件夹是否正确']);
  }
  const up = await verify.waitFor('Roxy 本地服务', config.timeouts.windowWaitMs, () => verify.checkPort(config.roxy.localHttpPort));
  if (!up) return fatal('Roxy 主程序启动后本地服务未就绪', [`请手动打开 ${config.roxy.appExe || 'RoxyBrowser'} 后重试`]);
  return true;
}

async function run(opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const facts = {
    proxyPort: null, dirId: null, staticIp: null, staticOrg: null,
    clashChanged: [], delayMs: null, routing: null, appProof: null,
    egress: null, groupNow: null, autostart: null, roxyRestarted: false,
  };

  banner(dryRun);
  const l = lock.acquire('start');
  if (!l.acquired) {
    log.err(`已有启动程序在运行（PID ${l.holder.pid}），本次退出`);
    return 1;
  }
  // 看门狗：防止某个外部命令卡死导致流程永远挂着。
  // 注意：必须在 finally 里 clearTimeout —— 界面模式（Electron 主进程内运行）下，
  // 残留的定时器会在 10 分钟后把整个界面进程杀掉（曾经的真实 bug）。
  const watchdogMinutes = Number(process.env.GPTWIZ_WATCHDOG_MIN || 10);
  const watchdog = installWatchdog(watchdogMinutes, () => {
    if (opts.watchdogExit === false) {
      log.err(`运行超过 ${watchdogMinutes} 分钟（界面模式：不强制退出程序，请检查是否有外部命令卡住）`);
      return;
    }
    log.err(`运行超过 ${watchdogMinutes} 分钟，强制退出（可能某个外部命令无响应）`);
    process.exit(3);
  });

  try {
    /* ---------- 步骤 1：环境自检 ---------- */
    log.step(1, '环境自检');
    log.ok(`应用目录：${config.APP_DIR}`);
    log.ok(`配置文件：${config.CONFIG_PATH}${config.IS_FIRST_RUN ? '（尚未创建，正在用默认值 + 自动探测）' : ''}`);
    log.ok(`Node 版本：${process.version}`);
    log.ok(`Clash Verge：${config.clash.appExe || '（未找到，请稍后在设置里指定）'}`);
    if (outlet.usesRoxy()) log.ok(`Roxy Browser：${config.roxy.appExe || '（未找到，请稍后在设置里指定）'}`);

    if (config.clash.appExe === '') {
      return fatal('未找到 Clash Verge 的安装位置', [
        '请确认已安装 Clash Verge（官网下载安装即可）',
        '或在设置里手动指定 clash-verge.exe 所在的文件夹',
      ]);
    }
    if (outlet.usesRoxy() && config.roxy.appExe === '') {
      return fatal('未找到 Roxy Browser 的安装位置', [
        '出口模式为 Roxy 静态 IP 时需要它；如果不想用 Roxy，可在设置里改用"自备静态 IP"或"订阅美国节点"模式',
      ]);
    }

    /* ---------- 步骤 2：Clash 后台服务 ---------- */
    log.step(2, '确保 Clash 后台服务在运行');
    {
      const state = await apps.getClashServiceState();
      log.info(`服务状态：${state}`);
      if (state === 'RUNNING') {
        log.ok('后台服务已在运行');
      } else if (state === 'NOTFOUND') {
        log.warn('未找到 Clash Verge 服务（可能未以服务模式安装），TUN 可能不可用');
      } else if (dryRun) {
        log.warn('（dry-run）服务处于停止状态；实际运行时会用助手任务把它拉起来');
      } else {
        const started = await apps.ensureClashServiceRunning();
        if (!started.ok) {
          return fatal(`无法启动 Clash 后台服务：${started.reason}`, [
            '若这是首次使用，请先执行一次"关闭全部"来注册助手任务（需要一次 UAC）',
            '或者手动启动一次 Clash Verge（它会自行拉起服务）',
          ]);
        }
        log.ok('后台服务已启动（无需 UAC）');
      }
    }

    /* ---------- 步骤 3：Clash 应用 + 系统代理(必须先于 Roxy) ---------- */
    log.step(3, '确保 Clash Verge 应用、内核与系统代理就绪');
    {
      if (await apps.isClashAppRunning(true)) {
        log.ok('Clash Verge 已在运行');
      } else if (dryRun) {
        log.warn('（dry-run）Clash Verge 未运行；实际运行时会自动启动');
      } else {
        log.info('Clash Verge 未运行，正在启动 ...');
        const launched = await apps.launchClash();
        if (launched && launched.ok === false) {
          return fatal(`启动 Clash Verge 失败：${launched.error}`, ['请在设置里确认安装文件夹是否正确']);
        }
        const up = await verify.waitFor('内核端口', config.timeouts.stepWaitMs, () => verify.checkPort(config.clash.mixedPort));
        if (!up) return fatal('Clash Verge 启动后内核未就绪', ['请手动打开 Clash Verge 检查内核状态']);
        log.ok('Clash Verge 已启动，内核就绪');
      }

      const server = `127.0.0.1:${config.clash.mixedPort}`;
      if (dryRun) {
        const on = await verify.checkSystemProxyOn();
        log.warn(`（dry-run）当前系统代理${on ? '已正确' : '需要修正'}（目标：${server}）`);
      } else {
        const r = await systemproxy.ensureOn(server);
        log.ok(r.changed ? `已开启系统代理并指向 ${server}` : `系统代理已是 ${server}`);
      }
    }

    /* ---------- 步骤 4：指纹窗口（仅 Roxy 模式） ---------- */
    log.step(4, '确保指纹窗口已打开');
    if (!outlet.usesRoxy()) {
      log.info(`当前出口模式为「${outlet.describe().label}」，不需要 Roxy 指纹窗口，跳过`);
    } else {
      const dirId = roxynet.findDirIdByWindowName(config.roxy.windowName);
      if (!dirId) {
        return fatal(`找不到窗口「${config.roxy.windowName}」（本地数据里没有该窗口）`, [
          '请在 Roxy 里确认窗口名，或在向导的"出口来源"里重新选择窗口',
        ]);
      }
      facts.dirId = dirId;
      const existing = await roxynet.findOpenWindow(dirId, config.roxy.windowName, true);
      if (existing) {
        log.ok(`窗口已打开（dirId=${dirId}，PID=${existing.pid}）`);
      } else {
        const started = await openRoxyWindowWithChecks(dirId, dryRun);
        if (started !== true) {
          if (dryRun) { /* dry-run：继续走后续只读检查 */ } else return started;
        } else {
          const win = await roxynet.waitForWindow(dirId, config.roxy.windowName, config.timeouts.windowWaitMs);
          if (!win) {
            return fatal('窗口打开超时', [
              '请在 Roxy 界面里手动打开该窗口后重试本程序',
              '（可选）在 Roxy 设置里开启本地 API，之后本程序可更可靠地自动开关窗口',
            ]);
          }
          log.ok(`窗口已打开（dirId=${win.dirId}，PID=${win.pid}）`);
        }
      }
    }

    /* ---------- 步骤 5：roxynet 端口（仅 Roxy 模式） ---------- */
    log.step(5, '探测 roxynet 本地代理口（动态端口）');
    if (!outlet.usesRoxy()) {
      log.info('跳过（非 Roxy 模式）');
    } else {
      const port = await roxynet.findProxyPort();
      if (!port) {
        if (dryRun) {
          log.warn('（dry-run）未找到 roxynet 代理口（窗口未打开时属正常）');
        } else {
          return fatal('未找到 roxynet 代理口（roxynet 未运行或窗口未打开）', [
            '确认 Roxy 窗口已打开（窗口打开时 roxynet 会自动运行）',
            `可查看日志：${config.roxy.userDataDir}\\logs\\`,
          ]);
        }
      } else {
        facts.proxyPort = port;
        log.ok(`roxynet 代理口：127.0.0.1:${port}`);
      }
    }

    /* ---------- 步骤 6：出口通道校验（按模式） ---------- */
    log.step(6, '校验出口通道');
    if (outlet.mode() === 'roxy') {
      log.info('经 roxynet 请求 ipinfo，最多重试 3 次');
      if (dryRun || !facts.proxyPort) {
        log.warn('（dry-run 或端口未知）跳过实际请求');
      } else {
        let info = await roxynet.checkStaticEgress(facts.proxyPort, facts.dirId);
        if (!info) {
          const proxyOn = await verify.checkSystemProxyOn();
          const clashUp = await verify.checkPort(config.clash.mixedPort);
          if (proxyOn && clashUp) {
            log.warn('静态通道不通 —— 正在重启 Roxy 以重建走系统代理的上游链路（约 30 秒）...');
            await apps.closeRoxyAll();
            await apps.openRoxyWindow(facts.dirId);
            const up = await verify.waitFor('Roxy 本地服务', config.timeouts.windowWaitMs, () => verify.checkPort(config.roxy.localHttpPort));
            if (up) {
              const win = await roxynet.waitForWindow(facts.dirId, config.roxy.windowName, config.timeouts.windowWaitMs);
              if (win) {
                facts.roxyRestarted = true;
                facts.proxyPort = await roxynet.findProxyPort();
                log.info(`重建后 roxynet 代理口：${facts.proxyPort}`);
                if (facts.proxyPort) info = await roxynet.checkStaticEgress(facts.proxyPort, facts.dirId);
              }
            }
          } else {
            log.warn(`跳过自愈：系统代理${proxyOn ? '正常' : '未开启'}、Clash${clashUp ? '正常' : '未就绪'}`);
          }
        }
        if (!info) {
          if (config.clash.groupType === 'select') {
            log.err('静态 IP 通道不通，且当前为严格模式：GPT 将无法联网（不会使用任何其它 IP）');
          } else {
            log.warn('静态 IP 通道当前不通（将回退到订阅美国节点；GPT 仍会打开）');
          }
          log.details([
            '常见原因：静态 IP 服务端临时不可用；或 Roxy 窗口自身的上游代理配置有问题',
            `可查看 Roxy 日志：${config.roxy.userDataDir}\\logs\\`,
          ]);
        } else {
          facts.staticIp = info.ip;
          facts.staticOrg = info.org;
          log.ok(`静态 IP 出口：${info.ip}（${info.country} / ${info.city} / ${info.org}）`);
          if (info.country !== 'US') log.warn(`注意：当前出口国家是 ${info.country}，不是 US，请检查 Roxy 窗口的代理配置`);
          const expected = expectedStaticIp();
          if (expected && info.ip !== expected) {
            log.warn('当前 IP 与配置的预期不同；若你更换过静态 IP，请在设置里更新');
          }
        }
      }
    } else if (outlet.mode() === 'static') {
      const s = config.outlet.static;
      if (!s.host || !s.port) {
        return fatal('尚未配置自备静态 IP（主机 / 端口）', ['请在向导的"出口来源"里填写 socks5/http 服务器信息']);
      }
      if (dryRun) {
        log.warn('（dry-run）跳过实际请求');
      } else {
        log.info(`直连校验上游 ${s.type}://${s.host}:${s.port} ...`);
        const info = await verify.egressViaStaticUpstream();
        if (!info) {
          if (config.clash.groupType === 'select') {
            log.err('静态 IP 上游不可达，且当前为严格模式：GPT 将无法联网（不会使用任何其它 IP）');
          } else {
            log.warn('静态 IP 上游当前不可达（将回退到订阅美国节点；GPT 仍会打开）');
          }
          log.details(['请检查服务器地址/端口/账号密码是否正确，以及该静态 IP 是否仍在有效期内']);
        } else {
          facts.staticIp = info.ip;
          facts.staticOrg = info.org;
          log.ok(`静态 IP 出口：${info.ip}（${info.country} / ${info.city} / ${info.org}）`);
          if (info.country !== 'US') log.warn(`注意：当前出口国家是 ${info.country}，不是 US`);
          const expected = expectedStaticIp();
          if (expected && info.ip !== expected) log.warn('当前 IP 与配置的预期不同（仅提示，不影响使用）');
        }
      }
    } else {
      // 订阅模式：兜底方案（非静态 IP）
      log.warn('当前出口为"订阅美国节点"兜底模式：能用且在美国，但**不是静态 IP**');
      if (!config.outlet.subscription.selectedNode) {
        const picked = await clashApi.findLeafByName(outlet.backupMatchers()).catch(() => null);
        if (picked) {
          config.outlet.subscription.selectedNode = picked;
          log.info(`已自动选取订阅美国节点：${picked}（可在设置里固定）`);
        } else {
          log.warn('订阅里暂未找到美国节点（稍后重试或在设置里手动指定节点名）');
        }
      } else {
        log.info(`使用订阅节点：${config.outlet.subscription.selectedNode}`);
      }
    }

    /* ---------- 步骤 7：同步扩展文件 ---------- */
    log.step(7, '同步 Clash 扩展文件（自定义节点 / 代理组 / 规则）');
    let profile = { changed: [], pending: 0 };
    if (dryRun) {
      const diff = clashProfile.diffProfile({ proxyPort: facts.proxyPort, dirId: facts.dirId });
      profile.pending = diff.pending.length;
      if (diff.unresolved.length) log.warn(`扩展槽位未就绪：${diff.unresolved.join('、')}`);
      log.warn('（dry-run）跳过写入；实际运行时会更新以下文件：');
      log.details(diff.pending.map((p) => `${clashProfile.slotPath(p.file)}${p.wouldCreate ? '（将新建）' : ''}`));
      if (diff.pending.length === 0) log.info('（当前内容已是最新，实际运行时无需改动）');
    } else {
      let backup = null;
      if (config.clash.groupType === 'fallback' && outlet.mode() !== 'subscription') {
        backup = await clashApi.findLeafByName(outlet.backupMatchers()).catch(() => null);
        if (!backup) log.warn('未在订阅里找到美国备用节点（回退兜底将不可用）');
        else log.info(`备用节点（回退用）：${backup}`);
      }
      const result = clashProfile.syncProfile({ proxyPort: facts.proxyPort, dirId: facts.dirId, backupNode: backup });
      profile = result;
      facts.clashChanged = result.changed;
      if (result.unresolved.length) {
        return fatal(`扩展槽位未就绪：${result.unresolved.join('、')}`, [
          '请在 Clash Verge 里对当前订阅点一次"编辑节点/编辑规则/编辑代理组"（生成扩展文件），然后重试',
          '或在设置里手动填写三个扩展文件名',
        ]);
      }
      if (result.changed.length === 0) {
        log.ok('扩展文件内容已是最新，无需改动');
      } else {
        log.ok(`已更新 ${result.changed.length} 个扩展文件：${result.changed.join(', ')}`);
        log.info('（原文件已备份为 *.gptproxy-backup）');
      }
    }

    /* ---------- 步骤 8：Clash 就绪核对 ---------- */
    log.step(8, '等待 Clash 代理就绪并确认自定义节点/组/规则已加载');
    {
      const profileChanged = profile.changed.length > 0 || (dryRun && profile.pending > 0);
      let nodes = await verify.checkNodes().catch(() => null);
      let rulesState = await verify.checkRunningRules().catch(() => ({ ok: false, missing: ['（无法读取）'] }));
      const needReload = profileChanged || !nodes || !rulesState.ok;
      if (needReload && !profileChanged && !rulesState.ok && rulesState.missing.length) {
        log.info(`内核尚未加载 ${rulesState.missing.length} 条本项目规则（例如 ${rulesState.missing[0]}）`);
      }
      if (needReload) {
        if (dryRun) {
          log.warn('（dry-run）需要重启 Clash 才能让改动生效；实际运行时会执行');
        } else {
          log.info('正在重启 Clash Verge 以重新生成配置（会短暂中断现有连接）...');
          await apps.closeClashAppOnly();
          const launched = await apps.launchClash();
          if (launched && launched.ok === false) return fatal(`重启 Clash 失败：${launched.error}`);
          const up = await verify.waitFor('内核端口', config.timeouts.stepWaitMs, () => verify.checkPort(config.clash.mixedPort));
          if (!up) return fatal('重启后 Clash 内核未就绪', ['请手动打开 Clash Verge 检查']);
          nodes = await verify.waitFor('自定义节点加载', config.timeouts.stepWaitMs, () => verify.checkNodes().catch(() => null));
          const rulesAfter = await verify.waitFor('规则加载', config.timeouts.stepWaitMs, async () => {
            const s = await verify.checkRunningRules().catch(() => ({ ok: false, missing: [] }));
            return s.ok ? s : null;
          });
          if (!rulesAfter) log.warn('重启后仍未在运行配置里看到全部本项目规则（可稍后重跑本程序复查）');
        }
      }
      if (!nodes) {
        if (dryRun) {
          log.warn('（dry-run）未能确认节点/组加载（dry-run 不写入扩展文件，属预期）');
        } else if (!needReload) {
          return fatal('Clash 中未找到自定义节点/组', [
            '请确认扩展文件已写入，并在 Clash Verge 界面里手动"重新载入配置"后重试',
          ]);
        } else {
          log.warn('重启后仍未找到自定义节点/组（可稍后重跑本程序复查）');
        }
      } else {
        const tun = await verify.checkTunAdapter();
        if (tun) log.ok('TUN 网卡已就绪（Rust 后端与一切子进程都会被代理接管）');
        else log.warn('未检测到 TUN 网卡：codex 后端可能不走代理，请检查 Clash Verge 的 TUN 开关与管理员权限');
        const expectedNode = outlet.expectedNodeName();
        log.ok(`节点 ${expectedNode} 与组 ${config.clash.groupName} 已加载（组当前选择：${nodes.groupNow}）`);
        if (config.clash.groupType === 'select' && nodes.groupNow !== expectedNode && expectedNode) {
          const r = await clashApi.selectProxy(config.clash.groupName, expectedNode);
          if (r.status === 204) log.ok(`严格模式：已把 ${config.clash.groupName} 的选择钉在 ${expectedNode}`);
          else log.warn(`严格模式：钉住节点选择失败（HTTP ${r.status}）`);
        }
      }
    }

    /* ---------- 步骤 9：节点连通性 ---------- */
    log.step(9, '节点连通性测试（经本项目组访问 chatgpt.com）');
    if (dryRun) {
      log.warn('（dry-run）跳过实际测速');
    } else {
      const delay = await verify.checkNodeDelay(outlet.expectedNodeName(), 3, 'https://chatgpt.com');
      if (!delay) {
        log.warn('组测速未通过（chatgpt.com 暂不可达；刚重启过 Clash 时偶发）。以第 12 步的实测出口为准，必要时重跑本程序复查。');
      } else {
        facts.delayMs = delay;
        log.ok(`测速成功：${delay} ms`);
      }
    }

    /* ---------- 步骤 10：自启任务 ---------- */
    log.step(10, '检查 ChatGPT 开机自启（防止无代理裸启动）');
    if (!config.flags.guardChatGPTAutostart) {
      log.info('已按配置跳过');
    } else if (dryRun) {
      log.warn('（dry-run）跳过修改');
    } else {
      const r = await apps.ensureChatGPTAutostartDisabled();
      facts.autostart = r;
      if (r.ok) log.ok('开机自启已处于"用户禁用"状态（正常）');
      else if (r.changed) log.ok('检测到开机自启被启用，已关闭（任务管理器"启动"页可改回）');
      else log.warn(`开机自启状态未变更（state=${r.state}）${r.note ? '：' + r.note : ''}`);
    }

    /* ---------- 步骤 11：打开应用 ---------- */
    log.step(11, '打开 ChatGPT 桌面应用');
    if (await apps.isChatGPTRunning(true)) {
      log.ok('ChatGPT 已在运行（将聚焦已有窗口）');
    } else if (dryRun) {
      log.warn('（dry-run）不实际打开应用');
    } else {
      await apps.launchChatGPT();
      const up = await verify.waitFor('ChatGPT 进程', config.timeouts.appLaunchWaitMs, () => apps.isChatGPTRunning(true));
      if (!up) return fatal('ChatGPT 应用启动超时', ['可手动打开开始菜单里的 ChatGPT 验证应用本身是否正常']);
      log.ok('ChatGPT 应用已启动');
    }

    /* ---------- 步骤 12：终检 ---------- */
    log.step(12, '终检：确认 GPT 流量全程走所选出口');
    if (dryRun) {
      log.warn('（dry-run）跳过真实性验证');
    } else {
      const routing = await verify.routingProof().catch(() => null);
      facts.routing = routing;
      if (routing) log.ok(`分流证据：chains=[${routing.chains.join(' → ')}]，规则=${routing.rule}，域名=${routing.host}`);
      else log.warn('未抓到新建连接的分流证据（稍后可重跑本程序查看）');

      if (config.flags.deepVerifyEgress) {
        log.info('正在实测"当前生效路径"的出口 IP（经规则路径请求 ipinfo.io）...');
        const egress = await verify.egressViaGroup().catch(() => null);
        facts.egress = egress;
        if (egress) {
          const via = egress.chains ? `，链路=[${egress.chains.join(' → ')}]` : '';
          log.ok(`实测出口：${egress.ip}（${egress.country} / ${egress.city} / ${egress.org}）${via}`);
          if (egress.country !== 'US') log.warn('出口不是美国！请检查出口通道配置');
          const expected = expectedStaticIp();
          if (expected && egress.ip === expected) log.ok('出口 IP 与预期的美国静态 IP 一致');
          else if (expected) log.warn('出口 IP 与预期静态 IP 不同 —— 说明当时不是那条链路');
        } else {
          log.warn('出口校验失败（不改动任何设置）');
        }
      }

      facts.groupNow = await verify.getGroupNow().catch(() => null);
      if (facts.groupNow === outlet.expectedNodeName()) {
        log.ok(`当前生效节点：${facts.groupNow}${outlet.isStaticGuaranteed() ? '（静态 IP 出口）' : '（订阅节点）'}`);
      } else if (facts.groupNow) {
        log.warn(`当前生效节点：${facts.groupNow}（备用节点；静态 IP 通道当时不可用）`);
      }

      const proof = await verify.waitFor('ChatGPT 应用流量分流证据', 20000, () => verify.chatgptAppTrafficProof().catch(() => null));
      facts.appProof = proof;
      if (proof) log.ok(`应用自身流量已走本项目节点：chains=[${proof.chains.join(' → ')}]，host=${proof.host}`);
      else log.info('暂未观察到 ChatGPT 应用自身的 OpenAI 流量（应用可能还在启动，正常使用后即可生效）');
    }

    /* ---------- 汇总 ---------- */
    log.blank();
    log.plain('============================================================');
    if (dryRun) {
      log.plain('  结果：DRY-RUN 检查完成 —— 上面每条"将..."就是实际运行时会执行的动作');
      log.plain('============================================================');
      log.blank();
      return 0;
    }
    log.plain('  结果：GPT 已启动，网络环境就绪');
    log.plain('============================================================');
    log.plain(`  · 出口模式             ：${outlet.describe().label}`);
    log.plain(`  · 静态 IP 出口         ：${facts.staticIp || '（未验证）'}${facts.staticOrg ? '（' + facts.staticOrg + '）' : ''}`);
    log.plain(`  · 当前生效节点         ：${facts.groupNow || '（未知）'}${facts.groupNow === outlet.expectedNodeName() ? '  ← 本通道' : ''}`);
    log.plain(`  · 节点测速             ：${facts.delayMs ? facts.delayMs + ' ms' : '（未通过/未测）'}`);
    log.plain(`  · 实测出口（规则路径） ：${facts.egress ? facts.egress.ip + '（' + facts.egress.country + '）' : '（未执行）'}`);
    log.plain(`  · 分流证据             ：${facts.routing ? facts.routing.chains.join(' → ') : '（未观察到）'}`);
    log.plain(`  · 扩展文件变更         ：${facts.clashChanged.length ? facts.clashChanged.join(', ') : '无（已是最新）'}`);
    if (facts.roxyRestarted) log.plain('  · 备注                 ：本次重启过 Roxy 以重建静态 IP 链路');
    log.blank();
    log.plain('  日常关闭请使用"关闭全部"命令 / 界面按钮。');
    log.blank();
    return 0;
  } finally {
    clearTimeout(watchdog);
    lock.release('start');
  }
}

module.exports = { run };
