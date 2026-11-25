import {DatabaseSync} from "node:sqlite";
import {randomUUID,createHash} from "node:crypto";
import {realpathSync} from "node:fs";
import {setTimeout as delay} from "node:timers/promises";
import {ReviewError,type Reviewer,type Review} from "./app-server-client.js";
import {directoryKey,diskPathKey,projectCatalog,projectPath} from "./projects.js";
import {resetCodexServers} from "./stdio.js";
import {attachments,resolveLocalImages} from "./file-ops.js";

import type {ThreadManagement} from "./thread-management.js";
type Input=Review & {idempotency_key?:string;wait_seconds?:number;fork_from?:{thread_id:string;last_turn_id:string;title:string}};
type Row={id:string;thread:string|null;status:string;mode:string;started:number;ended:number|null;result:string;signature:string};
function repoForRoot(root:string) {
  for(const project of projectCatalog().projects) {
    try {if(directoryKey(project.path)===diskPathKey(root))return project.name;} catch {continue;}
  }
  return null;
}
const partial="任务已中断，可能存在部分未完成修改。请先核对仓库现状。";
const signature=(fields:unknown[])=>createHash("sha256").update(JSON.stringify(fields)).digest("hex");
export class Jobs {
  private live=new Map<string,{controller:AbortController;done:Promise<void>}>();
  private mutations=new Set<{controller:AbortController;done:Promise<unknown>}>();
  private restarting=false;
  private draining=false;
  private stopping=false;
  constructor(private db:DatabaseSync,private run:Reviewer,private fork?:ThreadManagement["fork"]){
    db.exec("CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, thread TEXT, root TEXT, mode TEXT,status TEXT,started INTEGER,ended INTEGER,idem TEXT UNIQUE, fingerprint TEXT,signature TEXT,result TEXT NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS job_metadata(id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,repo TEXT,profile TEXT,thread_action TEXT,model_used TEXT)");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS active_thread ON jobs(thread) WHERE status='running'; CREATE UNIQUE INDEX IF NOT EXISTS writer ON jobs(root) WHERE status='running' AND mode='execute'");
  }
  recover(){
    this.db.prepare("UPDATE jobs SET status='interrupted',ended=?,result=? WHERE status='running'").run(Date.now(),JSON.stringify({error:partial}));
  }
  private row(id:string){const row=this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as Row|undefined;if(!row)throw Error("UNKNOWN_JOB");return row;}
  async get(id:string,wait=0,offset=0){
    const task=this.live.get(id);
    if(task && wait>0){const timer=new AbortController();try{await Promise.race([task.done,delay(wait*1000,undefined,{signal:timer.signal})]);}finally{timer.abort();}}
    const r=this.row(id);
    const metadata=this.db.prepare("SELECT repo,profile,thread_action,model_used FROM job_metadata WHERE id=?").get(id);
    const result=JSON.parse(r.result);
    if (typeof result.final_response==="string") {
      const full=result.final_response;
      const end=Math.min(full.length,offset+12000);
      result.final_response=full.slice(offset,end);
      result.next_offset=end<full.length?end:null;
      if(result.truncated && !result.turn_id) result.legacy_truncated=true;
      result.truncated=Boolean(result.truncated || end<full.length);
      if(offset) delete result.attached_files;
    }
    return {phase:r.status==="running"?"starting":r.status,last_activity_at:r.ended??r.started,...metadata,job_id:id,thread_id:metadata?.thread_action==="new_ephemeral"?null:r.thread,status:r.status,mode:r.mode,elapsed_ms:(r.ended??Date.now())-r.started,...result};
  }
  list(limit:number,thread?:string,repo?:string){
    const root=repo?projectPath(repo):undefined;
    if(repo && !root) throw Error("UNKNOWN_REPO");
    const key=root ? diskPathKey(root) : null;
    return this.db.prepare("SELECT jobs.id AS job_id,CASE WHEN m.thread_action='new_ephemeral' THEN NULL ELSE thread END AS thread_id,m.repo,m.profile,m.thread_action,COALESCE(json_extract(result,'$.model_used'),m.model_used) AS model_used,mode,status,started,COALESCE(json_extract(result,'$.phase'),CASE WHEN status='running' THEN 'starting' ELSE status END) AS phase, COALESCE(ended,json_extract(result,'$.last_activity_at'),started) AS last_activity_at FROM jobs LEFT JOIN job_metadata m ON m.id=jobs.id WHERE (? IS NULL OR thread=?) AND (? IS NULL OR root=?) ORDER BY started DESC LIMIT ?").all(thread??null,thread??null,key,key,limit);
  }
  assertFree(root:string,id=""){
    if(this.db.prepare("SELECT id FROM jobs WHERE status='running' AND mode='execute' AND root=? AND id<>?").get(directoryKey(root),id))throw Error("REPO_BUSY");
  }
  assertMutable(){
    if(this.draining || this.stopping)throw Error("SERVER_RESTARTING");
  }
  private assertAccepting(){
    this.assertMutable();
    if(this.restarting)throw Error("SERVER_RESTARTING");
  }
  async mutate<T>(signal:AbortSignal,work:(signal:AbortSignal)=>T|Promise<T>){
    this.assertMutable();
    const controller=new AbortController();
    const combined=AbortSignal.any([signal,controller.signal]);
    const task={controller,done:Promise.resolve().then(()=>{
      combined.throwIfAborted();
      return work(combined);
    })};
    this.mutations.add(task);
    try{return await task.done;}finally{this.mutations.delete(task);}
  }
  async submit(mode:"review"|"execute",input:Input){
    const branch=input.fork_from;
    if(branch && (mode!=="execute" || !input.repo || input.thread_id || input.title || !this.fork))throw Error("INVALID_FORK_REQUEST");
    if(input.ephemeral && (mode!=="review" || input.thread_id))throw Error("EPHEMERAL_REQUIRES_NEW_REVIEW");
    this.assertAccepting();
    let root=projectPath(input.repo);
    if(!root)throw Error("UNKNOWN_REPO");
    const thread=input.thread_id??null;
    const fullAccess=mode==="execute" && input.full_access===true;
    if(fullAccess){
      if(!this.run.authorizeFullAccess)throw Error("FULL_ACCESS_NOT_ALLOWED");
      root=await this.run.authorizeFullAccess(root,thread,Boolean(input.repo));
      this.assertAccepting();
    }
    let imageIdentity:Review["imageIdentity"];
    if(input.local_images?.length){
      if(thread && !fullAccess){
        if(!this.run.resolveThreadRoot)throw Error("THREAD_ROOT_UNAVAILABLE");
        root=await this.run.resolveThreadRoot(root,thread,Boolean(input.repo));
        this.assertAccepting();
      }
      imageIdentity=localImageIdentity(root,input.local_images);
    }
    const id=randomUUID(),start=Date.now(),rootKey=diskPathKey(root);
    const networkAccess=Boolean(input.network_access);
    const fingerprintFields:unknown[]=[rootKey,thread,input.prompt,...(imageIdentity?[imageIdentity]:[])];
    if(branch)fingerprintFields.push({fork:[branch.thread_id,branch.last_turn_id,branch.title]});
    const signatureFields=[input.model_override,input.reasoning_effort,input.profile,input.title];
    const fp=signature([...fingerprintFields,networkAccess,fullAccess]);
    const sig=signature([fp,...signatureFields,networkAccess,fullAccess]);
    const key=input.idempotency_key??null;
    if(mode==="execute"){
      // Pre-v2 jobs always ran with terminal networking disabled.
      const previousFp=fullAccess ? null : signature([...fingerprintFields,networkAccess]);
      const legacyFp=networkAccess || fullAccess ? null : signature(fingerprintFields);
      const old=(key?this.db.prepare("SELECT * FROM jobs WHERE idem=?").get(key):
        this.db.prepare("SELECT * FROM jobs WHERE fingerprint IN (?,?,?) AND mode='execute' AND started>? ORDER BY started DESC LIMIT 1")
          .get(fp,previousFp,legacyFp,start-120000)) as Row|undefined;
      if(old){
        if(key && old.signature!==sig &&
          (previousFp===null || old.signature!==signature([previousFp,...signatureFields,networkAccess])) &&
          (legacyFp===null || old.signature!==signature([legacyFp,...signatureFields]))) {
          throw Error("IDEMPOTENCY_CONFLICT");
        }
        return this.get(old.id,input.wait_seconds??20);
      }
    }
    if(thread && this.db.prepare("SELECT id FROM jobs WHERE status='running' AND thread=?").get(thread))throw Error("THREAD_BUSY");
    const known=!thread||Boolean(input.repo)||Boolean(imageIdentity)||fullAccess;
    if(mode==="execute" && known)this.assertFree(root);
    const action=branch?"fork":thread?"resume":input.ephemeral?"new_ephemeral":"new_persistent";
    const repo=known?repoForRoot(root):null;
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(id,thread,known?rootKey:null,mode,"running",start,null,key,fp,sig,'{"steps_completed":0}');
      this.db.prepare("INSERT INTO job_metadata(id,repo,profile,thread_action) VALUES(?,?,?,?)").run(id,repo,input.profile??"default",action);
      this.db.exec("COMMIT");
    } catch (err) {this.db.exec("ROLLBACK");throw err;}
    const controller=new AbortController();
    const done=this.perform(id,mode,{...input,imageIdentity},root,controller.signal).finally(()=>this.live.delete(id));
    this.live.set(id,{controller,done});
    return this.get(id,input.wait_seconds??20);
  }
  private async perform(id:string,mode:"review"|"execute",input:Input,root:string,signal:AbortSignal){
    let thread=input.thread_id,mutated=false;
    const claim=(cwd:string,value?:string)=>{
      const real=realpathSync.native(cwd);
      if(mode==="execute")this.assertFree(real,id);
      if(!input.repo && input.thread_id)this.db.prepare("UPDATE job_metadata SET repo=? WHERE id=?").run(repoForRoot(real),id);
      root=real;thread=value??thread;
      this.db.prepare("UPDATE jobs SET root=?,thread=? WHERE id=?").run(diskPathKey(real),thread??null,id);
    };
    const recordModel=(model:string)=>{this.db.prepare("UPDATE job_metadata SET model_used=? WHERE id=?").run(model,id);};
    let turnId:string|undefined,latestNote:string|undefined;
    const completed=new Set<string>();
    const activity:NonNullable<Review["activity"]>=(phase,value,progress)=>{
      if(value && value!==turnId){completed.clear();latestNote=undefined;}
      turnId=value??turnId;
      if(progress?.completedItemId)completed.add(progress.completedItemId);
      if(progress?.note)latestNote=progress.note;
      this.db.prepare("UPDATE jobs SET result=? WHERE id=? AND status='running'").run(JSON.stringify({
        phase,turn_id:turnId,last_activity_at:Date.now(),steps_completed:completed.size,latest_note:latestNote
      }),id);
    };
    let status="failed",out:Record<string,unknown>={};
    let forkWarning:string|undefined;
    try{
      if(input.fork_from && input.repo && this.fork){
        const branch=await this.fork({repo:input.repo,...input.fork_from},signal,child=>claim(root,child));
        thread=branch.thread_id;
        if("warning" in branch)forkWarning=branch.warning;
        signal.throwIfAborted();
      }
      for(let attempt=0;;attempt++){
        try{
          const r=await this.run({...input,workspaceRoot:root,mode,thread_id:input.ephemeral?undefined:thread,claim,recordModel,activity,sideEffect:()=>{mutated=true;}},signal);
          thread=r.thread_id;
          out={turn_id:r.turn_id??turnId,final_response:r.final_response,truncated:r.truncated,title:r.title,model_used:r.model_used,attached_files:attachments(root,r.final_response)};
          status="completed";break;
        }catch(e){
          if(e instanceof ReviewError)thread=e.thread_id??thread;
          if(!(e instanceof Error && e.message==="CODEX_rateLimitExceeded")||attempt||mutated||signal.aborted)throw e;
          await delay(1000,undefined,{signal});
        }
      }
    }catch(e){
      const reason=e instanceof Error?e.message:"UNKNOWN_ERROR";
      const code=(e instanceof ReviewError ? e.code : undefined)??({CODEX_usageLimitExceeded:"QUOTA_EXCEEDED",CODEX_unauthorized:"AUTH_ERROR",CODEX_rateLimitExceeded:"RATE_LIMITED"} as Record<string,string>)[reason]??reason;
      const stop=["AUTH_ERROR","QUOTA_EXCEEDED"].includes(code);
      if(signal.aborted || reason==="CODEX_interrupted" || (mode==="execute" && ["APP_SERVER_EXITED","APP_SERVER_TIMEOUT"].includes(reason)))status="interrupted";
      out={turn_id:turnId,error_code:code,error:status==="interrupted"?partial:stop?"请检查账号或额度，再按需重启并续接原线程。":reason,action_required:stop?"STOP_AND_ASK_USER":undefined,resume_command:stop&&thread&&!input.ephemeral?"codex_restart_server":undefined};
    }
    if(forkWarning)out.warning=forkWarning;
    this.db.prepare("UPDATE jobs SET status=?,thread=?,ended=?,result=? WHERE id=?").run(status,thread??null,Date.now(),JSON.stringify(out),id);
  }
  async cancel(id:string){this.row(id);this.live.get(id)?.controller.abort();return this.get(id,5);}
  async restart(force:boolean,probe:()=>Promise<unknown>){
    this.assertAccepting();
    if(this.live.size&&!force)return {status:"busy",job_ids:[...this.live.keys()]};
    this.restarting=true;
    try{
      const tasks=[...this.live.values()];for(const t of tasks)t.controller.abort();
      await Promise.all(tasks.map(t=>t.done));
      await resetCodexServers();
      return {status:"restarted",runtime:await probe()};
    }finally{this.restarting=false;}
  }
  private bridgeRestart?:{key?:string;result:Promise<BridgeRestartResult>};
  async restartBridge(force:boolean,key:string|undefined,ops:BridgeRestartOps,afterResponse:(run:()=>void)=>void){
    // A retry during preflight waits for the original decision and never schedules another helper.
    if(key && this.bridgeRestart?.key===key)return this.bridgeRestart.result;
    if(key){
      const accepted=ops.accepted?.(key);
      if(accepted)return accepted;
    }
    this.assertAccepting();
    if(!force && (this.live.size || this.mutations.size))return {status:"busy",scope:"bridge",job_ids:[...this.live.keys()]};
    this.draining=true;
    const result=this.prepareBridgeRestart(key,ops,afterResponse);
    this.bridgeRestart={key,result};
    return result;
  }
  private async prepareBridgeRestart(key:string|undefined,ops:BridgeRestartOps,afterResponse:(run:()=>void)=>void):Promise<BridgeRestartResult>{
    const tasks=[...this.live.values(),...this.mutations];
    for(const task of tasks)task.controller.abort();
    let forget:(()=>void)|undefined;
    const undo=()=>{
      this.bridgeRestart=undefined;
      this.draining=false;
      forget?.();
    };
    try{
      await Promise.allSettled(tasks.map(task=>task.done));
      await ops.preflight();
      const result:BridgeRestartResult={status:"restarting",scope:"bridge",pid:process.pid,preflight:"passed",
        message:"桥接预检通过，正在重启主进程，请等待数秒后调用 codex_start 验证。"};
      if(key)forget=ops.remember?.(key,result);
      afterResponse(()=>{void Promise.resolve().then(ops.launch).catch(error=>{
        try{undo();}finally{console.error("Bridge restart helper did not start.",error instanceof Error?error.name:"Error");}
      });});
      return result;
    }catch(error){
      undo();
      throw new BridgePreflightError(error instanceof BridgePreflightError ? error.reason : "Restart preparation failed.");
    }
  }
  async shutdown(){
    this.stopping=true;
    const tasks=[...this.live.values(),...this.mutations];
    for(const task of tasks)task.controller.abort();
    await Promise.allSettled(tasks.map(task=>task.done));
    await resetCodexServers();
  }
}

export type BridgeRestartResult={status:"restarting";scope:"bridge";pid:number;preflight:"passed";message:string};
export interface BridgeRestartOps {
  preflight():Promise<void>;
  launch():void|Promise<void>;
  accepted?(key:string):BridgeRestartResult|undefined;
  remember?(key:string,result:BridgeRestartResult):()=>void;
}
export class BridgePreflightError extends Error {
  constructor(readonly reason:string){super("BRIDGE_PREFLIGHT_FAILED");}
}

function localImageIdentity(root:string,files:readonly string[]){
  return resolveLocalImages(root,files).map(({relativePath,size,mtimeMs})=>({relativePath,size,mtimeMs}));
}

