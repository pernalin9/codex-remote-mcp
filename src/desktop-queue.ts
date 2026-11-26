import {open, realpath} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {exposedDirectory} from "./projects.js";
import {profiles} from "./config.js";
import {RpcError, withAppServer, type Rpc} from "./stdio.js";
import type {Review} from "./app-server-client.js";
import type {ThreadReadResponse} from "./generated/app-server-schema/v2/ThreadReadResponse";
import type {ThreadTurnsListResponse} from "./generated/app-server-schema/v2/ThreadTurnsListResponse";

export const trackingLimitMs=30*60_000;
export type Delivery={client_id:string;thread_id:string;anchor:string;cwd:string;model:string;started:number};
type Callbacks={record:(d:Delivery)=>void;phase:(phase:string,turnId?:string)=>void};
type SandboxPolicy={type?:unknown;network_access?:unknown};
async function latestSandboxPolicy(file:string|null|undefined):Promise<SandboxPolicy|undefined>{
  if(!file?.endsWith(".jsonl"))return;
  try{
    const sessions=await realpath(path.join(process.env.CODEX_HOME??path.join(os.homedir(),".codex"),"sessions"));
    const actual=await realpath(file),rel=path.relative(sessions,actual);
    if(rel===".." || rel.startsWith(".."+path.sep) || path.isAbsolute(rel) || !actual.endsWith(".jsonl"))return;
    const handle=await open(actual,"r");
    let tail:string;
    try{
      const {size}=await handle.stat(),length=Math.min(size,4*1024*1024);
      const buf=Buffer.alloc(length);
      const {bytesRead}=await handle.read(buf,0,length,size-length);
      tail=buf.toString("utf8",0,bytesRead);
      if(size>length)tail=tail.slice(tail.indexOf("\n")+1);
    }finally{await handle.close();}
    for(const line of tail.split("\n").reverse()){
      if(!line.includes('"turn_context"'))continue;
      let entry:{type?:string;payload?:{sandbox_policy?:SandboxPolicy}};
      try{entry=JSON.parse(line);}catch{continue;}
      if(entry?.type==="turn_context")return entry.payload?.sandbox_policy;
    }
  }catch{
    // Rollout metadata is best effort. The desktop owns the actual policy.
  }
}

const page=(rpc:Rpc,threadId:string,limit:number,cursor:string|null=null)=>rpc.request<ThreadTurnsListResponse>("thread/turns/list",{
  threadId,limit,cursor,sortDirection:"desc",itemsView:"full"
});
export function queuedTurnResult(turn:ThreadTurnsListResponse["data"][number],d:Delivery){
  if(turn.status==="completed"){
    const reply=turn.items.findLast(i=>i.type==="agentMessage" && i.phase!=="commentary");
    if(reply?.type==="agentMessage" && reply.text.trim())return {thread_id:d.thread_id,turn_id:turn.id,final_response:reply.text,model_used:d.model,truncated:false};
  }
  if(typeof turn.completedAt==="number" && (turn.status==="failed" || turn.status==="interrupted"))throw Error("QUEUE_TURN_"+turn.status.toUpperCase());
}
export function desktopQueue(exe:string){
  return {
    async submit(input:Review,cwd:string,id:string,signal:AbortSignal,callbacks:Callbacks){
      const threadId=input.thread_id!;
      const profile=profiles()[input.profile??"default"];
      return withAppServer(exe,cwd,signal,15_000,async rpc=>{
        const {thread}=await rpc.request<ThreadReadResponse>("thread/read",{threadId,includeTurns:false});
        if(thread.id!==threadId || !exposedDirectory(thread.cwd,cwd))throw Error("THREAD_PROJECT_MISMATCH");
        const latest=(await page(rpc,threadId,1)).data[0];
        const policy=await latestSandboxPolicy(thread.path);
        if((input.mode==="execute" && policy?.type==="read-only") ||
          (input.network_access===true && policy?.network_access===false))throw Error("QUEUE_NOT_SUBMITTED");
        // Verify this CLI actually supports the queue before recording a send.
        await rpc.request("thread/queue/list",{threadId,limit:1});
        const delivery:Delivery={client_id:id,thread_id:threadId,cwd,model:thread.model||profile.model,anchor:latest?.id??"",started:Date.now()};
        signal.throwIfAborted();
        // Commit intent before the only send. Loss of the acknowledgement always
        // leads to read-only reconciliation using the same client message ID.
        callbacks.record(delivery);
        try{
          await rpc.request("thread/queue/add",{threadId,clientUserMessageId:id,input:[
            {type:"text",text:input.prompt+"\n\nIf a file excerpt would help, optionally include [[ATTACH_FILE: relative/path:start-end]] on its own line.",text_elements:[]}
          ]});
          callbacks.phase("queued");
        }catch(e){
          if(e instanceof RpcError && ["APP_SERVER_RPC -32601","APP_SERVER_RPC -32602"].includes(e.code))throw Error("QUEUE_NOT_SUBMITTED");
          callbacks.phase("queue_receipt_unknown");
        }
        return delivery;
      },true);
    },
    async track(d:Delivery,signal:AbortSignal,phase:Callbacks["phase"]){
      const deadline=d.started+trackingLimitMs;
      let last="",turnId:string|undefined;
      // A transport failure may be transient. Reconnect only for reads.
      while(Date.now()<deadline){
        signal.throwIfAborted();
        if(!exposedDirectory(d.cwd))throw Error("QUEUE_OUTCOME_UNKNOWN");
        try{
          const result=await withAppServer(exe,d.cwd,signal,Math.max(1,deadline-Date.now()),async rpc=>{
            while(Date.now()<deadline){
              signal.throwIfAborted();
              let cursor:string|null=null;
              do{
                const batch=await page(rpc,d.thread_id,8,cursor);
                const turn=batch.data.find(t=>t.id===turnId || t.items.some(i=>i.type==="userMessage" && i.clientId===d.client_id));
                if(turn){
                  turnId=turn.id;
                  const result=queuedTurnResult(turn,d);
                  if(result)return result;
                  break;
                }
                if(d.anchor && batch.data.some(t=>t.id===d.anchor))break;
                cursor=batch.nextCursor;
              }while(cursor && Date.now()<deadline);
              const elapsed=Date.now()-d.started;
              const next=turnId?"queue_turn_started":elapsed>=30_000?"queue_waiting":"queue_tracking";
              if(last!==next){phase(next,turnId);last=next;}
              await delay(Math.min(elapsed<30_000?2000:5000,Math.max(0,deadline-Date.now())),undefined,{signal});
            }
          });
          if(result)return result;
        }catch(e){
          if(signal.aborted || (e instanceof Error && e.message.startsWith("QUEUE_TURN_")))throw e;
          await delay(Math.min(2000,Math.max(0,deadline-Date.now())),undefined,{signal});
        }
      }
      throw Error("QUEUE_OUTCOME_UNKNOWN");
    }
  };
}
