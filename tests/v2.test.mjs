import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { attachments, listFiles, readFile, resolveLocalImages } from "../dist/file-ops.js";

const png = Buffer.from("89504e470d0a1a0a","hex");
const threadId = randomUUID();
const sharedDist = fileURLToPath(new URL("../dist/",import.meta.url));
const testsDir = fileURLToPath(new URL("./",import.meta.url));

function fixture(t) {
  const home = fs.mkdtempSync(path.join(testsDir,"v2-"));
  const cleanups = [];
  t.after(async () => {
    try {
      for (const cleanup of cleanups.reverse()) await cleanup();
    } finally { fs.rmSync(home,{recursive:true,force:true}); }
  });
  return {home,cleanups};
}

function runtimeFixture(t) {
  const f = fixture(t);
  const dist = path.join(f.home,"dist");
  const config = path.join(f.home,"config");
  const fallback = path.join(f.home,"Fallback");
  const target = path.join(f.home,"Target");
  for (const directory of [dist,config,fallback,target]) fs.mkdirSync(directory);
  for (const file of fs.readdirSync(sharedDist).filter(name => name.endsWith(".js"))) {
    fs.copyFileSync(path.join(sharedDist,file),path.join(dist,file));
  }
  const repos = path.join(config,"repos.json");
  fs.writeFileSync(repos,JSON.stringify({Fallback:fallback,Target:{path:target,aliases:["alias"]}}));
  fs.writeFileSync(path.join(config,"profiles.json"),JSON.stringify({
    default:{model:"fixture",reasoningEffort:"low"},coding:{model:"fixture",reasoningEffort:"low"}
  }));
  fs.writeFileSync(path.join(f.home,"rpc.json"),JSON.stringify({target,threadId}));
  const fake = 'import fs from "node:fs"; import path from "node:path"; import {createInterface} from "node:readline"; ('+
    fakeAppServer.toString()+')();';
  for (const root of [fallback,target]) fs.writeFileSync(path.join(root,"app-server"),fake);
  const module = name => import(pathToFileURL(path.join(dist,name+".js")).href);
  return {...f,dist,repos,fallback,target,module,log:path.join(f.home,"requests.jsonl")};
}

function fakeAppServer() {
  const cwd = process.cwd();
  const home = path.dirname(cwd);
  const {target,threadId} = JSON.parse(fs.readFileSync(path.join(home,"rpc.json"),"utf8"));
  const user = (text,id) => ({type:"userMessage",id,content:[{type:"text",text}]});
  const agent = (text,id,phase) => ({type:"agentMessage",id,text,phase});
  const history = [
    {id:"old",status:"completed",items:[user("first","u1"),agent("old response","a1","final_answer")]},
    {id:"new",status:"completed",items:[user("🌱".repeat(180),"u2"),agent("progress","a2","commentary"),
      agent("A".repeat(8000)+"\n\n"+"🌱".repeat(3400),"a3","final_answer")]}
  ];
  const report = message => console.log(JSON.stringify(message));
  const notices = createInterface({input:process.stdin});
  notices.on("line",line => {
    const req = JSON.parse(line);
    if(req.id===undefined)return;
    fs.appendFileSync(path.join(home,"requests.jsonl"),JSON.stringify({cwd,...req})+"\n");
    const reply = result => report({id:req.id,result});
    switch(req.method) {
      case "thread/read":
        reply({thread:{cwd:target,id:threadId,name:"fixture",turns:req.params.includeTurns ? history : []}});
        break;
      case "thread/turns/list":
        reply(req.params.cursor ? {data:[history[0]],nextCursor:null}
          : {data:[history[1]],nextCursor:"older"});
        break;
      case "thread/fork":
        reply({thread:{id:threadId,cwd:target,name:null}});
        break;
      case "thread/resume":
      case "thread/start":
        reply({thread:{id:threadId,cwd:req.params.cwd??target,status:{type:"idle"},name:"fixture"},cwd:req.params.cwd??target,model:"fixture"});
        break;
      case "turn/start": {
        const turnId = "active", item = agent("界".repeat(240),"note","commentary");
        const status = (method,item,turn=turnId,thread=threadId) => report({method,params:{threadId:thread,turnId:turn,item}});
        status("item/started",item);
        status("item/started",{type:"reasoning",id:"pending",content:["private reasoning"]});
        status("item/completed",item,"wrong-turn");
        status("item/completed",item,turnId,"wrong-thread");
        status("item/completed",item);
        status("item/completed",item);
        reply({turn:{id:turnId}});
        const finish = () => {
          status("item/completed",agent("final text","final","final_answer"));
          report({method:"turn/completed",params:{threadId,turn:{id:turnId,status:"completed"}}});
        };
        if(req.params.input[0].text.startsWith("hold progress")){
          const timer=setInterval(()=>{
            if(fs.existsSync(path.join(home,"finish"))){clearInterval(timer);finish();}
          },15);
          timer.unref();
        }else finish();
        break;
      }
      default: reply({});
    }
  });
}

