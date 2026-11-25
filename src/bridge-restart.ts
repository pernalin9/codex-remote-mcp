import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdirSync,mkdtempSync,readFileSync,rmSync,statSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {createInterface} from "node:readline";
import {setTimeout as delay} from "node:timers/promises";
import {profiles,readWorkflowRules} from "./config.js";
import {bridgeHealth,callInstance,verifiedInstance} from "./instance.js";
import {BridgePreflightError,type BridgeRestartOps,type BridgeRestartResult} from "./jobs.js";
import {fullAccessProjects,projectCatalog,projectPath} from "./projects.js";
import {bridgeChildEnv,projectRoot,sandboxTempDirectory} from "./runtime.js";
import {withAppServer} from "./stdio.js";

const stageNames={
  startup:"Preflight child could not start.",
  config:"Bridge configuration validation failed.",
  codex:"Codex app-server handshake failed.",
  listener:"Preflight private control or loopback health check failed."
} as const;
type Stage=keyof typeof stageNames;

export async function checkPreflight(executable:string,signal:AbortSignal) {
  console.info("config");
  readWorkflowRules();
  profiles();
  const cwd=projectPath();
  if(!cwd || !projectCatalog().projects.every(project=>statSync(project.path).isDirectory())){
    throw new Error("Invalid preflight project catalog.");
  }
  fullAccessProjects();
  sandboxTempDirectory();
  console.info("codex");
  await withAppServer(executable,cwd,signal,10000,rpc=>rpc.request("model/list",{limit:1,includeHidden:false}));
  console.info("listener");
}

async function preflight() {
  const data=mkdtempSync(path.join(tmpdir(),"codex-bridge-preflight-"));
  const child=spawn(process.execPath,[path.join(projectRoot,"dist","index.js"),"--preflight"],{
    cwd:projectRoot,env:{...bridgeChildEnv(),CODEX_BRIDGE_DATA_DIR:data,PORT:"0"},
    windowsHide:true,stdio:["pipe","pipe","ignore"]
  });
  let stage:Stage="startup", exited=false;
  child.stdin.on("error",()=>{});
  const lines=createInterface({input:child.stdout});
  lines.on("line",message=>{
    if(Object.hasOwn(stageNames,message))stage=message as Stage;
  });
  const closed=new Promise<void>(resolve=>{
    const done=()=>{exited=true;resolve();};
    child.once("error",done);
    child.once("exit",done);
  });
  let active:Awaited<ReturnType<typeof verifiedInstance>>;
  try {
    const deadline=Date.now()+22000;
    while(!exited && Date.now()<deadline){
      active=await verifiedInstance(data);
      if(active?.entry.pid===child.pid && active?.state==="ready" && await bridgeHealth(active.entry.port)==="bridge")return;
      await delay(125);
    }
    throw new BridgePreflightError(stageNames[stage]);
  } finally {
    if(!exited && active && active.entry.pid===child.pid) {
      await callInstance(data,active.entry,"stop").catch(()=>{});
    }
    child.stdin.end();
    const timer=new AbortController();
    try {
      if(!exited && !await Promise.race([closed.then(()=>true),delay(5000,false,{signal:timer.signal})])){
        child.kill("SIGKILL");
        if(!await Promise.race([closed.then(()=>true),delay(2500,false,{signal:timer.signal})])){
          child.unref();
          throw new BridgePreflightError("Preflight child did not exit.");
        }
      }
    } finally {
      timer.abort();
      lines.close();
      child.stdout.destroy();
      if(exited)rmSync(data,{recursive:true,force:true,maxRetries:3,retryDelay:100});
    }
  }
}

export function bridgeRestartOperations(data:string):BridgeRestartOps {
  const receipts=path.join(data,"bridge-restarts");
  const receipt=(key:string)=>path.join(receipts,createHash("sha256").update(key).digest("hex")+".json");
  return {
    preflight,
    accepted(key){
      try{return JSON.parse(readFileSync(receipt(key),"utf8")) as BridgeRestartResult;}
      catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    },
    remember(key,result){
      mkdirSync(receipts,{recursive:true,mode:0o700});
      const file=receipt(key);
      writeFileSync(file,JSON.stringify(result),{flag:"wx",mode:0o600});
      return ()=>rmSync(file,{force:true});
    },
    launch(){
      const helper=spawn(process.execPath,[path.join(projectRoot,"dist","cli-ctl.js"),"restart","--bridge-from",data,String(process.pid)],{
        cwd:projectRoot,env:bridgeChildEnv(),detached:true,windowsHide:true,stdio:"ignore"
      });
      helper.unref();
      return new Promise<void>((resolve,reject)=>{
        helper.once("error",reject);
        helper.once("exit",code=>{if(code===0)resolve();else reject(new Error("Bridge restart helper failed."));});
      });
    }
  };
}
