# Codex Remote MCP

将 **Gemini 网页端** 与你本机 **Codex CLI（`app-server`）** 连接起来的个人双 Agent 协作桥（支持 Windows 与 macOS）。Gemini 负责需求梳理、方案设计与正式文案，Codex 在你本机仓库内核实代码、执行已授权修改、运行验证，并与桌面端 Codex 共享会话历史。

> **设计定位**：本项目是面向个人自部署的轻量协作桥（非多租户公有服务）。部署流程**以交给本机 Codex 交互式引导完成为主**，因此本页重点列出上手前必须了解的**前提条件、隐形门槛与核心约定**，完整部署引导见 [DEPLOY_PROMPT.md](DEPLOY_PROMPT.md)。

---

## 一、开始前必看：前提条件与隐形门槛

### 1. Gemini 网页端自定义 MCP 的隐形门槛
- **账号与界面条件**：Gemini Custom Apps（Developer Mode）对账号类型、地区、年龄、语言及活动记录（History）开关有平台限制。若常规界面找不到自定义 MCP 入口，可尝试访问 [https://gemini.google.com/usage?hl=en](https://gemini.google.com/usage?hl=en) 核对当前账号是否具备入口。
- **热加载 vs 同步 Schema vs 重连**：
  - `config/gemini-instructions.md`、`config/user-instructions.md`、`config/repos.json` 和 `config/profiles.json` 支持热加载。文件更新后，在聊天里让 Gemini 再调一次 `codex_start` 即可生效。
  - 升级桥接服务并新增或修改工具参数后，在 Gemini Developer Mode 的 **Tool Schemas** 中点击 **Sync schema** 即可。
  - 修改 `.env` 需要重启本地桥接服务（`npm run ctl -- restart`）。
  - Gemini 保留有效的 OAuth 刷新令牌时可自动续期。关闭再打开应用时可以沿用该授权。解除账户关联或移除应用后，重新连接需要重新获取授权码。

### 2. 公网 HTTPS 入口选型（必须支持固定 HTTPS Origin）
Gemini 网页端需要通过公网 HTTPS 访问本机的 `/mcp/v1` 与 OAuth 端点。请根据你手头资源任选其一（部署时 Codex 会引导配置）：

| 方案 | 域名要求 | 稳定性与适用场景 |
|---|---|---|
| **Cloudflare Named Tunnel**（推荐） | 需要一个托管在 Cloudflare 的自有域名 | 长期固定域名，重启不失效。注意：若遇拦截，免费版普通 Bot Fight Mode 无法通过 WAF Skip 按路径跳过，请先查 Security Events 再按实际套餐处理。 |
| **Tailscale Funnel**（无域名首选） | 无需买域名，免费使用固定 `*.ts.net` | 适合没有自有域名的用户，重启域名不变；需注意 Tailscale Funnel 的外网端口与 macOS 客户端变体要求。 |
| **自有 VPS / 反向代理 / frp** | 自有公网域名 + HTTPS 证书 | 将标准 HTTPS 流量反代至本机回环地址 `127.0.0.1:<PORT>` 即可。 |
| **Cloudflare Quick Tunnel**（仅尝鲜） | 免账号、免域名（`*.trycloudflare.com`） | **每次重启都会更换随机域名**，导致 OAuth issuer 与 Gemini 绑定全部失效，仅限 10 分钟临时体验，不适合日常使用。 |

### 3. 本地运行环境要求
- **操作系统**：支持 **Windows** 与 **macOS**（统一 Node.js 运维入口，也兼容 Linux 回退路径）。
- **Node.js**：需要 **Node 22.16+**（使用内置 `node:sqlite`）。
- **本地监听**默认使用 `127.0.0.1:9088`。新部署时，部署引导从 `9088` 开始探测，端口被占用就自动加 1，直到找到空闲端口，并将选定端口写入 `.env` 的 `PORT`。
- **独立安装的 Codex CLI（关键）**：必须安装并登录独立的 `@openai/codex` CLI（例如通过 npm 全局安装），并确保处于当前桌面登录用户下运行。
  - **Windows 特别注意**：不要指向 Codex 桌面客户端自带的内置 `codex.exe`（后台只读可通，但执行写文件沙箱时可能报 `app runtime provisioning service is unavailable`）；同时若配置开机自启，计划任务必须使用**当前桌面登录账户**，禁止使用 `SYSTEM` 账户（会读错 `CODEX_HOME`）。
  - **会话同步**：独立 CLI 与 Codex 桌面客户端共用当前用户的 `CODEX_HOME`，通过 Gemini 创建的持久线程会同步出现在桌面侧边栏中（默认带 `[Gem]` 或 `[Gem][Fork]` 前缀）。

### 4. 模型档位、项目列表与协作规则

- **`config/profiles.json`** 定义 `default`、`coding`、`probe`、`review` 和 `deep_review` 五个档位。部署时，Codex 根据当前账号的 `model/list` 推荐模型和推理强度。基准推荐支持代际自动替换，可采用当前可用、定位相同且更合适的新一代模型。
- **`config/repos.json`** 声明允许 Gemini 访问的本地项目目录、简称和备注。`.env` 中的 `DEFAULT_REPO` 指定默认项目。
- **`config/gemini-instructions.md`** 是由 Git 追踪的系统前置规则，随版本自动更新。
- **`config/user-instructions.md`** 是 Git 忽略的本地个人规则，可以从 [模板](config/user-instructions.example.md) 复制并按需编辑。服务会在系统规则后附加个人规则，合并后的上限为 10,000 字符。

### 5. 文件与多模态边界
- **上传文件局限**：你在 Gemini 网页端直接上传的原始图片、PDF、表格等非纯文本文件，Gemini 只能理解其内容，**无法把原始二进制写入你本地磁盘**。若需要 Codex 修改原件，请先把文件放进对应项目目录再告知路径。
- **本地多模态读取**：`repo_read_file` 仅读取纯文本（支持 UTF-8 与 UTF-16 BOM，自动拦截二进制/PDF 防止乱码灌上下文）；仓库内已有的图片可通过 `local_images` 参数交由 Codex 本地识图，PDF/表格等交由 Codex 在本地解析后回传结构化摘要。

---

## 二、快速开始（交给本机 Codex 部署）

无需手动克隆或翻阅文档，直接把下面这句话发给你本机的 Codex：

```text
请把 https://github.com/pernalin9/codex-remote-mcp.git 克隆到合适的本地目录（如目录已存在先问我），然后读取仓库里的 DEPLOY_PROMPT.md，按其中的步骤一步步引导我完成部署。
```

完整部署流程见 [DEPLOY_PROMPT.md](DEPLOY_PROMPT.md)，绑定完成后按 [GEMINI-ACCEPTANCE.md](GEMINI-ACCEPTANCE.md) 在 Gemini 网页端做一次全链路验收。

### 检查更新与排查问题

升级或遇到问题时，可查阅 [VERSION_MANUAL.md](VERSION_MANUAL.md)，也可直接把下面这句话发给本机 Codex。

```text
请查看 GitHub 上 pernalin9/codex-remote-mcp 最新的 VERSION_MANUAL.md，对比我本机的 codex-remote-mcp 版本并核对已知问题，如有更新或需要注意的环境坑点请提示我并引导处理。
```

---

## 三、日常运维命令（Windows / macOS 通用）

```bash
npm run doctor                 # 只读环境体检（Node、CLI、登录态、模型列表、端口、配置）
npm run ctl -- start           # 后台启动本地桥接服务（带单实例锁防重复启动）
npm run ctl -- status          # 查看运行状态与健康检查
npm run ctl -- restart         # 重启本地服务（修改 .env 后使用）
npm run ctl -- stop            # 停止本地服务
npm run ctl -- logs            # 查看最近服务日志
npm run ctl -- copy-code <连接编号>  # 将本次连接的 8 位授权码复制到系统剪贴板
npm run repo -- list           # 管理暴露的本地项目白名单（支持 list / add / remove）
```

首次连接 Gemini 时，先打开 OAuth 授权页，再在运行桥接的电脑上让本机 Codex 按页面显示的连接编号复制授权码。也可以在 `codex-remote-mcp` 项目目录运行上面的 `copy-code` 命令。把剪贴板里的短码粘贴到授权页即可。

---

## 四、工具能力一览（共 13 个工具）

| 工具 | 用途 |
|---|---|
| `codex_start` | `@codex` 开场入口：返回热加载规则、项目列表、模型档位、最近会话与运行状态 |
| `codex_get_project` | 查看指定项目详情与会话列表；传 `thread_id` 只读会话正文，支持 `view="outline"` 轮次目录、`last_turns` 末尾读取与游标分页 |
| `codex_fork` / `codex_rename_thread` | 遇桌面端占用（`THREAD_BUSY`）或需剪枝时从指定已完成轮次创建持久分支（`[Gem][Fork]`） / 重命名会话 |
| `codex_review` / `codex_execute` | 发起只读评审（支持 `ephemeral=true` 临时探针） / 仓库写任务；支持 `local_images` 本地识图与按需开启 `network_access` |
| `codex_get_result` / `codex_list_jobs` | 轮询任务进度（支持最长 50s 等待、返回 `steps_completed` 与 `latest_note` 及长正文 `next_offset` 续读） / 按项目或线程查询任务清单 |
| `codex_cancel_task` / `codex_restart_server` | 中止指定运行中任务 / 重置 Codex `app-server` 并核对账号状态 |
| `repo_list_files` / `repo_read_file` / `repo_write_file` | 安全枚举目录 / 按行或关键词读纯文本（含 UTF-16 支持与敏感黑名单拦截） / 在 `.ai-handoff/` 内原子写入交接文件 |

---

## 五、安全与隐私说明

- 服务仅监听回环地址 `127.0.0.1`，公网走 HTTPS 与 OAuth 2.1（PKCE）。本机控制通道为当前授权请求签发短码，最长有效两分钟，五次输错后需要重新生成，成功即作废。SQLite 仅保存令牌哈希。
- 工具层强制隔离只读评审与可写执行，每轮显式下发模型、推理强度与沙箱策略；终端沙箱默认断网，仅在 Gemini 识别到明确联网需求（如安装依赖）时按轮次显式开启。
- 敏感路径（`.git`、`.env*`、私钥/证书、密码文件、`.codex/auth.json`）在目录枚举、文本读取、附件展开与图片校验中均默认拦截。
