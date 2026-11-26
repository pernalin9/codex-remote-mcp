# 进阶配置、工具一览与安全说明

本文档收纳 `codex-remote-mcp` 的运行环境细则、配置与生效机制、工具清单及安全架构说明。常规上手请先查看 [README.md](../README.md)。

---

## 一、本地运行环境细则

- **操作系统**：支持 **Windows** 与 **macOS**（统一 Node.js 运维入口，也兼容 Linux 回退路径）。
- **Node.js**：需要 **Node 22.16+**（使用内置 `node:sqlite`）。
- **默认端口**：本地回环默认监听 `127.0.0.1:9088`。新部署时，部署引导从 `9088` 开始探测，端口被占用则自动 `+1` 递增直到找到首个空闲端口，并将选定端口写入 `.env` 的 `PORT`。
- **独立安装的 Codex CLI（关键）**：必须安装并登录独立的 `@openai/codex` CLI（例如通过 npm 全局安装），并确保处于当前桌面登录用户下运行。
  - **Windows 特别注意**：不要指向 Codex 桌面客户端自带的内置 `codex.exe`（后台只读可通，但执行写文件沙箱时可能报 `app runtime provisioning service is unavailable`）；若配置开机自启，计划任务必须使用**当前桌面登录账户**，禁止使用 `SYSTEM` 账户（会读错 `CODEX_HOME`）。
  - **会话同步**：独立 CLI 与 Codex 桌面客户端共用当前用户的 `CODEX_HOME`，通过 Gemini 创建的持久线程会同步出现在桌面侧边栏中（默认带 `[Gem]` 或 `[Gem][Fork]` 前缀）。

---

## 二、配置文件与生效方式

### 1. 个性化配置文件
- **`config/profiles.json`**（本地忽略）：定义 `default`、`coding`、`probe`、`review`、`deep_review` 五个语义档位。部署时由 Codex 基于账号真实 `model/list` 推荐组合，基准推荐支持代际自动替换。
- **`config/repos.json`**（本地忽略）：白名单声明允许 Gemini 访问的本地项目目录、简称与备注；`.env` 中的 `DEFAULT_REPO` 指定未提及项目时的默认归属。
- **`config/gemini-instructions.md`**（Git 追踪）：系统前置协作规则，随版本自动更新。
- **`config/user-instructions.md`**（本地忽略）：个人自定义协作规则，可从 [config/user-instructions.example.md](../config/user-instructions.example.md) 复制并按需编辑。服务会在系统规则后自动拼接个人规则，合并上限为 10,000 字符。
- **`ALLOW_FULL_ACCESS_REPOS`**（`.env` 可选项）：允许按需开启全权限执行的项目白名单，支持用英文或中文逗号分隔项目名或别名，空值禁用；续接任务按线程实际目录校验。

### 2. 热加载、重启、Sync Schema 与 OAuth 续期
- **热加载**：修改 `config/gemini-instructions.md`、`config/user-instructions.md`、`config/repos.json`、`config/profiles.json` **无需重启、无需重连**，在 Gemini 聊天里重新触发一次 `codex_start` 即可生效。
- **重启服务**：修改 `.env` 或升级桥接代码后，执行 `npm run ctl -- restart` 生效。
- **同步工具参数**：升级桥接并新增或修改工具参数后，在 Gemini Developer Mode 的 **Tool Schemas** 中点击 **Sync schema** 即可。
- **OAuth 自动续期**：Gemini 保留有效的 OAuth 刷新令牌时可自动续期，关闭再打开应用可沿用原授权；仅在解除账户关联或移除应用后重新连接时，才需要通过 `npm run ctl -- copy-code <连接编号>` 重新获取一次性短码。

---

## 三、公网入口进阶注意事项

- **Cloudflare Named Tunnel**：若遇请求被拦截，免费版普通 Bot Fight Mode 无法通过 WAF Skip 按路径跳过，请先检查 Cloudflare 控制台的 **Security → Events** 再按实际套餐处理。如本机开启 Clash / Mihomo TUN 模式导致隧道异常，详见 [VERSION_MANUAL.md](../VERSION_MANUAL.md)。
- **Tailscale Funnel**：需留意 Tailscale Funnel 的外网端口限制以及 macOS 客户端变体要求。
- **自有 VPS / 反向代理 / frp**：将标准 HTTPS 流量反代至本机回环地址 `127.0.0.1:<PORT>` 即可。

