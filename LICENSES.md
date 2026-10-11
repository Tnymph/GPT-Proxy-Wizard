# 第三方组件与再分发声明

本仓库**只包含我们自己的代码**。下面区分三类情况：运行期依赖（打包时会被带入）、
构建期依赖、以及**只被引导、绝不随本程序分发**的第三方软件。

## 1. 运行期依赖（打包产物中会包含）

| 组件 | 许可证 | 说明 |
|---|---|---|
| Electron / Chromium / Node.js | MIT（Electron）、BSD 类（Chromium/Node 及其内嵌组件） | 桌面运行时。electron-builder 打包时会自动附带各自的许可证文件（`LICENSE.electron.txt`、`LICENSES.chromium.html`），发布产物时请一并保留 |

引擎本体（`engine/`）为零依赖纯 Node 代码，运行时只调用 Windows 自带组件：
PowerShell 5.1、`taskkill` / `reg` / `curl` / `schtasks` / `explorer`。

## 2. 构建期依赖（不进产物）

| 组件 | 许可证 | 说明 |
|---|---|---|
| Electron（npm 包，devDependency） | MIT | 开发与打包用 |
| electron-builder（计划中） | MIT | 生成安装器/便携包 |

## 3. 被引导但**不再分发**的第三方软件

本程序只做"检测安装位置 → 引导到官方渠道 → 复查配置"，**不打包、不再分发**下列软件；
请自行到官方渠道获取并遵守各自许可：

| 软件 | 许可情况 | 我们的做法 |
|---|---|---|
| Clash Verge Rev（含 verge-mihomo 内核） | GPL-3.0 | 仅检测其安装位置与运行状态；不捆绑、不改其代码（通过其官方支持的"扩展文件"机制与本地 API 交互） |
| Roxy Browser | 闭源商业软件 | 仅检测安装与本地服务状态；不捆绑、不修改 |
| ChatGPT 桌面端 | Microsoft Store / OpenAI 专有 | 仅检测与打开；只能由用户从 Microsoft Store 安装 |

## 4. 交互方式说明

- 与 Clash 内核的交互走其**官方 REST API**（Windows 命名管道，不校验 secret），
  以及 Clash Verge 官方支持的订阅"扩展文件"（`prepend/append/delete` 合并机制）；
- 与 Roxy 的交互限于：读取本地窗口元数据（判断窗口是否打开）、探测其本地代理端口、
  按官方界面同样的方式启动窗口；不注入、不修改其文件；
- 与 ChatGPT 桌面端：只按 Microsoft 官方方式（`shell:AppsFolder\...`）启动，不修改其安装文件。

## 5. 合规提示

- 本程序只帮助你配置**你自己拥有的**代理资源；不内置任何订阅、账号或静态 IP；
- 不收集任何遥测；所有上传/下载行为（订阅更新、出口校验请求）都发生在你自己配置的链路上；
- 若你把本程序分发给他人，请连同本文件一起分发，并确保产物中不含任何私密值
  （发布前必须运行 `tools\scan-for-secrets.ps1`，0 命中）。