async function eventually(check) {
  const deadline=Date.now()+5000;
  do {
    const value=await check();
    if(value)return value;
    await delay(20);
  } while(Date.now()<deadline);
  assert.fail("Timed out waiting for fixture state");
}

test("workflow rules merge optional user rules and hot reload file changes",async t=>{
  const f=runtimeFixture(t);
  const systemFile=path.join(f.home,"config","gemini-instructions.md");
  const userFile=path.join(f.home,"config","user-instructions.md");
  const {rules,readWorkflowRules}=await f.module("config");
  const system="System rules.\r\n";
  const heading="# 以下为用户自定义规则";

  assert.throws(rules,{code:"ENOENT"});
  fs.writeFileSync(systemFile," \n");
  assert.throws(rules,/EMPTY_WORKFLOW_RULES/);
  fs.writeFileSync(systemFile,system);
  assert.deepEqual(readWorkflowRules(),{text:system,userLoaded:false});

  fs.writeFileSync(userFile," \r\n\t");
  assert.deepEqual(readWorkflowRules(),{text:system,userLoaded:false});

  const titledUser=" \n"+heading+"\nKeep exact wording.\n";
  fs.writeFileSync(userFile,titledUser);
  assert.deepEqual(readWorkflowRules(),{text:system+"\n\n"+titledUser,userLoaded:true});

  const untitledPrefix=system+"\n\n"+heading+"\n\n";
  fs.writeFileSync(userFile,"First");
  assert.equal(rules(),untitledPrefix+"First");
  fs.writeFileSync(userFile,"Other");
  assert.equal(rules(),untitledPrefix+"Other");

  const userAtLimit="😀".repeat(6000-[...untitledPrefix].length);
  fs.writeFileSync(userFile,userAtLimit);
  assert.equal([...rules()].length,6000);
  fs.writeFileSync(userFile,userAtLimit+"!");
  assert.throws(rules,/WORKFLOW_RULES_OVER_6000/);

  fs.unlinkSync(userFile);
  assert.deepEqual(readWorkflowRules(),{text:system,userLoaded:false});
  fs.writeFileSync(userFile,"Restored");
  assert.equal(rules(),untitledPrefix+"Restored");
});

test("binary detection, UTF-16 and hardlink errors preserve byte metadata",t => {
  const root=fs.realpathSync.native(fixture(t).home);
  const put=(name,body)=>fs.writeFileSync(path.join(root,name),body);
  const body=Buffer.from("one\r\n二\r\n","utf16le");
  for(const [name,bytes] of [
    ["le.txt",Buffer.concat([Buffer.from("fffe","hex"),body])],
    ["be.txt",Buffer.concat([Buffer.from("feff","hex"),Buffer.from(body).swap16()])]
  ]){
    put(name,bytes);
    const result=readFile(root,{relative_path:name});
    assert.equal(result.content,"L1: one\nL2: 二");
    assert.equal(result.size_bytes,bytes.length);
    assert.equal(result.sha256,createHash("sha256").update(bytes).digest("hex"));
  }
  put("odd.txt",Buffer.from("fffe61","hex"));
  put("report","%PDF-1.7");
  put("looks-like-text.PDF","plain text");
  for(const file of ["odd.txt","report","looks-like-text.PDF"]) {
    assert.throws(()=>readFile(root,{relative_path:file}),{message:"binary_file"});
  }
  put("hard.txt","secret");
  fs.linkSync(path.join(root,"hard.txt"),path.join(root,"alias.txt"));
  assert.throws(()=>readFile(root,{relative_path:"alias.txt"}),{message:"hardlink_not_allowed"});
  if(process.platform!=="win32"){
    execFileSync("mkfifo",[path.join(root,"pipe")]);
    assert.throws(()=>readFile(root,{relative_path:"pipe"}),{message:"not_regular_file"});
    assert.ok(listFiles(root,{}).entries.every(entry=>entry.path!=="pipe"));
  }
  put("Case.txt","a");put("case.txt","b");
  const expanded=attachments(root,"[[ATTACH_FILE: Case.txt]]\n[[ATTACH_FILE: case.txt]]");
  assert.equal(expanded.length,process.platform==="win32"?1:2);
});