---

## 四、文件与多模态边界

- **上传文件局限**：在 Gemini 网页端直接上传的原始图片、PDF、表格等非纯文本文件，Gemini 只能理解其内容，**无法把原始二进制写入本地磁盘**。若需要 Codex 修改原件，请先把文件放进对应项目目录再告知路径。
- **本地多模态读取**：`repo_read_file` 仅读取纯文本（支持 UTF-8 与 UTF-16 BOM，自动拦截二进制/PDF 防止乱码灌上下文）；仓库内已有的图片可通过 `local_images` 参数交由 Codex 本地识图，PDF/表格等交由 Codex 在本地解析后回传结构化摘要。

---

## 五、工具能力一览（共 13 个工具）

| 工具 | 用途 |
|---|---|
| `codex_start` | `@codex` 开场入口：返回热加载规则、项目列表、模型档位、最近会话与运行状态 |
| `codex_get_project` | 查看指定项目详情与会话列表；传 `thread_id` 只读会话正文，支持 `view="outline"` 轮次目录、`last_turns` 末尾读取与游标分页 |
| `codex_fork` / `codex_rename_thread` | 遇桌面端占用（`THREAD_BUSY`）或需剪枝时从指定已完成轮次创建持久分支（`[Gem][Fork]`） / 重命名会话 |
| `codex_review` / `codex_execute` | 发起只读评审（支持 `ephemeral=true` 临时探针） / 仓库写任务；支持 `local_images` 本地识图与按需开启 `network_access`。已获授权的白名单项目可对单次执行传 `full_access=true` |
| `codex_get_result` / `codex_list_jobs` | 轮询任务进度（支持最长 50s 等待、返回 `steps_completed` 与 `latest_note` 及长正文 `next_offset` 续读） / 按项目或线程查询任务清单 |
| `codex_cancel_task` / `codex_restart_server` | 中止指定运行中任务 / 默认重置 Codex `app-server`。传 `scope="bridge"` 会排空任务并隔离预检，发送受理响应后才重启桥接并重载 `.env`。重试同一次请求时沿用 `idempotency_key` |
| `repo_list_files` / `repo_read_file` / `repo_write_file` | 安全枚举目录 / 按行或关键词读纯文本（含 UTF-16 支持与敏感黑名单拦截） / 在 `.ai-handoff/` 内原子写入交接文件 |

普通文本续接默认启用桌面队列兜底。桥接先尝试正常续接，遇桌面写锁时可追加到白名单仓库的原会话，沿用其模型、推理强度与权限，已有待处理消息也可继续排队。只有在可读的最新会话设置明确为只读而本次要求写入，或明确离线而本次要求联网时，才拒绝该次队列提交。指定模型或推理强度、带本地图片或启用全访问的请求跳过队列。需要严格固定本轮设置时传 `allow_queue=false`，受限只读 OAuth 客户端无法使用队列。建议续接时传稳定的 `idempotency_key`，按同一 `job_id` 查询进度。桥接按客户端消息 ID 查回原轮次，前 30 秒每 2 秒查一次，此后每 5 秒查一次，最多跟踪 30 分钟，重启后恢复跟踪。取消跟踪、超时或回执不明时，桌面仍可能执行。收到 `CHECK_ORIGINAL_THREAD` 时应核对原会话，收到 `QUEUE_NOT_SUBMITTED` 时可按任务类型分叉。

---

## 六、安全与隐私说明

- 服务仅监听回环地址 `127.0.0.1`，公网走 HTTPS 与 OAuth 2.1（PKCE）。本机控制通道为当前授权请求签发 8 位短码，最长有效两分钟，五次输错后需要重新生成，成功即作废。SQLite 仅保存令牌哈希。
- 桥接直接发起的轮次按评审或执行显式下发模型、推理强度和沙箱策略，沙箱默认断网，可按轮开启。桌面队列续接沿用桌面会话设置。
- 普通执行使用桥接数据目录下的 `sandbox-tmp`。启用 `full_access=true` 的执行以桥接进程账户权限运行，终端也具有该账户的网络权限。桥接直接发起的评审使用只读沙箱。
- 敏感路径（`.git`、`.env*`、私钥/证书、密码文件、`.codex/auth.json`）在目录枚举、文本读取、附件展开与图片校验中均默认拦截。
