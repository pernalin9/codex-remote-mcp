import path from "node:path";
import { realpathSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { profiles, rules } from "./config.js";
import { directoryKey, exposedDirectory, projectCatalog, repoLabel } from "./projects.js";
import { withAppServer, type Rpc } from "./stdio.js";
import type { GetAccountResponse } from "./generated/app-server-schema/v2/GetAccountResponse";
import type { ThreadListParams } from "./generated/app-server-schema/v2/ThreadListParams";
import type { ThreadListResponse } from "./generated/app-server-schema/v2/ThreadListResponse";

import type { ThreadReadResponse } from "./generated/app-server-schema/v2/ThreadReadResponse";

import type { ThreadTurnsListResponse } from "./generated/app-server-schema/v2/ThreadTurnsListResponse";
import type { Turn } from "./generated/app-server-schema/v2/Turn";
import type { ThreadItem } from "./generated/app-server-schema/v2/ThreadItem";

interface StartInput {repo?:string;include_rules?:boolean}
type Summary = {thread_id:string;title:string|null;repo:string;status:string;updated_at:string};
const runFile = promisify(execFile);
type Project = ReturnType<typeof projectCatalog>["projects"][number];

async function recentThreads(rpc:Pick<Rpc,"request">,projects:Project[],limit:number):Promise<Summary[]> {
  if (!projects.length) return [];
  const roots = new Map<string,string>();
  const dirs = new Set<string>();
  for (const project of projects) {
    const dir=path.resolve(project.path);
    try {
      const real=realpathSync.native(dir);
      roots.set(directoryKey(real),project.name);
      dirs.add(dir);
      dirs.add(real);
      if(process.platform==="win32"){
        dirs.add(path.toNamespacedPath(dir));
        dirs.add(path.toNamespacedPath(real));
      }
    } catch {continue;}
  }
  if(!dirs.size)return [];
  const {data}=await rpc.request<ThreadListResponse>("thread/list",{
    cwd:[...dirs],sortKey:"updated_at",sortDirection:"desc",limit,useStateDbOnly:true,
    sourceKinds:["cli","vscode","exec","appServer","unknown"]
  } satisfies ThreadListParams);
  return data.flatMap(t=>{
    let repo:string|undefined;
    try{repo=roots.get(directoryKey(t.cwd));}catch{return [];}
    return repo ? [{thread_id:t.id,title:t.name?.slice(0,200) ?? null,repo,status:t.status.type,
      updated_at:new Date(t.updatedAt*1000).toISOString()}] : [];
  }).slice(0,limit);
}

type MessageItem=Extract<ThreadItem,{type:"userMessage"|"agentMessage"}>;
const messagesIn=(turn:Turn)=>turn.items.filter((item):item is MessageItem=>item.type==="userMessage" || item.type==="agentMessage");
const messageText=(item:MessageItem)=>item.type==="agentMessage" ? item.text : item.content.filter(c=>c.type==="text").map(c=>c.text).join("\n");
function preview(item:MessageItem|undefined) {
  let result="", count=0;
  if(item)for(const char of messageText(item).trim().replace(/\s+/g," ")){
    if(count++===140)break;
    result+=char;
  }
  return result;
}
function outlineTurn(turn:Turn){
  const items=messagesIn(turn);
  return {turn_id:turn.id,turn_status:turn.status,
    user_preview:preview(items.find(item=>item.type==="userMessage")),
    assistant_preview:preview(items.findLast(item=>item.type==="agentMessage" && item.phase!=="commentary") ??
      items.findLast(item=>item.type==="agentMessage"))};
}

const pageChars=10000;
function historyPage(turns:Turn[],offset:number){
  const messages:{turn_id:string;turn_status:string;role:string;text:string}[]=[];
  let position=0, end=offset, pageFull=false;
  for(const turn of turns) {
    for(const item of messagesIn(turn)) {
      const body=messageText(item), begin=Math.max(0,offset-position);
      position+=body.length;
      if(pageFull || begin>=body.length)continue;
      const remaining=pageChars-(end-offset);
      if(messages.length && body.length-begin>remaining){pageFull=true;continue;}
      const chunk=body.slice(begin,begin+remaining);
      let length=chunk.length;
      if(begin+length<body.length){
        const boundary=[...chunk.matchAll(/\r?\n\r?\n/g)].at(-1);
        if(boundary && boundary.index>length/2)length=boundary.index+boundary[0].length;
        else if(/[\uD800-\uDBFF]/.test(chunk.at(-1)??""))length--;
      }
      const text=chunk.slice(0,length);
      messages.push({turn_id:turn.id,turn_status:turn.status,role:item.type==="userMessage"?"user":"assistant",text});
      end+=text.length;
      pageFull=begin+length<body.length || messages.length>=60 || end-offset>=pageChars;
    }
  }
  return {messages,next_offset:end<position?end:null};
}

interface ProjectInput {
  repo:string;
  limit?:number;
  thread_id?:string;
  view?:"full"|"outline";
  cursor?:string;
  offset?:number;
  last_turns?:number;
  anchor_turn_id?:string;
}
export function createGetProject(executable:string) {
  return async ({repo,limit=20,thread_id,view="full",cursor,offset=0,last_turns,anchor_turn_id}:ProjectInput,signal?:AbortSignal)=>{
    const project=projectCatalog().byName.get(repoLabel(repo));
    if (!project) throw new Error("UNKNOWN_REPO");
    if ((view==="outline" && (!thread_id || offset || last_turns || anchor_turn_id)) ||
      (cursor!==undefined && view!=="outline"))throw new Error("INVALID_PROJECT_VIEW");
    const {name,aliases,note}=project;
    if (thread_id) {
      return withAppServer(executable,project.path,signal,30000,async rpc=>{
        const read=(includeTurns:boolean)=>rpc.request<ThreadReadResponse>("thread/read",{threadId:thread_id,includeTurns});
        const check=(record:ThreadReadResponse)=>{
          if (!exposedDirectory(record.thread.cwd,project.path)) throw new Error("THREAD_PROJECT_MISMATCH");
        };
        const metadata=await read(false);
        check(metadata);
        const title=metadata.thread.name?.slice(0,512)??null;
        if(view==="outline"){
          const page=await rpc.request<ThreadTurnsListResponse>("thread/turns/list",{
            threadId:thread_id,limit,sortDirection:"desc",itemsView:"full",cursor
          });
          return {name,thread_id,title,turns:page.data.map(outlineTurn),next_cursor:page.nextCursor};
        }
        const fullHistory=async()=>{
          const history=await read(true);
          check(history);
          return history.thread.turns;
        };
        let turns;
        if (last_turns && !anchor_turn_id) {
          const page=await rpc.request<ThreadTurnsListResponse>("thread/turns/list",{
            threadId:thread_id,limit:last_turns,sortDirection:"desc",itemsView:"full"
          });
          turns=page.data.reverse();
        } else {
          turns=await fullHistory();
          if (last_turns && anchor_turn_id) {
            const end=turns.findIndex(turn=>turn.id===anchor_turn_id);
            if (end<0) throw new Error("UNKNOWN_TURN");
            turns=turns.slice(Math.max(0,end+1-last_turns),end+1);
          }
        }
        return {name,thread_id,title,anchor_turn_id:last_turns?turns.at(-1)?.id:undefined,...historyPage(turns,offset)};
      });
    }
    const warnings:string[]=[];
    const recent_threads=await withAppServer(executable,process.cwd(),signal,10000,
      rpc=>recentThreads(rpc,[project],limit)).catch(()=>{warnings.push("THREAD_LIST_UNAVAILABLE");return [];});
    return {name,aliases,note,recent_threads,warnings};
  };
}
export type ProjectTool = ReturnType<typeof createGetProject>;
export function createStart(executable:string) {
  return async (input:StartInput,signal?:AbortSignal) => {
    const {projects,byName} = projectCatalog();
    const selected = input.repo === undefined ? undefined : byName.get(repoLabel(input.repo));
    if (input.repo !== undefined && !selected) throw new Error("UNKNOWN_REPO");
    const result = {
      ...(input.include_rules === false ? {} : {workflow_rules:rules()}),
      repos:projects.map(({name,aliases,note})=>({name,aliases,note})),
      profiles:profiles(),
      recent_threads:[] as Summary[],
      runtime:{
        cli_version:null as string|null,app_server:"unavailable",
        account:null as {type:string;plan?:string}|null
      },
      warnings:[] as string[]
    };
    const version = runFile(executable,["--version"],{windowsHide:true,timeout:4000,maxBuffer:4096,signal})
      .then(({stdout})=>{result.runtime.cli_version=/\bcodex-cli\s+([\w.+-]+)/.exec(stdout)?.[1] ?? null;})
      .catch(()=>{result.warnings.push("CLI_VERSION_UNAVAILABLE");});
    try {
      await withAppServer(executable,process.cwd(),signal,10000,async({request})=>{
        result.runtime.app_server="reachable";
        const account = request<GetAccountResponse>("account/read",{refreshToken:false}).then(({account:a})=>{
          result.runtime.account=a ? {type:a.type,...(a.type==="chatgpt"?{plan:a.planType}:{})} : {type:"signed_out"};
        }).catch(()=>{result.warnings.push("ACCOUNT_UNAVAILABLE");});
        result.recent_threads=await recentThreads({request},selected ? [selected] : projects,selected ? 10 : 5)
          .catch(()=>{result.warnings.push("THREAD_LIST_UNAVAILABLE");return [];});
        await account;
      });
    } catch {result.warnings.push("APP_SERVER_UNAVAILABLE");}
    await version;
    return result;
  };
}
export type StartTool = ReturnType<typeof createStart>;

