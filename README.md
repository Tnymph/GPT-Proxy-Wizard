> # 🪄 deepseek许愿式编程产物
>
> **本仓库由 DeepSeek 以"许愿式编程"方式产出**：由人提出需求，模型负责设计、实现、自测与交付。
> 保留此醒目标记，用于版本控制与产物溯源。
>
> **维护状态：后续停止更新**（最后一版 v0.1.1）。接手请先读 **[HANDOVER.md](HANDOVER.md)**（现状、架构、发布流程、避坑清单、待办）。

---

# GPT Proxy Wizard（GPT 代理配置向导）

把"让 ChatGPT / Codex 桌面端全程走美国出口（静态 IP 优先）"这件事做成一个**带向导界面的 Windows 小工具**：

**检测已装的第三方软件 → 引导你完成必要配置 → 一键应用并逐项验证 → 日常"启动 GPT / 关闭全部"。**

- 本仓库只包含**我们自己的代码**：不捆绑、不再分发任何第三方安装包，也不含任何私密值。
- 程序**不提供任何代理资源**：出口（静态 IP / 订阅）需要你自己拥有并填入。
- 私密值只存在于两个地方：本机 `%APPDATA%\GPTProxyWizard\config.json`（界面向导写入），
  以及本仓库的 `private\` 目录（已 gitignore，用于本机开发/迁移，绝不进分发包）。

---

## 功能一览

| 能力 | 说明 |
|---|---|
| 环境自检（只读） | Clash Verge 安装/服务/内核/TUN/系统代理、Roxy、ChatGPT 桌面端、出口通道，共 11 项检查，失败项都给出"下一步" |
| 向导 | 第 1 步 Clash Verge（检测安装位置、数据目录）；第 2 步出口来源（三选一）；第 3 步 ChatGPT 检测/打开 |
| 单独打开（检查用） | 配置好各软件的安装位置后，可**逐个打开** Clash Verge / Roxy 主程序 / Roxy 指纹窗口 / ChatGPT，并核对进程是否真的出现（仪表盘卡片、向导每一步、设置页"单独打开"都有按钮；命令行 `node app.js open <目标>`） |
| 启动 GPT | 准备代理环境（服务 → 应用/系统代理 → 窗口/通道 → 扩展文件 → 就绪核对 → 测速 → 打开 ChatGPT），最后给出**可复核证据**：静态出口 IP、分流链路（chains）、规则命中、应用自身流量 |
| 关闭全部 | ChatGPT（含 Codex 进程）→ Roxy → 系统代理 → Clash（含停服务）→ 项目窗口 → 终检（回到直连） |
| 严格 / 兜底模式 | `select`：只用所选出口，不通就不可用；`fallback`：不通时回退订阅美国节点 |
| 干跑与日志 | `--dry-run` 只检查不修改；运行日志写到应用目录，**默认遮罩**（IP/账号/Roxy 身份都打码） |
| 幂等自愈 | 扩展文件内容一致就不动；内核没加载就重启 Clash 重载；静态通道不通就重建 Roxy 链路 |

### 三种出口模式（向导第 2 步）

| 模式 | 是否静态 IP | 需要你提供 | 说明 |
|---|---|---|---|
| **A. Roxy 静态 IP**（推荐） | ✅ | Roxy 指纹浏览器 + 你自备的美国静态 IP（在 Roxy 窗口里配置）+ 窗口名/工作区 ID | 本程序经 roxynet 本地代理口接入 |
| **B. 自备静态 IP** | ✅ | socks5 / http 的服务器地址、端口、账号密码 | 直接写成 Clash 节点，**不依赖 Roxy** |
| **C. 订阅美国节点** | ❌（只是"能用且在美国"） | Clash 订阅里的一个美国节点 | 兜底方案，向导里会明确标注差异 |

---

## 前置条件

- Windows 10 / 11（x64）
- [Clash Verge](https://github.com/clash-verge-rev/clash-verge-rev)（需开启**服务模式 + TUN**）
- ChatGPT 桌面端（Microsoft Store 搜索 "ChatGPT"）
- 出口三选一：A) [Roxy Browser](https://www.roxybrowser.com/) + 自备美国静态 IP；B) 自备 socks5/http 静态 IP；C) 你自己的 Clash 订阅
- （命令行方式需要）Node.js ≥ 20；界面方式无需单独装 Node（打包版自带运行时）

> 上述第三方软件**都需要你自己到官方渠道安装**。本程序只做"检测 → 引导 → 复查"，不代装、不再分发。

---

## 使用

### 界面（日常使用）

```bat
npm install
npm run gui
```

或使用打包后的安装包/便携版（打包方式见下文）。界面左侧五个页面：**仪表盘 / 向导 / 检查 / 设置 / 日志**。

### 命令行（与界面等价，便于排障与自动化）

```bat
node app.js help                        :: 用法
node app.js detect                      :: 只探测：本机装了哪些、在哪（只读）
node app.js check --quick               :: 11 项检查（只读；--quick 跳过联网项）
node app.js open clash|roxy|window|chatgpt
                                        :: 按配置好的位置单独打开某个软件，并核对进程是否真的出现
                                           （用于检查"安装位置配得对不对"，或先把某个软件打开备用）
