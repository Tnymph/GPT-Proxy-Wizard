# 项目交接文档 · GPT Proxy Wizard

> 🪄 本仓库是 **deepseek 许愿式编程产物**：由人提出需求，模型负责设计、实现、自测与交付。
>
> **维护状态：后续停止更新（frozen）**——最后一次功能更新为 **v0.1.1**（2026-10-11）。
> 接手这个项目需要的一切都在本文件里；读完 §1~§4 就能上手改代码，§5~§8 是流程与避坑清单。

---

## 1. 现状快照（先看这个）

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/Tnymph/GPT-Proxy-Wizard （PUBLIC，MIT） |
| 最新发布 | **v0.1.1**（安装器 + 便携版 + SHA256SUMS，GitHub Latest） |
| 历史发布 | **v0.1.0**（保留；标记为"预发布"并在说明里注明已知问题："关闭全部"提权不弹 UAC，已在 v0.1.1 修复） |
| 发布策略 | **已发布的 Release 永不删除**；有问题的版本在新版修复 + 旧版说明里标注（用 Latest / 预发布 控制推荐下载哪个） |
| 已实测通过 | CLI 干跑（`start/stop/cleanup --dry-run`）、11 项检查、打包版实机启动与检查、提权链路（UAC → 提权实例跑只读 dry-run → 日志落盘 → 干净退出） |
| 尚未验证 | **干净虚拟机上的安装/卸载与完整向导**（见 §7 待办 1）；"真的执行关闭/启动"只在本机跑过只读路径 |
| 用户配置与日志 | `%APPDATA%\GPTProxyWizard\`（`config.json` + `state\logs\`，日志默认遮罩） |
| 本机开发目录（示例） | `E:\VibeCoding\GPTAppPackaging\app`（工作区里的 `handover\` 目录是私有资料，**不在本仓库**） |

---

## 2. 一句话定位与架构

**把"让 ChatGPT / Codex 桌面端全程走美国出口（静态 IP 优先）"做成带向导界面的 Windows 小工具**：
检测已装的第三方软件 → 引导完成配置 → 一键启动/关闭 → 逐项自检并给出可复核证据。

```
app/
├─ app.js                  CLI 入口（node app.js <命令>，等价于 node engine/cli.js）
├─ engine/                 引擎：零依赖纯 Node（不依赖 Electron，可独立运行）
│  ├─ cli.js               命令解析与分发（start/stop/open/check/detect/cleanup/config）
│  ├─ start.js  stop.js    两套编排（程序 A 12 步 / 程序 B 6 步，支持 --dry-run）
│  ├─ check.js             11 项检查矩阵（只读；每项给出"下一步"）
│  ├─ cleanup.js           清理辅助项（助手任务/系统代理/扩展文件备份；默认只列出）
│  ├─ detect.js            安装探测（调用 tools/detect-apps.ps1）
│  ├─ open.js              单独打开某个软件并核对进程/窗口是否真的出现
│  ├─ config.js            默认值 + JSON 配置深度合并（配置在 %APPDATA%\GPTProxyWizard\config.json）
│  ├─ lib/                 exec(白名单执行)/netinfo(运行态采集)/clash-api/clash-profile(扩展文件)/
│  │                       roxynet/systemproxy/apps/verify/outlet(三出口模式)/lock/log(遮罩)
│  └─ tools/*.ps1          PowerShell"手脚"：probe/detect-apps/launch-app/elevate/stop-service/…
├─ main/                   Electron 主进程（进程内 require 引擎）+ preload（contextIsolation）
├─ ui/                     界面：原生 HTML/CSS/JS 五页（仪表盘/向导/检查/设置/日志）
├─ tools/                  开发工具：脱敏扫描、BOM 工具、配置迁移、看门狗回归（不随产物分发）
├─ private/                隐私目录（除 README 外全部 gitignore；真实私密值不入库）
└─ package.json            版本、依赖、electron-builder 打包配置
```

**数据流**：界面（渲染进程）→ `preload` 暴露的窄接口 → 主进程 IPC → 引擎函数 → PowerShell/注册表/Clash API。
**提权**：主进程以 `--elevate-run <stop|cleanup> [--dry-run]` 重启自身（`elevate.ps1` → UAC），提权实例不建窗口、跑完即退，父进程负责等待并把它写的日志转发回界面。

---

## 3. 关键设计决策（改动前必读）

1. **引擎与界面解耦**：引擎零依赖纯 Node —— 排障优先用 `node app.js check/start --dry-run`，不必开界面。
2. **三种出口模式**（`lib/outlet.js`）：`roxy`（Roxy 指纹窗口 + 静态 IP，经 roxynet）/ `static`（自备 socks5-http 静态 IP，直连节点）/ `subscription`（订阅美国节点兜底，**非静态 IP**）。所有检查、日志、界面文案都按模式分支。
3. **Clash 侧只走官方机制**：内核 REST API（命名管道，免 secret）+ 订阅"扩展文件"（`prepend/append/delete` 合并）——槽位文件名从 `profiles.yaml` 的 `option.{proxies,rules,groups}` **动态解析**，不写死 uid；写前备份 `*.gptproxy-backup`。
4. **隐私模型**：代码里只允许占位符；真实值只在 `%APPDATA%\GPTProxyWizard\config.json` 与仓库 `private\`（gitignore）。日志默认遮罩（IPv4 前三段、用户名/主机名、Roxy 窗口名/工作区 ID、上游主机/账号；值匹配带字母数字边界，避免误伤时间戳）。
5. **单实例锁 + 看门狗**：锁文件在 `%APPDATA%\GPTProxyWizard\state`（死 PID/超 10 分钟可接管）；看门狗 10 分钟兜底——**必须 `clearTimeout`**，界面模式下传 `watchdogExit:false`（见 §8 坑 1）。
6. **不捆绑第三方**：只做"检测 → 引导到官方渠道 → 复查"；`LICENSES.md` 写明了 Clash Verge/Roxy/ChatGPT 的分发边界。
7. **一切外部命令走参数数组**（不经 shell），可执行文件受白名单约束（`lib/exec.js` 的 `resolveAllowedApp`）；"启动程序"这个动作统一交给 `tools/launch-app.ps1` 执行。

---

## 4. 界面与命令对应关系

| 界面 | CLI（等价） | 说明 |
|---|---|---|
| 仪表盘 / 检查页 | `node app.js check [--quick] [--json]` | 11 项只读检查 |
| 启动 GPT | `node app.js start [--dry-run]` | 程序 A：代理就绪 → 打开 ChatGPT → 出证据 |
| 关闭全部 | `node app.js stop [--dry-run]` | 程序 B：ChatGPT → Roxy → 系统代理 → Clash → 窗口；需一次 UAC |
| 卡片/向导里的"打开…" | `node app.js open clash\|roxy\|window\|chatgpt [--wait 秒]` | 打开并核对是否真的起来（检查路径用） |
| 设置 → 维护 → 清理辅助项 | `node app.js cleanup [--apply]` | 删助手任务 / 关本方案设置的系统代理 / 还原扩展文件备份 |
| 设置 → 维护 → 导出/导入配置 | `node app.js config path\|show\|init` | 配置读写（导出文件含私密值，别外传） |

退出码：`0` 成功 · `1` 有失败项/已有实例在跑 · `2` 配置或步骤错误 · `3` 未预期异常 · `10` 已提权到新窗口继续执行。

---

## 5. 开发环境与常用命令

```bat
npm install                     :: 装 electron（44.x）与 electron-builder；Electron 是"懒下载"，首次 npx electron 会拉二进制
npm run gui                     :: 开发模式开界面
node app.js help                :: CLI 用法
node app.js check --quick       :: 最快的一次自检（只读）
npm run pack                    :: 只出未打包目录（dist\win-unpacked，调试打包问题用）
npm run dist                    :: 出安装器 + 便携版
npm run lint / npm run secrets  :: 编码规则 / 脱敏扫描（发布前必跑，0 命中）
node tools/dev-watchdog-smoke.js   :: 看门狗回归（用 GPTWIZ_WATCHDOG_MIN=1 缩短）
node tools/dev-migrate-config.js   :: 把旧的本地配置迁进 %APPDATA%（纯文本解析，不执行源码）
```

国内网络提示：`npm install` / 打包时用镜像环境变量
`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`、
`ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`。

---

## 6. 发布流程（照抄即可）

1. 改代码 → 本地自检：`node app.js check --quick`、`node app.js start --dry-run`、`npm run lint`、`npm run secrets`（0 命中）；
2. 升 `package.json` 的 `version`（同步 `package-lock.json` 的 version）→ `npm run dist`；
3. 生成校验和：`Get-FileHash` 两个 exe → 写进 `dist\SHA256SUMS.txt`；
4. `git add -A && git commit && git push`；建 tag 并推送（`git tag -a vX.Y.Z -m "…" && git push origin vX.Y.Z`；
   若直连 github.com 超时，可用 `gh api repos/<owner>/<repo>/git/refs -f ref=refs/tags/vX.Y.Z -f sha=<commit>` 兜底建标签）；
5. `gh release create vX.Y.Z --title "…" --notes "…" dist\*-setup.exe dist\*-portable.exe dist\SHA256SUMS.txt`；
6. **旧 release 不删**：新版本设 Latest；有问题的那一版改成"预发布"并在说明里加"已知问题 + 建议用新版"。

本机 `gh` 不在 PATH：用绝对路径 `"C:\Program Files\GitHub CLI\gh.exe"`；
git 凭据已配好（fetch 走 ghfast 加速、push 直连、凭据助手用 gh）；发布后建议做一次"走国内加速下载 + 校验和比对"的实测。

---

## 7. 待办与可选增强

1. **（必修）干净环境回归**：找一台干净的 Windows（虚拟机/新账户），从零走一遍——
   安装器安装 → 向导第 1~3 步 → 11 项检查全绿 → 启动 GPT（看到"出口 = 自己的静态 IP"证据）→ 关闭全部（UAC）→ 卸载；
   同时确认产物里不含 `private\`、日志、`.git`、任何真实私密值。
2. 可选增强：配置里的密码用 DPAPI 加密落盘（现在明文在 `%APPDATA%`，仅受用户目录权限保护）；
   英文界面（文案目前集中在 `ui/app.js` 与 `engine/*` 的输出里）；更多节点来源（自建 socks5 列表等）；
   安装器代码签名（消除 SmartScreen 提示）。
3. 已知限制（不是 bug，别"修"）：Roxy 为闭源软件、本地接口未文档化（窗口/端口探测可能随版本变化）；
   TUN 依赖 Clash Verge 服务模式；无代码签名；不提供任何代理资源（出口需用户自备）。

---

## 8. 踩过的坑（省你几天时间）

1. **看门狗会"自杀"**：`installWatchdog(10, () => process.exit(3))` 若不清定时器，界面模式（引擎跑在 Electron 主进程内）会在用完一次"启动/关闭"后 **10 分钟自己退出**。修法：`finally { clearTimeout(watchdog) }` + 界面模式传 `watchdogExit:false`；回归脚本 `tools/dev-watchdog-smoke.js`。
2. **`Start-Process -ArgumentList` 不接受空数组**（无参数启动会在绑定阶段报错）——无参数时必须省略该参数。
3. **白名单比较要 `toLowerCase()`**：Windows 文件名不区分大小写，`RoxyBrowser.exe` 曾因此被误拒。
4. **打包形态的提权**：`elevate.ps1` 必须允许"只有 -ExePath"这种形态（打包后的 exe 本身就是应用）；用 `-DryRun` 干跑自检，不要真的弹 UAC 来测。三种形态：打包版 / 未打包（-AppPath）/ 命令行（-ScriptPath）。
5. **asar 与 PowerShell**：外部进程读不了 asar 内部路径 —— `engine/tools/**` 必须 `asarUnpack`，`exec.js` 会把 `app.asar` 换成 `app.asar.unpacked`。
6. **Electron 44 的 npm 包没有 postinstall**：二进制靠首次 `npx electron` 懒下载（配合 `ELECTRON_MIRROR`）。
7. **Roxy 窗口的进程形态**：本机实测窗口主进程是 `RoxyBrowser.exe --roxy-action launch-browser --dir-id <32hex>`；只按 `RoxyChrome.exe` + `browser-cache` 匹配会漏（两种形态都要认）。
8. **TUN 开启时没有"真·直连"**：任何直连请求也会被 TUN 接管，`egressDirect` 只在 Clash 已停（如"关闭全部"终检）时才有意义。
9. **安全钩子（Mimosa）**：`spawn/execFile(变量路径)`、动态 `require(变量)`、argv→fs 路径、"带路径参数的函数"都会被拦 —— 替代写法见 `tools/` 里的现有实现（白名单 + 参数数组；纯字面量常量路径）。
10. **提交前扫描**：`npm run secrets`（含 `-Aggressive`）应 0 命中；`dist\builder-debug.yml` 含本机路径，别提交（`dist/` 已 gitignore，但脚本扫描时记得排除或删掉它）。

---

## 9. 接手清单（逐条打勾）

- [ ] 能访问仓库（gh 已登录 / 有写权限），本地 `git clone` 后 `npm install` 能跑 `npm run gui`
- [ ] `node app.js check --quick` 在本机能给出结果（不需要装 Clash 也能跑，只是会报"未找到")
- [ ] 能复现一次发布：`npm run dist` 出 exe；`npm run secrets` 0 命中
- [ ] 明白"不删 release"的规矩，并在新版本发布时执行
- [ ] 知道私密值只在本机 `%APPDATA%\GPTProxyWizard\config.json` 与 `private\`，且不要把它们提交/上传
- [ ] 读过 §8 的坑，尤其是 1（看门狗）与 4（提权三形态）

---

## 10. 来源与许可

- 引擎由用户既有的另一个项目（`HelpUseCodexAndGPTAPI`，公开仓库）**复制改造**而来；**原项目未做任何改动**，两边可以共存。
- 本仓库代码 MIT（见 `LICENSE`）；第三方软件"只引导、不分发"的边界见 `LICENSES.md`。
- 保留 "🪄 deepseek 许愿式编程产物" 标记，用于版本控制与产物溯源。
