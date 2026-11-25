import {threadManagement} from "../dist/thread-management.js";
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { createApp } from "../dist/mcp.js";
import { createStart, createGetProject } from "../dist/start.js";
import { bridgePort, dataDirectory, loadBridgeEnv } from "../dist/runtime.js";
import { rules } from "../dist/config.js";
import { callInstance, verifiedInstance } from "../dist/instance.js";
import { configuredBridge } from "./config-fixture.mjs";

const issuer = "https://bridge.example", resource = issuer+"/mcp/v1";
const callbacks = ["oauth-redirect","oauth-redirect-sandbox","oauth-redirect-test"].flatMap(host =>
  ["a","r"].map(p => "https://"+host+".googleusercontent.com/"+p+"/codex-personal-probe"));
const headers = {"content-type":"application/json"};
const post = (url, data, extra={})=>fetch(url,{method:"POST",headers:{...headers,...extra},body:JSON.stringify(data),redirect:"manual"});

function approvalFields(html) {
  return {
    nonce:/name="nonce" value="([^"]+)"/.exec(html)[1],
    request_id:/name="request_id" value="([A-F0-9]{12})"/.exec(html)[1]
  };
}

function liveBridgeOrigin() {
  loadBridgeEnv();
  return "http://127.0.0.1:"+bridgePort();
}

async function issueLiveCode(requestId) {
  const data=dataDirectory(), active=await verifiedInstance(data);
  assert.ok(active);
  return callInstance(data,active.entry,{approvalRequest:requestId});
}

async function link(origin, issueCode, method) {
  const {resource}=await (await fetch(origin+"/.well-known/oauth-protected-resource/mcp/v1")).json();
  const registration = await post(origin+"/oauth/register",{redirect_uris:callbacks,token_endpoint_auth_method:method});
  assert.equal(registration.status,201);
  const c = await registration.json();
  const credentials = method === "client_secret_post" ? {client_id:c.client_id,client_secret:c.client_secret}
    : method === "none" ? {client_id:c.client_id} : {};
  const auth = method === "client_secret_basic" ? {authorization:"Basic "+Buffer.from(c.client_id+":"+c.client_secret).toString("base64")} : {};
  const challenge = randomBytes(32).toString("base64url"), state = "s".repeat(4096);
  const params = new URLSearchParams({client_id:c.client_id,redirect_uri:callbacks[0],response_type:"code",resource,state,
    code_challenge_method:"S256",code_challenge:createHash("sha256").update(challenge).digest("base64url")});
  const page = await fetch(origin+"/oauth/authorize?"+params);
  assert.equal(page.status,200);
  const fields = approvalFields(await page.text());
  const cookie = page.headers.get("set-cookie").split(";")[0];
  const approval_code=await issueCode(fields.request_id);
  assert.match(approval_code,/^[0-9A-HJKMNP-TV-Z]{8}$/);
  const approved = await post(origin+"/oauth/authorize",{...fields,approval_code},{cookie});
  assert.equal(approved.status,200);
  assert.equal(approved.headers.get("cache-control"),"no-store");
  const html = await approved.text();
  const automatic = /http-equiv="refresh" content="0;url=([^"]+)"/.exec(html)[1];
  const manual = /<a href="([^"]+)"/.exec(html)[1];
  assert.equal(manual,automatic);
  const location = new URL(manual.replaceAll("&amp;","&"));
  assert.equal(location.origin + location.pathname,callbacks[0]);
  assert.equal(location.searchParams.get("state"),state);
  const tokenCall = (grant)=>post(origin+"/oauth/token",{...credentials,...grant},auth);
  const grant = {grant_type:"authorization_code",code:location.searchParams.get("code"),code_verifier:challenge,redirect_uri:callbacks[0],resource};
  assert.equal((await tokenCall({...grant,resource:issuer+"/x"})).status,400);
  assert.equal((await tokenCall({...grant,code_verifier:"b".repeat(43)})).status,400);
  const response = await tokenCall(grant);
  assert.equal(response.status,200);
  const tokens = await response.json();
  assert.equal((await tokenCall(grant)).status,400);
  return {tokens,tokenCall,revoke:token=>post(origin+"/oauth/revoke",{...credentials,token},auth)};
}
async function rpc(origin,token,method,params,id=1) {
  const r = await post(origin+"/mcp/v1",{jsonrpc:"2.0",id,method,params},{
    accept:"application/json, text/event-stream",authorization:"Bearer "+token,"mcp-protocol-version":"2025-11-25"});
  assert.equal(r.status,200);
  const payload = await r.json();
  assert.equal(payload.error,undefined);
  return payload.result;
}

