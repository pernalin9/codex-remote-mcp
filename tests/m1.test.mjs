import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import * as fs from "node:fs";
import os from "node:os";
import {fileURLToPath} from "node:url";
import path from "node:path";
import {configuredBridge} from "./config-fixture.mjs";
import {readFile,writeFile,attachments} from "../dist/file-ops.js";
const fixture=configuredBridge(test);
const {Jobs}=await fixture("jobs");
const {ReviewError}=await fixture("app-server-client");
import {RpcError} from "../dist/stdio.js";
import {queuedTurnResult} from "../dist/desktop-queue.js";

test("desktop history can temporarily report interrupted even after final text appears",()=>{
  const turn={id:"turn",status:"interrupted",completedAt:null,items:[{type:"agentMessage",text:"answer"}]};
  const delivery={thread_id:"thread",model:"model"};
  assert.equal(queuedTurnResult(turn,delivery),undefined);
  assert.throws(()=>queuedTurnResult({...turn,completedAt:100},delivery),/QUEUE_TURN_INTERRUPTED/);
  assert.equal(queuedTurnResult({...turn,status:"completed",completedAt:100},delivery).final_response,"answer");
});

test("ambiguous queue acknowledgement, service restart and duplicate submit only track the original intent",async()=>{
  const db=new DatabaseSync(":memory:");
  let sends=0,reads=0;
  const observing=Promise.withResolvers();
  const reviewer=async()=>{throw new ReviewError("writer",undefined,"THREAD_BUSY");};
  reviewer.queue={
    async submit(input,cwd,id,signal,cb){
      sends++;cb.record({client_id:id,cwd,started:Date.now(),thread_id:input.thread_id,anchor:"a",model:"model"});
      throw Error("connection lost after send");
    },
    async track(d,signal){
      reads++;
      if(reads===1){observing.resolve();await new Promise((_,rej)=>signal.addEventListener("abort",()=>rej(Error("stop")),{once:true}));}
      return {thread_id:d.thread_id,turn_id:"b",model_used:d.model,final_response:"ok",truncated:false};
    }
  };
  try{
    const jobs=new Jobs(db,reviewer);
    const input={repo:"Other",thread_id:"thread",prompt:"test",network_access:true,idempotency_key:"question",wait_seconds:0};
    const first=await jobs.submit("review",input);
    await observing.promise;
    assert.equal((await jobs.submit("review",{...input,allow_queue:true})).job_id,first.job_id);
    assert.equal((await jobs.get(first.job_id)).client_message_id,first.job_id);
    await jobs.shutdown();
    const recovered=new Jobs(db,reviewer);recovered.recover();
    const result=await recovered.get(first.job_id,2);
    assert.equal(result.final_response,"ok");assert.equal(result.delivery,"desktop_queue");
    assert.equal(reads,2);assert.equal(sends,1);
    assert.equal((await recovered.submit("review",input)).job_id,first.job_id);
    for(const overrides of [{model_override:"different"},{reasoning_effort:"high"},{allow_queue:false}]){
      const r=await recovered.submit("review",{...input,...overrides,idempotency_key:undefined,wait_seconds:1});
      assert.equal(r.error_code,"THREAD_BUSY");
    }
    assert.equal(sends,1);
  }finally{db.close();}
});

