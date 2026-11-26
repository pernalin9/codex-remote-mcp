import { realpathSync } from "node:fs";
import { RpcError, withAppServer, withTurnServer, type Rpc } from "./stdio.js";
import { profiles } from "./config.js";
import { desktopQueue } from "./desktop-queue.js";
import { projectPath, exposedDirectory, directoryKey, fullAccessProjects } from "./projects.js";
import { sandboxTempDirectory } from "./runtime.js";
import { fileError, resolveLocalImages } from "./file-ops.js";
import type { ThreadStartParams } from "./generated/app-server-schema/v2/ThreadStartParams";
import type { ThreadResumeParams } from "./generated/app-server-schema/v2/ThreadResumeParams";
import type { ThreadStartResponse } from "./generated/app-server-schema/v2/ThreadStartResponse";
import type { TurnStartParams } from "./generated/app-server-schema/v2/TurnStartParams";
import type { TurnCompletedNotification } from "./generated/app-server-schema/v2/TurnCompletedNotification";
import type { ServerNotification } from "./generated/app-server-schema/ServerNotification";

type ImageIdentity=Pick<ReturnType<typeof resolveLocalImages>[number],"relativePath"|"size"|"mtimeMs">;
type Progress={completedItemId?:string;note?:string};
export interface Review {
  prompt:string;
  thread_id?:string;
  title?:string;
  repo?:string;
  profile?:string;
  mode?:"review"|"execute";
  model_override?:string;
  reasoning_effort?:"low"|"medium"|"high"|"xhigh";
  ephemeral?:boolean;
  allow_queue?:boolean;
  local_images?:string[];
  network_access?:boolean;
  full_access?:boolean;
  workspaceRoot?:string;
  imageIdentity?:ImageIdentity[];
  claim?:(cwd:string,thread?:string)=>void;
  recordModel?:(model:string)=>void;
  activity?:(phase:string,turnId?:string,progress?:Progress)=>void;
  sideEffect?:()=>void;
}
interface Result { turn_id?:string; cwd?:string; model_used?:string; thread_id: string; title?: string; final_response: string; truncated: boolean }
export type Reviewer = ((input: Review, signal?: AbortSignal) => Promise<Result>) & {
  queue?:ReturnType<typeof desktopQueue>;
  resolveThreadRoot?:(cwd:string,threadId:string,explicitRepo:boolean)=>Promise<string>;
  authorizeFullAccess?:(cwd:string,threadId:string|null,explicitRepo:boolean)=>Promise<string>;
};

export class ReviewError extends Error {
  constructor(message: string, readonly thread_id?: string, readonly code?: string) { super(message); }
}

export function createReviewer(executable: string): Reviewer {
  const run:Reviewer = async (input, signal) => {
    const cwd = input.workspaceRoot ?? projectPath(input.repo);
    if (!cwd) throw new ReviewError("UNKNOWN_REPO");
    return review(executable,cwd,input,signal);
  };
  const resolveThreadRoot:NonNullable<Reviewer["resolveThreadRoot"]>=(cwd,threadId,explicitRepo)=>
    withAppServer(executable,cwd,undefined,10000,rpc=>readThreadRoot(rpc,threadId,explicitRepo?cwd:undefined));
  run.resolveThreadRoot=resolveThreadRoot;
  run.queue=desktopQueue(executable);
  run.authorizeFullAccess=async(cwd,threadId,explicitRepo)=>{
    const actual=threadId ? await resolveThreadRoot(cwd,threadId,explicitRepo) : cwd;
    assertFullAccess(actual);
    return actual;
  };
  return run;
}

function assertFullAccess(cwd:string) {
  if(!exposedDirectory(cwd) || !fullAccessProjects().allowed.has(directoryKey(cwd))) {
    throw new ReviewError("FULL_ACCESS_NOT_ALLOWED");
  }
}