test("M0 OAuth discovery, Google callbacks, client authentication, revocation and MCP",async(t)=>{
  const fixture=configuredBridge(t);
  const {createApp}=await fixture("mcp");
  const {createStart,createGetProject}=await fixture("start");
  const db = new DatabaseSync(":memory:");
  const app = createApp(db,issuer,async()=>({thread_id:"test",final_response:"ok",truncated:false}),createStart(process.execPath),createGetProject(process.execPath),threadManagement(process.execPath));
  const server = app.listen(0,"127.0.0.1"); await once(server,"listening");
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();});
  const origin = "http://127.0.0.1:"+server.address().port;
  assert.equal((await (await fetch(origin+"/.well-known/oauth-protected-resource/mcp/v1")).json()).resource,resource);
  assert.equal((await (await fetch(origin+"/.well-known/oauth-authorization-server")).json()).issuer,issuer);
  assert.equal((await fetch(origin+"/mcp/v1")).status,405);
  const blocked = await post(origin+"/mcp/v1",{});
  assert.equal(blocked.status,401); assert.match(blocked.headers.get("www-authenticate"),/resource_metadata=/);
  assert.equal((await post(origin+"/oauth/register",{redirect_uris:[callbacks[0]+"/unexpected"]})).status,400);
  for (const method of ["none","client_secret_basic","client_secret_post"]) {
    const {tokens,tokenCall,revoke} = await link(origin,app.locals.issueApprovalCode,method);
    const init=await rpc(origin,tokens.access_token,"initialize",{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"probe",version:"1"}});
    assert.equal(init.protocolVersion,"2025-11-25");
    assert.equal(init.serverInfo.version,"0.2.0");
    assert.ok(init.instructions.includes("[Codex]"));
    assert.equal(init.serverInfo.icons[0].src,issuer+"/codex-remote.png");
    const image=await fetch(origin+"/codex-remote.png");
    assert.equal(image.headers.get("content-type"),"image/png");
    assert.equal(Buffer.from(await image.arrayBuffer()).readUInt32BE(16),512);
    const tools = await rpc(origin,tokens.access_token,"tools/list",{});
    assert.deepEqual(tools.tools.map(t=>t.name).sort(),["codex_cancel_task","codex_execute","codex_fork","codex_get_project","codex_get_result","codex_list_jobs","codex_rename_thread","codex_restart_server","codex_review","codex_start","repo_list_files","repo_read_file","repo_write_file"]);
    for (const tool of tools.tools) assert.equal(tool.annotations.readOnlyHint,true,tool.name);
    const opening = await rpc(origin,tokens.access_token,"tools/call",{name:"codex_start",arguments:{repo:"pic",include_rules:false}});
    assert.equal(opening.isError,undefined);
    assert.equal("workflow_rules" in opening.structuredContent,false);
    assert.equal(opening.structuredContent.profiles.probe.model,"fixture-model");
    assert.equal(opening.structuredContent.profiles.probe.reasoningEffort,"medium");
    const withRules = await rpc(origin,tokens.access_token,"tools/call",{name:"codex_start",arguments:{repo:"pic"}});
    assert.equal(withRules.structuredContent.workflow_rules,"Fixture workflow rules.");
    const result = await rpc(origin,tokens.access_token,"tools/call",{name:"codex_review",arguments:{repo:"pic",prompt:"probe"}});
    assert.equal(JSON.parse(result.content[0].text).final_response,"ok");
    let latest = tokens.access_token;
    if (method === "none") assert.equal(tokens.refresh_token,undefined);
    else {
      const r = await tokenCall({grant_type:"refresh_token",refresh_token:tokens.refresh_token});
      assert.equal(r.status,200); const refreshed = await r.json();
      assert.equal(tokens.refresh_token,refreshed.refresh_token); latest = refreshed.access_token;
    }
    assert.equal((await revoke(tokens.refresh_token ?? latest)).status,200);
    for (const token of [tokens.access_token,latest]) assert.equal((await post(origin+"/mcp/v1",{},{authorization:"Bearer "+token})).status,401);
    if (tokens.refresh_token) assert.equal((await (await tokenCall({grant_type:"refresh_token",refresh_token:tokens.refresh_token})).json()).error,"invalid_grant");
  }
});