test("native desktop queue inherits settings and accepts pending and active turns",async t=>{
  const {desktopQueue}=await fixture("desktop-queue");
  const {createReviewer}=await fixture("app-server-client");
  const {projectPath}=await fixture("projects");
  const {resetCodexServers}=await fixture("stdio");
  const cwd=projectPath("Other"),other=projectPath("Picsort");
  const home=fs.mkdtempSync(path.join(cwd,"queue-home-"));
  const sessions=path.join(home,"sessions");
  fs.mkdirSync(sessions);
  const previous=process.env.CODEX_HOME;
  process.env.CODEX_HOME=home;
  t.after(async()=>{
    await resetCodexServers();
    if(previous===undefined)delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME=previous;
  });

  function desktopFixture(){
    createInterface({input:process.stdin}).on("line",line=>{
      const {id,method,params}=JSON.parse(line);
      if(id===undefined)return;
      const {thread,latest}=JSON.parse(fs.readFileSync("queue-state.json","utf8"));
      const send=result=>console.log(JSON.stringify({id,result}));
      switch(method){
        case "thread/read": return send({thread});
        case "thread/resume": return send({thread,cwd:thread.cwd,sandbox:{type:"workspaceWrite"}});
        case "thread/queue/list": return send({data:[{id:"pending"}]});
        case "thread/queue/add":
          fs.writeFileSync("queue-client",params.clientUserMessageId);
          return send({});
        case "thread/turns/list":
          if(params.limit===1)return send({data:latest?[latest]:[],nextCursor:null});
          if(!params.cursor)return send({data:[{id:"",items:[]}],nextCursor:"older"});
          return send({data:[{id:"queued-turn",status:"completed",items:[
            {type:"userMessage",clientId:fs.readFileSync("queue-client","utf8")},{type:"agentMessage",text:"done"}
          ]}],nextCursor:null});
        default: return send({});
      }
    });
  }
  fs.writeFileSync(path.join(cwd,"app-server"),
    'import fs from "node:fs"; import {createInterface} from "node:readline"; ('+desktopFixture.toString()+')();');
  const rollout=path.join(sessions,"rollout.jsonl");
  const thread={id:"thread",cwd,path:rollout,status:{type:"active"},originator:"desktop",model:"desktop-model",reasoningEffort:"high"};
  const latest={id:"running",status:"inProgress"};
  const state=(overrides={},turn=latest)=>fs.writeFileSync(path.join(cwd,"queue-state.json"),JSON.stringify({thread:{...thread,...overrides},latest:turn}));
  const context=sandbox_policy=>JSON.stringify({payload:{sandbox_policy,permission_profile:{network:"enabled"}},type:"turn_context"})+"\n";
  const queue=desktopQueue(process.execPath);
  const signal=AbortSignal.timeout(15000);
  let records=0;
  const submit=options=>queue.submit({thread_id:thread.id,prompt:"continue",...options},cwd,"message",signal,{
    record(){records++;},phase(){}
  });

  state();
  const writable={type:"workspace-write",network_access:true,writable_roots:[other]};
  const readOnly={type:"read-only",network_access:false};
  fs.writeFileSync(rollout,context(readOnly)+context(writable));
  const delivery=await submit({mode:"execute",network_access:true});
  assert.equal(delivery.anchor,latest.id);
  assert.equal(delivery.model,thread.model);

  fs.writeFileSync(rollout,context(readOnly));
  await assert.rejects(submit({mode:"execute"}),/QUEUE_NOT_SUBMITTED/);
  fs.writeFileSync(rollout,context({...writable,network_access:false}));
  await assert.rejects(submit({mode:"review",network_access:true}),/QUEUE_NOT_SUBMITTED/);
  state({cwd:other});
  await assert.rejects(submit({mode:"review"}),/THREAD_PROJECT_MISMATCH/);
  assert.equal(records,1);

  fs.writeFileSync(rollout,context(readOnly)+context({type:"future-format"}));
  state({model:""},null);
  const noAnchor=await submit({mode:"execute",network_access:true});
  assert.equal(noAnchor.anchor,"");
  assert.equal(noAnchor.model,"fixture-model");
  assert.equal((await queue.track(noAnchor,signal,()=>{})).turn_id,"queued-turn");

  for(const file of [rollout+".zst",path.join(home,"outside.jsonl")]){
    fs.writeFileSync(file,context(readOnly));
    state({path:file});
    await submit({mode:"execute",network_access:true});
  }

  state();
  fs.writeFileSync(rollout,context(writable));
  const db=new DatabaseSync(":memory:");
  const jobs=new Jobs(db,createReviewer(process.execPath));
  try{
    const result=await jobs.submit("review",{repo:"Other",thread_id:thread.id,prompt:"review",network_access:true,wait_seconds:5});
    assert.equal(result.delivery,"desktop_queue");
    assert.equal(result.model_used,thread.model);
  }finally{
    await jobs.shutdown();
    db.close();
  }
});

