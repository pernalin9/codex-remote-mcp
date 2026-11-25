# Gemini 网页验收

在 Gemini Custom Apps 使用 `https://<你的域名>/mcp/v1`。需要授权时，先打开授权页，再让本机 Codex 按页面显示的连接编号复制一次性授权码。服务升级后，在 Developer Mode 的 **Tool Schemas** 选择 **Sync schema**，核对 13 个工具。如果工具返回 `RELINK_REQUIRED`，再重新授权。将下方话术粘贴到普通 Gemini 聊天并选择你的 Codex 应用。任选一个已暴露项目，可事先放入一张无敏感信息的图片。

> @Codex 请在「<项目名>」验收这次升级。先调用 codex_start 刷新规则，生成新短标识 ID 和测试词。只允许新建 .ai-handoff/ID-input.txt 和 .ai-handoff/ID-output.txt。
>
> 1. 用 repo_write_file 新建 ID-input.txt，写入测试词，传 overwrite=false。用 repo_list_files(repo, subdir=".ai-handoff", filter="ID-input.txt") 定位，再用 repo_read_file 核对文本。将 ID 替换为实际短标识。
> 2. 调用 codex_review，要求只读核对该文件并在最终答复包含单独一行 [[ATTACH_FILE: .ai-handoff/ID-input.txt:1-1]]。核对 attached_files 并保存 thread_id。用 codex_get_project(repo, thread_id, view="outline", limit=1) 核对轮次 ID、状态及预览，有 next_cursor 时用 cursor 翻页。
> 3. 在同一线程调用 codex_execute，传唯一 idempotency_key 和 wait_seconds=0，只写 ID-output.txt，内容为测试词加 -written。保存 job_id，用 codex_get_result(wait_seconds=50) 串行查询并记录耗时、phase、steps_completed 和 latest_note（如有）。按 workflow_rules 持续查询至任务进入终态或触发停止条件。仅当实际等待接近 50 秒且正常返回时，才记为公网长轮询通过。查询超时后，稍等再用原 job_id 缩短单次等待时间继续轮询。任务提前完成时将长轮询标为待测。
> 4. 用 repo_read_file 核对输出，原样重发一次 execute 请求并检查是否返回原 job_id。再在同一线程分别传 network_access=true 和省略该参数做只读复核；只访问部署者允许的无敏感 HTTP 端点，分别记录实际联网结果。有本地测试图片时，另用 codex_review(local_images=["<图片相对路径>"]) 描述可见细节；没有图片则记为待测。
> 5. 汇报线程 ID、写任务 ID、幂等键复用结果、附件、目录和历史验证，以及网络、图片和公网长轮询的实测情况。保留两个测试文件供桌面端复盘。
