# private/ · 隐私目录

**本目录用于存放"绝不能进公开仓库 / 分发物"的东西。** 除本文件外，整个目录已被 `.gitignore` 忽略。

## 可以放在这里的

- 本机开发时用的真实配置副本（例如从旧项目迁移出来的 `config.local.js` / 导出的 `config.json`）
- 排障用的日志、截图（可能含真实 IP / 账号 / 窗口名）
- 任何你不想让人看到的笔记与凭据

## 绝对不要

- 不要把这里的东西复制到 `engine/`、`ui/`、`tools/`、文档或任何会被打包/提交的位置；
- 不要在 `engine/`、`ui/` 的代码或默认配置里写真实 IP、账号、窗口名、工作区 ID、订阅地址、token；
  一律用占位符 `<美国静态IP>`、`<窗口名>`、`<工作区ID>` 之类；
- 打包/发布前务必运行扫描（0 命中才允许发布）：

```bat
powershell -NoProfile -ExecutionPolicy Bypass -File tools\scan-for-secrets.ps1 -Command secrets -Target .
powershell -NoProfile -ExecutionPolicy Bypass -File tools\scan-for-secrets.ps1 -Command lint -Target .
```

## 运行期私密值放在哪

程序**运行时**的私密值不在本目录，而在用户自己的机器上：

- `%APPDATA%\GPTProxyWizard\config.json`（界面向导采集写入；CLI 可用 `node app.js config path` 查看路径）

换机部署时，用 `node tools/dev-migrate-config.js --from <旧配置>` 迁移，或直接在界面里重新填写。