test("review without an idempotency key does not reuse the execute fingerprint",async()=>{
  const db=new DatabaseSync(":memory:");
  try{
    const jobs=new Jobs(db,async input=>({thread_id:input.thread_id,final_response:input.mode,truncated:false}));
    const input={repo:"Other",thread_id:"thread",prompt:"same text"};
    const execute=await jobs.submit("execute",input);
    const review=await jobs.submit("review",input);
    assert.notEqual(review.job_id,execute.job_id);
    assert.equal(review.final_response,"review");
  }finally{
    db.close();
  }
});

test("RPC diagnostics retain method and a safe reason in job results",async()=>{
  const busy=new RpcError("thread/resume",-32600,"thread 01234567-89ab-cdef-0123-456789abcdef already has an active writer");
  const invalid=new RpcError("turn/start",-32602,"invalid params: bearer private-token\n"+"x".repeat(6000));
  assert.equal(invalid.message,"APP_SERVER_RPC -32602 turn/start: invalid params");
  const db=new DatabaseSync(":memory:");
  try {
    const jobs=new Jobs(db,async()=>{throw new ReviewError(busy.message,undefined,busy.code);});
    const result=await jobs.submit("review",{repo:"Other",prompt:"test"});
    assert.equal(result.error_code,"THREAD_BUSY");
    assert.equal(result.error,"APP_SERVER_RPC -32600 thread/resume: thread [id] already has an active writer");
  } finally { db.close(); }
});

test("bounded files, search, junction and attachment budgets",t=>{
  const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),"m1-test-")));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const put=(name,content)=>fs.writeFileSync(path.join(root,name),content);
  put("a.txt","one\ntwo\nthree\n");
  assert.equal(readFile(root,{relative_path:"a.txt",start_line:2,end_line:2}).content,"L2: two");
  assert.equal(readFile(root,{relative_path:"a.txt",search_query:"TWO",context_lines:1}).match_count,1);
  assert.ok(readFile(root,{relative_path:"a.txt",max_chars:3}).truncated);
  for(const file of [".git/config",".Env","x.pFx","key.p12","pFx-password.txt","../escape","a.txt:ads"])
    assert.throws(()=>readFile(root,{relative_path:file}));
  put("big",Buffer.alloc(5242881));assert.throws(()=>readFile(root,{relative_path:"big"}),/too_large/);
  put("binary",Buffer.from([0]));assert.throws(()=>readFile(root,{relative_path:"binary"}),/binary/);
  assert.throws(()=>writeFile(root,"../escape","x"));
  for(let i=0;i<2;i++)assert.equal(writeFile(root,"nested/a","v"+i).size_bytes,2);
  assert.throws(()=>writeFile(root,"nested/a","x",false));
  const junctionProject=path.join(root,"junction-project");
  const junctionTarget=path.join(root,"junction-target");
  fs.mkdirSync(junctionProject);
  fs.mkdirSync(junctionTarget);
  const hand=path.join(junctionProject,".ai-handoff");
  fs.symlinkSync(junctionTarget,hand,"junction");
  try {
    assert.throws(()=>writeFile(junctionProject,"x","a"),/invalid_path/);
    assert.equal(fs.existsSync(path.join(junctionTarget,"x")),false);
  } finally {fs.unlinkSync(hand);}
  put("long","A".repeat(18001));
  const marks=["a.txt","a.txt",".env","long",...Array.from({length:10},(_,i)=>"f"+i)];
  for(const f of marks.slice(4))put(f,"x");
  const expanded=attachments(root,marks.map(f=>"[[ATTACH_FILE: "+f+"]] ").join("\n"));
  assert.equal(expanded.length,9);
  assert.equal(expanded.filter(e=>e.content).length,3);
  assert.equal(expanded.find(e=>e.path===".env").skipped_reason,"blocked_sensitive_path");
  assert.equal(expanded.find(e=>e.path==="long").skipped_reason,"budget_exceeded");
});

