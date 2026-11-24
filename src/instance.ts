import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, lstatSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { once } from "node:events";
import path from "node:path";
import { dataDirectoryLocked } from "./runtime.js";

export type Instance = {pid:number;port:number;token:string};
type State = "ready" | "stopping";
const registry = (data:string) => path.join(data,"bridge-instance.json");

export function readInstance(data:string):Instance|undefined {
  try {
    const entry=JSON.parse(readFileSync(registry(data),"utf8")) as Instance;
    if(Number.isSafeInteger(entry.pid) && entry.pid>0 && Number.isInteger(entry.port) && entry.port>0 &&
      entry.port<=65535 && /^[a-f0-9]{48}$/.test(entry.token)) return entry;
  } catch (error) {
    if (!(error instanceof SyntaxError || error instanceof TypeError) &&
      (error as NodeJS.ErrnoException).code!=="ENOENT") throw error;
  }
}

function controlAddress(data:string,token:string) {
  const name="codex-mcp-"+token.slice(0,24);
  if(process.platform==="win32") return "\\\\.\\pipe\\"+name;
  for(const directory of [realpathSync.native(data),"/tmp"]){
    const socket=path.join(directory,name+".sock");
    if(Buffer.byteLength(socket)<100) return socket;
  }
  throw new Error("Unable to select a local control socket path.");
}

function unlinkIfPresent(file:string) {
  try {unlinkSync(file);}
  catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT") throw error;}
}

// Only call while holding the data-directory lock. Never remove its SQLite inode.
export function clearInstanceRecord(data:string) {
  const old=readInstance(data);
  if(old && process.platform!=="win32"){
    const socket=controlAddress(data,old.token);
    try {if(lstatSync(socket).isSocket())unlinkIfPresent(socket);}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  }
  unlinkIfPresent(registry(data));
}

export async function publishInstance(data:string,port:number,issueApprovalCode:(requestId:string)=>string|undefined,stop:()=>void) {
  clearInstanceRecord(data);
  const instance:Instance={pid:process.pid,port,token:randomBytes(24).toString("hex")};
  const address=controlAddress(data,instance.token);
  let state:State="ready";
  const control=createServer((req,res)=>{
    const token=req.headers.authorization;
    res.setHeader("Cache-Control","no-store");
    if(typeof token!=="string" || !/^[a-f0-9]{48}$/.test(token) ||
      !timingSafeEqual(Buffer.from(token),Buffer.from(instance.token))){
      res.writeHead(403).end();
      return;
    }
    const approval=req.method==="POST" && /^\/approval-code\/([A-F0-9]{12})$/.exec(req.url??"");
    if(req.method==="GET" && req.url==="/status"){
      res.end(JSON.stringify({pid:instance.pid,port,state}));
    }else if(approval && state==="ready"){
      const code=issueApprovalCode(approval[1]);
      if(code)res.end(code);
      else res.writeHead(404).end();
    }else if(req.method==="POST" && req.url==="/stop"){
      const initiate=state==="ready";
      state="stopping";
      res.end("",()=>{if(initiate)stop();});
    }else res.writeHead(404).end();
  });
  const release=async()=>{
    if(control.listening){
      const closed=new Promise<void>(resolve=>control.close(()=>resolve()));
      control.closeAllConnections();
      await closed;
    }
    clearInstanceRecord(data);
  };
  const temp=registry(data)+"."+instance.token.slice(0,24)+".tmp";
  try{
    writeFileSync(temp,JSON.stringify(instance),{flag:"wx",mode:0o600});
    renameSync(temp,registry(data));
    control.listen(address);
    await once(control,"listening");
    if(process.platform!=="win32")chmodSync(address,0o600);
    return release;
  }catch(error){
    await release();
    unlinkIfPresent(temp);
    throw error;
  }
}

export function callInstance(data:string,instance:Instance,operation:"status"|"stop"|{approvalRequest:string}) {
  const approval=typeof operation==="object";
  const route=approval?"/approval-code/"+encodeURIComponent(operation.approvalRequest):"/"+operation;
  return new Promise<string>((resolve,reject)=>{
    const fail=()=>reject(new Error("The private bridge control channel did not respond."));
    const req=request({
      socketPath:controlAddress(data,instance.token),path:route,
      method:operation==="status"?"GET":"POST",
      headers:{authorization:instance.token},signal:AbortSignal.timeout(1000)
    },res=>{
      let text="";
      res.setEncoding("utf8");
      res.on("error",fail);
      res.on("data",chunk=>{
        text+=chunk;
        if(text.length>65536){res.destroy();fail();}
      });
      res.on("end",()=>{
        if(res.statusCode===200)resolve(text);
        else if(approval && res.statusCode===404)reject(new Error("Connection request unavailable. Open a fresh authorization page in Gemini."));
        else fail();
      });
    });
    req.on("error",fail);
    req.end();
  });
}

export async function verifiedInstance(data:string) {
  if(!dataDirectoryLocked(data))return;
  const entry=readInstance(data);
  if(!entry)return;
  try{
    process.kill(entry.pid,0);
    const live=JSON.parse(await callInstance(data,entry,"status")) as {pid:number;port:number;state:State};
    if(live.pid===entry.pid && live.port===entry.port && (live.state==="ready" || live.state==="stopping")){
      return {entry,state:live.state};
    }
  }catch { /* PID liveness alone is not proof of ownership. */ }
}

export async function bridgeHealth(port:number):Promise<"bridge"|"occupied"|"free"> {
  if(port===0)return "free";
  try{
    const response=await fetch("http://127.0.0.1:"+port+"/healthz",{
      redirect:"manual",signal:AbortSignal.timeout(850)
    });
    const reader=response.body?.getReader();
    if(!reader)return "occupied";
    let body="";
    try{
      const decoder=new TextDecoder();
      while(body.length<1024){
        const {done,value}=await reader.read();
        if(done){
          const result=JSON.parse(body+decoder.decode());
          return response.ok && result.status==="ok" && result.milestone===1 ? "bridge" : "occupied";
        }
        if(value.byteLength>1024)return "occupied";
        body+=decoder.decode(value,{stream:true});
      }
    }finally{await reader.cancel().catch(()=>{});}
  }catch(error){
    if((error as {cause?:{code?:string}}).cause?.code==="ECONNREFUSED")return "free";
  }
  return "occupied";
}