test("directory listing skips sensitive names, links and special files with bounded scan and response",t => {
  const {home}=fixture(t);
  const root=path.join(fs.realpathSync.native(home),"repo");
  fs.mkdirSync(root);
  for(const dir of ["src","src/deep",".git","node_modules",".codex"])fs.mkdirSync(path.join(root,dir));
  for(const file of ["src/a.TS","src/deep/b.ts",".git/config","node_modules/hidden",".codex/auth.json",".Env","private.p12","hard"]){
    fs.writeFileSync(path.join(root,file),"abc");
  }
  fs.linkSync(path.join(root,"hard"),path.join(root,"also-hard"));
  fs.symlinkSync(home,path.join(root,"outside"),"junction");
  fs.symlinkSync(path.join(root,"src"),path.join(root,"inside"),"junction");
  const full=listFiles(root,{});
  assert.deepEqual(full.entries.map(e=>e.path).sort(),[".codex","src","src/a.TS","src/deep","src/deep/b.ts"]);
  assert.deepEqual(listFiles(root,{subdir:"src",max_depth:1,filter:".ts"}).entries,
    [{path:"src/a.TS",type:"file",size_bytes:3}]);
  for(const subdir of [".git","node_modules","..","outside","inside"])assert.throws(()=>listFiles(root,{subdir}));
  assert.equal(listFiles(root,{limit:1}).truncated,true);

  const long="界".repeat(60);
  fs.mkdirSync(path.join(root,long));
  for(let n=0;n<300;n++)fs.writeFileSync(path.join(root,long,"档".repeat(90)+n),"");
  const sized=listFiles(root,{subdir:long,limit:300});
  assert.equal(sized.truncated,true);
  assert.ok(sized.entries.length<300);
  assert.ok(Buffer.byteLength(JSON.stringify({content:[{type:"text",text:JSON.stringify(sized)}]}))<126*1024);

  const many=path.join(root,"many");
  fs.mkdirSync(many);
  for(let n=0;n<5001;n++)fs.writeFileSync(path.join(many,".env."+n),"");
  assert.deepEqual(listFiles(root,{subdir:"many",filter:"absent"}),{entries:[],truncated:true});
});

test("local images require supported signatures, regular files and contained relative paths",t => {
  const {home}=fixture(t);
  const root=path.join(fs.realpathSync.native(home),"repo");
  fs.mkdirSync(root);
  const valid={
    "a.PNG":png,"b.jpg":Buffer.from("ffd8ff","hex"),"c.gif":Buffer.from("GIF89a"),
    "d.webp":Buffer.from("RIFF0000WEBP")
  };
  for(const [name,body] of Object.entries(valid))fs.writeFileSync(path.join(root,name),body);
  assert.equal(resolveLocalImages(root,Object.keys(valid)).length,4);
  assert.throws(()=>resolveLocalImages(root,[...Object.keys(valid),"a.PNG"]),{message:"too_many_images"});
  fs.writeFileSync(path.join(home,"outside.png"),png);
  fs.symlinkSync(home,path.join(root,"external"),"junction");
  fs.mkdirSync(path.join(root,".git"));
  fs.writeFileSync(path.join(root,".git","sensitive.png"),png);
  fs.writeFileSync(path.join(root,"bad.jpg"),png);
  fs.writeFileSync(path.join(root,"large.png"),png);
  fs.truncateSync(path.join(root,"large.png"),10*1024*1024+1);
  fs.linkSync(path.join(root,"a.PNG"),path.join(root,"link.png"));
  for(const [name,message] of [
    ["../outside.png","invalid_path"],[path.join(root,"b.jpg"),"invalid_path"],
    ["external/outside.png","invalid_path"],[".git/sensitive.png","blocked_sensitive_path"],
    ["large.png","file_too_large"],["bad.jpg","invalid_image"],["link.png","hardlink_not_allowed"]
  ])assert.throws(()=>resolveLocalImages(root,[name]),{message});
});

