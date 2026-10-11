'use strict';
/* 渲染进程：页面渲染与交互（通过 preload 暴露的 window.gptw 访问能力） */

const $ = (s, r = document) => r.querySelector(s);

const state = {
  info: null,
  config: null,
  detect: null,
  lastCheck: null,
  reveal: false,          // 是否在界面上显示敏感值（默认遮罩）
  busy: false,
  page: 'dashboard',
  activeLog: null,
  roxyNames: null,        // 点击"读取窗口名"后填充
  clashNodes: null,       // 点击"读取节点列表"后填充
};

const SENSITIVE_KEYS = ['windowName', 'workspaceId', 'expectedStaticIp', 'host', 'username', 'password', 'expectedIp'];
const MASK = '••••••••';

/* ---------- 小工具 ---------- */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

function toast(msg, ms = 4200) {
  const t = el('div', 'toast', msg);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

function setBusy(on) {
  state.busy = on;
  $('#busy').classList.toggle('hidden', !on);
  for (const id of ['btnStart', 'btnStop', 'btnRefresh']) $('#' + id).disabled = on;
}

function consoleAppend(chunk) {
  const c = $('#console');
  c.textContent += chunk;
  if (c.textContent.length > 160000) c.textContent = c.textContent.slice(-100000);
  c.scrollTop = c.scrollHeight;
}

function fmtTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/* ---------- 数据 ---------- */

async function boot() {
  try {
    state.info = await window.gptw.info();
    $('#modeBadge').textContent = `出口模式：${state.info.mode.label}`;
    state.config = await window.gptw.getConfig();
    const d = await window.gptw.detect();
    state.detect = d.ok ? d.info : null;
    renderAll();
    await refreshCheck(true);
    console.log('[ui] ready; mode=' + state.info.mode.mode);
  } catch (e) {
    console.error('[ui] 初始化失败', e);
    toast('初始化失败：' + (e && e.message ? e.message : e));
  }
}

async function refreshCheck(quick) {
  if (state.busy) return;
  setBusy(true);
  try {
    const r = await window.gptw.check({ quick: Boolean(quick) });
    if (r.ok) {
      state.lastCheck = r.result;
      renderDashboard();
      renderCheck();
      console.log('[ui] check done; items=' + (r.result.items || []).length + ' quick=' + Boolean(quick));
    } else {
      toast('检查失败：' + r.error);
    }
  } catch (e) {
    toast('检查异常：' + (e && e.message ? e.message : e));
  } finally {
    setBusy(false);
  }
}

/* ---------- 检查项渲染 ---------- */

const ICON = { pass: '✔', fail: '✘', warn: '⚠', skip: '–' };
const STATUS_TEXT = { pass: '通过', fail: '失败', warn: '警告', skip: '跳过' };

function renderCheckList(container, items, withNext) {
  const list = el('div', 'check-list');
  for (const item of items) {
    const box = el('div', `check-item ${item.status}`);
    const row1 = el('div', 'row1');
    row1.appendChild(el('span', 'icon', ICON[item.status] || '?'));
    row1.appendChild(el('span', 'title', `${item.id}. ${item.title}`));
    row1.appendChild(el('span', 'detail', `（${STATUS_TEXT[item.status] || item.status}）`));
    box.appendChild(row1);
    box.appendChild(el('div', 'detail', item.detail));
    if (withNext) for (const next of item.next || []) box.appendChild(el('div', 'next', `→ ${next}`));
    list.appendChild(box);
  }
  container.appendChild(list);
}

/* ---------- 仪表盘 ---------- */

function itemById(id) {
  return state.lastCheck ? state.lastCheck.items.find((i) => i.id === id) : null;
}

function shortStatus(item) {
  if (!item) return '（未检查）';
  return `${STATUS_TEXT[item.status] || item.status}`;
}

function card(title, big, sub, actions) {
  const c = el('div', 'card');
  c.appendChild(el('h3', null, title));
  c.appendChild(el('div', 'big', big));
  if (sub) c.appendChild(el('div', 'sub', sub));
  if (actions && actions.length) {
    const row = el('div', 'save-bar');
    for (const b of actions) row.appendChild(b);
    c.appendChild(row);
  }
  return c;
}

/** "打开某个软件"按钮：按配置好的位置打开，并核对进程是否真的出现（反馈写入提示条） */
function openBtn(label, target) {
  const b = el('button', 'btn ghost', label);
  b.addEventListener('click', async () => {
    if (state.busy) return;
    b.disabled = true;
    b.textContent = '打开中…';
    try {
      const r = await window.gptw.openApp({ target });
      toast(r.message || (r.ok ? '已请求打开' : '打开失败'));
      if (r.ok) await refreshCheck(true);
    } catch (e) {
      toast('打开异常：' + (e && e.message ? e.message : e));
    } finally {
      b.disabled = false;
      b.textContent = label;
    }
  });
  return b;
}

function renderDashboard() {
  const page = $('#page-dashboard');
  clear(page);

  const mode = state.info ? state.info.mode : { label: '--', detail: '', static: true };
  const cards = el('div', 'cards');
  cards.appendChild(card(
    '出口模式',
    mode.label,
    `${mode.detail}${mode.static ? '' : '（注意：这不是静态 IP）'}`,
    mode.mode === 'roxy' ? [openBtn('打开指纹窗口', 'window')] : []
  ));

  const c1 = itemById(1);
  cards.appendChild(card('Clash Verge', shortStatus(c1), c1 ? c1.detail : '尚未检查', [openBtn('打开 Clash Verge', 'clash')]));

  const c2 = itemById(2);
  const c3 = itemById(3);
  cards.appendChild(card('TUN / 系统代理', `${shortStatus(c2)} / ${shortStatus(c3)}`, `${c2 ? c2.detail : ''}${c2 && c3 ? '；' : ''}${c3 ? c3.detail : ''}`));

  const c9 = itemById(9);
  cards.appendChild(card('实测出口（美国）', c9 && c9.status === 'pass' ? '已确认' : shortStatus(c9), c9 ? c9.detail : '点击"重新检查"或运行一次完整检查'));

  const gptPkgs = state.detect && state.detect.chatgpt ? state.detect.chatgpt.packages || [] : [];
  cards.appendChild(card(
    'ChatGPT 桌面端',
    gptPkgs.length ? '已安装' : '未检测到',
    gptPkgs.length ? `${gptPkgs[0].name} ${gptPkgs[0].version}` : '请到 Microsoft Store 安装 ChatGPT',
    gptPkgs.length ? [openBtn('打开 ChatGPT', 'chatgpt')] : []
  ));

  const c11 = itemById(11);
  cards.appendChild(card('开机自启守护', shortStatus(c11), c11 ? c11.detail : ''));

  page.appendChild(cards);
  page.appendChild(el('p', 'hint', '上面每个卡片都可以单独"打开"某个软件（用来检查安装位置配得对不对）；要把整套环境准备好并按顺序打开 → 点右上角"启动 GPT"。'));

  if (state.lastCheck) {
    const sec = el('div', 'section');
    const head = el('h2', null, '检查概要');
    sec.appendChild(head);
    sec.appendChild(el('p', null, `最近一次检查：${fmtTime(Date.parse(state.lastCheck.at))}（快速检查不含联网项）`));
    renderCheckList(sec, state.lastCheck.items, false);
    page.appendChild(sec);
  } else {
    page.appendChild(el('p', 'hint', '正在获取状态…'));
  }
}

/* ---------- 检查页 ---------- */

function renderCheck() {
  const page = $('#page-check');
  clear(page);
  const bar = el('div', 'save-bar');
  const btnFull = el('button', 'btn primary', '运行完整检查（含联网项）');
  btnFull.addEventListener('click', () => refreshCheck(false));
  const btnQuick = el('button', 'btn', '快速检查');
  btnQuick.addEventListener('click', () => refreshCheck(true));
  bar.appendChild(btnFull);
  bar.appendChild(btnQuick);
  bar.appendChild(el('span', 'hint', '检查全程只读，不会修改任何设置。失败项下面都会给出下一步。'));
  page.appendChild(bar);

  if (state.lastCheck) {
    renderCheckList(page, state.lastCheck.items, true);
  } else {
    page.appendChild(el('p', 'hint', '尚无检查结果。'));
  }
}

/* ---------- 向导 ---------- */

function textInput(value, onchange, placeholder) {
  const input = el('input');
  input.type = 'text';
  input.value = value || '';
  if (placeholder) input.placeholder = placeholder;
  if (onchange) input.addEventListener('input', () => onchange(input.value));
  return input;
}

function maskedInput(key, value) {
  // 敏感字段：默认不显示内容（占位提示），留空 = 不修改；需要查看时打开"显示敏感值"
  const input = el('input');
  input.type = key === 'password' ? 'password' : 'text';
  if (state.reveal) input.value = value || '';
  else input.placeholder = value ? `${MASK}（已保存，留空表示不修改）` : '（未设置）';
  input.dataset.key = key;
  return input;
}

function gridRow(grid, labelText, control, extra) {
  grid.appendChild(el('label', null, labelText));
  grid.appendChild(control);
  grid.appendChild(extra || el('span'));
}

function renderWizard() {
  const page = $('#page-wizard');
  clear(page);
  if (!state.config) { page.appendChild(el('p', 'hint', '正在读取配置…')); return; }
  const cfg = state.config;

  const revealRow = el('div', 'save-bar');
  const label = el('label');
  const cb = el('input'); cb.type = 'checkbox'; cb.checked = state.reveal;
  cb.addEventListener('change', () => { state.reveal = cb.checked; renderWizard(); renderSettings(); });
  label.appendChild(cb);
  label.appendChild(el('span', null, ' 显示敏感值（截图/演示时请保持关闭）'));
  revealRow.appendChild(label);
  page.appendChild(revealRow);

  /* 第 1 步：Clash Verge */
  const s1 = el('div', 'section');
  const h1 = el('h2'); h1.appendChild(el('span', 'step-badge', '第 1 步')); h1.appendChild(el('span', null, 'Clash Verge'));
  s1.appendChild(h1);
  s1.appendChild(el('p', null, '本程序不捆绑 Clash Verge；如未安装，请到官网下载安装（需要开启"服务模式 + TUN"）。安装后这里会自动检测到。'));
  const g1 = el('div', 'form-grid');
  const exe1 = textInput(cfg.clash.appExe, (v) => { cfg.clash.appExe = v; });
  const pick1 = el('button', 'btn', '选择文件夹');
  pick1.addEventListener('click', async () => {
    const r = await window.gptw.pickFolder();
    if (!r.ok) return;
    const candidate = r.path + '\\clash-verge.exe';
    cfg.clash.appExe = candidate;
    const chk = await window.gptw.checkPath({ path: candidate });
    renderWizard();
    toast(chk.ok ? '已设置并验证：clash-verge.exe 存在' : `注意：${chk.error}（请选择含 clash-verge.exe 的安装目录）`);
  });
  gridRow(g1, 'clash-verge.exe 路径', exe1, pick1);
  gridRow(g1, '配置目录', el('div', 'hint', cfg.clash.dataDir || '（默认 %APPDATA% 下）'), el('span'));
  s1.appendChild(g1);
  const s1Row = el('div', 'save-bar');
  s1Row.appendChild(openBtn('打开 Clash Verge（验证路径）', 'clash'));
  s1Row.appendChild(el('span', 'hint', '会按上面的路径打开；若提示"未检测到进程"，说明路径不对。'));
  s1.appendChild(s1Row);
  const rediscover = el('button', 'btn ghost', '重新检测');
  rediscover.addEventListener('click', async () => {
    const d = await window.gptw.detect();
    if (d.ok) {
      state.detect = d.info;
      if (d.info.clash && d.info.clash.best) cfg.clash.appExe = d.info.clash.best;
      if (d.info.roxy && d.info.roxy.best) cfg.roxy.appExe = d.info.roxy.best;
      renderWizard(); renderDashboard();
      toast('已重新检测');
    }
  });
  s1.appendChild(rediscover);
  page.appendChild(s1);

  /* 第 2 步：出口来源 */
  const s2 = el('div', 'section');
  const h2 = el('h2'); h2.appendChild(el('span', 'step-badge', '第 2 步')); h2.appendChild(el('span', null, '出口来源（三选一）'));
  s2.appendChild(h2);
  s2.appendChild(el('p', null, '只有 A（Roxy 静态 IP）和 B（自备静态 IP）能保证"美国静态 IP"；C 只是"能用且在美国"的兜底。'));
  const radios = el('div', 'radio-row');
  const modes = [
    ['roxy', 'A. Roxy 静态 IP（推荐）'],
    ['static', 'B. 自备静态 IP（socks5/http）'],
    ['subscription', 'C. 订阅美国节点（兜底）'],
  ];
  for (const [value, text] of modes) {
    const lb = el('label');
    const rb = el('input'); rb.type = 'radio'; rb.name = 'outletMode'; rb.value = value;
    rb.checked = (cfg.outlet.mode || 'roxy') === value;
    rb.addEventListener('change', () => { cfg.outlet.mode = value; renderWizard(); });
    lb.appendChild(rb); lb.appendChild(el('span', null, text));
    radios.appendChild(lb);
  }
  s2.appendChild(radios);

  const g2 = el('div', 'form-grid');
  if (cfg.outlet.mode === 'subscription') {
    const node = textInput(cfg.outlet.subscription.selectedNode, (v) => { cfg.outlet.subscription.selectedNode = v; }, '例如订阅里的某个美国节点名');
    const nodeBtn = el('button', 'btn ghost', '从 Clash 读取节点列表');
    nodeBtn.addEventListener('click', async () => {
      const r = await window.gptw.listClashNodes();
      if (r.ok) {
        state.clashNodes = r.names;
        renderWizard();
        toast(r.names.length ? `已读取 ${r.names.length} 个节点` : '订阅里还没有可用节点（请先在 Clash 里导入订阅）');
      } else {
        toast(r.error);
      }
    });
    gridRow(g2, '美国节点名', node, nodeBtn);
    if (state.clashNodes && state.clashNodes.length) {
      const sel = el('select');
      sel.appendChild(el('option', null, '（从列表中选择）'));
      for (const name of state.clashNodes) {
        const o = el('option', null, name); o.value = name;
        if (cfg.outlet.subscription.selectedNode === name) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => { if (sel.value) { cfg.outlet.subscription.selectedNode = sel.value; renderWizard(); } });
      gridRow(g2, '（已读取的节点）', sel, el('span'));
    }
    const matcher = textInput(cfg.outlet.subscription.nodeMatcher, (v) => { cfg.outlet.subscription.nodeMatcher = v; });
    gridRow(g2, '节点匹配正则', matcher, el('span'));
  } else if (cfg.outlet.mode === 'static') {
    const sel = el('select');
    for (const t of ['socks5', 'http']) {
      const o = el('option', null, t); o.value = t;
      if (cfg.outlet.static.type === t) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => { cfg.outlet.static.type = sel.value; });
    gridRow(g2, '类型', sel);
    gridRow(g2, '服务器地址', textInput(cfg.outlet.static.host, (v) => { cfg.outlet.static.host = v; }, '例如 203.0.113.10 或域名'));
    gridRow(g2, '端口', textInput(cfg.outlet.static.port || '', (v) => { cfg.outlet.static.port = Number(v) || 0; }));
    gridRow(g2, '用户名', maskedInput('username', cfg.outlet.static.username));
    gridRow(g2, '密码', maskedInput('password', cfg.outlet.static.password));
    gridRow(g2, '预期 IP（可选）', maskedInput('expectedIp', cfg.outlet.static.expectedIp));
  } else {
    const win = maskedInput('windowName', cfg.roxy.windowName);
    win.placeholder = cfg.roxy.windowName ? `${MASK}（已保存）` : '在 Roxy 里看到的窗口名';
    const listBtn = el('button', 'btn ghost', '从本机 Roxy 读取窗口名');
    listBtn.addEventListener('click', async () => {
      const r = await window.gptw.listRoxyWindows();
      if (r.ok) {
        state.roxyNames = r.names;
        renderWizard();
        toast(r.names.length ? `已读取 ${r.names.length} 个窗口名` : 'Roxy 里还没有窗口（请先在 Roxy 里创建窗口）');
      } else {
        toast('读取失败：' + (r.error || ''));
      }
    });
    gridRow(g2, 'Roxy 窗口名', win, listBtn);
    if (state.roxyNames && state.roxyNames.length) {
      const sel = el('select');
      sel.appendChild(el('option', null, '（从列表中选择）'));
      for (const name of state.roxyNames) {
        const o = el('option', null, name); o.value = name;
        if (cfg.roxy.windowName === name) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => { if (sel.value) { cfg.roxy.windowName = sel.value; renderWizard(); } });
      gridRow(g2, '（已读取的窗口）', sel, el('span'));
    }
    gridRow(g2, '工作区 ID', maskedInput('workspaceId', cfg.roxy.workspaceId), el('span'));
    gridRow(g2, '预期静态 IP（可选）', maskedInput('expectedStaticIp', cfg.roxy.expectedStaticIp), el('span'));
    const roxyRow = el('div', 'save-bar');
    roxyRow.appendChild(openBtn('打开 Roxy 主程序', 'roxy'));
    roxyRow.appendChild(openBtn('打开指纹窗口', 'window'));
    roxyRow.appendChild(el('span', 'hint', '用来检查 Roxy 的安装位置配得对不对；指纹窗口打开后静态通道才会建立。'));
    g2.appendChild(roxyRow);
    g2.appendChild(el('span'));
    g2.appendChild(el('span'));
  }
  s2.appendChild(g2);
  page.appendChild(s2);

  /* 第 3 步：ChatGPT */
  const s3 = el('div', 'section');
  const h3 = el('h2'); h3.appendChild(el('span', 'step-badge', '第 3 步')); h3.appendChild(el('span', null, 'ChatGPT 桌面端'));
  s3.appendChild(h3);
  const pkgs = state.detect ? (state.detect.chatgpt ? state.detect.chatgpt.packages || [] : []) : [];
  s3.appendChild(el('p', null, pkgs.length
    ? `已检测到：${pkgs[0].name} ${pkgs[0].version}（${pkgs[0].aumid || 'AUMID 未知'}）`
    : '未检测到 ChatGPT 桌面端。请到 Microsoft Store 搜索 "ChatGPT" 安装（本程序不会代你安装）。'));
  const openRow = el('div', 'save-bar');
  openRow.appendChild(openBtn('打开 ChatGPT', 'chatgpt'));
  openRow.appendChild(el('span', 'hint', '会启动并核对进程是否出现；若失败可先到 Microsoft Store 更新应用。'));
  s3.appendChild(openRow);
  page.appendChild(s3);

  /* 保存 */
  const saveBar = el('div', 'save-bar');
  const saveBtn = el('button', 'btn primary', '保存配置');
  saveBtn.addEventListener('click', async () => {
    const patch = buildPatch(cfg, page);
    const r = await window.gptw.saveConfig(patch);
    if (r.ok) {
      toast('已保存。回到仪表盘点击"启动 GPT"应用配置。');
      state.config = await window.gptw.getConfig();
      renderAll();
    } else {
      toast('保存失败：' + r.error);
    }
  });
  saveBar.appendChild(saveBtn);
  saveBar.appendChild(el('span', 'hint', '保存后请点击右上角"启动 GPT"来应用并验证。'));
  page.appendChild(saveBar);
}

/**
 * 从页面上收集"敏感字段"输入框的值：
 * - 里面已有文字（用户看过并编辑过）→ 提交该值；
 * - 留空（默认遮罩下用户没动它）→ 不提交（保持原值）。
 */
function collectMaskedInputs(root, patch) {
  for (const input of Array.from(root.querySelectorAll('input[data-key]'))) {
    const key = input.dataset.key;
    const value = input.value.trim();
    if (value === '') continue;
    if (key === 'windowName') patch.roxy.windowName = value;
    else if (key === 'workspaceId') patch.roxy.workspaceId = value;
    else if (key === 'expectedStaticIp') patch.roxy.expectedStaticIp = value;
    else if (key === 'host') patch.outlet.static.host = value;
    else if (key === 'username') patch.outlet.static.username = value;
    else if (key === 'password') patch.outlet.static.password = value;
    else if (key === 'expectedIp') patch.outlet.static.expectedIp = value;
  }
}

function buildPatch(cfg, root) {
  const patch = {
    outlet: {
      mode: cfg.outlet.mode,
      static: {
        type: cfg.outlet.static.type,
        host: cfg.outlet.static.host,
        port: cfg.outlet.static.port,
        username: cfg.outlet.static.username,
        password: cfg.outlet.static.password,
        expectedIp: cfg.outlet.static.expectedIp,
      },
      subscription: {
        nodeMatcher: cfg.outlet.subscription.nodeMatcher,
        selectedNode: cfg.outlet.subscription.selectedNode,
      },
    },
    clash: {
      appExe: cfg.clash.appExe,
      dataDir: cfg.clash.dataDir,
      groupType: cfg.clash.groupType,
      slots: cfg.clash.slots,
    },
    roxy: {
      appExe: cfg.roxy.appExe,
      userDataDir: cfg.roxy.userDataDir,
      windowName: cfg.roxy.windowName,
      workspaceId: cfg.roxy.workspaceId,
      expectedStaticIp: cfg.roxy.expectedStaticIp,
    },
    ui: { maskSensitive: cfg.ui.maskSensitive },
  };
  collectMaskedInputs(root, patch);
  return patch;
}

/* ---------- 设置页 ---------- */

function renderSettings() {
  const page = $('#page-settings');
  clear(page);
  if (!state.config) { page.appendChild(el('p', 'hint', '正在读取配置…')); return; }
  const cfg = state.config;

  const s1 = el('div', 'section');
  s1.appendChild(el('h2', null, '运行策略'));
  const g1 = el('div', 'form-grid');

  const selGroup = el('select');
  for (const [v, t] of [['select', '严格（只用所选出口，不通就不可用）'], ['fallback', '兜底（所选出口优先，不通时回退订阅美国节点）']]) {
    const o = el('option', null, t); o.value = v;
    if (cfg.clash.groupType === v) o.selected = true;
    selGroup.appendChild(o);
  }
  selGroup.addEventListener('change', () => { cfg.clash.groupType = selGroup.value; });
  gridRow(g1, '代理组策略', selGroup);

  const cbMask = el('input'); cbMask.type = 'checkbox'; cbMask.checked = cfg.ui.maskSensitive !== false;
  cbMask.addEventListener('change', () => {
    cfg.ui.maskSensitive = cbMask.checked;
    toast(cbMask.checked ? '已开启遮罩：日志与检查结果中的 IP/账号会被打码' : '已关闭遮罩：界面与日志将显示完整 IP/账号（请勿直接分享）');
  });
  gridRow(g1, '遮罩敏感值', cbMask);
  s1.appendChild(g1);
  page.appendChild(s1);

  const s2 = el('div', 'section');
  s2.appendChild(el('h2', null, '软件路径'));
  const g2 = el('div', 'form-grid');
  const p1 = el('button', 'btn', '选择');
  p1.addEventListener('click', async () => {
    const r = await window.gptw.pickFolder();
    if (!r.ok) return;
    const candidate = r.path + '\\clash-verge.exe';
    cfg.clash.appExe = candidate;
    const chk = await window.gptw.checkPath({ path: candidate });
    renderSettings();
    toast(chk.ok ? '已设置并验证：clash-verge.exe 存在' : `注意：${chk.error}`);
  });
  gridRow(g2, 'Clash Verge', textInput(cfg.clash.appExe, (v) => { cfg.clash.appExe = v; }), p1);
  const p2 = el('button', 'btn', '选择');
  p2.addEventListener('click', async () => {
    const r = await window.gptw.pickFolder();
    if (!r.ok) return;
    const candidate = r.path + '\\RoxyBrowser.exe';
    cfg.roxy.appExe = candidate;
    const chk = await window.gptw.checkPath({ path: candidate });
    renderSettings();
    toast(chk.ok ? '已设置并验证：RoxyBrowser.exe 存在' : `注意：${chk.error}`);
  });
  gridRow(g2, 'Roxy Browser', textInput(cfg.roxy.appExe, (v) => { cfg.roxy.appExe = v; }), p2);
  gridRow(g2, 'Clash 配置目录', textInput(cfg.clash.dataDir, (v) => { cfg.clash.dataDir = v; }), el('span'));
  s2.appendChild(g2);
  page.appendChild(s2);

  const s3 = el('div', 'section');
  s3.appendChild(el('h2', null, '高级：扩展槽位'));
  s3.appendChild(el('p', null, '留空 = 自动从 Clash 订阅的 profiles.yaml 读取（推荐）。只有在自动读取失败时才需要手动填写三个槽位文件名。'));
  const g3 = el('div', 'form-grid');
  gridRow(g3, '节点槽位文件', textInput(cfg.clash.slots.proxies, (v) => { cfg.clash.slots.proxies = v; }, '例如 xxxxxxxx.yaml'));
  gridRow(g3, '规则槽位文件', textInput(cfg.clash.slots.rules, (v) => { cfg.clash.slots.rules = v; }, '例如 xxxxxxxx.yaml'));
  gridRow(g3, '代理组槽位文件', textInput(cfg.clash.slots.groups, (v) => { cfg.clash.slots.groups = v; }, '例如 xxxxxxxx.yaml'));
  s3.appendChild(g3);
  page.appendChild(s3);

  const s5 = el('div', 'section');
  s5.appendChild(el('h2', null, '维护'));
  s5.appendChild(el('p', null, '导出/导入配置用于换机或备份；"清理辅助项"会把本方案在系统里的三处改动还原（删除助手计划任务、关闭本方案设置的系统代理、用备份还原扩展文件），不影响其它软件。'));
  const row5 = el('div', 'save-bar');
  const bExp = el('button', 'btn', '导出配置…');
  bExp.addEventListener('click', async () => {
    const r = await window.gptw.exportConfig();
    if (r.canceled) return;
    toast(r.ok ? '已导出（文件里含你的私密值，请妥善保管，勿上传到公开渠道）' : '导出失败：' + r.error);
  });
  const bImp = el('button', 'btn', '导入配置…');
  bImp.addEventListener('click', async () => {
    if (!window.confirm('导入会用文件里的同名配置覆盖当前设置（含出口/窗口/路径等），继续？')) return;
    const r = await window.gptw.importConfig();
    if (r.canceled) return;
    if (r.ok) {
      state.config = await window.gptw.getConfig();
      renderAll();
      toast('已导入并生效（顶层字段：' + r.keys + '）');
    } else {
      toast('导入失败：' + r.error);
    }
  });
  const bClean = el('button', 'btn danger ghost', '清理辅助项…');
  bClean.addEventListener('click', async () => {
    const ok = window.confirm([
      '「清理辅助项」将执行：',
      '· 删除助手计划任务（下一次"关闭全部"会重新注册）',
      '· 关闭系统代理（仅在它指向本方案的 127.0.0.1 端口时）',
      '· 用 *.gptproxy-backup 备份还原被本方案改过的 Clash 扩展文件',
      '',
      '不会删除：你的配置与日志。可能需要一次 UAC。确定继续？',
    ].join('\n'));
    if (!ok) return;
    setBusy(true);
    consoleAppend('\n=== 开始执行「清理辅助项」 ===\n');
    try {
      const r = await window.gptw.cleanup({ apply: true });
      if (r.ok && r.elevated) toast('已在提权窗口继续执行清理，稍后可查看日志');
      else toast(r.ok ? '清理完成（详见运行输出）' : '清理未完成：' + r.error);
    } finally {
      setBusy(false);
    }
  });
  row5.appendChild(bExp);
  row5.appendChild(bImp);
  row5.appendChild(bClean);
  s5.appendChild(row5);
  page.appendChild(s5);

  const s4 = el('div', 'section');
  s4.appendChild(el('h2', null, '目录'));
  s4.appendChild(el('p', null, `配置文件：${state.info ? state.info.configPath : ''}`));
  const row = el('div', 'save-bar');
  const b1 = el('button', 'btn', '打开配置目录');
  b1.addEventListener('click', () => window.gptw.openFolder('configDir'));
  const b2 = el('button', 'btn', '打开日志目录');
  b2.addEventListener('click', () => window.gptw.openFolder('logsDir'));
  row.appendChild(b1); row.appendChild(b2);
  s4.appendChild(row);
  page.appendChild(s4);

  const s6 = el('div', 'section');
  s6.appendChild(el('h2', null, '单独打开（检查用）'));
  s6.appendChild(el('p', null, '按上面的路径逐个打开软件，并核对进程是否真的出现——用来检查路径配得对不对，也可以先把某个软件打开备用。'));
  const row6 = el('div', 'save-bar');
  row6.appendChild(openBtn('打开 Clash Verge', 'clash'));
  row6.appendChild(openBtn('打开 Roxy 主程序', 'roxy'));
  row6.appendChild(openBtn('打开指纹窗口', 'window'));
  row6.appendChild(openBtn('打开 ChatGPT', 'chatgpt'));
  s6.appendChild(row6);
  page.appendChild(s6);

  const saveBar = el('div', 'save-bar');
  const saveBtn = el('button', 'btn primary', '保存设置');
  saveBtn.addEventListener('click', async () => {
    const patch = buildPatch(cfg, page);
    const r = await window.gptw.saveConfig(patch);
    toast(r.ok ? '设置已保存' : '保存失败：' + r.error);
    if (r.ok) { state.config = await window.gptw.getConfig(); renderAll(); }
  });
  saveBar.appendChild(saveBtn);
  page.appendChild(saveBar);
}

/* ---------- 日志页 ---------- */

async function renderLogs() {
  const page = $('#page-logs');
  clear(page);
  const bar = el('div', 'save-bar');
  const refresh = el('button', 'btn', '刷新');
  refresh.addEventListener('click', renderLogs);
  const openDir = el('button', 'btn ghost', '打开日志目录');
  openDir.addEventListener('click', () => window.gptw.openFolder('logsDir'));
  bar.appendChild(refresh); bar.appendChild(openDir);
  bar.appendChild(el('span', 'hint', '日志默认已遮罩（IP/账号/Roxy 身份都打码）。'));
  page.appendChild(bar);

  const r = await window.gptw.listLogs();
  const layout = el('div', 'logs-layout');
  const listCol = el('div', 'log-list');
  const view = el('pre', 'log-view', '（点击左侧选择一个日志文件）');
  if (!r.ok || !r.files.length) {
    listCol.appendChild(el('p', 'hint', '暂无日志（运行一次"启动/关闭"或"检查"后会出现）'));
  } else {
    for (const f of r.files) {
      const item = el('div', 'log-item');
      item.appendChild(el('div', null, f.name));
      item.appendChild(el('div', 'hint', `${fmtTime(f.mtime)} · ${(f.size / 1024).toFixed(1)} KB`));
      item.addEventListener('click', async () => {
        for (const n of Array.from(listCol.children)) n.classList.remove('active');
        item.classList.add('active');
        const content = await window.gptw.readLog(f.name);
        view.textContent = content.ok ? content.content : ('读取失败：' + content.error);
        view.scrollTop = 0;
      });
      listCol.appendChild(item);
    }
  }
  layout.appendChild(listCol);
  layout.appendChild(view);
  page.appendChild(layout);
}

/* ---------- 页面切换与全局按钮 ---------- */

function renderAll() {
  renderDashboard();
  renderWizard();
  renderCheck();
  renderSettings();
  renderLogs();
}

function showPage(name) {
  state.page = name;
  for (const b of Array.from(document.querySelectorAll('.nav-item'))) {
    b.classList.toggle('active', b.dataset.page === name);
  }
  const titles = { dashboard: '仪表盘', wizard: '向导', check: '检查', settings: '设置', logs: '日志' };
  $('#pageTitle').textContent = titles[name] || name;
  for (const p of Array.from(document.querySelectorAll('.page'))) {
    p.classList.toggle('active', p.id === 'page-' + name);
  }
  if (name === 'logs') renderLogs();
  if (name === 'settings') renderSettings();
  if (name === 'wizard') renderWizard();
}

function bindGlobal() {
  for (const b of Array.from(document.querySelectorAll('.nav-item'))) {
    b.addEventListener('click', () => showPage(b.dataset.page));
  }
  $('#btnRefresh').addEventListener('click', () => refreshCheck(false));
  $('#btnClearConsole').addEventListener('click', () => { $('#console').textContent = ''; });
  $('#btnCopyEnv').addEventListener('click', () => window.gptw.openFolder('configDir'));

  $('#btnStart').addEventListener('click', async () => {
    if (state.busy) return;
    setBusy(true);
    consoleAppend('\n=== 开始执行「启动 GPT」 ===\n');
    try {
      const r = await window.gptw.start();
      toast(r.ok ? '启动流程完成（详见运行输出与检查结果）' : `启动流程未全部完成（退出码 ${r.code ?? '-'}）${r.error ? '：' + r.error : ''}`);
    } catch (e) {
      toast('执行异常：' + (e && e.message ? e.message : e));
    } finally {
      setBusy(false);
      await reloadConfig();      // 引擎可能刚探测/改写路径，刷新界面
      await refreshCheck(true);
    }
  });

  $('#btnStop').addEventListener('click', async () => {
    if (state.busy) return;
    const ok = window.confirm([
      '「关闭全部」将执行：',
      '· 关闭 ChatGPT（含 Codex 进程）',
      '· 关闭 Roxy Browser（强制，未同步的云端数据不会上传）',
      '· 关闭系统代理',
      '· 关闭 Clash Verge 应用与后台服务（会断网，TUN 消失）',
      '',
      '需要管理员权限（会弹一次 UAC）。确定继续？',
    ].join('\n'));
    if (!ok) return;
    setBusy(true);
    consoleAppend('\n=== 开始执行「关闭全部」 ===\n');
    try {
      const r = await window.gptw.stop({ allowElevate: true });
      if (r.ok && r.elevated) toast('已在提权窗口继续执行，完成后可点"重新检查"查看结果');
      else toast(r.ok ? '关闭流程完成' : `关闭流程未全部完成${r.error ? '：' + r.error : ''}`);
    } catch (e) {
      toast('执行异常：' + (e && e.message ? e.message : e));
    } finally {
      setBusy(false);
      await reloadConfig();
      await refreshCheck(true);
    }
  });

  window.gptw.onLog((chunk) => consoleAppend(chunk));
  // 主进程在"启动探测完成"或引擎改动配置后会通知刷新
  window.gptw.onRefresh(() => { reloadConfig().catch(() => {}); });
}

/** 重新读取配置并刷新界面（探测可能刚补上路径） */
async function reloadConfig() {
  try {
    state.config = await window.gptw.getConfig();
    renderAll();
  } catch { /* 忽略：下次刷新会再试 */ }
}

bindGlobal();
boot();
