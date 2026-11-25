# Codex Remote MCP 版本手册与排障指南

本文件记录 `codex-remote-mcp` 的版本演进、升级动作与高频环境坑点。无论是检查更新还是排查异常，本机 Codex 均应优先查阅 GitHub 上最新版本的本文件：
`https://github.com/pernalin9/codex-remote-mcp/blob/main/VERSION_MANUAL.md`

---

## 一、给本机 Codex 的自动检查与升级指引

当用户让你「检查更新」或「排查连接/隧道/运行问题」时，请按以下顺序执行：
1. **获取最新手册**：先读取 GitHub `main` 分支最新的 `VERSION_MANUAL.md`（或先 `git fetch origin` 对比 `origin/main` 与当前本地提交、`package.json` 版本号）。
2. **优先核对已知坑点**：若用户正在排查故障，先对照下方「三、已知问题与环境避坑清单」逐项核查本机环境，命中时直接给出针对性提示与修复步骤。
3. **判断是否需要升级**：
   - 若本地已是最新版本，直接告知已是最新，并只提示与当前环境相关的注意事项。
   - 若远端有新版本，简明列出新增版本的核心变更与「升级动作」，征得用户同意后执行 `git pull`、按版本要求安装依赖/构建/重启，并提醒是否需要在 Gemini 网页端点击 **Sync schema**。
   - 升级时严禁覆盖用户的本地忽略文件（`.env`、`config/repos.json`、`config/profiles.json`、`config/user-instructions.md`）。

---

## 二、版本记录与升级动作

### v0.2.0（2026-11-24）
- **主要变更**：
  1. **协作规则拆分**：将 `config/gemini-instructions.md` 改为 Git 追踪的系统前置规则（随版本自动更新）；新增本地忽略的 `config/user-instructions.md`（模板为 `config/user-instructions.example.md`，内置「文案主权」等体验示例），服务端热加载自动拼接。
  2. **部署引导大幅精简（`DEPLOY_PROMPT.md`）**：新增极简对话规范，缺依赖单刀直入、隐藏内部自检流水账、项目列表化、绑定后改为单句引导验收，信息类内容后置。
  3. **模型档位与默认端口调整**：移除 `reasoning` 档位（保留 `default`、`coding`、`probe`、`review`、`deep_review` 5 档）；默认端口由 `19224` 调整为 `9088`（新部署时若占用自动 `+1` 递增）。
  4. **新增版本手册（`VERSION_MANUAL.md`）**：统一维护版本升级动作与已知环境坑点。
- **老用户升级动作**：
  - 执行 `git pull` 后运行 `npm run build` 与 `npm run ctl -- restart`。
  - **无需改动 `.env` 中的现有端口**（如已运行在 `19224`，继续保留即可，不影响现有隧道和 Gemini 绑定）。
  - 若此前在旧版 `config/gemini-instructions.md` 中写过个人定制规则：先备份你的自定义条目，拉取新版系统 `config/gemini-instructions.md` 后，将个人规则迁入 `config/user-instructions.md`（热加载生效，无需重启）。
  - 工具 Schema 未变化，**无需**在 Gemini 网页端重新绑定或 Sync schema。

### v0.1.0（2026-11-24）
- 初始开源版本，支持 Windows / macOS 双端部署、13 个 MCP 工具、OAuth 2.1（PKCE）与剪贴板一次性短码授权、热加载配置与桌面端会话同步。

---

## 三、已知问题与环境避坑清单

### 1. Clash / Mihomo TUN 模式干扰 Cloudflare Tunnel 端口
- **现象**：本地桥接 `/healthz` 正常，但 Cloudflare Named Tunnel 频繁断连、建连超时，或公网访问 `/mcp/v1` 偶发 502 / 超时 / 轮询中断。
- **原因**：Clash / Mihomo 开启 TUN（虚拟网卡）模式时，会接管本机出站流量（尤其是 `cloudflared` 连接 Cloudflare 边缘节点使用的 QUIC UDP `7844` 与 TCP `7844` 端口），导致隧道控制链路异常或延迟剧增。
- **排查与处理建议**：
  1. 临时关闭 Clash / Mihomo 的 **TUN 模式**，观察隧道是否立即恢复稳定。
  2. 若需长期开启 TUN，请将 `cloudflared` 进程加入 TUN 绕过列表（`tun.exclude-process` / 进程直连规则），或在规则中对 Cloudflare Tunnel 端口 `7844`（TCP/UDP）及 `*.argotunnel.com` / `*.cftunnel.com` 走 `DIRECT` 直连。
  3. 若当前网络对 UDP 不友好，也可在 `cloudflared` 配置中显式切换传输协议为 `protocol: http2` 规避 QUIC 干扰。

### 2. Windows 误用 Codex 桌面端内置 `codex.exe` 或 `SYSTEM` 账户
- **现象**：只读探查可用，但写文件任务报 `app runtime provisioning service is unavailable`，或提示未登录 / 找不到桌面端会话。
- **处理**：确保安装独立 CLI（`npm.cmd install -g @openai/codex`）并在 `.env` 中指向该独立 CLI；开机自启计划任务必须运行在**当前桌面登录用户**下，禁止使用 `SYSTEM` 账户。

### 3. Cloudflare 免费版 Bot Fight Mode 拦截 `/mcp/v1`
- **现象**：公网浏览器打开正常，但 Gemini 服务端请求 `/mcp/v1` 或 OAuth 端点返回 `403` / 质询页。
- **处理**：登录 Cloudflare 控制台查看 **Security → Events** 确认拦截来源；免费版普通 Bot Fight Mode 无法通过 WAF Skip 按路径跳过，需按实际套餐调整安全策略。

### 4. Gemini 网页端找不到 Custom Apps 入口
- **处理**：直接访问 [https://gemini.google.com/usage?hl=en](https://gemini.google.com/usage?hl=en) 打开入口。

### 5. 修改配置或升级代码后不生效
- 修改 `config/gemini-instructions.md`、`config/user-instructions.md`、`config/repos.json`、`config/profiles.json`：**热加载生效，无需重启**，在 Gemini 聊天中重新触发一次 `codex_start` 即可。
- 修改 `.env` 或升级 `src/` 代码：需执行 `npm run build && npm run ctl -- restart`。
- 升级后若有工具参数变更：在 Gemini Developer Mode 的 **Tool Schemas** 中点击 **Sync schema**。
