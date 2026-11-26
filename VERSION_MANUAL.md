# Codex Remote MCP 版本维护手册

远端最新：`https://github.com/pernalin9/codex-remote-mcp/blob/main/VERSION_MANUAL.md`

## AI 执行协议

1. 对比本机 `package.json` 版本与本手册最新版本号，**只执行高于本机版本的增量条目**（按版本从旧到新）。
2. 遇到「新增环境自查项」时，**先自行检查本机配置/进程/网络环境**；命中风险再向用户说明并确认处理，未命中静默跳过。
3. 升级严禁覆盖本地忽略文件（`.env`、`config/repos.json`、`config/profiles.json`、`config/user-instructions.md`）。
4. 仅在用户主动报故障时，查阅文末「故障速查」。

## 增量版本记录

### v0.4.0
- **升级动作**：`git pull` → `npm run build` → 重启桥接 → 在 Gemini 的 Tool Schemas 点击 **Sync schema**，再调用 `codex_start(include_rules=true)` 加载投递跟踪与上下文剪枝规则。

### v0.3.1
- **升级动作**：使用 Cloudflare Named Tunnel 的 Windows 部署，已有 UUID 配置可直接沿用。将调用部署脚本的自启任务设为无参数的 `deploy/start-tunnel.ps1`；首次配置或修改域名、桥接端口时先执行 `deploy/start-tunnel.ps1 -Configure`。已按 UUID 直接运行连接器的自启任务可沿用。
- **新增环境自查项**：检查日常启动和自启使用隧道 JSON；升级时保留已有账户证书。新部署仅在公网验收通过后清理本次新建的账户证书，尊重用户的保留要求。

### v0.3.0
- **升级动作**：`git pull` → `npm run build` → `npm run ctl -- restart`（沿用本机 `.env` 端口）→ 在 Gemini Developer Mode 的 **Tool Schemas** 点击 **Sync schema**。
- **可选配置**：如需启用 `full_access`，在 `.env` 设置 `ALLOW_FULL_ACCESS_REPOS=<项目名或别名，逗号分隔>`，保留现有 `PUBLIC_BASE_URL`，然后重启桥接服务。

### v0.2.2
- **升级动作**：`git pull` → `npm run build` → `npm run ctl -- restart`（沿用本机 `.env` 端口）。规则合并上限升至 10,000 字符。

### v0.2.1
- **升级动作**：`git pull` 后，在 Gemini 重新调用一次 `codex_start` 热加载规则。
- **可选配置迁移**：若本机 `config/user-instructions.md` 沿用旧版全局文案确认模板，可参考 `config/user-instructions.example.md` 改为局部确认。

### v0.2.0
- **升级动作**：`git pull` → `npm run build` → `npm run ctl -- restart`（保留现有 `.env` 端口；无需 `Sync schema`）。
- **配置迁移**：若旧版改过 `config/gemini-instructions.md`，先备份个人条款，拉取后迁入 `config/user-instructions.md`。
- **新增环境自查项**：
  - **Clash / Mihomo TUN 干扰 Cloudflare Tunnel**
    - **适用**：使用 Cloudflare Tunnel 的环境
    - **自查**：检查本机是否运行 Clash / Mihomo 且启用了 TUN 模式，以及 `cloudflared` 是否未配置进程/端口绕过且未指定 `protocol: http2`
    - **命中后确认**：提示 TUN 会干扰隧道 `7844` 端口，询问用户是否放行 `cloudflared` / `7844` 直连，或在隧道配置中改为 `protocol: http2`

### v0.1.0
- 初始版本，无增量迁移。

## 故障速查（仅排障时核对）

- **隧道断连 / 502 / 长轮询中断**：查本机 Clash/Mihomo TUN 干扰；查 Cloudflare Security Events 是否被免费版 Bot Fight Mode 拦截。
- **Windows 写文件报 `app runtime provisioning service is unavailable`**：查 `.env` 是否误指桌面端内置 `codex.exe`，或计划任务是否跑在 `SYSTEM` 账户下。
- **找不到 Gemini Custom Apps 入口**：直接给链接 `https://gemini.google.com/usage?hl=en`。