test("OAuth styles and negotiated 403 preserve the approval transaction",async t=>{
  const db=new DatabaseSync(":memory:");
  const app=createApp(db,issuer,async()=>({thread_id:"test",final_response:"ok",truncated:false}),
    createStart(process.execPath),createGetProject(process.execPath),threadManagement(process.execPath));
  const server=app.listen(0,"127.0.0.1");
  await once(server,"listening");
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();});
  const origin="http://127.0.0.1:"+server.address().port;
  const css=await fetch(origin+"/oauth/style.css");
  assert.equal(css.status,200);
  assert.match(css.headers.get("content-type"),/^text\/css\b/);
  assert.match(await css.text(),/#f3f5f8/);

  const response=await post(origin+"/oauth/register",{redirect_uris:[callbacks[0]]});
  const {client_id}=await response.json();
  const state='test & " < >';
  const query=new URLSearchParams({client_id,redirect_uri:callbacks[0],response_type:"code",state,
    code_challenge_method:"S256",code_challenge:"a".repeat(43)});
  const page=await fetch(origin+"/oauth/authorize?"+query);
  assert.equal(page.status,200);
  const csp=page.headers.get("content-security-policy");
  assert.match(csp,/style-src 'self'/);
  assert.match(csp,/img-src 'self'/);
  assert.match(csp,/form-action 'self'/);
  const cookie=page.headers.get("set-cookie").split(";")[0];
  const html=await page.text();
  for(const copy of [
    "授权连接到本地 Codex","允许 Gemini 通过本机协作桥读取项目、发起评审、执行已授权修改并管理任务。",
    "一次性授权码","让本机 Codex","npm run ctl -- copy-code ",
    "授权并继续","连接详情（系统自动处理，无需点击）"
  ])assert.ok(html.includes(copy),copy);
  const fields=approvalFields(html);
  const prompt="为连接 "+fields.request_id+" 复制授权码";
  const scriptNonce=/<script src="\/oauth\/copy\.js" nonce="([^"]+)" defer><\/script>/.exec(html)[1];
  assert.ok(csp.includes("script-src 'nonce-"+scriptNonce+"'"));
  assert.ok(html.indexOf('id="codex-prompt"')<html.indexOf('<label for="approval-code">'));
  assert.ok(html.includes('<code id="codex-prompt">'+prompt+'</code>'));
  const script=await fetch(origin+"/oauth/copy.js");
  assert.equal(script.status,200);
  assert.match(script.headers.get("content-type"),/javascript/);
  let click,copied,clipboardBlocked=false;
  const elements={
    "codex-prompt":{textContent:prompt},
    "copy-prompt":{hidden:true,addEventListener(type,callback){assert.equal(type,"click");click=callback;}},
    "copy-feedback":{textContent:""}
  };
  runInNewContext(await script.text(),{
    document:{getElementById:id=>elements[id]},
    navigator:{clipboard:{async writeText(value){if(clipboardBlocked)throw Error("clipboard blocked");copied=value;}}}
  });
  assert.equal(elements["copy-prompt"].hidden,false);
  await click();
  assert.equal(copied,prompt);
  assert.match(elements["copy-feedback"].textContent,/已复制/);
  clipboardBlocked=true;
  await click();
  assert.match(elements["copy-feedback"].textContent,/手动选中并复制/);
  const code=app.locals.issueApprovalCode(fields.request_id);
  const wrong=code[0]==="0"?"1"+code.slice(1):"0"+code.slice(1);
  for(const accept of ["application/json","*/*","text/html;q=0, */*;q=0.5","text/html;q=0.2, application/json"]){
    const denied=await post(origin+"/oauth/authorize",{...fields,approval_code:wrong},{cookie,accept});
    assert.equal(denied.status,403);
    assert.deepEqual(await denied.json(),{error:"access_denied"});
  }
  const form=value=>fetch(origin+"/oauth/authorize",{method:"POST",redirect:"manual",
    headers:{cookie,accept:"text/html,application/xhtml+xml,*/*;q=0.8"},
    body:new URLSearchParams({...fields,approval_code:value})});
  const denied=await form(wrong);
  assert.equal(denied.status,403);
  assert.match(denied.headers.get("content-type"),/^text\/html\b/);
  assert.equal(denied.headers.get("set-cookie"),null);
  const error=await denied.text();
  assert.ok(error.includes("尝试次数已用完，请在本机重新获取授权码。"));
  assert.ok(error.includes('name="nonce" value="'+fields.nonce+'"'));
  const retryScriptNonce=/<script src="\/oauth\/copy\.js" nonce="([^"]+)"/.exec(error)[1];
  assert.notEqual(retryScriptNonce,scriptNonce);
  assert.ok(denied.headers.get("content-security-policy").includes("script-src 'nonce-"+retryScriptNonce+"'"));
  assert.ok(!error.includes(wrong));
  assert.equal((await form(code)).status,403);
  const fresh=app.locals.issueApprovalCode(fields.request_id);
  const approved=await form("\uFEFF"+fresh.toLowerCase()+" \r\n");
  assert.equal(approved.status,200);
  assert.doesNotMatch(approved.headers.get("content-security-policy"),/script-src/);
  const success=await approved.text();
  for(const copy of ["授权成功，正在返回 Gemini","若页面未自动跳转，请点击下方按钮继续。","继续返回 Gemini"]){
    assert.ok(success.includes(copy),copy);
  }
  const automatic=/http-equiv="refresh" content="0;url=([^"]+)"/.exec(success)[1];
  const manual=/<a href="([^"]+)"/.exec(success)[1];
  assert.equal(manual,automatic);
  assert.equal(new URL(manual.replaceAll("&amp;","&")).searchParams.get("state"),state);
  assert.equal((await form(fresh)).status,400);
  assert.equal(app.locals.issueApprovalCode(fields.request_id),undefined);
});

