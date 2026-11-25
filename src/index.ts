import path from "node:path";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "./mcp.js";
import { createReviewer } from "./app-server-client.js";
import { createStart, createGetProject } from "./start.js";
import { threadManagement } from "./thread-management.js";
import { bridgePort, codexExecutable, dataDirectory, loadBridgeEnv, lockDataDirectory, publicOrigin } from "./runtime.js";
import { publishInstance } from "./instance.js";
import { bridgeRestartOperations, checkPreflight } from "./bridge-restart.js";

const preflight=process.argv[2]==="--preflight";
if(preflight && (process.env.PORT!=="0" || !process.env.CODEX_BRIDGE_DATA_DIR ||
  !path.basename(process.env.CODEX_BRIDGE_DATA_DIR).startsWith("codex-bridge-preflight-"))){
  throw new Error("Preflight requires a private temporary instance and PORT=0.");
}
loadBridgeEnv();
if (process.platform === "win32" && process.env.USERNAME?.toUpperCase() === "SYSTEM") {
  throw new Error("Start as the signed-in Windows desktop user.");
}
if (process.platform !== "win32" && process.geteuid?.() === 0) {
  console.warn("Run the bridge under the account that owns the Codex installation and projects.");
}

const data = dataDirectory();
const exe = codexExecutable();
const base = publicOrigin();
const port = bridgePort();
const preflightStop=new AbortController();
if(preflight){
  process.stdin.once("end",()=>preflightStop.abort());
  process.stdin.resume();
  try {await checkPreflight(exe,preflightStop.signal);}
  catch(error){process.stdin.destroy();throw error;}
}
const release = lockDataDirectory(data);
try {
  const db = new DatabaseSync(path.join(data,"oauth.sqlite"));
  try {
    const app = createApp(db,base,createReviewer(exe),createStart(exe),createGetProject(exe),threadManagement(exe),
      preflight?undefined:bridgeRestartOperations(data));
    const server = app.listen(port,"127.0.0.1");
    const stopping=Promise.withResolvers<void>();
    const shutdown=()=>stopping.resolve();
    process.on("SIGTERM",shutdown);
    process.on("SIGINT",shutdown);
    if(preflight){
      preflightStop.signal.addEventListener("abort",shutdown,{once:true});
      if(preflightStop.signal.aborted)shutdown();
    }
    let unpublish:(()=>Promise<void>)|undefined;
    try {
      await once(server,"listening");
      if(!preflight)app.locals.jobs.recover();
      const address=server.address();
      if(!address || typeof address==="string")throw new Error("Missing loopback listener.");
      unpublish=await publishInstance(data,address.port,app.locals.issueApprovalCode,shutdown);
      console.info("Listening at 127.0.0.1:"+address.port);
      await stopping.promise;
    } finally {
      process.off("SIGTERM",shutdown);
      process.off("SIGINT",shutdown);
      if(preflight){
        preflightStop.signal.removeEventListener("abort",shutdown);
        process.stdin.destroy();
      }
      if(server.listening){
        const closed=new Promise<void>(resolve=>server.close(()=>resolve()));
        server.closeAllConnections();
        await closed;
      }
      try {await app.locals.jobs.shutdown();}
      finally {await unpublish?.();}
    }
  } finally { db.close(); }
} finally { release(); }
