import { exposedDirectory, projectPath } from "./projects.js";
import { withAppServer, type Rpc } from "./stdio.js";
import type { ThreadReadResponse } from "./generated/app-server-schema/v2/ThreadReadResponse";
import type { ThreadForkResponse } from "./generated/app-server-schema/v2/ThreadForkResponse";
import type { ThreadForkParams } from "./generated/app-server-schema/v2/ThreadForkParams";
import type { ThreadTurnsListResponse } from "./generated/app-server-schema/v2/ThreadTurnsListResponse";

type Target={repo:string;thread_id:string};
type ForkSandbox=NonNullable<ThreadForkParams["sandbox"]>;
const sandboxType={
  "read-only":"readOnly","workspace-write":"workspaceWrite","danger-full-access":"dangerFullAccess"
} satisfies Record<ForkSandbox,ThreadForkResponse["sandbox"]["type"]>;
function projectRoot(repo:string) {
  const cwd=projectPath(repo);
  if(!cwd) throw new Error("UNKNOWN_REPO");
  return cwd;
}
async function verifiedThread(rpc:Rpc,id:string,cwd:string) {
  const {thread}=await rpc.request<ThreadReadResponse>("thread/read",{threadId:id,includeTurns:false});
  if(!exposedDirectory(thread.cwd,cwd)) throw new Error("THREAD_PROJECT_MISMATCH");
  return thread;
}
function branchTitle(title:string) {
  const name=title.replace(/^(?:\[(?:gem|gemini|fork)\]\s*)+/i,"").trim();
  return "[Gem][Fork] "+(name||"分支");
}
export function threadManagement(exe:string) {
  return {
    fork(input:Target & {last_turn_id:string;title:string;sandbox?:ForkSandbox},signal?:AbortSignal,onCreated?:(threadId:string)=>void) {
      const cwd=projectRoot(input.repo);
      return withAppServer(exe,cwd,signal,30000,async rpc=>{
        await verifiedThread(rpc,input.thread_id,cwd);
        let cursor:string|null=null;
        for (;;) {
          const page:ThreadTurnsListResponse=await rpc.request("thread/turns/list",{
            threadId:input.thread_id,limit:50,sortDirection:"desc",itemsView:"summary",cursor
          });
          const anchor=page.data.find(t=>t.id===input.last_turn_id);
          if(anchor) {
            if(anchor.status!=="completed") throw new Error("FORK_ANCHOR_NOT_COMPLETED");
            break;
          }
          if(!page.nextCursor) throw new Error("UNKNOWN_TURN");
          cursor=page.nextCursor;
        }
        const sandbox=input.sandbox??"read-only";
        const approvals=sandbox==="read-only"
          ? {approvalPolicy:"never"} as const
          : {approvalPolicy:"on-request",approvalsReviewer:"auto_review"} as const;
        const fork=await rpc.request<ThreadForkResponse>("thread/fork",{
          threadId:input.thread_id,lastTurnId:input.last_turn_id,cwd,excludeTurns:true,ephemeral:false,
          sandbox,...approvals,config:{web_search:"cached"}
        } satisfies ThreadForkParams);
        const {thread}=fork;
        if(!exposedDirectory(thread.cwd,cwd) || (fork.cwd && !exposedDirectory(fork.cwd,cwd))){
          throw new Error("THREAD_PROJECT_MISMATCH");
        }
        if(fork.sandbox?.type!==sandboxType[sandbox])throw new Error("THREAD_SANDBOX_MISMATCH");
        const result={parent_thread_id:input.thread_id,last_turn_id:input.last_turn_id,thread_id:thread.id};
        onCreated?.(thread.id);
        const title=branchTitle(input.title);
        try {
          await rpc.request("thread/name/set",{threadId:thread.id,name:title});
          return {...result,title};
        } catch {
          return {...result,title:thread.name,warning:"FORK_CREATED_RENAME_REQUIRED"};
        }
      });
    },
    rename(input:Target & {title:string},signal?:AbortSignal) {
      const cwd=projectRoot(input.repo);
      return withAppServer(exe,cwd,signal,15000,async rpc=>{
        const thread=await verifiedThread(rpc,input.thread_id,cwd);
        const title=thread.forkedFromId || thread.name?.startsWith("[Gem][Fork] ") ? branchTitle(input.title) : input.title;
        await rpc.request("thread/name/set",{threadId:thread.id,name:title});
        return {thread_id:thread.id,title};
      });
    }
  };
}
export type ThreadManagement=ReturnType<typeof threadManagement>;