test("approval codes expire and are bound to the browser and OAuth request",async t=>{
  const db=new DatabaseSync(":memory:");
  const app=createApp(db,issuer,async()=>({}),async()=>({}),async()=>({}),{});
  const server=app.listen(0,"127.0.0.1");
  await once(server,"listening");
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();});
  const origin="http://127.0.0.1:"+server.address().port;
  const registration=await post(origin+"/oauth/register",{redirect_uris:[callbacks[0]]});
  const {client_id}=await registration.json();
  const query=new URLSearchParams({client_id,redirect_uri:callbacks[0],response_type:"code",
    code_challenge_method:"S256",code_challenge:"a".repeat(43)});
  const open=async()=>{
    const page=await fetch(origin+"/oauth/authorize?"+query);
    return {fields:approvalFields(await page.text()),cookie:page.headers.get("set-cookie").split(";")[0]};
  };
  let time=Date.now();
  t.mock.method(Date,"now",()=>time);
  const first=await open(), second=await open();
  const submit=(page,approval_code,cookie=page.cookie)=>post(origin+"/oauth/authorize",{...page.fields,approval_code},{cookie});
  const code=app.locals.issueApprovalCode(first.fields.request_id);
  assert.equal((await submit(second,code)).status,403);
  assert.equal((await submit(first,code,second.cookie)).status,400);
  time+=120_000;
  assert.equal((await submit(first,code)).status,403);
  const renewed=app.locals.issueApprovalCode(first.fields.request_id);
  assert.equal((await submit(first,renewed)).status,200);
  time+=180_000;
  assert.equal(app.locals.issueApprovalCode(second.fields.request_id),undefined);
  assert.equal((await submit(second,code)).status,400);
});