node app.js start --dry-run             :: 干跑：只检查与汇报，不做任何修改
node app.js start                       :: 一键启动（准备代理并打开 ChatGPT）
node app.js stop                        :: 一键关闭（会弹一次 UAC）
node app.js cleanup                     :: 清理辅助项（只列出；加 --apply 才执行）
node app.js config path|show|init       :: 配置查看 / 初始化模板
```

### 打包产物（给同事分发）

```bat
npm run dist        :: 生成 dist\GPT-Proxy-Wizard-<版本>-setup.exe（安装器）与 -portable.exe（便携版）
```

- 安装器装到 `%LOCALAPPDATA%`，**不强制管理员**；便携版解压即用；
- 产物只包含我们自己的代码（`app.js`/`engine`/`main`/`ui` + 文档），
  `private\`、`node_modules\`、日志、`.git`、任何私密值都不会进入；
- 分发前请自行确认：在**干净机器**上按向导走一遍、跑一次打包产物扫描（见"隐私与遮罩"）。

退出码：`0` 成功；`1` 有失败项/已有实例在运行；`2` 配置或步骤错误；`3` 未预期异常；`10` 已提权到新窗口继续执行。

---

## 目录结构

```
app/
├─ app.js                 # CLI 入口（node app.js <命令>）
├─ engine/                # 引擎：零依赖纯 Node（也可被 Electron 直接复用）
│  ├─ cli.js / start.js / stop.js / check.js / detect.js / config.js
│  ├─ lib/                # 执行封装、Clash API、扩展文件、Roxy、系统代理、日志、锁…
│  └─ tools/              # PowerShell 工具脚本（全部 UTF-8 带 BOM）
├─ main/                  # Electron 主进程 + preload（contextIsolation）
├─ ui/                    # 界面（原生 HTML/CSS/JS，无前端框架）
├─ tools/                 # 脱敏扫描 / BOM 工具 / 配置迁移工具
├─ private/               # 隐私目录（除 README 外全部 gitignore）
└─ package.json
```

## 隐私与遮罩

- 日志与检查结果**默认遮罩**：IPv4 只保留前三段、用户名/主机名、Roxy 窗口名/工作区 ID、上游主机与账号；
- 界面里敏感输入框默认打码（留空 = 不修改），需要查看/编辑时打开"显示敏感值"（截图演示时请保持关闭）；
- 关闭遮罩：命令行 `--show-sensitive`，或界面"设置 → 遮罩敏感值"；
- **发布/打包前必须扫描**（0 命中才算通过，`private/` 目录应排除在产物之外）：

```bat
node app.js detect >nul
powershell -NoProfile -ExecutionPolicy Bypass -File tools\scan-for-secrets.ps1 -Command secrets -Target .
powershell -NoProfile -ExecutionPolicy Bypass -File tools\scan-for-secrets.ps1 -Command lint    -Target .
```

## 卸载与清理

1. **日常卸载**：用安装器自带的卸载项卸载程序本体（用户配置与日志不会被删）；
2. **清理辅助项**（本方案在系统里的三处改动）——界面「设置 → 维护 → 清理辅助项…」，或命令行：

```bat
node app.js cleanup            :: 先列出将做什么（只读）
node app.js cleanup --apply    :: 实际执行：删助手计划任务 / 关闭本方案设置的系统代理 / 还原扩展文件备份
```

3. **彻底清理**：手动删除 `%APPDATA%\GPTProxyWizard`（配置 + 日志）。

## 开发与打包（开发者）

- 引擎是零依赖纯 Node：`node app.js <命令>` 即可直接调试，不需要 Electron；
- 打包用 `electron-builder`（`npm run pack` 出未打包目录，`npm run dist` 出安装器 + 便携版）；
  PowerShell 工具脚本通过 `asarUnpack` 解包到 `app.asar.unpacked/engine/tools/`（外部进程读不了 asar）；
- 产物**不得**包含：`private/`、`node_modules/`、日志、`.git`、任何真实私密值；
- 打包前跑上面的 secrets + lint 扫描（0 命中）；**安装器**还应在干净机器（虚拟机/新账户）上完整走一遍向导（P6 回归）。

## 已知限制

- 需要你**自备美国出口**（本程序不内置任何代理资源与订阅）；
- TUN 依赖 Clash Verge 的服务模式（首次开启可能需要管理员权限）；
- 首次"关闭全部"需要一次 UAC（用于注册"启动服务"助手计划任务，之后日常启动无需 UAC）；
- 未做代码签名：Windows SmartScreen 可能提示"未知发布者"，选择"仍要运行"即可；
- Roxy Browser 为闭源软件且其本地接口未文档化，相关能力（窗口/代理口探测）可能随版本变化；
- 日志/配置存放在 `%APPDATA%\GPTProxyWizard\`，卸载时是否清除由安装器提示。

## 许可

- 本仓库代码：MIT，见 [LICENSE](LICENSE)；
- 第三方组件与"不捆绑"声明：见 [LICENSES.md](LICENSES.md)。
