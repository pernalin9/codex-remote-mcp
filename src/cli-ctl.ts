import { spawn } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { bridgeHealth, callInstance, clearInstanceRecord, readInstance, verifiedInstance } from "./instance.js";
import { bridgeChildEnv, bridgePort, dataDirectory, dataDirectoryLocked, loadBridgeEnv, lockDataDirectory, projectRoot } from "./runtime.js";

const usage="npm run ctl -- start|stop|restart|status|logs [--lines|-n N]|copy-code <connection-id>";
const logNames=["service.log","service-error.log"];

async function waitFor<T>(ms:number,check:()=>Promise<T|undefined>|T|undefined) {
  const deadline=Date.now()+ms;
  do{
    const result=await check();
    if(result!==undefined)return result;
    await delay(125);
  }while(Date.now()<deadline);
}

async function start(data:string,port:number) {
  const entry=path.join(projectRoot,"dist","index.js");
  if(!existsSync(entry))throw new Error("Build the bridge first with npm run build.");
  if(dataDirectoryLocked(data))throw new Error("The data directory is already in use. Run npm run ctl -- status.");
  const health=await bridgeHealth(port);
  if(health!=="free")throw new Error(health==="bridge" ?
    "A bridge already responds on the configured port." : "The configured loopback port is in use.");

  mkdirSync(data,{mode:0o700,recursive:true});
  const logs=logNames.map(name=>path.join(data,name));
  const descriptors:number[]=[];
  let child;
  try{
    for(const file of logs)descriptors.push(openSync(file,"a",0o600));
    child=spawn(process.execPath,[entry],{
      cwd:projectRoot,env:bridgeChildEnv(),detached:true,windowsHide:true,stdio:["ignore",descriptors[0],descriptors[1]]
    });
  }finally{for(const fd of descriptors)closeSync(fd);}
  let failed=false;
  child.once("error",()=>{failed=true;});
  child.once("exit",()=>{failed=true;});
  child.unref();
  const ready=await waitFor(12000,async()=>{
    if(failed)return false;
    const active=await verifiedInstance(data);
    if(active?.entry.pid===child.pid && active?.state==="ready" && await bridgeHealth(active.entry.port)==="bridge")return active.entry;
  });
  if(!ready)throw new Error("The bridge did not become ready. Inspect "+logs[1]);
  console.log("Bridge running (PID "+ready.pid+") at 127.0.0.1:"+ready.port);
  for(const file of logs)console.log(file);
}

async function stop(data:string,port:number,allowAbsent=false,expectedPid?:number) {
  const active=await verifiedInstance(data);
  if(expectedPid!==undefined && active?.entry.pid!==expectedPid)throw new Error("Restart source bridge has changed.");
  if(!active){
    if(dataDirectoryLocked(data) || await bridgeHealth(port)==="bridge"){
      throw new Error("Bridge process ownership could not be verified. Use its original service manager.");
    }
    if(!allowAbsent)console.log("Bridge is stopped.");
    return;
  }
  const {entry}=active;
  await callInstance(data,entry,"stop");
  const released=()=>dataDirectoryLocked(data) ? undefined : true;
  if(!await waitFor(8000,released)){
    const current=await verifiedInstance(data);
    if(!current || current.entry.pid!==entry.pid || current.entry.token!==entry.token || current.state!=="stopping"){
      throw new Error("Bridge did not stop in time and process ownership could not be reverified.");
    }
    try{process.kill(entry.pid,"SIGKILL");}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ESRCH")throw error;}
    if(!await waitFor(2500,released))throw new Error("The bridge still holds the data directory lock.");
  }
  // A graceful exit removes its record. After forced exit, clean up only our own
  // record while holding the same lock used by bridge startup.
  if(readInstance(data)?.token===entry.token){
    const release=lockDataDirectory(data);
    try{if(readInstance(data)?.token===entry.token)clearInstanceRecord(data);}
    finally{release();}
  }
  console.log("Bridge stopped (PID "+entry.pid+").");
}

async function status(data:string,port:number) {
  const active=await verifiedInstance(data);
  if(active){
    const health=await bridgeHealth(active.entry.port);
    console.log("Bridge "+active.state+" (PID "+active.entry.pid+") at 127.0.0.1:"+active.entry.port+
      " (healthz "+(health==="bridge"?"OK":"unavailable")+").");
    return;
  }
  const health=await bridgeHealth(port), locked=dataDirectoryLocked(data);
  if(locked)console.log("Data directory is locked but the bridge owner is unverified.");
  if(health==="bridge")console.log("Bridge responds at 127.0.0.1:"+port+" (unmanaged or using another data directory).");
  else if(health==="occupied")console.log("Port "+port+" is occupied by another listener.");
  else if(!locked)console.log("Bridge is stopped.");
}