test("live desktop-user bridge: new read-only thread and resume", {skip:process.env.BRIDGE_LIVE !== "1"},async()=>{
  const origin = liveBridgeOrigin();
  const {tokens,revoke} = await link(origin,issueLiveCode,"client_secret_basic");
  const run = async args=>{
    const result = await rpc(origin,tokens.access_token,"tools/call",{name:"codex_review",arguments:args});
    let value = JSON.parse(result.content[0].text);
    while(value.status==="running")value=JSON.parse((await rpc(origin,tokens.access_token,"tools/call",{name:"codex_get_result",arguments:{job_id:value.job_id}})).content[0].text);
    assert.ok(!result.isError,JSON.stringify(value));
    return value;
  };
  try {
    const opened=await rpc(origin,tokens.access_token,"tools/call",{name:"codex_start",arguments:{repo:"通用"}});
    assert.ok(!opened.isError);
    assert.deepEqual(opened.structuredContent.warnings,[]);
    assert.equal(opened.structuredContent.workflow_rules,rules());
    assert.ok(opened.structuredContent.recent_threads.every(t=>t.repo==="通用"));
    const marker = "M0-"+randomBytes(4).toString("hex");
    const first = await run({title:"M0 本机联通",profile:"probe",prompt:"记住测试词 "+marker+"。仅回复该测试词。无需调用任何工具或读取文件。"});
    assert.equal(first.title,"[Gem] M0 本机联通");
    assert.ok(first.final_response.includes(marker),"first reply should contain the marker");
    const next = await run({thread_id:first.thread_id,prompt:"仅回复上一轮的测试词。无需调用任何工具或读取文件。"});
    assert.equal(next.thread_id,first.thread_id); assert.ok(next.final_response.includes(marker),"resume should retain the marker");
    console.info("Verified live thread "+first.thread_id+"; both replies matched");
  } finally {await revoke(tokens.refresh_token);}
});

test("M1 live read/write/read on one thread", {skip:process.env.BRIDGE_LIVE!=="1",timeout:600000},async()=>{
  const origin=liveBridgeOrigin();
  const {tokens,revoke}=await link(origin,issueLiveCode,"client_secret_basic");
  const call=async(name,args)=>{
    const r=await rpc(origin,tokens.access_token,"tools/call",{name,arguments:args});
    const v=JSON.parse(r.content[0].text);
    assert.ok(!r.isError,JSON.stringify(v));return v;
  };
  const run=async(name,args)=>{
    let r=await call(name,{...args,repo:"服务维护",wait_seconds:0});
    while(r.status==="running")r=await call("codex_get_result",{job_id:r.job_id,wait_seconds:20});
    assert.equal(r.status,"completed",JSON.stringify(r));return r;
  };
  const marker="m1-"+randomBytes(8).toString("hex");
  const filename=marker+".txt", rel=".ai-handoff/"+filename;
  const disk=new URL("../../"+rel,import.meta.url);
  try{
    await call("repo_write_file",{repo:"服务维护",filename,overwrite:false,content:"// Public sandbox acceptance fixture: "+marker});
    const first=await run("codex_review",{title:"M1 权限验收",prompt:"这是我们自己刚生成的公开验收夹具，首行为测试注释。在只读轮核实文件并引用该行供 Gemini 验收自动展开：请在最终回复中原样包含以下独立行，随后给出评审结论。\n[[ATTACH_FILE: "+rel+":1-1]]"});
    assert.ok(first.attached_files.some(f=>f.content?.includes(marker)));
    const restart=await call("codex_restart_server",{});assert.equal(restart.status,"restarted");
    const thread_id=first.thread_id;
    const write=await run("codex_execute",{thread_id,prompt:"这是授权的沙箱切换测试。请实际使用文件工具将 "+rel+" 的内容替换为 "+marker+"-written，仅修改该文件。"});
    assert.equal(write.thread_id,thread_id);
    assert.equal(readFileSync(disk,"utf8").trim(),marker+"-written");
    const last=await run("codex_review",{thread_id,prompt:"测试只读沙箱，用 PowerShell 的 Set-Content 尝试一次写入 "+rel+" 为 DENIED-CHECK，无需也不得提升权限。报告此次实际命令与错误。"});
    assert.equal(last.thread_id,thread_id);
    assert.equal(readFileSync(disk,"utf8").trim(),marker+"-written");
    console.log("Read/write/read verified on "+thread_id+"; final review: "+last.final_response.slice(0,800));
  }finally{
    const fs=await import("node:fs");
    if(fs.existsSync(disk) && ["// Public sandbox acceptance fixture: "+marker,marker,marker+"-written","DENIED-CHECK"].includes(readFileSync(disk,"utf8").trim()))fs.unlinkSync(disk);
    await revoke(tokens.refresh_token);
  }
});



