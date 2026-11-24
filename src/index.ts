import path from "node:path";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "./mcp.js";
import { createReviewer } from "./app-server-client.js";
import { createStart, createGetProject } from "./start.js";
import { threadManagement } from "./thread-management.js";
import { bridgePort, codexExecutable, dataDirectory, loadBridgeEnv, lockDataDirectory, publicOrigin } from "./runtime.js";
import { publishInstance } from "./instance.js";

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
const release = lockDataDirectory(data);
try {
  const db = new DatabaseSync(path.join(data,"oauth.sqlite"));
  try {
    const app = createApp(db,base,createReviewer(exe),createStart(exe),createGetProject(exe),threadManagement(exe));
    const server = app.listen(port,"127.0.0.1");
    const stopping=Promise.withResolvers<void>();
    const shutdown=()=>stopping.resolve();
    process.on("SIGTERM",shutdown);
    process.on("SIGINT",shutdown);
    let unpublish:(()=>Promise<void>)|undefined;
    try {
      await once(server,"listening");
      app.locals.jobs.recover();
      const address=server.address();
      if(!address || typeof address==="string")throw new Error("Missing loopback listener.");
      unpublish=await publishInstance(data,address.port,app.locals.issueApprovalCode,shutdown);
      console.info("Listening at 127.0.0.1:"+address.port);
      await stopping.promise;
    } finally {
      process.off("SIGTERM",shutdown);
      process.off("SIGINT",shutdown);
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
