import type {ThreadManagement} from "./thread-management.js";
import type {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {z} from "zod";
import {BridgePreflightError,Jobs} from "./jobs.js";
import {fileError,listFiles,readFile,writeFile} from "./file-ops.js";
import {projectPath} from "./projects.js";
import type {StartTool,ProjectTool} from "./start.js";
const str=z.string().trim().min(1).max(512);
const wait=(max:number)=>z.number().int().min(0).max(max).default(20)
  .describe("最多等待的秒数，默认 20，范围 0–"+max+"。传 0 立即返回当前状态。");
const repoName=str.describe("接受已配置项目的全称或别名，忽略大小写。");
const threadId=z.string().uuid().describe("已有 Codex 线程的 thread_id。");
const offset=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional();
function reply(value:unknown){
  const text=JSON.stringify(value);
  const result={content:[{type:"text" as const,text}]};
  if(Buffer.byteLength(JSON.stringify(result))<=126*1024)return result;
  const r=value as Record<string,unknown>;
  return {content:[{type:"text" as const,text:JSON.stringify({job_id:r.job_id,thread_id:r.thread_id,status:r.status,path:r.path,truncated:true,error:"response_budget_exceeded",content:typeof r.content==="string"?r.content.slice(0,8192):undefined,final_response:typeof r.final_response==="string"?r.final_response.slice(0,8192):undefined})}]};
}
function safe<T>(fn:()=>T|Promise<T>){
  return Promise.resolve().then(fn).then(reply).catch(e=>({isError:true,content:[{type:"text" as const,text:JSON.stringify({
    error:e instanceof Error && /^[A-Z_]+$/.test(e.message)?e.message:fileError(e),
    reason:e instanceof BridgePreflightError?e.reason:undefined
  })}]}));
}
function annotations(title:string,readOnlyHint:boolean,destructiveHint=false,idempotentHint=readOnlyHint,openWorldHint=false){
  return {title,readOnlyHint,destructiveHint,idempotentHint,openWorldHint};
}
function root(repo:string){const value=projectPath(repo);if(!value)throw Error("UNKNOWN_REPO");return value;}
export function registerTools(server:McpServer,jobs:Jobs,start:StartTool,full:boolean,getProject:ProjectTool,manage:ThreadManagement,
  restartBridge?:(force:boolean,key?:string)=>ReturnType<Jobs["restartBridge"]>){
  const input={
    prompt:z.string().trim().min(1).max(32768).describe("交给 Codex 的任务和验收要求。"),
    repo:repoName.optional().describe("项目全称或别名。续接时省略可按线程归属识别，新任务省略则使用默认项目。"),
    thread_id:threadId.optional().describe("续接已有线程时传入其 thread_id，省略时创建新线程。"),
    title:str.optional().describe("新线程的显示名称，省略时从任务文本生成。"),
    profile:str.optional().describe("从 codex_start 返回的 profiles 选择档位，默认 default。"),
    model_override:str.optional().describe("显式指定模型，覆盖档位的模型设置。"),
    reasoning_effort:z.enum(["low","medium","high","xhigh"]).optional().describe("覆盖档位的推理强度。"),
    wait_seconds:wait(25),
    network_access:z.boolean().default(false).describe("默认 false。传 true 仅对此轮开启终端沙箱网络；读写权限由工具类型决定。"),
    local_images:z.array(str.describe("一张仓库内图片的相对路径。")).max(4).optional()
      .describe("随任务传给 Codex 的仓库内图片。支持 PNG、JPEG、GIF、WebP，最多 4 张，每张最多 10 MiB。")
  };
  const access=()=>{if(!full)throw Error("RELINK_REQUIRED");};
  server.registerTool("codex_get_project",{
    description:"查看项目与最近会话，或按 thread_id 阅读历史正文和分叉所需的轮次目录。",
    inputSchema:{
      repo:repoName,
      limit:z.number().int().min(1).max(50).default(20).describe("最近会话或 outline 每页的最大条数，默认 20。"),
      thread_id:threadId.optional().describe("查看线程历史时指定 thread_id，省略时返回项目摘要。"),
      view:z.enum(["full","outline"]).default("full").describe("full 返回正文，outline 返回由新到旧的轮次预览，须提供 thread_id。"),
      cursor:z.string().min(1).max(2048).optional().describe("outline 翻页时传上一页 next_cursor，沿用项目、线程和 limit。"),
      offset:offset.describe("full 正文翻页时传上一页 next_offset，默认 0。"),
      last_turns:z.number().int().min(1).max(20).optional().describe("full 正文仅选择最近几轮，范围 1–20，翻页时沿用。"),
      anchor_turn_id:z.string().min(1).max(128).optional().describe("与 last_turns 一起传上一页返回的 anchor_turn_id，固定正文的轮次窗口。")
    },
    annotations:annotations("查看项目详情",true)
  },(args,extra)=>safe(()=>getProject(args,extra.signal)));
  const namedThread={repo:repoName,thread_id:threadId,title:z.string().trim().min(1).max(120).describe("线程的显示名称，最多 120 字符。")};
  server.registerTool("codex_fork",{description:"从选定的已完成轮次（含该轮）创建并命名持久分支。返回子线程 ID 供后续续接。",
    inputSchema:{...namedThread,last_turn_id:z.string().min(1).max(128).describe("作为分叉终点的已完成轮次 ID，分支包含该轮。")},annotations:annotations("从指定轮次分叉",true,false,false)},
    (args,extra)=>safe(()=>{access();return jobs.mutate(extra.signal,signal=>manage.fork(args,signal));}));
  server.registerTool("codex_rename_thread",{description:"更改指定项目中会话的显示名称。分支保留 [Gem][Fork] 前缀。",
    inputSchema:namedThread,annotations:annotations("重命名会话",true,false,true)},
    (args,extra)=>safe(()=>{access();return jobs.mutate(extra.signal,signal=>manage.rename(args,signal));}));
  server.registerTool("codex_review",{description:"只读评审。一次性独立调查传 ephemeral=true，省略 thread_id，凭 job_id 取结果。",inputSchema:z.object({...input,ephemeral:z.boolean().optional().describe("传 true 发起不保存线程的一次性评审，须省略 thread_id。")}).strict(),annotations:annotations("只读评审",true,false,false,true)},args=>safe(()=>jobs.submit("review",args)));
  server.registerTool("codex_execute",{description:"执行已授权的项目任务。需要从历史分叉并执行时，在同一次调用中传 fork_from。后续独立任务可多次执行，每次沿用返回的子线程 thread_id。",inputSchema:{
    ...input,
    full_access:z.boolean().default(false).describe("默认 false。仅对白名单内的实际项目按需启用全权限沙箱，须获得用户明确授权。"),
    fork_from:z.object({
      thread_id:threadId.describe("分叉来源的父线程 ID。"),
      last_turn_id:z.string().min(1).max(128).describe("要包含的最后一个已完成轮次 ID。"),
      title:namedThread.title
    }).optional().describe("创建并命名子线程后执行首个任务。须指定 repo，省略顶层 thread_id 和 title。"),
    idempotency_key:str.optional().describe("重试同一任务时沿用原键和参数。新的执行任务使用新键。")
  },annotations:annotations("执行修改",true,true,false,true)},args=>safe(()=>{access();return jobs.submit("execute",args);}));
  const id={job_id:z.string().uuid().describe("提交任务后返回的 job_id。")};
  server.registerTool("codex_get_result",{description:"查询阶段、最近活动和结果；传回 next_offset 续读。",inputSchema:{...id,wait_seconds:wait(50),offset:offset.describe("读取最终回复的后续页时传上一页 next_offset，默认 0。")},annotations:annotations("查询结果",true)},args=>safe(()=>jobs.get(args.job_id,args.wait_seconds,args.offset)));
  server.registerTool("codex_list_jobs",{description:"最近任务摘要，可按项目和线程过滤。",inputSchema:{repo:repoName.optional().describe("只返回此项目的任务，接受全称或别名。"),thread_id:threadId.optional().describe("只返回此线程的任务。"),limit:z.number().int().min(1).max(30).default(10).describe("最多返回的任务数，默认 10。")},annotations:annotations("最近任务",true)},args=>safe(()=>jobs.list(args.limit,args.thread_id,args.repo)));
  server.registerTool("codex_cancel_task",{description:"中止指定任务。",inputSchema:id,annotations:annotations("中止任务",true,true,false)},args=>safe(()=>{access();return jobs.cancel(args.job_id);}));
  server.registerTool("codex_restart_server",{description:"默认重启 Codex app-server 会话。scope=bridge 先隔离预检，再重启桥接主进程。",inputSchema:{
    force:z.boolean().default(false).describe("默认 false，存在运行中任务时返回 busy。传 true 先中止运行任务。"),
    scope:z.enum(["codex","bridge"]).default("codex").describe("默认 codex。bridge 重启桥接，重新加载 .env。"),
    idempotency_key:str.optional().describe("重试同一次桥接重启时沿用此键。")
  },annotations:annotations("重启服务",true,true,false)},args=>safe(async()=>{access();
    if(args.scope==="bridge"){
      if(!restartBridge)throw Error("BRIDGE_RESTART_UNAVAILABLE");
      return restartBridge(args.force,args.idempotency_key);
    }
    return jobs.restart(args.force,async()=>{
      const result=await start({include_rules:false});
      if(result.runtime.app_server!=="reachable")throw Error("APP_SERVER_UNAVAILABLE");
      return result.runtime;
    });
  }));
  server.registerTool("repo_list_files",{
    description:"按相对路径浏览项目目录，排除敏感项、链接和非普通文件。",
    inputSchema:{
      repo:repoName,
      subdir:str.optional().describe("相对仓库根的子目录，省略时从仓库根开始。"),
      max_depth:z.number().int().min(1).max(6).default(3).describe("相对子目录的遍历深度，直接子项为 1，默认 3。"),
      limit:z.number().int().min(1).max(300).default(100).describe("最多返回的条目数，默认 100。达到扫描或响应预算时也会标记 truncated。"),
      filter:str.optional().describe("匹配仓库相对路径的大小写不敏感子串，例如 .ts。")
    },annotations:annotations("浏览项目目录",true)
  },a=>safe(()=>listFiles(root(a.repo),a)));
  server.registerTool("repo_read_file",{description:"在指定项目按行或关键词读取文本。",inputSchema:{
    repo:repoName,
    relative_path:str.describe("相对仓库根的文本文件路径。"),
    start_line:z.number().int().positive().optional().describe("起始行，从 1 开始，默认 1。搜索也从此行开始。"),
    end_line:z.number().int().positive().optional().describe("按行读取的末行，含该行。默认读取起始行起 300 行，最多 500 行。"),
    search_query:str.optional().describe("改用大小写不敏感的子串搜索，从起始行查找至多 10 个命中。"),
    context_lines:z.number().int().min(0).max(20).optional().describe("搜索结果每处命中前后的上下文行数，默认各 5 行。"),
    with_line_numbers:z.boolean().optional().describe("默认在返回文本中附行号。传 false 省略行号。"),
    max_chars:z.number().int().min(1).max(40000).optional().describe("返回文本的字符上限，默认 20000，最多 40000。")
  },annotations:annotations("读取文件",true)},a=>safe(()=>readFile(root(a.repo),a)));
  server.registerTool("repo_write_file",{description:"原子写入项目 .ai-handoff 内的 UTF-8 文件。",inputSchema:{
    repo:repoName,
    filename:str.describe("相对仓库 .ai-handoff/ 的文件路径，可含子目录。"),
    content:z.string().max(1048576).describe("要保存的文本，使用 UTF-8，最多 1 MiB。"),
    overwrite:z.boolean().default(true).describe("默认允许覆盖。传 false 时已有目标会报错。")
  },annotations:annotations("写入交接文件",true,true,false)},a=>safe(()=>{
    access();jobs.assertMutable();const dir=root(a.repo);jobs.assertFree(dir);return writeFile(dir,a.filename,a.content,a.overwrite);
  }));
}

