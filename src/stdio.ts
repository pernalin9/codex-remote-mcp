import { statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { directoryKey } from "./projects.js";
import type { InitializeParams } from "./generated/app-server-schema/InitializeParams";

interface Notice {method:string; params:unknown}
export interface Rpc {
  request<T=unknown>(method:string,params:unknown):Promise<T>;
  notify(packet:unknown):void;
  onNotice(fn:(notice:Notice)=>void):void;
  until<T>(work:Promise<T>):Promise<T>;
}
function openServer(exe:string,cwd:string) {
  const env={...process.env};
  delete env.OWNER_ADMIN_PASSWORD;
  delete env.OAUTH_STATIC_CLIENT_SECRET;
  // Independent CLI subprocesses use their installed sandbox helpers and the
  // desktop user's Codex configuration, outside the initiating chat session.
  for (const key of ["CODEX_APP_RUNTIME_CLI_PATH","CODEX_APP_TOOLS_PIPE_PATH","CODEX_WINDOWS_REGISTERED_CORE","CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY","CODEX_THREAD_ID","CODEX_SESSION_ID","CODEX_TOOL_CALL_ID","CODEX_INTERNAL_ORIGINATOR_OVERRIDE","CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY"]) delete env[key];
  const windows=process.platform==="win32";
  const child=spawn(exe,["app-server","--stdio"],{cwd,env,windowsHide:true,detached:!windows,stdio:["pipe","pipe","ignore"]});
  let hasClosed=false;
  const closed=new Promise<true>(resolve=>child.once("close",()=>{hasClosed=true;resolve(true);}));
  function signalGroup(signal:NodeJS.Signals|0){
    if(!child.pid)return false;
    try{return process.kill(-child.pid,signal);}
    catch(error){
      return (error as NodeJS.ErrnoException).code==="EPERM";
    }
  }
  async function closedWithin(ms:number){
    const controller=new AbortController();
    try{return await Promise.race([closed,delay(ms,false,{signal:controller.signal})]);}
    finally{controller.abort();}
  }
  async function groupClosedWithin(ms:number){
    const deadline=Date.now()+ms;
    if(!await closedWithin(ms))return false;
    while(signalGroup(0) && Date.now()<deadline)await delay(25);
    return !signalGroup(0);
  }
  const lines=createInterface({input:child.stdout,crlfDelay:Infinity});
  const failed=Promise.withResolvers<never>();
  void failed.promise.catch(()=>{});
  let error:Error|undefined, seq=0;
  const pending=new Map<number,{method:string;resolve:(v:unknown)=>void;reject:(e:Error)=>void}>();
  let listener:((n:Notice)=>void)|undefined;
  function fail(code:string) {
    if (error) return;
    error=new Error(code); failed.reject(error);
    for(const p of pending.values()) p.reject(error);
    pending.clear();
  }
  function notify(packet:unknown) {if(child.stdin.writable) child.stdin.write(JSON.stringify(packet)+"\n");}
  function request<R>(method:string,params:unknown):Promise<R> {
    if(error) return Promise.reject(error);
    const id=++seq;
    return new Promise((resolve,reject)=>{
      pending.set(id,{method,resolve:v=>resolve(v as R),reject});
      notify({id,method,params});
    });
  }
  lines.on("line",line=>{
    try {
      const msg=JSON.parse(line);
      if(msg.id!==undefined && msg.method) {
        notify({id:msg.id,error:{code:-32601,message:"Interactive request unavailable in headless mode"}});
      } else if(msg.id!==undefined) {
        const p=pending.get(msg.id); pending.delete(msg.id);
        if(msg.error && p) p.reject(new RpcError(p.method,msg.error.code,msg.error.message));
        else p?.resolve(msg.result);
      } else listener?.(msg);
    } catch {fail("APP_SERVER_PROTOCOL_ERROR");}
  });
  child.on("error",()=>fail("APP_SERVER_SPAWN_FAILED"));
  child.stdin.on("error",()=>fail("APP_SERVER_STDIN_CLOSED"));
  child.once("close",()=>fail("APP_SERVER_EXITED"));
  let initialized=false;
  return {
    healthy:()=>!error,
    async use<T>(signal:AbortSignal|undefined,timeoutMs:number,run:(rpc:Rpc)=>Promise<T>){
      const abort=()=>fail("APP_SERVER_CANCELLED");
      signal?.addEventListener("abort",abort,{once:true});
      if(signal?.aborted)abort();
      const timer=setTimeout(()=>fail("APP_SERVER_TIMEOUT"),timeoutMs);
      try {
        if(!initialized){
          await request("initialize",{clientInfo:{name:"codex_remote_mcp",title:"Gemini Codex Bridge",version:"0.2.0"},capabilities:null} satisfies InitializeParams);
          notify({method:"initialized",params:{}});initialized=true;
        }
        return await run({request,notify,onNotice:fn=>{listener=fn;},until:work=>Promise.race([work,failed.promise])});
      } finally {clearTimeout(timer);signal?.removeEventListener("abort",abort);listener=undefined;}
    },
    async close(){
      child.stdin.end();
      if(windows){
        if(!await closedWithin(2500) && child.pid){
          const killer=spawn("taskkill.exe",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});
          killer.once("error",()=>child.kill());
          killer.once("exit",code=>{if(code && !hasClosed)child.kill();});
          killer.unref();
          if(!await closedWithin(1500)){child.kill();await closedWithin(500);}
        }
      }else if(!await groupClosedWithin(1000)){
        signalGroup("SIGTERM");
        if(!await groupClosedWithin(1000)){
          signalGroup("SIGKILL");
          await groupClosedWithin(750);
        }
      }
      lines.close();
      if(!hasClosed){child.stdin.destroy();child.stdout.destroy();child.unref();}
    }
  };
}
export async function withAppServer<T>(exe:string,cwd:string,signal:AbortSignal|undefined,timeoutMs:number,run:(rpc:Rpc)=>Promise<T>) {
  const server=openServer(exe,cwd);
  try{return await server.use(signal,timeoutMs,run);}finally{await server.close();}
}
type Lease={server:ReturnType<typeof openServer>; timer:NodeJS.Timeout;key:string};
const idle=new Set<Lease>();
let generation=0;
export async function resetCodexServers(){
  generation++;
  const leases=[...idle];idle.clear();
  await Promise.all(leases.map(l=>{clearTimeout(l.timer);return l.server.close();}));
}
function authStamp(){
  try{const st=statSync(path.join(process.env.CODEX_HOME??path.join(os.homedir(),".codex"),"auth.json"));return st.mtimeMs+"/"+st.size;}
  catch{return "absent";}
}
let authVersion:string|undefined;
export async function withTurnServer<T>(exe:string,cwd:string,signal:AbortSignal|undefined,timeoutMs:number,run:(rpc:Rpc)=>Promise<T>){
  const stamp=authStamp();
  if(stamp!==authVersion){authVersion=stamp;await resetCodexServers();}
  const epoch=generation,key=JSON.stringify([exe,directoryKey(cwd)]);
  const cached=[...idle].find(l=>l.key===key && l.server.healthy());
  if(cached){clearTimeout(cached.timer);idle.delete(cached);}
  const server=cached?.server??openServer(exe,cwd);
  try{return await server.use(signal,timeoutMs,run);}
  finally{
    if(epoch!==generation || !server.healthy())await server.close();
    else{
      const ttl=Number(process.env.APP_SERVER_IDLE_SHUTDOWN_SEC??60);
      const lease:Lease={server,key,timer:setTimeout(()=>{idle.delete(lease);void server.close();},1000*(Number.isFinite(ttl)?Math.max(0,ttl):60))};
      idle.add(lease);
    }
  }
}

// RPC details can contain paths, prompts or credentials. Only forward diagnostic
// vocabulary from the first line; arbitrary upstream payloads stay local.
export class RpcError extends Error {
  readonly code: string;
  constructor(readonly method: string, rpcCode: unknown, raw: unknown) {
    const line = typeof raw === "string" ? raw.slice(0,1024).split(/[\r\n]/,1)[0] : "";
    const busy = method === "thread/resume" && /^thread [a-f0-9-]{36} already has an active writer$/i.test(line.trim());
    const detail = busy ? "thread [id] already has an active writer" :
      line.match(/\b(?:invalid (?:request|params|parameters|type|value)|unknown (?:field|variant|thread)|missing field|thread not found|method not found|failed to (?:load|read|parse|resume) (?:thread|rollout)|permission denied|internal error)\b/i)?.[0] ?? "[detail redacted]";
    const rpc = Number.isSafeInteger(rpcCode) ? String(rpcCode) : "UNKNOWN";
    super(`APP_SERVER_RPC ${rpc} ${method}: ${detail.slice(0,160)}`);
    this.code = busy ? "THREAD_BUSY" : "APP_SERVER_RPC "+rpc;
  }
}