function tail(file:string,count:number) {
  const fd=openSync(file,"r");
  try{
    const size=fstatSync(fd).size;
    let end=size,newlines=0;
    const chunks:Buffer[]=[];
    while(end>0 && newlines<=count && size-end<1024*1024){
      const chunk=Buffer.alloc(Math.min(end,8192));
      end-=chunk.length;
      const bytes=chunk.subarray(0,readSync(fd,chunk,0,chunk.length,end));
      chunks.unshift(bytes);
      for(const byte of bytes)if(byte===10)newlines++;
    }
    const lines=Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/,"").split(/\r?\n/);
    return lines.slice(-count).join("\n");
  }finally{closeSync(fd);}
}

function logs(data:string,options:string[]) {
  const count=options.length ? Number(options[1]) : 60;
  if((options.length && (options.length!==2 || !["--lines","-n"].includes(options[0]))) ||
    !Number.isInteger(count) || count<1 || count>5000)throw new Error(usage);
  for(const name of logNames){
    const file=path.join(data,name);
    console.log("== "+name+" ==");
    console.log(existsSync(file)?tail(file,count):"(no log file)");
  }
}

async function copyApprovalCode(data:string,requestId:string) {
  const active=await verifiedInstance(data);
  if(active?.state!=="ready")throw new Error("The running bridge could not be verified. Run npm run ctl -- status.");
  const code=await callInstance(data,active.entry,{approvalRequest:requestId});
  if(!/^[0-9A-HJKMNP-TV-Z]{8}$/.test(code))throw new Error("The bridge returned an invalid authorization code.");
  // Decode redirected stdin explicitly so Windows receives the exact text.
  const windowsCopy="$ErrorActionPreference = 'Stop'; $buffer = [IO.MemoryStream]::new(); "+
    "[Console]::OpenStandardInput().CopyTo($buffer); "+
    "Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString($buffer.ToArray()))";
  const commands=process.platform==="win32"
    ? [["powershell.exe","-NoProfile","-NonInteractive","-STA","-Command",windowsCopy]]
    : process.platform==="darwin" ? [["pbcopy"]]
    : [["wl-copy"],["xclip","-selection","clipboard"]];
  const bytes=Buffer.from(code,"utf8");
  for(const [command,...args] of commands){
    const copied=await new Promise<boolean>(resolve=>{
      const clip=spawn(command,args,{stdio:["pipe","ignore","ignore"],windowsHide:true,timeout:3000});
      clip.once("error",()=>resolve(false));
      clip.once("close",code=>resolve(code===0));
      clip.stdin?.on("error",()=>resolve(false));
      clip.stdin?.end(bytes);
    });
    if(copied){console.log("One-time authorization code copied to the clipboard.");return;}
  }
  throw new Error("Clipboard unavailable. Check the desktop session and platform clipboard command.");
}

try {
  const [action,...options]=process.argv.slice(2);
  const from=action==="restart" && options[0]==="--bridge-from";
  if(!["start","stop","restart","status","logs","copy-code"].includes(action) ||
    (options.length && action!=="logs" && action!=="copy-code" && !from))throw new Error(usage);
  if(action==="copy-code" && (options.length!==1 || !/^[a-f0-9]{12}$/i.test(options[0])))throw new Error(usage);
  loadBridgeEnv();
  const data=dataDirectory(),port=bridgePort();
  if(action==="start")await start(data,port);
  if(from){
    const [,oldData,pid]=options;
    if(options.length!==3 || !path.isAbsolute(oldData) || !/^\d+$/.test(pid))throw new Error(usage);
    const source=await verifiedInstance(oldData);
    if(source?.entry.pid!==Number(pid))throw new Error("Restart source bridge has changed.");
    const dataChanged=path.relative(oldData,data)!=="";
    if(dataChanged && dataDirectoryLocked(data))throw new Error("New data directory is already in use.");
    if(port!==source.entry.port && await bridgeHealth(port)!=="free")throw new Error("New loopback port is already in use.");
    await stop(oldData,source.entry.port,false,source.entry.pid);
  }else if(action==="stop" || action==="restart")await stop(data,port,action==="restart");
  if(action==="restart")await start(data,port);
  if(action==="status")await status(data,port);
  if(action==="logs")logs(data,options);
  if(action==="copy-code")await copyApprovalCode(data,options[0].toUpperCase());
}catch(error){
  console.error(error instanceof Error ? error.message : "Bridge control failed.");
  process.exitCode=1;
}