test("images resolve in the resumed root, participate in both dedupe checks, and keep progress separate",async t => {
  const f=runtimeFixture(t);
  const [{createReviewer},{Jobs},{resetCodexServers}]=await Promise.all([
    f.module("app-server-client"),f.module("jobs"),f.module("stdio")
  ]);
  const db=new DatabaseSync(path.join(f.home,"test.sqlite"));
  const jobs=new Jobs(db,createReviewer(process.execPath));
  f.cleanups.push(async()=>{await jobs.shutdown();await resetCodexServers();db.close();});
  const file=path.join(f.target,"image.png");
  fs.writeFileSync(file,png);
  fs.writeFileSync(path.join(f.target,"other.png"),png);
  fs.writeFileSync(path.join(f.fallback,"image.png"),"invalid");
  const args={thread_id:threadId,prompt:"hold progress",local_images:["image.png"],wait_seconds:0};
  await assert.rejects(jobs.submit("review",{...args,repo:"Fallback"}),/THREAD_PROJECT_MISMATCH/);
  const first=await jobs.submit("execute",{...args,idempotency_key:"same"});
  const running=await eventually(async()=>{
    const result=await jobs.get(first.job_id);
    assert.equal(result.status,"running",JSON.stringify(result));
    return result.latest_note && result;
  });
  assert.equal(running.steps_completed,1);
  assert.equal(running.latest_note,"界".repeat(200));
  assert.equal(running.final_response,undefined);
  assert.equal(running.repo,"Target");
  assert.equal((await jobs.submit("execute",{...args,idempotency_key:"same"})).job_id,first.job_id);
  fs.writeFileSync(path.join(f.home,"finish"),"");
  const done=await jobs.get(first.job_id,5);
  assert.equal(done.final_response,"final text");
  assert.equal(done.status,"completed");
  const sent=fs.readFileSync(f.log,"utf8").trim().split("\n").map(line=>JSON.parse(line))
    .find(req=>req.method==="turn/start");
  assert.deepEqual(sent.params.input[1],{type:"localImage",path:fs.realpathSync.native(file)});
  assert.match(sent.params.input[0].text,/\[\[ATTACH_FILE: relative\/path:start-end\]\]/);
  assert.doesNotMatch(sent.params.input[0].text,/VERDICT:|COPY_PENDING|正式用户文案/);
  assert.equal((await jobs.submit("execute",{...args,wait_seconds:5})).job_id,first.job_id);
  const changed=await jobs.submit("execute",{...args,local_images:["other.png"],wait_seconds:5});
  assert.notEqual(changed.job_id,first.job_id);
  await assert.rejects(jobs.submit("execute",{...args,local_images:["other.png"],idempotency_key:"same"}),/IDEMPOTENCY_CONFLICT/);
  fs.utimesSync(file,1,1);
  await assert.rejects(jobs.submit("execute",{...args,idempotency_key:"same"}),/IDEMPOTENCY_CONFLICT/);
  const review=await jobs.submit("review",{...args,repo:"alias",wait_seconds:5});
  assert.equal(review.final_response,"final text");
  assert.equal(jobs.list(10,undefined,"alias").length,3);
});

test("execute uses automatic approval review and read-only review disables escalation on new and resumed threads",async t=>{
  const f=runtimeFixture(t);
  const {createReviewer}=await f.module("app-server-client");
  const {resetCodexServers}=await f.module("stdio");
  f.cleanups.push(resetCodexServers);
  const run=createReviewer(process.execPath);
  const expected=[];
  for(const resume of [false,true]){
    for(const mode of ["execute","review"]){
      await run({mode,repo:"Target",prompt:"test approvals",ephemeral:true,thread_id:resume?threadId:undefined});
      const policy=mode==="execute"?"on-request":"never";
      const reviewer=mode==="execute"?"auto_review":undefined;
      expected.push([resume?"thread/resume":"thread/start",policy,reviewer],["turn/start",policy,reviewer]);
    }
  }
  const requests=fs.readFileSync(f.log,"utf8").trim().split("\n").map(line=>JSON.parse(line));
  assert.deepEqual(requests.filter(r=>["thread/start","thread/resume","turn/start"].includes(r.method))
    .map(r=>[r.method,r.params.approvalPolicy,r.params.approvalsReviewer]),expected);
});

test("named tunnel uses the bridge origin and port and rejects missing or unsupported origins",async t=>{
  const f=runtimeFixture(t);
  const deploy=path.join(f.home,"deploy");
  fs.mkdirSync(deploy);
  const script=path.join(deploy,"tunnel-settings.mjs");
  fs.copyFileSync(new URL("../deploy/tunnel-settings.mjs",import.meta.url),script);
  const {spawnSync}=await import("node:child_process");
  const env={...process.env};
  delete env.PUBLIC_BASE_URL;
  delete env.PORT;
  const run=(overrides={})=>spawnSync(process.execPath,[script],{env:{...env,...overrides},encoding:"utf8"});
  assert.notEqual(run().status,0);
  fs.writeFileSync(path.join(f.home,".env"),"PUBLIC_BASE_URL=https://bridge.example.org\nPORT=19244\n");
  const result=run();
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(result.stdout),{hostname:"bridge.example.org",bridge:19244});
  for(const origin of ["http://bridge.example.org","https://bridge.example.org/path","https://bridge.example.org:8443","https://127.0.0.1"]){
    assert.notEqual(run({PUBLIC_BASE_URL:origin}).status,0);
  }
});

