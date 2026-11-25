import type {ThreadManagement} from "./thread-management.js";
import { fileURLToPath } from "node:url";
import express from "express";
import type { DatabaseSync } from "node:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { installOAuth } from "./oauth.js";
import type { StartTool, ProjectTool } from "./start.js";
import {Jobs} from "./jobs.js";
import {registerTools} from "./tools.js";
import { type Reviewer } from "./app-server-client.js";

export function createApp(db: DatabaseSync, base: string, review: Reviewer, start: StartTool, getProject: ProjectTool, manage:ThreadManagement) {
  const app = express();
  const jobs=new Jobs(db,review,manage.fork);
  app.locals.jobs=jobs;
  app.disable("x-powered-by");
  app.use((req,res,next)=>{
    res.on("finish",()=>console.info(req.method+" "+req.path.slice(0,120)+" "+res.statusCode));
    next();
  });
  app.use("/oauth",express.json({limit:"64kb"}));
  app.use(express.json({limit:"7mb"}),express.urlencoded({extended:false,limit:"64kb",parameterLimit:64}));
  const assets=fileURLToPath(new URL("../assets/",import.meta.url));
  app.get("/",(_req,res)=>res.type("html").send(
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Codex Remote MCP</title>'+
    '<link rel="icon" type="image/png" sizes="512x512" href="/codex-remote.png"></head>'+
    '<body><img src="/codex-remote.png" width="48" height="48" alt=""> Codex Remote MCP</body></html>'
  ));
  app.get("/codex-remote.png",(_req,res)=>res.sendFile("codex-remote.png",{root:assets}));
  app.get("/favicon.ico",(_req,res)=>res.sendFile("favicon.ico",{root:assets}));
  app.get("/healthz",(_req,res)=>{res.json({status:"ok",milestone:1});});
  const {authorize,issueApprovalCode} = installOAuth(app,db,base);
  app.locals.issueApprovalCode=issueApprovalCode;
  app.get("/mcp/v1",(_req,res)=>{res.set("Allow","POST").sendStatus(405);});
  app.post("/mcp/v1",authorize,async(req,res)=>{
    if (req.headers.origin && req.headers.origin !== base) {res.sendStatus(403);return;}
    const server = new McpServer({name:"codex-remote-mcp",version:"0.2.0",icons:[{src:base+"/codex-remote.png",mimeType:"image/png",sizes:["512x512"]}]},{
      instructions:"新对话首次使用 @codex 时，必须先调用 codex_start 并加载规则（include_rules=true）。后续协作严格遵循本次返回的 workflow_rules。为当前 Gemini 聊天命名时，在标题开头加一次 [Codex] 和一个空格，后接简短的任务名。这个前缀仅用于 Gemini 聊天标题。"
    });
    server.registerTool("codex_start",{
      description:"首次使用 @codex 的开场入口。读取本地协作规则、项目与档位、最近线程和运行状态。",
      inputSchema:{repo:z.string().trim().min(1).max(120).optional().describe("接受全称或简称。指定项目时列最近 10 条会话，省略时列全局最近 5 条。"),
        include_rules:z.boolean().default(true).describe("开场时保留 true。已加载规则且只刷新状态时可传 false。")},
      annotations:{title:"开始 Codex 协作",readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}
    },async(input,extra)=>{
      try {
        const result=await start(input,extra.signal);
        const response={structuredContent:result,content:[{type:"text" as const,text:JSON.stringify(result)}]};
        if (Buffer.byteLength(JSON.stringify(response),"utf8")>126*1024) throw new Error("START_RESPONSE_TOO_LARGE");
        return response;
      } catch(err) {
        const code=err instanceof Error && /^(UNKNOWN_REPO|EMPTY_WORKFLOW_RULES|WORKFLOW_RULES_OVER_10000|START_RESPONSE_TOO_LARGE)$/.test(err.message)
          ? err.message : "START_CONFIG_UNAVAILABLE";
        return {isError:true,content:[{type:"text",text:JSON.stringify({error:code})}]};
      }
    });
    registerTools(server,jobs,start,Boolean(res.locals.fullGrant),getProject,manage);
    const transport = new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    res.on("close",()=>{void server.close().catch(()=>{});});
    await server.connect(transport);
    await transport.handleRequest(req,res,req.body);
  });
  app.use((err: {status?:number},_req:express.Request,res:express.Response,next:express.NextFunction)=>{
    if (res.headersSent) return next(err);
    const status = err.status && err.status >= 400 && err.status <= 599 ? err.status : 500;
    res.status(status).json({error:status === 500 ? "internal_error" : "invalid_request"});
  });
  return app;
}

