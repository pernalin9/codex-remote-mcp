# Codex Remote MCP

将 **Gemini 网页端** 与你本机 **Codex CLI** 连接起来的个人双 Agent 协作桥（支持 Windows / macOS）。Gemini 负责梳理需求、设计方案与把控体验，Codex 在你本机仓库内核实代码、执行修改并运行验证。

## 它能做什么
- **远程操控本机代码库**：在 Gemini 网页端直接指挥本机 Codex 读代码、改文件、跑测试。
- **与桌面端共享会话**：通过 Gemini 创建的对话会同步出现在本机 Codex 桌面端侧边栏，随时无缝接力。
- **按任务选档 + 配置热加载**：自动按探查、编码、评审、深度架构分配模型档位；修改个人规则、模型档位或项目白名单均**热加载生效**，无需重启服务。
- **轻量且安全**：仅监听本机回环地址，通过 OAuth 一次性剪贴板短码完成授权，无需手动配置复杂密钥。

---

## 一、上手前准备与注意事项

### 1. 你需要准备什么
- **本机环境**：一台 Windows 或 macOS 电脑（需 Node.js 22.16+ 与独立 `@openai/codex` CLI，部署时 Codex 会自动检查并引导安装）。
- **公网 HTTPS 入口**（四选一，部署时 Codex 会引导配置）：
  - **有自有域名** → 推荐 **Cloudflare Named Tunnel**（免费、域名固定、最稳定）。
  - **没有域名** → 首选 **Tailscale Funnel**（免费获得固定 `*.ts.net` 网址）。
  - **有自己的 VPS / 反代** → 直接将 HTTPS 流量反代到本机端口（默认 `9088`）。
  - **只想先试用 10 分钟** → 可用 **Cloudflare Quick Tunnel**（免账号域名，但每次重启会换网址导致绑定失效）。

### 2. Gemini 端隐形门槛与使用提醒
- **找不到 Custom Apps 入口**：Gemini 自定义应用对账号、地区与语言有平台限制，若界面里看不到入口，直接访问 [https://gemini.google.com/usage?hl=en](https://gemini.google.com/usage?hl=en) 确认当前账号是否可用。
- **普通聊天 vs 任务模式（实测差异）**：
  - **普通聊天**：单轮可连续调用的工具次数较少，但可以自由选择模型的思考强度。
  - **任务模式**：支持更多轮次的连续工具调用（适合长流程执行），但目前无法手动选择思考强度。
  - 建议按任务复杂度灵活选用。
- **网页上传文件边界**：直接在 Gemini 网页端上传的图片、PDF 等文件无法自动写入你本地磁盘；如果需要 Codex 修改原件，请先把文件放进本地项目目录再告知路径。

---

## 二、快速开始（交给本机 Codex 部署）

无需手动克隆或翻阅文档，直接把下面这句话发给你本机的 Codex：

```text
请把 https://github.com/pernalin9/codex-remote-mcp.git 克隆到合适的本地目录（如目录已存在先问我），然后读取仓库里的 DEPLOY_PROMPT.md，按其中的步骤一步步引导我完成部署。
```

### 检查更新与排查问题

后续想检查新版本、同步新发现的环境避坑项，或遇到连接异常需要排障时，直接把下面这句话发给本机 Codex：

```text
请查看 GitHub 上 pernalin9/codex-remote-mcp 最新的 VERSION_MANUAL.md，对比我本机的 codex-remote-mcp 版本并核对已知问题，如有更新或需要注意的环境坑点请提示我并引导处理。
```

---

## 三、常用运维命令

```bash
npm run ctl -- start           # 后台启动本地桥接服务
npm run ctl -- stop            # 停止本地服务
npm run ctl -- restart         # 重启本地服务（修改 .env 后使用）
npm run ctl -- status          # 查看运行状态与健康检查
npm run ctl -- logs            # 查看最近服务日志
npm run doctor                 # 环境体检（Node、CLI、登录态、端口与配置）
npm run repo -- list           # 管理暴露的本地项目白名单（list / add / remove）
```

---

## 四、进阶文档

- [进阶配置、工具一览与安全说明](docs/REFERENCE.md) — 环境细则、配置与热加载机制、13 个工具列表、多模态边界与安全架构
- [部署引导 Prompt](DEPLOY_PROMPT.md) — 交给本机 Codex 的完整交互式部署流程
- [版本维护与排障手册](VERSION_MANUAL.md) — 增量版本升级动作、新增环境自查项与故障速查
- [开发者全链路验收清单](GEMINI-ACCEPTANCE.md) — 面向开发者的完整回归测试话术