test("forked execution creates one named child and subsequent turns resume it",async t=>{
  const f=runtimeFixture(t);
  const {Jobs}=await f.module("jobs");
  const {createReviewer}=await f.module("app-server-client");
  const {threadManagement}=await f.module("thread-management");
  const db=new DatabaseSync(":memory:");
  const jobs=new Jobs(db,createReviewer(process.execPath),threadManagement(process.execPath).fork);
  f.cleanups.push(async()=>{await jobs.shutdown();db.close();});
  const parent=randomUUID();
  const args={repo:"Target",fork_from:{thread_id:parent,last_turn_id:"old",title:"branch"},prompt:"first",idempotency_key:"first",wait_seconds:5};
  const [first,replay]=await Promise.all([jobs.submit("execute",args),jobs.submit("execute",args)]);
  assert.equal(first.status,"completed",JSON.stringify(first));
  assert.equal(first.thread_id,threadId);
  assert.equal(first.job_id,replay.job_id);
  await assert.rejects(jobs.submit("execute",{...args,fork_from:{...args.fork_from,title:"different"}}),/IDEMPOTENCY_CONFLICT/);
  await assert.rejects(jobs.submit("execute",{...args,thread_id:parent}),/INVALID_FORK_REQUEST/);
  const invalid=await jobs.submit("execute",{...args,idempotency_key:"bad-anchor",fork_from:{...args.fork_from,last_turn_id:"missing"}});
  assert.equal(invalid.error_code,"UNKNOWN_TURN");
  const next=await jobs.submit("execute",{repo:"Target",thread_id:first.thread_id,prompt:"second",wait_seconds:5});
  assert.equal(next.status,"completed");
  assert.notEqual(next.job_id,first.job_id);
  const calls=fs.readFileSync(f.log,"utf8").trim().split("\n").map(line=>JSON.parse(line));
  const params=method=>calls.filter(x=>x.method===method).map(x=>x.params);
  assert.deepEqual(params("thread/fork").map(p=>[p.threadId,p.lastTurnId]),[[parent,"old"]]);
  assert.deepEqual(params("thread/name/set"),[{threadId,name:"[Gem][Fork] branch"}]);
  assert.deepEqual(params("turn/start").map(p=>p.threadId),[threadId,threadId]);
});

test("network access is sent on every turn and distinguishes execute requests",async t=>{
  const f=runtimeFixture(t);
  const [{Jobs},{createReviewer}]=await Promise.all([f.module("jobs"),f.module("app-server-client")]);
  const db=new DatabaseSync(path.join(f.home,"network.sqlite"));
  const jobs=new Jobs(db,createReviewer(process.execPath));
  f.cleanups.push(async()=>{await jobs.shutdown();db.close();});
  const execute={repo:"Target",thread_id:threadId,prompt:"same network prompt",wait_seconds:5};
  const disconnected=await jobs.submit("execute",{...execute,idempotency_key:"no-network"});
  const connected=await jobs.submit("execute",{...execute,network_access:true});
  assert.equal(disconnected.status,"completed");
  assert.equal(connected.status,"completed");
  assert.notEqual(disconnected.job_id,connected.job_id);
  assert.equal((await jobs.submit("execute",execute)).job_id,disconnected.job_id);
  await assert.rejects(jobs.submit("execute",{...execute,idempotency_key:"no-network",network_access:true}),/IDEMPOTENCY_CONFLICT/);
  assert.equal((await jobs.submit("execute",{...execute,prompt:"restore default"})).status,"completed");
  assert.equal((await jobs.submit("review",{...execute,network_access:true})).status,"completed");
  assert.equal((await jobs.submit("review",execute)).status,"completed");
  const policies=fs.readFileSync(f.log,"utf8").trim().split("\n").map(line=>JSON.parse(line))
    .filter(req=>req.method==="turn/start").map(req=>[req.params.sandboxPolicy.type,req.params.sandboxPolicy.networkAccess]);
  assert.deepEqual(policies,[["workspaceWrite",false],["workspaceWrite",true],["workspaceWrite",false],
    ["readOnly",true],["readOnly",false]]);
});

