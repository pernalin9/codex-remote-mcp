import { execFile } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { profiles, readWorkflowRules } from "./config.js";
import { bridgeHealth } from "./instance.js";
import { parseCatalog, repoLabel } from "./projects.js";
import { bridgePort, codexExecutable, dataDirectory, loadBridgeEnv, projectRoot, publicOrigin } from "./runtime.js";
import { withAppServer } from "./stdio.js";
import type { GetAccountResponse } from "./generated/app-server-schema/v2/GetAccountResponse";
import type { ModelListResponse } from "./generated/app-server-schema/v2/ModelListResponse";

type Level="OK"|"WARN"|"FAIL";
function report(level:Level,check:string,detail:string) {
  console.log("["+level+"] "+check+" — "+detail);
  if(level==="FAIL")process.exitCode=1;
}

function check(label:string,verify:()=>string,fix:string) {
  try{report("OK",label,verify());}
  catch{report("FAIL",label,fix);}
}

function dataAccess() {
  const directory=dataDirectory();
  let parent=directory;
  for(;;){
    try{
      if(!statSync(parent).isDirectory())throw new Error("Expected a data directory");
      accessSync(parent,constants.R_OK|constants.W_OK|constants.X_OK);
      return directory+(parent===directory?" (read/write access)":" (absent; parent is writable)");
    }catch(error){
      const ancestor=path.dirname(parent);
      if((error as NodeJS.ErrnoException).code!=="ENOENT" || ancestor===parent)throw error;
      parent=ancestor;
    }
  }
}

const runFile=promisify(execFile);
async function inspectCodex() {
  let executable:string;
  try{executable=codexExecutable();}
  catch{report("FAIL","Codex CLI","Install the standalone @openai/codex CLI or set its absolute CODEX_EXE.");return;}
  report("OK","Codex CLI",executable);
  try{
    const {stdout}=await runFile(executable,["--version"],{cwd:projectRoot,windowsHide:true,timeout:4000,maxBuffer:4096});
    const version=/\bcodex-cli\s+([\w.+-]{1,80})/.exec(stdout)?.[1];
    if(!version)throw new Error("unrecognized version");
    report("OK","Codex version",version);
  }catch{report("FAIL","Codex version","Run codex --version using the standalone CLI.");}
  try{
    const {account,models}=await withAppServer(executable,projectRoot,undefined,12000,async rpc=>{
      const {account}=await rpc.request<GetAccountResponse>("account/read",{refreshToken:false});
      const models:ModelListResponse["data"]=[];
      let cursor:string|null=null;
      do{
        const page:ModelListResponse=await rpc.request("model/list",{includeHidden:false,limit:50,cursor});
        models.push(...page.data.filter(model=>!model.hidden));
        if(page.nextCursor===cursor)break;
        cursor=page.nextCursor;
      }while(cursor && models.length<100);
      return {account,models};
    });
    report("OK","App server","initialize and model/list responded.");
    if(account){
      const plan=account.type==="chatgpt" && /^[\w-]{1,40}$/.test(account.planType) ? " ("+account.planType+")" : "";
      const type=["chatgpt","apiKey","amazonBedrock"].includes(account.type) ? account.type : "unknown";
      report("OK","Codex account",type+plan);
    }else report("WARN","Codex account","No account reported. Sign in with the standalone CLI if your provider requires it.");
    const summary=models.slice(0,12).map(model=>{
      const name=/^[\w./:-]{1,96}$/.test(model.model) ? model.model : "(unrecognized model name)";
      const efforts=(model.supportedReasoningEfforts??[]).map(option=>option.reasoningEffort)
        .filter(effort=>/^[a-z]{1,16}$/.test(effort));
      return name+(efforts.length?" ["+efforts.join("/") +"]":"");
    });
    if(summary.length)report("OK","Available models",summary.join(", ")+(models.length>summary.length ? " (and more)" : ""));
    else report("WARN","Available models","model/list returned no visible models. Check sign-in and provider settings.");
  }catch{
    report("FAIL","App server","Could not read the account and model list. Check CLI login and sandbox access.");
  }
}

async function inspectPort() {
  try{
    const port=bridgePort();
    const health=await bridgeHealth(port);
    if(health==="bridge")report("OK","Loopback port","Bridge healthz responded at 127.0.0.1:"+port+".");
    else if(health==="free")report("OK","Loopback port",port===0 ? "An available port will be selected at startup." : port+" is free; bridge is not running.");
    else report("WARN","Loopback port",port+" is occupied or its healthz did not identify the bridge. Check the listener or choose another port.");
  }catch{report("FAIL","Loopback port","Set PORT to a valid local port.");}
}

const system=process.platform==="win32" ? process.env.USERNAME?.toUpperCase()==="SYSTEM" : process.geteuid?.()===0;
report(system?"FAIL":"OK","Platform / account",process.platform+" / "+(system?"use the regular desktop account":"regular user"));
check("Node.js",()=>{
  const [major,minor]=process.versions.node.split(".").map(Number);
  if(major<22 || major===22 && minor<16)throw new Error("unsupported Node version");
  return process.versions.node;
},"Install Node.js 22.16 or newer.");

let loaded=false;
check(".env",()=>{
  loaded=loadBridgeEnv();
  bridgePort();
  publicOrigin();
  const fields=[process.env.OAUTH_STATIC_CLIENT_ID,process.env.OAUTH_STATIC_CLIENT_SECRET,process.env.OAUTH_STATIC_REDIRECT_URIS];
  if(fields.some(Boolean)){
    if(!fields.every(Boolean))throw new Error("incomplete static OAuth environment");
    const redirects=JSON.parse(fields[2]!);
    if(!Array.isArray(redirects) || !redirects.length || !redirects.every(uri=>typeof uri==="string")){
      throw new Error("invalid static OAuth redirects");
    }
  }
  return loaded?"Project file loaded and settings validated.":"No project file; using environment and defaults.";
},"Check the project .env, PORT, PUBLIC_BASE_URL and optional static OAuth settings.");
check("Data directory",dataAccess,"Check CODEX_BRIDGE_DATA_DIR and read/write access to its directory or parent.");
check("config/repos.json",()=>{
  const {projects,byName}=parseCatalog(readFileSync(path.join(projectRoot,"config","repos.json"),"utf8"));
  if(!projects.length || process.env.DEFAULT_REPO!==undefined && !byName.has(repoLabel(process.env.DEFAULT_REPO))){
    throw new Error("no default project");
  }
  for(const project of projects){
    if(!statSync(project.path).isDirectory())throw new Error("project path is not a directory");
    accessSync(project.path,constants.R_OK|constants.X_OK);
  }
  return projects.length+" readable project directories.";
},"Fill config/repos.json with readable absolute project directories and check DEFAULT_REPO.");
check("config/profiles.json",()=>Object.keys(profiles()).length+" profiles.",
  "Fill config/profiles.json with valid model IDs and reasoning settings, including default and coding.");
check("config/gemini-instructions.md + config/user-instructions.md",()=>{
  const {text,userLoaded}=readWorkflowRules();
  const userStatus=userLoaded ? "loaded" : "skipped (missing or blank)";
  return "System rules loaded; optional user rules "+userStatus+". Combined: "+[...text].length+" / 6000 characters.";
},"Check that the required system rules are nonempty, the optional user rules are readable if present, and the combined rules have at most 6000 characters.");
await Promise.all([inspectCodex(),inspectPort()]);