test("durable dedupe, real-root lock, thread mutex, cancellation and orphan recovery",async()=>{
  const db=new DatabaseSync(":memory:");
  const jobs=new Jobs(db,async(a,signal)=>{await new Promise((_,reject)=>signal.addEventListener("abort",()=>reject(Error("cancelled"))));});
  const args={repo:"pic",prompt:"edit",thread_id:"existing",wait_seconds:0};
  const job=await jobs.submit("execute",args);
  assert.equal((await jobs.submit("execute",args)).job_id,job.job_id);
  await assert.rejects(jobs.submit("execute",{...args,repo:"Picsort",thread_id:"other",prompt:"x"}),/REPO_BUSY/);
  await assert.rejects(jobs.submit("review",args),/THREAD_BUSY/);
  assert.ok((await jobs.restart(false,async()=>null)).job_ids.includes(job.job_id));
  await jobs.restart(true,async()=>null);
  assert.equal((await jobs.get(job.job_id)).status,"interrupted");
  const tagged=await jobs.submit("execute",{...args,idempotency_key:"K"});
  assert.equal((await jobs.submit("execute",{...args,idempotency_key:"K"})).job_id,tagged.job_id);
  await assert.rejects(jobs.submit("execute",{...args,idempotency_key:"K",prompt:"different"}),/CONFLICT/);
  await jobs.cancel(tagged.job_id);
  db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(job.job_id);
  jobs.recover();assert.match((await jobs.get(job.job_id)).error,/部分/);db.close();
});
test("structured limits retry once, account failures stop immediately",async()=>{
  for(const [detail,expected,count] of [["rateLimitExceeded","RATE_LIMITED",2],["usageLimitExceeded","QUOTA_EXCEEDED",1],["unauthorized","AUTH_ERROR",1]]){
    const db=new DatabaseSync(":memory:");let calls=0;
    const jobs=new Jobs(db,async()=>{calls++;throw new ReviewError("CODEX_"+detail);});
    const r=await jobs.submit("review",{repo:"Other",prompt:"x"});
    assert.equal(r.error_code,expected);assert.equal(calls,count);
    if(count===1)assert.equal(r.action_required,"STOP_AND_ASK_USER");
    db.close();
  }
});