test("outline passes the app-server cursor and full history preserves the offset and anchor",async t=>{
  const f=runtimeFixture(t);
  const {createGetProject}=await f.module("start");
  const get=createGetProject(process.execPath);
  const args={repo:"alias",thread_id:threadId};
  const first=await get({...args,view:"outline",limit:1});
  assert.deepEqual(first.turns,[{turn_id:"new",turn_status:"completed",user_preview:"🌱".repeat(140),assistant_preview:"A".repeat(140)}]);
  assert.equal(first.next_cursor,"older");
  const second=await get({...args,view:"outline",limit:1,cursor:first.next_cursor});
  assert.equal(second.turns[0].turn_id,"old");
  assert.equal(second.next_cursor,null);
  const pages=[];
  let offset=0,anchor;
  for(let n=0;n<5 && offset!==null;n++){
    const result=await get({...args,offset,last_turns:1,anchor_turn_id:anchor});
    anchor=result.anchor_turn_id;
    assert.equal(anchor,"new");
    pages.push(...result.messages.map(message=>message.text));
    if(result.next_offset!==null)assert.ok(result.next_offset>offset);
    offset=result.next_offset;
  }
  assert.equal(offset,null);
  assert.equal(pages.join(""),"🌱".repeat(180)+"progress"+"A".repeat(8000)+"\n\n"+"🌱".repeat(3400));
  assert.equal(pages[2],"A".repeat(8000)+"\n\n");
});

test("MCP describes every parameter and caps submit and result waits independently",async t=>{
  const f=runtimeFixture(t);
  const {createApp}=await f.module("mcp");
  const db=new DatabaseSync(path.join(f.home,"api.sqlite"));
  const base="https://fixture.example", access=randomUUID(), grantId=randomUUID();
  const app=createApp(db,base,async()=>({thread_id:threadId,final_response:"ok",truncated:false}),
    async()=>({}),async()=>({}),{});
  db.prepare("INSERT INTO grants VALUES(?,?,?,?)")
    .run(grantId,"client",null,Math.floor(Date.now()/1000)+60);
  db.prepare("INSERT INTO m1_grants VALUES(?)").run(grantId);
  db.prepare("INSERT INTO access VALUES(?,?,?,?)").run(
    createHash("sha256").update(access).digest("base64url"),grantId,base+"/mcp/v1",Math.floor(Date.now()/1000)+60
  );
  const server=app.listen(0,"127.0.0.1");
  f.cleanups.push(async()=>{
    await new Promise(resolve=>server.close(resolve));
    await app.locals.jobs.shutdown();
    db.close();
  });
  await once(server,"listening");
  const rpc=async(method,params)=>{
    const response=await fetch("http://127.0.0.1:"+server.address().port+"/mcp/v1",{
      method:"POST",
      headers:{"content-type":"application/json",accept:"application/json, text/event-stream",
        authorization:"Bearer "+access,"mcp-protocol-version":"2025-11-25"},
      body:JSON.stringify({jsonrpc:"2.0",id:1,method,params})
    });
    assert.equal(response.status,200);
    return response.json();
  };
  const {result:{tools}}=await rpc("tools/list",{});
  assert.equal(tools.length,13);
  for(const {name,inputSchema} of tools){
    assert.equal(inputSchema.type,"object");
    assert.ok(Object.keys(inputSchema.properties).length);
    for(const [key,property] of Object.entries(inputSchema.properties))assert.ok(property.description,name+"."+key);
  }
  const schema=name=>tools.find(tool=>tool.name===name).inputSchema.properties;
  assert.equal(schema("codex_review").wait_seconds.maximum,25);
  assert.equal(schema("codex_execute").wait_seconds.maximum,25);
  assert.equal(schema("codex_get_result").wait_seconds.maximum,50);
  assert.equal(schema("codex_get_result").wait_seconds.default,20);
  assert.equal(schema("codex_review").network_access.default,false);
  assert.equal(schema("codex_execute").network_access.default,false);
  const call=(name,args)=>rpc("tools/call",{name,arguments:args});
  for(const name of ["codex_review","codex_execute"]){
    const rejected=await call(name,{prompt:"fixture",wait_seconds:26});
    assert.ok(rejected.result?.isError || rejected.error);
  }
  const started=await call("codex_review",{prompt:"fixture",wait_seconds:25});
  const {job_id}=JSON.parse(started.result.content[0].text);
  const allowed=await call("codex_get_result",{job_id,wait_seconds:50});
  assert.equal(JSON.parse(allowed.result.content[0].text).final_response,"ok");
  const rejected=await call("codex_get_result",{job_id,wait_seconds:51});
  assert.ok(rejected.result?.isError || rejected.error);
});

