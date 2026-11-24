# 使用 Codex 部署 Codex Remote MCP

推荐直接按 [README.md](README.md) 的「快速开始」，向本机 Codex 发送一句话指令，由它自动克隆仓库并读取本文件引导部署；若你已自行克隆仓库，也可直接将下方整段 Prompt 复制发送给本机 Codex。

Codex 会先完成仓库就位与文档核对，再做只读环境侦察，并与你逐项对话确认所有关键决策；未经你确认不会改动配置文件、创建公网隧道或启动后台服务。

---

```markdown
请帮我部署并配置 `codex-remote-mcp`（Gemini 网页端与我本机 Codex 的协作桥）。

请先完成 **阶段零**，再严格按 **阶段一至阶段三** 逐步引导我。**在阶段二我明确确认全部关键决策之前，不要修改仓库追踪的模板文件、不要写入任何本地配置文件、不要创建公网隧道、也不要启动后台服务**：

### 阶段零：仓库就位与核对文档
1. **确认仓库目录**：若尚未克隆本仓库，先向我确认本机存放路径（给出推荐目录；若目标目录已存在先提示我），确认后再克隆并进入仓库目录；若已在仓库目录内则直接继续。
2. **核对核心文档与模板**：快速读取 `README.md`、`GEMINI-ACCEPTANCE.md`、`.env.example` 与 `config/*.example.*`，对齐当前版本的隐形门槛、运维命令与配置边界，再进入下一阶段。

### 阶段一：只读环境侦察
先检查我本机的实际环境与可用能力，不要猜测：
1. **系统与运行环境**：操作系统（Windows / macOS / Linux）、当前登录用户（Windows 需确认不是 `SYSTEM` 账户，macOS/Linux 需确认不是 `root`）、Node.js 版本（需要 `>= 22.16`）。
2. **独立 Codex CLI 探测**：检查我本机是否安装了独立的 `@openai/codex` CLI 并记录路径与版本（Windows 特别核对不要误选 Codex 桌面端内置的无沙箱 `codex.exe`）。若未安装，先告知我安装命令。
3. **动态探测模型与账号状态**：核对本机 Codex 登录状态，实际拉取当前账号可见的模型及支持的推理强度列表（`model/list`），不要假设固定模型名。
4. **扫描本机已有项目**：检查我本机 Codex 已有会话/项目目录，或列出常见工作目录供我挑选（仅列目录名与路径，不要读取业务源码）。
5. **公网暴露工具与端口**：检查本机是否已安装 `cloudflared` 或 `tailscale`，并确认候选本地端口是否空闲。

### 阶段二：与我对话确认关键决策
汇总侦察结果后，用清晰选项向我一次性确认以下决策（每项给出你的推荐方案与简短理由）：
1. **公网 HTTPS 暴露方案与地址**：
   - 方案 A：**Cloudflare Named Tunnel**（推荐，需我有托管在 Cloudflare 的自有域名；请向我确认域名及子域名，如 `codex.example.com`）
   - 方案 B：**Tailscale Funnel**（无自有域名首选，免费获得固定 `*.ts.net` HTTPS 地址）
   - 方案 C：**自有 VPS / 反向代理 / frp**（请向我确认公网 HTTPS Origin 与反代目标端口）
   - 方案 D：**Cloudflare Quick Tunnel**（仅限临时体验，明确提醒我每次重启会换域名导致 Gemini 绑定失效）
2. **本地监听端口与自启策略**：
   - 确认本地回环端口（默认监听 `127.0.0.1`），以及是否需要配置开机/登录自动启动（Windows 用当前登录用户计划任务、macOS 用用户级 `launchd` LaunchAgent，均不提交到 Git）。
3. **模型档位配置（`config/profiles.json`）**：
   - 基于阶段一动态探测到的**本机真实可用模型与推理强度**，为以下 6 个语义档位提出推荐映射并由我拍板（同时提醒我后续可随时自行编辑热加载）：
     - `default` / `coding`：日常连续开发与常规编码
     - `probe`：快速低成本只读探查、定位接口与单点事实查询
     - `review`：常规方案评审
     - `deep_review`：复杂架构评审与疑难排错
     - `reasoning`：高强度多步推演决策
4. **暴露的项目白名单与默认项目（`config/repos.json` & `DEFAULT_REPO`）**：
   - 展示侦察到的本地项目，引导我勾选允许 Gemini 远程访问的仓库、为常用项目设置简短别名与备注，并指定一个“未指定项目时的默认归属目录”（如新建或选用「通用」目录）。
5. **协作规则定制（`config/gemini-instructions.md`）**：
   - 基于 `config/gemini-instructions.example.md` 询问我是否需要调整：回复语言、审辩汇报与无感审批偏好、遇到桌面端占用（`THREAD_BUSY`）时是否允许自动分叉、以及是否允许 Gemini 在需要装依赖时按需开启 `network_access`。

### 阶段三：分步落地与双端验收
等我明确回复确认上述决策后，再开始执行：
1. 安装依赖、生成协议类型（如需要）、构建并运行自动化测试（`npm test`）。
2. 生成本地忽略的配置文件（`.env`、`config/repos.json`、`config/profiles.json`、`config/gemini-instructions.md`），不污染 Git 追踪的 `*.example.*` 模板。
3. 运行 `npm run doctor` 体检确认全部绿色，然后用 `npm run ctl -- start` 启动服务并验证本机 `/healthz` 返回 `200`、未授权访问 `/mcp/v1` 返回 `401`。
4. 按我选定的方案配置公网 HTTPS 入口：若涉及浏览器登录授权（如 `cloudflared tunnel login` 或 Tailscale 开启 Funnel），暂停并给我精确操作提示；完成后验证公网 `https://<你的域名>/healthz` 与 `/.well-known/oauth-authorization-server` 均返回 `200`。
5. 指导我在 Gemini Custom Apps（若默认界面未显示，提示尝试 `https://gemini.google.com/usage?hl=en`）填入 `https://<你的域名>/mcp/v1`（Client ID / Client Secret 留空）。等授权页出现后，按页面显示的连接编号，在项目目录运行 `npm run ctl -- copy-code <连接编号>` 将短码复制到我的剪贴板，指导我粘贴并提交。短码仅通过剪贴板交付。
6. 绑定成功后，把仓库内 `GEMINI-ACCEPTANCE.md` 的验收话术整理发给我，带我在 Gemini 网页端完成全链路验收，并在本机 Codex 桌面侧边栏核对同步结果。
```
