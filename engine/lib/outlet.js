'use strict';
/**
 * 出口模式（outlet）统一逻辑。三种模式：
 *   - roxy        ：Roxy 指纹窗口里的美国静态 IP，经 roxynet 本地代理口接入（静态 IP 有保障）
 *   - static      ：用户自备 socks5/http 静态 IP，直接写成 Clash 节点（不依赖 Roxy，静态 IP 有保障）
 *   - subscription：从订阅里选一个美国节点兜底（**不是静态 IP**，只保证"能用且在美国"）
 */
const config = require('../config');

const MODES = ['roxy', 'static', 'subscription'];

function mode() {
  return MODES.includes(config.outlet.mode) ? config.outlet.mode : 'roxy';
}

/** 该模式是否保证"美国静态 IP" */
function isStaticGuaranteed() {
  return mode() === 'roxy' || mode() === 'static';
}

/** 该模式是否依赖 Roxy 指纹浏览器 */
function usesRoxy() {
  return mode() === 'roxy';
}

/** 校验（验证节点/组/测速时用）的目标节点名；模式 C 为用户选定的订阅节点 */
function expectedNodeName() {
  if (mode() === 'subscription') return config.outlet.subscription.selectedNode || '';
  return config.clash.nodeName;
}

/** 兜底节点匹配（fallback 组用）：返回正则数组 */
function backupMatchers() {
  const matcher = config.outlet.subscription.nodeMatcher || 'US|美国|United States';
  return Array.isArray(matcher) ? matcher : [new RegExp(matcher, 'i')];
}

/** 描述当前模式（供界面/日志展示） */
function describe() {
  switch (mode()) {
    case 'roxy':
      return {
        mode: 'roxy',
        label: 'Roxy 静态 IP（经 roxynet）',
        static: true,
        detail: `窗口「${config.roxy.windowName || '（未配置）'}」→ 美国静态 IP`,
      };
    case 'static':
      return {
        mode: 'static',
        label: '自备静态 IP（直连节点）',
        static: true,
        detail: `${config.outlet.static.type}://${config.outlet.static.host || '（未配置）'}:${config.outlet.static.port || '?'}`,
      };
    default:
      return {
        mode: 'subscription',
        label: '订阅美国节点（兜底，非静态 IP）',
        static: false,
        detail: config.outlet.subscription.selectedNode || '（未选定节点）',
      };
  }
}

/**
 * 当前模式下"自定义节点"的规格（用于生成扩展文件）。
 * 模式 A/B 返回节点对象；模式 C 不需要自定义节点，返回 null。
 */
function nodeSpec(runtime = {}) {
  switch (mode()) {
    case 'roxy': {
      const { proxyPort, dirId } = runtime;
      if (!proxyPort || !dirId) return null;
      return {
        name: config.clash.nodeName,
        type: 'socks5',
        server: '127.0.0.1',
        port: proxyPort,
        username: dirId,
        password: dirId,
        udp: true,
      };
    }
    case 'static': {
      const s = config.outlet.static;
      if (!s.host || !s.port) return null;
      const node = {
        name: config.clash.nodeName,
        type: s.type === 'http' ? 'http' : 'socks5',
        server: s.host,
        port: Number(s.port),
        udp: true,
      };
      if (s.username) node.username = s.username;
      if (s.password) node.password = s.password;
      return node;
    }
    default:
      return null;
  }
}

/** 供界面/向导列出的三种模式说明 */
function allModes() {
  return [
    { mode: 'roxy', label: 'Roxy 静态 IP', static: true, needs: ['Roxy 已安装并登录', '窗口名', '工作区 ID'] },
    { mode: 'static', label: '自备静态 IP（socks5/http）', static: true, needs: ['服务器地址', '端口', '用户名/密码（可选）'] },
    { mode: 'subscription', label: '订阅美国节点（兜底）', static: false, needs: ['Clash 订阅已导入', '选定一个美国节点'] },
  ];
}

module.exports = {
  MODES,
  mode,
  isStaticGuaranteed,
  usesRoxy,
  expectedNodeName,
  backupMatchers,
  describe,
  nodeSpec,
  allModes,
};