test("ctl manages its verified fixture and issues codes only through the private control channel",async t=>{
  const f=runtimeFixture(t);
  const data=path.join(f.home,"managed");
  const env={...process.env,CODEX_BRIDGE_DATA_DIR:data,PORT:"0",CODEX_EXE:process.execPath,
    PUBLIC_BASE_URL:"https://fixture.example"};
  for(const key of Object.keys(env))if(/^OAUTH_STATIC_/i.test(key))delete env[key];
  const ctl=(...args)=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[path.join(f.dist,"cli-ctl.js"),...args],{cwd:f.home,env,windowsHide:true});
    let stdout="",stderr="";
    child.stdout.on("data",chunk=>{stdout+=chunk;});
    child.stderr.on("data",chunk=>{stderr+=chunk;});
    child.once("error",reject);
    child.once("close",code=>resolve({code,stdout,stderr}));
  });
  const {bridgeHealth,callInstance,readInstance}=await f.module("instance");
  f.cleanups.push(async()=>{if(readInstance(data))await ctl("stop");});
  const run=async(...args)=>{
    const result=await ctl(...args);
    assert.equal(result.code,0,result.stderr);
    return result.stdout;
  };
  assert.match(await run("start"),/Bridge running \(PID \d+\)/);
  const first=readInstance(data);
  assert.equal(await bridgeHealth(first.port),"bridge");
  assert.match(await run("status"),/healthz OK/);
  assert.notEqual((await ctl("start")).code,0);
  const origin="http://127.0.0.1:"+first.port;
  const redirect_uri="https://oauth-redirect.googleusercontent.com/a/fixture";
  const registration=await fetch(origin+"/oauth/register",{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({redirect_uris:[redirect_uri]})});
  const {client_id}=await registration.json();
  const parameters=new URLSearchParams({client_id,redirect_uri,response_type:"code",
    code_challenge_method:"S256",code_challenge:"A".repeat(43)});
  const approval=await fetch(origin+"/oauth/authorize?"+parameters);
  assert.equal(approval.status,200);
  const html=await approval.text();
  const requestId=/name="request_id" value="([A-F0-9]{12})"/.exec(html)[1];
  const publicRoute=await fetch(origin+"/approval-code/"+requestId,{method:"POST"});
  assert.equal(publicRoute.status,404);
  await assert.rejects(callInstance(data,first,{approvalRequest:"000000000000"}),/Connection request unavailable/);
  const code=await callInstance(data,first,{approvalRequest:requestId});
  assert.match(code,/^[0-9A-HJKMNP-TV-Z]{8}$/);
  assert.equal(fs.existsSync(path.join(data,"owner-password.txt")),false);
  const logs=await run("logs","-n","50");
  assert.match(logs,/service\.log/);
  assert.equal(logs.includes(code),false);
  assert.match(await run("restart"),/Bridge running \(PID \d+\)/);
  assert.notEqual(readInstance(data).token,first.token);
  assert.match(await run("stop"),/Bridge stopped/);
  assert.equal(readInstance(data),undefined);
  assert.match(await run("status"),/Bridge is stopped/);
});

test("legacy job keys and filters remain compatible, and repo CLI recovers a stale lock",async t=>{
  const f=runtimeFixture(t);
  const {Jobs}=await f.module("jobs");
  const db=new DatabaseSync(path.join(f.home,"legacy.sqlite"));
  f.cleanups.push(()=>db.close());
  const jobs=new Jobs(db,async()=>{assert.fail("The legacy job should be found");});
  const signature=fields=>createHash("sha256").update(JSON.stringify(fields)).digest("hex");
  const real=fs.realpathSync.native(f.target);
  const key=process.platform==="win32"?real.toLowerCase():real;
  const fingerprint=signature([key,null,"old prompt"]);
  db.prepare("INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
    "legacy",null,key,"execute","completed",Date.now(),Date.now(),"legacy-key",fingerprint,
    signature([fingerprint,undefined,undefined,undefined,undefined]),'{"final_response":"old result"}'
  );
  assert.equal(jobs.list(10,undefined," Alias ")[0].job_id,"legacy");
  const args={repo:"alias",prompt:"old prompt",wait_seconds:0};
  assert.equal((await jobs.submit("execute",args)).job_id,"legacy");
  assert.equal((await jobs.submit("execute",{...args,idempotency_key:"legacy-key"})).job_id,"legacy");

  const {projectPath}=await f.module("projects");
  const env={...process.env,DEFAULT_REPO:" ALIAS "};
  assert.equal(execFileSync(process.execPath,["--input-type=module","-e",
    "import {projectPath} from "+JSON.stringify(pathToFileURL(path.join(f.dist,"projects.js")).href)+"; console.log(projectPath());"
  ],{env,encoding:"utf8"}).trim(),real);
  assert.equal(projectPath("alias"),real);
  const lock=f.repos+".lock";
  fs.writeFileSync(lock,"");fs.utimesSync(lock,1,1);
  const cli=(...args)=>execFileSync(process.execPath,[path.join(f.dist,"cli-repos.js"),...args],{encoding:"utf8"});
  cli("add"," New ",f.target);
  assert.ok(Object.hasOwn(JSON.parse(cli("list")),"New"));
  cli("remove"," NEW ");
  assert.equal(fs.existsSync(lock),false);
  assert.equal(projectPath("NEW"),undefined);
});