async function readThreadRoot(rpc:Rpc,threadId:string,selected?:string){
  const {thread}=await rpc.request<{thread:{cwd:string}}>("thread/read",{threadId,includeTurns:false});
  if (!exposedDirectory(thread.cwd,selected)) throw new ReviewError("THREAD_PROJECT_MISMATCH",threadId);
  return realpathSync.native(thread.cwd);
}

async function review(executable: string, cwd: string, input: Review, signal?: AbortSignal): Promise<Result> {
  const config = profiles();
  const key = input.profile ?? "default";
  if (!Object.hasOwn(config,key)) throw new ReviewError("UNKNOWN_PROFILE");
  const model=input.model_override??config[key].model, effort=input.reasoning_effort??config[key].reasoningEffort;
  const write=input.mode==="execute";
  const full=write && input.full_access===true;
  const sandboxTmp=write && !full ? sandboxTempDirectory() : undefined;
  let actualModel=model;
  let threadId = input.thread_id, title = input.title;
  try { return await withTurnServer(executable,cwd,signal,30*60*1000,async rpc=>{
    const {request} = rpc;
    let currentTurn:string|undefined, subscribed=false, finished=false, finalText="";
    const done=Promise.withResolvers<TurnCompletedNotification>();
    let earlyNotices:ServerNotification[]|undefined;
    function handle(msg:ServerNotification){
      if (msg.method==="model/rerouted") {
        const event=msg.params;
        if(event.threadId===threadId && currentTurn===event.turnId) {
          actualModel=event.toModel;
          input.recordModel?.(actualModel);
        }
      }
      if (msg.method==="item/started" || msg.method==="item/completed") {
        const event=msg.params;
        if(event.threadId!==threadId || event.turnId!==currentTurn)return;
        const item=event.item;
        if(write && ["commandExecution","fileChange","mcpToolCall"].includes(item.type))input.sideEffect?.();
        const progress:Progress={};
        if(msg.method==="item/completed"){
          progress.completedItemId=item.id;
          if(item.type==="agentMessage"){
            if(item.phase==="commentary")progress.note=Array.from(item.text.trim()).slice(0,200).join("");
            else finalText=item.text;
          }
        }
        input.activity?.(item.type,currentTurn,progress);
      } else if(msg.method==="turn/completed") {
        const event=msg.params;
        if(event.threadId===threadId && currentTurn===event.turn.id)done.resolve(event);
      }
    }
    rpc.onNotice(raw=>{
      const msg=raw as ServerNotification;
      if(msg.method!=="item/started" && msg.method!=="item/completed" && msg.method!=="model/rerouted" && msg.method!=="turn/completed")return;
      if(msg.params.threadId!==threadId)return;
      if(earlyNotices){
        if(write && msg.method==="item/started" && ["commandExecution","fileChange","mcpToolCall"].includes(msg.params.item.type))input.sideEffect?.();
        earlyNotices.push(msg);
      }
      else if(currentTurn)handle(msg);
    });
    try {
      const approvals = write
        ? {approvalPolicy:"on-request", approvalsReviewer:"auto_review"} as const
        : {approvalPolicy:"never"} as const;
      if (input.thread_id) {
        cwd=await readThreadRoot(rpc,input.thread_id,input.repo || input.imageIdentity || full && input.workspaceRoot ? cwd : undefined);
      }
      if(full)assertFullAccess(cwd);
      const cwdKey=directoryKey(cwd);
      const options = {model,config:{web_search:"cached"},sandbox:full?"danger-full-access":write?"workspace-write":"read-only",...approvals} as const;
      let images:ReturnType<typeof resolveLocalImages>=[];
      if(input.local_images?.length){
        try {
          images=resolveLocalImages(cwd,input.local_images);
          const identity=images.map(({relativePath,size,mtimeMs})=>({relativePath,size,mtimeMs}));
          if(input.imageIdentity && JSON.stringify(identity)!==JSON.stringify(input.imageIdentity))throw Error("file_changed");
        } catch (error) {throw new ReviewError(fileError(error),threadId);}
      }
      input.claim?.(cwd,input.thread_id);
      const thread = input.thread_id
        ? await request<ThreadStartResponse>("thread/resume",{...options,threadId:input.thread_id,cwd} satisfies ThreadResumeParams)
        : await request<ThreadStartResponse>("thread/start",{...options,cwd,ephemeral:input.ephemeral??false} satisfies ThreadStartParams);
      threadId = thread.thread.id;
      subscribed = true;
      if(directoryKey(thread.thread.cwd)!==cwdKey || directoryKey(thread.cwd)!==cwdKey){
        throw new ReviewError("THREAD_PROJECT_MISMATCH",threadId);
      }
      if (thread.thread.status.type === "active") {
        throw new ReviewError("THREAD_BUSY",threadId,"THREAD_BUSY");
      }
      const expected=full?"dangerFullAccess":write?"workspaceWrite":"readOnly";
      if(thread.sandbox?.type && thread.sandbox.type!==expected){
        throw new ReviewError("THREAD_SANDBOX_MISMATCH",threadId);
      }
      input.claim?.(thread.cwd,threadId);
      if (!input.thread_id) {
        const label = (title ?? Array.from(input.prompt).slice(0,36).join("")).replace(/^(?:\[(?:Gem|Gemini)\]\s*)+/i,"").trim();
        title = "[Gem] " + (label || "对话");
        if (!input.ephemeral) await request("thread/name/set",{threadId,name:title});
      } else {
        title = thread.thread.name ?? undefined;
      }
      actualModel=thread.model;
      input.recordModel?.(actualModel);
      earlyNotices=[];
      if(full)assertFullAccess(cwd);
      const networkAccess=Boolean(input.network_access);
      const start = await request<{turn:{id:string}}>("turn/start",{
        threadId,cwd,model,effort,...approvals,
        sandboxPolicy:full ? {type:"dangerFullAccess"} : sandboxTmp
          ? {type:"workspaceWrite",writableRoots:[cwd,sandboxTmp],networkAccess,excludeTmpdirEnvVar:false,excludeSlashTmp:true}
          : {type:"readOnly",networkAccess},
        input:[{type:"text",text:input.prompt+"\n\nIf a file excerpt would help, optionally include [[ATTACH_FILE: relative/path:start-end]] on its own line.",text_elements:[]},
          ...images.map(({absolutePath})=>({type:"localImage" as const,path:absolutePath}))]
      } satisfies TurnStartParams);
      currentTurn = start.turn.id;
      input.activity?.("turn_started",currentTurn);
      const buffered=earlyNotices;
      earlyNotices=undefined;
      for(const notice of buffered)handle(notice);
      const {turn} = await rpc.until(done.promise);
      finished = true;
      if (turn.status !== "completed") {
        const detail = turn.error?.codexErrorInfo;
        const code = typeof detail === "string" ? detail : (detail && Object.keys(detail)[0]) || turn.status;
        throw new ReviewError("CODEX_" + code,threadId);
      }
      if (!finalText.trim()) throw new ReviewError("EMPTY_FINAL_RESPONSE",threadId);
      return {cwd,model_used:actualModel,thread_id:threadId,title,turn_id:currentTurn,final_response:finalText,truncated:false};
    } finally {
      if (currentTurn && !finished) rpc.notify({id:"interrupt",method:"turn/interrupt",params:{threadId,turnId:currentTurn}});
      if (subscribed) {
        await Promise.race([request("thread/unsubscribe",{threadId}).catch(()=>{
          rpc.notify({id:"cleanup",method:"thread/unsubscribe",params:{threadId}});
        }), new Promise(r=>setTimeout(r,1000))]);
      }
    }
  },sandboxTmp); } catch(err) {
    if(err instanceof ReviewError) throw err;
    throw new ReviewError(err instanceof Error ? err.message : "REVIEW_FAILED",threadId,err instanceof RpcError ? err.code : undefined);
  }
}