test("live cancellation persists an interrupted turn and releases the thread", {skip:process.env.BRIDGE_CANCEL_LIVE!=="1",timeout:180000},async()=>{
  const origin=liveBridgeOrigin();
  const {tokens,revoke}=await link(origin,issueLiveCode,"client_secret_post");
  const tool=async(name,args)=>{
    const r=await rpc(origin,tokens.access_token,"tools/call",{name,arguments:args});
    const value=JSON.parse(r.content[0].text);
    assert.ok(!r.isError,JSON.stringify(value));return value;
  };
  const repo="通用";
  try {
    let job=await tool("codex_review",{repo,profile:"probe",wait_seconds:0,title:"取消与续接验收",prompt:"请通过 shell 执行 Start-Sleep -Seconds 45，然后回答完成。"});
    const deadline=Date.now()+45000;
    while(job.status==="running" && !job.turn_id && Date.now()<deadline)
      job=await tool("codex_get_result",{job_id:job.job_id,wait_seconds:1});
    assert.ok(job.turn_id && job.thread_id);
    const listed=await tool("codex_list_jobs",{repo});
    assert.ok(listed.some(j=>j.job_id===job.job_id && j.last_activity_at));
    let stopped=await tool("codex_cancel_task",{job_id:job.job_id});
    while(stopped.status==="running") stopped=await tool("codex_get_result",{job_id:job.job_id,wait_seconds:5});
    assert.equal(stopped.status,"interrupted");
    const {withAppServer}=await import("../dist/stdio.js");
    const read=()=>withAppServer(process.env.DIAG_EXE,process.cwd(),undefined,15000,async rpc=>{
      const r=await rpc.request("thread/read",{threadId:job.thread_id,includeTurns:true});
      return r.thread.turns.find(t=>t.id===job.turn_id)?.status;
    });
    assert.equal(await read(),"interrupted");
    let next=await tool("codex_review",{repo,thread_id:job.thread_id,profile:"probe",prompt:"仅回复 resumed，不使用工具。",wait_seconds:10});
    while(next.status==="running")next=await tool("codex_get_result",{job_id:next.job_id,wait_seconds:10});
    assert.equal(next.status,"completed",JSON.stringify(next));
    const tail=await tool("codex_get_project",{repo,thread_id:job.thread_id,last_turns:1});
    assert.equal(tail.anchor_turn_id,next.turn_id);
    assert.ok(tail.messages.some(m=>m.role==="assistant" && m.text.includes("resumed")));
    assert.ok(tail.messages.every(m=>m.turn_id===next.turn_id));
    console.log("Verified interrupted turn, resumed thread and latest-turn history",job.thread_id);
  } finally {await revoke(tokens.refresh_token);}
});

test("live ephemeral probe returns a job result without a persistent thread", {skip:process.env.BRIDGE_EPHEMERAL_LIVE!=="1",timeout:150000},async()=>{
  const origin=liveBridgeOrigin();
  const directory=dataDirectory();
  const {tokens,revoke}=await link(origin,issueLiveCode,"client_secret_post");
  const call=async(name,args)=>{
    const r=await rpc(origin,tokens.access_token,"tools/call",{name,arguments:args});
    assert.ok(!r.isError,JSON.stringify(r.content));return JSON.parse(r.content[0].text);
  };
  try{
    const repo="通用";
    let job=await call("codex_review",{repo,profile:"probe",ephemeral:true,prompt:"请只回复 ephemeral-ok，不调用工具。",wait_seconds:0});
    while(job.status==="running")job=await call("codex_get_result",{job_id:job.job_id,wait_seconds:10});
    assert.equal(job.status,"completed",JSON.stringify(job));
    assert.equal(job.thread_id,null);
    assert.ok(job.final_response.includes("ephemeral-ok"));
    const row=(await call("codex_list_jobs",{repo})).find(j=>j.job_id===job.job_id);
    assert.equal(row.thread_action,"new_ephemeral");assert.equal(row.repo,repo);assert.equal(row.profile,"probe");assert.ok(row.model_used);
    const db=new DatabaseSync(path.join(directory,"oauth.sqlite"),{readOnly:true});
    let id;try{id=db.prepare("SELECT thread FROM jobs WHERE id=?").get(job.job_id).thread;}finally{db.close();}
    assert.ok(id);
    const listed=await call("codex_get_project",{repo,limit:50});
    assert.deepEqual(listed.warnings,[]);assert.ok(listed.recent_threads.every(t=>t.thread_id!==id));
    const state=new DatabaseSync(path.join(process.env.CODEX_HOME??path.join(process.env.USERPROFILE,".codex"),"state_5.sqlite"),{readOnly:true});
    try{assert.equal(state.prepare("SELECT id FROM threads WHERE id=?").get(id),undefined);}finally{state.close();}
    console.log("Verified ephemeral result, job metadata, project list and desktop thread index",job.job_id);
  }finally{await revoke(tokens.refresh_token);}
});