test("startup uses project .env and a data directory lock prevents a second recovery",async t=>{
  const f=runtimeFixture(t);
  const data=path.join(f.home,"bridge-data");
  const conflicting=path.join(f.home,"other-data");
  fs.writeFileSync(path.join(f.home,".env"),"CODEX_BRIDGE_DATA_DIR="+JSON.stringify(data.replaceAll("\\","/"))+"\n");
  fs.writeFileSync(path.join(f.target,".env"),"CODEX_BRIDGE_DATA_DIR="+JSON.stringify(conflicting.replaceAll("\\","/"))+"\n");
  const launch=()=>{
    const env={...process.env,CODEX_EXE:process.execPath,PORT:"0",PUBLIC_BASE_URL:"https://fixture.example"};
    for(const key of Object.keys(env)){
      if(/^(CODEX_BRIDGE_DATA_DIR|OAUTH_STATIC_)/i.test(key))delete env[key];
    }
    const child=spawn(process.execPath,[path.join(f.dist,"index.js")],{cwd:f.target,env,windowsHide:true});
    const closed=once(child,"close");
    let stdout="",stderr="";
    child.stdout.on("data",chunk=>{stdout+=chunk;});
    child.stderr.on("data",chunk=>{stderr+=chunk;});
    f.cleanups.push(async()=>{
      if(child.exitCode===null && child.signalCode===null)child.kill("SIGKILL");
      await closed;
    });
    return {child,closed,stdout:()=>stdout,stderr:()=>stderr};
  };
  const first=launch();
  await eventually(()=>first.stdout().includes("Listening at"));
  assert.equal(fs.existsSync(conflicting),false);
  if(process.platform!=="win32"){
    assert.equal(fs.statSync(data).mode&0o777,0o700);
    assert.equal(fs.statSync(path.join(data,"bridge-instance.json")).mode&0o777,0o600);
  }
  const db=new DatabaseSync(path.join(data,"oauth.sqlite"));
  f.cleanups.push(()=>db.close());
  db.prepare("INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
    "still-running",null,null,"review","running",Date.now(),null,null,null,null,"{}"
  );
  const status=()=>db.prepare("SELECT status FROM jobs WHERE id='still-running'").get().status;
  const second=launch();
  const [rejected]=await second.closed;
  assert.notEqual(rejected,0);
  assert.match(second.stderr(),/already uses this data directory/);
  assert.equal(status(),"running");
  first.child.kill("SIGKILL");
  await first.closed;
  const replacement=launch();
  await eventually(()=>replacement.stdout().includes("Listening at"));
  assert.equal(status(),"interrupted");
  replacement.child.kill("SIGTERM");
  await replacement.closed;
});

test("POSIX app-server shutdown times out and signals its owned process group",{
  skip:process.platform==="win32",timeout:10000
},async t=>{
  const f=fixture(t);
  const {withAppServer}=await import("../dist/stdio.js");
  fs.writeFileSync(path.join(f.home,"app-server"),String.raw`
    import {spawn} from "node:child_process";
    import {writeFileSync} from "node:fs";
    process.on("SIGTERM",()=>writeFileSync("parent-term",""));
    spawn(process.execPath,["-e",'process.on("SIGTERM",()=>require("node:fs").writeFileSync("child-term","")); setInterval(()=>{},500);']);
    setInterval(()=>{},500);
  `);
  await assert.rejects(withAppServer(process.execPath,f.home,undefined,700,()=>assert.fail("No initialize response expected")),
    /APP_SERVER_TIMEOUT/);
  assert.ok(fs.existsSync(path.join(f.home,"parent-term")));
  assert.ok(fs.existsSync(path.join(f.home,"child-term")));
});
