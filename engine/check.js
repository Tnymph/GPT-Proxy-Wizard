'use strict';
/**
 * 检查矩阵（只读）：逐项给出 通过/失败/警告/跳过 + 失败时的"下一步"。
 * 用法：node app.js check [--json] [--quick]
 *   --quick：跳过联网项目（分流证据 / 实测出口 / 应用流量 / 通道可达），用于仪表盘快速刷新。
 */
const config = require('./config');
const log = require('./lib/log');
const apps = require('./lib/apps');
const clashApi = require('./lib/clash-api');
const clashProfile = require('./lib/clash-profile');
const roxynet = require('./lib/roxynet');
const systemproxy = require('./lib/systemproxy');
const verify = require('./lib/verify');
const outlet = require('./lib/outlet');

const STATUS = { PASS: 'pass', FAIL: 'fail', WARN: 'warn', SKIP: 'skip' };

async function collect({ quick = false } = {}) {
  const items = [];
  const add = (id, title, status, detail, next = []) => items.push({ id, title, status, detail, next: next || [] });

  /* 1. Clash 服务 / 应用 / 内核 */
  {
    const serviceState = await apps.getClashServiceState().catch(() => 'UNKNOWN');
    const appRunning = await apps.isClashAppRunning(true).catch(() => false);
    const portOn = await verify.checkPort(config.clash.mixedPort).catch(() => false);
    let pipeOk = false;
    let coreVersion = '';
    try {
      const v = await clashApi.version();
      pipeOk = v.status === 200;
      coreVersion = (v.json && v.json.version) || '';
    } catch { /* 管道不可达 */ }
    const parts = [
      `服务=${serviceState}`,
      `应用=${appRunning ? '运行中' : '未运行'}`,
      `内核端口 ${config.clash.mixedPort}=${portOn ? '监听中' : '未监听'}`,
      `内核 API=${pipeOk ? '可用' + (coreVersion ? `（${coreVersion}）` : '') : '不可用'}`,
    ].join('，');
    if (appRunning && portOn && pipeOk) {
      add(1, 'Clash 服务 / 应用 / 内核', STATUS.PASS, parts);
    } else if (!config.clash.appExe) {
      add(1, 'Clash 服务 / 应用 / 内核', STATUS.FAIL, parts, [
        '未找到 Clash Verge，请在设置里指定它安装文件夹里的 clash-verge.exe',
      ]);
    } else if (!appRunning) {
      add(1, 'Clash 服务 / 应用 / 内核', STATUS.WARN, parts, ['点击"启动 GPT"会自动打开 Clash Verge 并等待内核就绪']);
    } else {
      add(1, 'Clash 服务 / 应用 / 内核', STATUS.WARN, parts, [
        '打开 Clash Verge 主界面查看内核状态；必要时在 Clash 设置里重新开启"服务模式"',
      ]);
    }
  }

  /* 2. TUN 就绪 */
  {
    const tun = await verify.checkTunAdapter().catch(() => false);
    if (tun) add(2, 'TUN 网卡', STATUS.PASS, `已检测到网卡「${config.clash.tunAdapterName}」`);
    else add(2, 'TUN 网卡', STATUS.WARN, `未检测到网卡「${config.clash.tunAdapterName}」`, [
      '在 Clash Verge → 设置里开启 TUN 模式（需要服务模式；Rust 版 codex 后端要靠 TUN 才会被代理）',
    ]);
  }

  /* 3. 系统代理 */
  {
    const sp = await systemproxy.read().catch(() => ({ enable: 0, server: '' }));
    const target = `127.0.0.1:${config.clash.mixedPort}`;
    if (sp.enable === 1 && sp.server.includes(String(config.clash.mixedPort))) {
      add(3, '系统代理', STATUS.PASS, `已开启并指向 ${sp.server}`);
    } else if (sp.enable === 1) {
      add(3, '系统代理', STATUS.WARN, `开启中但指向 ${sp.server}（期望 ${target}）`, ['点击"启动 GPT"会自动修正']);
    } else {
      add(3, '系统代理', STATUS.WARN, '未开启', ['点击"启动 GPT"会开启并指向 ' + target]);
    }
  }

  /* 4. 扩展文件与运行规则一致 */
  {
    const expectedNode = outlet.expectedNodeName();
    let runtime = { proxyPort: null, dirId: null };
    if (outlet.usesRoxy() && config.roxy.windowName) {
      try {
        runtime = { proxyPort: await roxynet.findProxyPort(), dirId: roxynet.findDirIdByWindowName(config.roxy.windowName) };
      } catch { /* 探测失败按未就绪处理 */ }
    }
    const diff = clashProfile.diffProfile(runtime);
    const rulesState = await verify.checkRunningRules().catch(() => ({ ok: false, missing: ['（内核不可达）'] }));
    const nodesOk = Boolean(await verify.checkNodes(expectedNode).catch(() => null));

    if (diff.unresolved.length) {
      add(4, '扩展文件（节点/组/规则）', STATUS.FAIL, `槽位未就绪：${diff.unresolved.join('、')}`, [
        '在 Clash Verge 里对当前订阅执行一次"编辑节点 / 编辑规则 / 编辑代理组"，然后回到本程序重新检查',
        '或在设置里手动填写三个扩展文件名',
      ]);
    } else if (diff.pending.length || !rulesState.ok || !nodesOk) {
      const bits = [];
      if (nodesOk) bits.push(`节点 ${expectedNode} 与组 ${config.clash.groupName} 已加载`);
      else bits.push('尚未在内核里找到本项目节点/组');
      if (!rulesState.ok) bits.push(`运行规则缺少 ${rulesState.missing.length} 条`);
      if (diff.pending.length) bits.push(`${diff.pending.length} 个扩展文件需要更新`);
      add(4, '扩展文件（节点/组/规则）', STATUS.WARN, bits.join('；'), ['点击"启动 GPT"会自动同步并重启 Clash 使其生效']);
    } else {
      add(4, '扩展文件（节点/组/规则）', STATUS.PASS, `3 个扩展文件与内核运行规则一致（节点 ${expectedNode} / 组 ${config.clash.groupName}）`);
    }
  }

  /* 5. 节点与代理组 */
  {
    const expectedNode = outlet.expectedNodeName();
    const nodes = await verify.checkNodes(expectedNode).catch(() => null);
    if (nodes) {
      const strictPin = config.clash.groupType === 'select';
      const pinnedOk = !strictPin || !expectedNode || nodes.groupNow === expectedNode;
      const detail = `组「${config.clash.groupName}」当前选择：${nodes.groupNow || '（未知）'}（期望 ${expectedNode || '未配置'}）`;
      if (pinnedOk) add(5, '节点与代理组', STATUS.PASS, detail);
      else add(5, '节点与代理组', STATUS.WARN, detail, ['点击"启动 GPT"会把组的选择钉到预期节点']);
    } else if (!config.clash.dataDir) {
      add(5, '节点与代理组', STATUS.FAIL, '未找到 Clash 配置目录', ['在设置里指定 Clash Verge 的配置目录']);
    } else {
      add(5, '节点与代理组', STATUS.FAIL, `内核里找不到节点 ${expectedNode || '（未配置）'} 或组 ${config.clash.groupName}`, [
        '点击"启动 GPT"会写入扩展文件并重启 Clash；若仍失败，请检查订阅是否已导入且节点可用',
      ]);
    }
  }

  /* 6. 出口通道可达 */
  {
    const mode = outlet.mode();
    if (quick) {
      add(6, '出口通道可达', STATUS.SKIP, '快速检查已跳过');
    } else if (mode === 'roxy') {
      let dirId = null;
      try { dirId = config.roxy.windowName ? roxynet.findDirIdByWindowName(config.roxy.windowName) : null; } catch { dirId = null; }
      const win = dirId ? await roxynet.findOpenWindow(dirId, config.roxy.windowName, true).catch(() => null) : null;
      const port = await roxynet.findProxyPort().catch(() => null);
      if (!config.roxy.windowName) {
        add(6, '出口通道可达', STATUS.WARN, '尚未配置 Roxy 窗口名', ['在向导的"出口来源"里选择/填写窗口名']);
      } else if (!dirId) {
        const roots = roxynet.cacheRoots();
        add(6, '出口通道可达', STATUS.FAIL, '本机 Roxy 数据里找不到该窗口', [
          '在向导里确认窗口名；如需新建，请先在 Roxy 里创建窗口',
          '若你改过 Roxy 的「浏览器缓存目录」（设置 → 缓存/数据目录），请在「设置 → Roxy 缓存根目录」里填入新位置',
          `当前查找的缓存目录：${roots.length ? roots.join('；') : '(无)'}`,
        ]);
      } else if (!win) {
        add(6, '出口通道可达', STATUS.WARN, `窗口「${config.roxy.windowName}」当前未打开（静态通道在窗口打开时建立）`, ['点击"启动 GPT"会自动打开窗口并建立通道']);
      } else if (!port) {
        add(6, '出口通道可达', STATUS.WARN, 'roxynet 代理口未探测到', ['点击"启动 GPT"会重建（必要时重启 Roxy）']);
      } else {
        const info = await roxynet.checkStaticEgress(port, dirId, 2).catch(() => null);
        if (!info) {
          add(6, '出口通道可达', STATUS.FAIL, `窗口已打开，但经 roxynet 的静态通道不通（端口 ${port}）`, [
            '常见原因：窗口打开时系统代理/Clash 未就绪（顺序问题），或静态 IP 服务端暂时不可用',
            '点击"启动 GPT"会自动重建链路（必要时重启 Roxy 窗口）',
          ]);
        } else if (info.country !== 'US') {
          add(6, '出口通道可达', STATUS.WARN, `出口 ${info.ip} 的国家是 ${info.country}，不是 US`, ['检查 Roxy 窗口自身的代理配置']);
        } else {
          add(6, '出口通道可达', STATUS.PASS, `静态 IP 出口 ${info.ip}（${info.country} / ${info.org}）`);
        }
      }
    } else if (mode === 'static') {
      const info = await verify.egressViaStaticUpstream(1).catch(() => null);
      if (!info) add(6, '出口通道可达', STATUS.FAIL, '自备静态 IP 上游不可达', ['检查服务器地址/端口/账号密码，以及静态 IP 是否在有效期内']);
      else if (info.country !== 'US') add(6, '出口通道可达', STATUS.WARN, `出口 ${info.ip} 的国家是 ${info.country}，不是 US`);
      else add(6, '出口通道可达', STATUS.PASS, `静态 IP 出口 ${info.ip}（${info.country} / ${info.org}）`);
    } else {
      const node = outlet.expectedNodeName();
      if (!node) add(6, '出口通道可达', STATUS.WARN, '尚未选定订阅美国节点', ['在向导的"出口来源"里选择，或在设置里填写节点名']);
      else {
        const delay = await verify.checkNodeDelay(node, 1).catch(() => null);
        if (delay) add(6, '出口通道可达', STATUS.PASS, `订阅节点 ${node} 可达（${delay} ms）；注意：这不是静态 IP`);
        else add(6, '出口通道可达', STATUS.FAIL, `订阅节点 ${node} 不可达`, ['刷新订阅或另选一个美国节点']);
      }
    }
  }

  /* 7. 节点测速 */
  {
    const node = outlet.expectedNodeName();
    if (quick) add(7, '节点测速（chatgpt.com）', STATUS.SKIP, '快速检查已跳过');
    else if (!node) add(7, '节点测速（chatgpt.com）', STATUS.SKIP, '未配置出口节点');
    else {
      const delay = await verify.checkNodeDelay(node, 1).catch(() => null);
      if (delay) add(7, '节点测速（chatgpt.com）', STATUS.PASS, `${delay} ms`);
      else add(7, '节点测速（chatgpt.com）', STATUS.WARN, '测速未通过（chatgpt.com 暂不可达时属正常波动）', ['稍后重试；或点击"启动 GPT"走完整流程后再看']);
    }
  }

  /* 8. 分流证据 */
  {
    if (quick) add(8, '分流证据（chains）', STATUS.SKIP, '快速检查已跳过');
    else {
      const routing = await verify.routingProof().catch(() => null);
      if (routing) add(8, '分流证据（chains）', STATUS.PASS, `chains=[${routing.chains.join(' → ')}]，规则=${routing.rule}`);
      else add(8, '分流证据（chains）', STATUS.WARN, '未抓到新建连接的分流证据', ['点击"启动 GPT"后再看；或确认系统代理/TUN 已生效']);
    }
  }

  /* 9. 实测出口 */
  {
    if (quick) add(9, '实测出口（规则路径）', STATUS.SKIP, '快速检查已跳过');
    else {
      const egress = await verify.egressViaGroup().catch(() => null);
      if (!egress) add(9, '实测出口（规则路径）', STATUS.WARN, '出口校验失败（不影响现有设置）', ['确认 Clash 在运行且节点可用']);
      else {
        const expected = config.roxy.expectedStaticIp || config.outlet.static.expectedIp || '';
        const real = expected && !expected.startsWith('<');
        const match = real && egress.ip === expected;
        if (egress.country !== 'US') add(9, '实测出口（规则路径）', STATUS.FAIL, `当前出口 ${egress.ip}（${egress.country}）不是美国`, ['检查出口通道配置']);
        else if (match) add(9, '实测出口（规则路径）', STATUS.PASS, `${egress.ip}（US）＝ 你的静态 IP${egress.chains ? `，链路=[${egress.chains.join(' → ')}]` : ''}`);
        else add(9, '实测出口（规则路径）', STATUS.PASS, `${egress.ip}（US）${egress.chains ? `，链路=[${egress.chains.join(' → ')}]` : ''}`);
      }
    }
  }

  /* 10. 应用自身流量 */
  {
    if (quick) add(10, 'ChatGPT 应用流量', STATUS.SKIP, '快速检查已跳过');
    else {
      const proof = await verify.chatgptAppTrafficProof().catch(() => null);
      if (proof) add(10, 'ChatGPT 应用流量', STATUS.PASS, `chains=[${proof.chains.join(' → ')}]，host=${proof.host}`);
      else add(10, 'ChatGPT 应用流量', STATUS.SKIP, '暂未观察到应用自身的 OpenAI 流量（应用未运行或刚开始使用）', ['打开 ChatGPT 并正常使用后重新检查']);
    }
  }

  /* 11. 开机自启守护 */
  {
    const state = await apps.readChatGPTAutostartState().catch(() => ({ state: null, ok: false }));
    if (state.ok) add(11, 'ChatGPT 开机自启守护', STATUS.PASS, '已处于"用户禁用"（正常）');
    else if (state.state === null) add(11, 'ChatGPT 开机自启守护', STATUS.SKIP, state.note || '未找到起始任务注册表项');
    else if (state.enabled) add(11, 'ChatGPT 开机自启守护', STATUS.WARN, `开机自启当前为启用（state=${state.state}）`, ['点击"启动 GPT"会自动关闭它（防止无代理时裸启动）']);
    else add(11, 'ChatGPT 开机自启守护', STATUS.WARN, `状态异常（state=${state.state}）`, ['可在任务管理器"启动"页手动设置']);
  }

  return { items, mode: outlet.describe(), configPath: config.CONFIG_PATH, at: new Date().toISOString() };
}

const ICON = { pass: '✔', fail: '✘', warn: '⚠', skip: '–' };

async function run(opts = {}) {
  const result = await collect({ quick: Boolean(opts.quick) });
  if (opts.json) {
    process.stdout.write(log.masked(JSON.stringify(result, null, 2)) + '\n');
    return result.items.some((i) => i.status === STATUS.FAIL) ? 1 : 0;
  }
  log.blank();
  log.plain('============================================================');
  log.plain(`  检查结果 · 出口模式：${result.mode.label}（${result.mode.detail}）`);
  log.plain('============================================================');
  for (const item of result.items) {
    log.plain(`  ${ICON[item.status] || '?'} ${String(item.id).padStart(2)}. ${item.title}：${item.detail}`);
    for (const next of item.next) log.plain(`        → ${next}`);
  }
  const failed = result.items.filter((i) => i.status === STATUS.FAIL).length;
  const warned = result.items.filter((i) => i.status === STATUS.WARN).length;
  log.blank();
  log.plain(`  共 ${result.items.length} 项：通过 ${result.items.filter((i) => i.status === STATUS.PASS).length}、警告 ${warned}、失败 ${failed}`);
  log.blank();
  return failed > 0 ? 1 : 0;
}

module.exports = { collect, run, STATUS };