test("repo CLI add/list/remove is visible to a running project catalog",async t=>{
  const local=fs.mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)),"m1-config-"));
  t.after(()=>fs.rmSync(local,{recursive:true,force:true}));
  fs.mkdirSync(path.join(local,"config"));fs.mkdirSync(path.join(local,"dist"));
  for(const f of ["config","projects","cli-repos","local-lock"])fs.copyFileSync(new URL("../dist/"+f+".js",import.meta.url),path.join(local,"dist",f+".js"));
  const {pathToFileURL}=await import("node:url");
  const {projectPath,projectCatalog}=await import(pathToFileURL(path.join(local,"dist/projects.js")).href);
  const {execFileSync}=await import("node:child_process");
  const cli=(...a)=>execFileSync(process.execPath,[path.join(local,"dist/cli-repos.js"),...a],{encoding:"utf8"});
  assert.equal(projectCatalog().projects.length,0);
  cli("add","probe",local,"--note","fixture");
  assert.equal(projectPath("PROBE"),fs.realpathSync.native(local));
  assert.equal(JSON.parse(cli("list")).probe.note,"fixture");
  cli("remove","probe");assert.equal(projectCatalog().projects.length,0);
});
test("stdio reuses an idle process, reloads changed auth, restarts and expires idle leases",async t=>{
  const {withTurnServer,resetCodexServers}=await import("../dist/stdio.js");
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"m1-stdio-"));
  const before=process.env.CODEX_HOME,ttl=process.env.APP_SERVER_IDLE_SHUTDOWN_SEC;
  process.env.CODEX_HOME=dir;process.env.APP_SERVER_IDLE_SHUTDOWN_SEC="1";
  t.after(async()=>{
    await resetCodexServers();
    if(before===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=before;
    if(ttl===undefined)delete process.env.APP_SERVER_IDLE_SHUTDOWN_SEC;else process.env.APP_SERVER_IDLE_SHUTDOWN_SEC=ttl;
    fs.rmSync(dir,{recursive:true,force:true});
  });
  fs.writeFileSync(path.join(dir,"app-server"),'require("node:readline").createInterface({input:process.stdin}).on("line",line=>{const q=JSON.parse(line); if(q.id!==undefined) console.log(JSON.stringify({id:q.id,result:process.pid}));});');
  const pid=()=>withTurnServer(process.execPath,dir,undefined,5000,r=>r.request("probe",{}));
  const a=await pid();assert.equal(await pid(),a);
  fs.writeFileSync(path.join(dir,"auth.json"),"{}");const b=await pid();assert.notEqual(b,a);
  await resetCodexServers();const c=await pid();assert.notEqual(c,b);
  await new Promise(resolve=>setTimeout(resolve,1200));assert.notEqual(await pid(),c);
});

test("job result pages stay bound to their turn and project",async()=>{
  const db=new DatabaseSync(":memory:");
  const answer="甲".repeat(12000)+"最后一条发现";
  const jobs=new Jobs(db,async input=>{
    input.activity("turn_started","turn-1");
    return {thread_id:"thread-1",turn_id:"turn-1",final_response:answer,truncated:false};
  });
  try {
    const first=await jobs.submit("review",{repo:"pic",prompt:"review"});
    assert.equal(first.turn_id,"turn-1");
    assert.equal(first.next_offset,12000);
    const last=await jobs.get(first.job_id,0,first.next_offset);
    assert.equal(first.final_response+last.final_response,answer);
    assert.equal(last.next_offset,null);
    assert.equal(jobs.list(10,undefined,"Picsort")[0].job_id,first.job_id);
    assert.equal(jobs.list(10,undefined,"Other").length,0);
  } finally {db.close();}
});

test("temporary reviews reject resume and retry as fresh ephemeral turns",async()=>{
  const db=new DatabaseSync(":memory:");
  let attempts=0;
  const jobs=new Jobs(db,async input=>{
    assert.equal(input.thread_id,undefined);
    input.recordModel("resolved-model");
    if(++attempts===1)throw new ReviewError("CODEX_rateLimitExceeded","temporary-1");
    return {thread_id:"temporary-2",model_used:"resolved-model",final_response:"ok",truncated:false};
  });
  try {
    const args={repo:"pic",profile:"probe",prompt:"inspect",ephemeral:true};
    await assert.rejects(jobs.submit("review",{...args,thread_id:"existing"}),/EPHEMERAL_REQUIRES_NEW_REVIEW/);
    await assert.rejects(jobs.submit("execute",args),/EPHEMERAL_REQUIRES_NEW_REVIEW/);
    const result=await jobs.submit("review",args);
    assert.equal(result.final_response,"ok");
    const [job]=jobs.list(1,undefined,"pic");
    assert.equal(job.thread_action,"new_ephemeral");
    assert.equal(job.thread_id,null);
    assert.equal(job.profile,"probe");
    assert.equal(job.repo,"Picsort");
    assert.equal(job.model_used,"resolved-model");
  } finally {db.close();}
});
