import {open, readdir, realpath} from "node:fs/promises";
import {DatabaseSync} from "node:sqlite";
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
type SandboxPolicy={type?:unknown;network_access?:unknown;networkAccess?:unknown};
type PermissionEntry={access?:unknown;path?:{type?:unknown;path?:unknown;value?:{kind?:unknown}}};
type PermissionProfile={network?:unknown;file_system?:{type?:unknown;entries?:unknown}};
type PermissionSettings=SandboxPolicy & PermissionProfile & {
  sandbox_policy?:SandboxPolicy;permission_profile?:PermissionProfile;
};
type QueuePermissions={readOnly:boolean;networkAccess?:boolean};

function pathCoversDirectory(root:string,cwd:string){
  const stripNamespace=(value:string)=>value.replace(/^\\\\\?\\UNC\\/i,"\\\\").replace(/^\\\\\?\\/,"");
  const windowsAbsolute=/^(?:[a-z]:[\\/]|\\\\)/i;
  const target=stripNamespace(cwd);
  if(windowsAbsolute.test(target)){
    const base=stripNamespace(root);
    if(!windowsAbsolute.test(base))return false;
    const relative=path.win32.relative(base.toLowerCase(),target.toLowerCase());
    return relative!==".." && !relative.startsWith("..\\") && !path.win32.isAbsolute(relative);
  }
  if(!path.posix.isAbsolute(root) || !path.posix.isAbsolute(cwd))return false;
  const relative=path.posix.relative(root,cwd);
  return relative!==".." && !relative.startsWith("../") && !path.posix.isAbsolute(relative);
}

export function parseQueuePermissions(raw:unknown,cwd:string):QueuePermissions{
  const settings=raw as PermissionSettings|null|undefined;
  const sandbox=settings?.sandbox_policy??settings;
  const profile=settings?.permission_profile??settings;
  const filesystem=profile?.file_system;
  const entries=Array.isArray(filesystem?.entries)?filesystem.entries:[];
  const coversCwd=({access,path:entry}:PermissionEntry)=>access==="write" && (
    (entry?.type==="special" && entry.value?.kind==="root") ||
    (entry?.type==="path" && typeof entry.path==="string" && pathCoversDirectory(entry.path,cwd))
  );
  const readOnly=sandbox?.type==="read-only" || sandbox?.type==="readOnly" ||
    (filesystem?.type==="restricted" && !entries.some(entry=>entry && coversCwd(entry)));
  const legacyNetwork=sandbox?.network_access??sandbox?.networkAccess;
  const managedNetwork=profile?.network==="restricted"?false:profile?.network==="enabled"?true:undefined;
  // Either format can carry an explicit restriction when both are present.
  const networkAccess=legacyNetwork===false || managedNetwork===false ? false : legacyNetwork===true ? true : managedNetwork;
  return {readOnly,networkAccess};
}

async function rolloutPermissions(home:string,file:string|null|undefined,cwd:string):Promise<QueuePermissions|undefined>{
  if(!file?.endsWith(".jsonl"))return;
  try{
    const sessions=await realpath(path.join(home,"sessions"));
    const actual=await realpath(file),rel=path.relative(sessions,actual);
    if(rel===".." || rel.startsWith(".."+path.sep) || path.isAbsolute(rel) || !actual.endsWith(".jsonl"))return;
    const handle=await open(actual,"r");
    let tail:string;
    try{
      const {size}=await handle.stat(),length=Math.min(size,4*1024*1024);
      const buf=Buffer.alloc(length);
      const {bytesRead}=await handle.read(buf,0,length,size-length);
      tail=buf.toString("utf8",0,bytesRead);
      if(size>length){
        const newline=tail.indexOf("\n");
        tail=newline<0?"":tail.slice(newline+1);
      }
    }finally{await handle.close();}
    for(const line of tail.split("\n").reverse()){
      if(!line.includes('"turn_context"') && !line.includes('"thread_settings_applied"'))continue;
      let entry:{type?:string;payload?:{type?:string;thread_settings?:unknown}};
      try{entry=JSON.parse(line);}catch{continue;}
      if(entry?.type==="turn_context")return parseQueuePermissions(entry.payload,cwd);
      if(entry?.type==="event_msg" && entry.payload?.type==="thread_settings_applied"){
        return parseQueuePermissions(entry.payload.thread_settings,cwd);
      }
    }
  }catch{
    // Try the state database if the rollout is unavailable.
  }
}

async function statePermissions(home:string,threadId:string,cwd:string):Promise<QueuePermissions|undefined>{
  try{
    let newest:{name:string;version:bigint}|undefined;
    for(const entry of await readdir(home,{withFileTypes:true})){
      const match=/^state_(\d+)\.sqlite$/.exec(entry.name);
      if(!entry.isFile() || !match)continue;
      const version=BigInt(match[1]);
      if(!newest || version>newest.version)newest={name:entry.name,version};
    }
    if(!newest)return;
    const db=new DatabaseSync(path.join(home,newest.name),{readOnly:true});
    try{
      const row=db.prepare("SELECT sandbox_policy FROM threads WHERE id = ?").get(threadId);
      if(typeof row?.sandbox_policy==="string")return parseQueuePermissions(JSON.parse(row.sandbox_policy),cwd);
    }finally{db.close();}
  }catch{
    // Missing or unreadable state leaves the policy unknown.
  }
}

export async function latestQueuePermissions(file:string|null|undefined,threadId:string,cwd:string){
  const home=process.env.CODEX_HOME??path.join(os.homedir(),".codex");
  return (await rolloutPermissions(home,file,cwd))??statePermissions(home,threadId,cwd);
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
        const policy=await latestQueuePermissions(thread.path,threadId,cwd);
        if((input.mode==="execute" && policy?.readOnly===true) ||
          (input.network_access===true && policy?.networkAccess===false))throw Error("QUEUE_NOT_SUBMITTED");
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