test("live occupied parent forks through a completed turn, renames and resumes", {skip:process.env.BRIDGE_FORK_LIVE!=="1",timeout:200000},async()=>{
  const origin=liveBridgeOrigin();
  const {tokens,revoke}=await link(origin,issueLiveCode,"client_secret_post");
  const {withAppServer}=await import("../dist/stdio.js");
  const call=async(name,args)=>{
    const r=await rpc(origin,tokens.access_token,"tools/call",{name,arguments:args});
    const v=JSON.parse(r.content[0].text);assert.ok(!r.isError,JSON.stringify(v));return v;
  };
  try {
    const parent=process.env.BRIDGE_FORK_PARENT;assert.ok(parent);
    await withAppServer(process.env.DIAG_EXE,process.cwd(),undefined,150000,async owner=>{
      const {thread}=await owner.request("thread/read",{threadId:parent,includeTurns:true});
      const {projectCatalog}=await import("../dist/projects.js");
      const normalize=p=>path.toNamespacedPath(path.resolve(p)).toLowerCase();
      const repo=projectCatalog().projects.find(p=>normalize(p.path)===normalize(thread.cwd)).name;
      const pivot=thread.turns.find(t=>t.status==="completed");
      assert.equal(pivot.status,"completed");assert.ok(thread.turns.length>1);
      // The selected parent is already owned by the desktop app.
      const busy=await call("codex_review",{repo,thread_id:parent,profile:"probe",prompt:"只回复 ok。"});
      assert.equal(busy.error_code,"THREAD_BUSY");
      const branch=await call("codex_fork",{repo,thread_id:parent,last_turn_id:pivot.id,title:"指定轮次分叉验收"});
      assert.notEqual(branch.thread_id,parent);assert.equal(branch.title,"[Gem][Fork] 指定轮次分叉验收");
      const read=async()=> (await owner.request("thread/read",{threadId:branch.thread_id,includeTurns:true})).thread;
      const initial=await read();
      assert.equal(initial.turns.length,1);
      const texts=t=>t.items.filter(i=>i.type==="userMessage").map(i=>i.content);
      assert.deepEqual(texts(initial.turns[0]),texts(pivot));
      await call("codex_rename_thread",{repo,thread_id:branch.thread_id,title:"分叉续接验收"});
      assert.equal((await read()).name,"[Gem][Fork] 分叉续接验收");
      let job=await call("codex_review",{repo,thread_id:branch.thread_id,profile:"probe",prompt:"仅回复 fork-ok。",wait_seconds:10});
      while(job.status==="running")job=await call("codex_get_result",{job_id:job.job_id,wait_seconds:10});
      assert.equal(job.status,"completed",JSON.stringify(job));assert.ok(job.final_response.includes("fork-ok"));
      assert.equal((await read()).turns.length,2);
      assert.equal((await owner.request("thread/read",{threadId:parent,includeTurns:true})).thread.turns.length,thread.turns.length);
      console.log("Verified busy parent, inclusive fork, persistent title and child continuation",branch.thread_id);
    });
  }finally{await revoke(tokens.refresh_token);}
});
