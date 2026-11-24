import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response } from "express";
import { z } from "zod";

const random = () => randomBytes(32).toString("base64url");
const digest = (value: string) => createHash("sha256").update(value).digest("base64url");
const same = (a: string, b: string) => timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
const approvalAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const approvalLifetime = 120_000;
const maxApprovalAttempts = 5;
const now = () => Math.floor(Date.now() / 1000);
const hosts = new Set(["oauth-redirect", "oauth-redirect-test", "oauth-redirect-sandbox"]
  .map(host => host + ".googleusercontent.com"));
const redirect = z.string().max(2048).refine(uri => {
  try {
    const u = new URL(uri);
    return hosts.has(u.hostname) && /^\/[ra]\/[A-Za-z0-9._~-]+$/.test(u.pathname)
      && u.href === "https://" + u.hostname + u.pathname && u.href === uri;
  } catch { return false; }
});
const method = z.enum(["none", "client_secret_basic", "client_secret_post"]);
const registration = z.object({redirect_uris: z.array(redirect).min(1).max(20),
  token_endpoint_auth_method: method.default("client_secret_basic")});
const authParams = z.object({ client_id: z.string(), redirect_uri: redirect, response_type: z.literal("code"),
  code_challenge_method: z.literal("S256"), code_challenge: z.string().regex(/^[\w-]{43}$/),
  state: z.string().max(16384).optional(), resource: z.string().optional(), scope: z.string().optional() });
type Client = { id: string; method: z.infer<typeof method>; secret_hash: string; uris: string };
type Grant = { id: string; client: string; refresh_hash: string | null; expires: number };
type Code = { client: string; uri: string; challenge: string; resource: string; expires: number };
function invalid(res: Response, error: string, status = 400) { res.status(status).json({error}); }

const stylesheet = fileURLToPath(new URL("../assets/oauth.css",import.meta.url));
const copyScript = fileURLToPath(new URL("../assets/oauth-copy.js",import.meta.url));
const oauthCsp = "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const escapeHtml = (text: string) => text.replaceAll("&","&amp;").replaceAll('"',"&quot;").replaceAll("<","&lt;").replaceAll(">","&gt;");

function approvalPage(title: string, content: string, head = "") {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">${head}
    <title>${title}</title><link rel="stylesheet" href="/oauth/style.css"></head>
    <body><main class="card" aria-labelledby="page-title">
      <img src="/codex-remote.png" alt="" width="48" height="48">
      <h1 id="page-title">${title}</h1>${content}
    </main></body></html>`;
}

function codePage(res: Response, status: number, nonce: string, requestId: string, redirectUri: string, message?: string) {
  const scriptNonce = random();
  res.set("Content-Security-Policy",oauthCsp+"; script-src 'nonce-"+scriptNonce+"'");
  const error = message ? '<p class="error" id="code-error" role="alert">'+escapeHtml(message)+'</p>' : "";
  return res.status(status).type("html").send(approvalPage("授权连接到本地 Codex",`
    <p class="intro">允许 Gemini 通过本机协作桥读取项目、发起评审、执行已授权修改并管理任务。</p>
    <section class="code-guide" aria-label="获取授权码">
      <p>在运行桥接的电脑上，让本机 Codex 执行这句话。</p>
      <div class="copy-prompt">
        <code id="codex-prompt">为连接 ${requestId} 复制授权码</code>
        <button class="copy-button" id="copy-prompt" type="button" hidden>复制这句话</button>
      </div>
      <p class="copy-feedback" id="copy-feedback" role="status"></p>
      <p id="code-help">Codex 复制授权码后，将它粘贴到下方。授权码最长有效 2 分钟，只能用一次。</p>
    </section>
    <form method="post" action="/oauth/authorize">
      <input type="hidden" name="nonce" value="${escapeHtml(nonce)}">
      <input type="hidden" name="request_id" value="${requestId}">
      <label for="approval-code">一次性授权码</label>
      <input type="password" id="approval-code" name="approval_code" required autocomplete="one-time-code"
        autocapitalize="characters" spellcheck="false" aria-describedby="${message ? "code-error " : ""}code-help"${message ? ' aria-invalid="true"' : ""}>
      ${error}
      <button class="action" type="submit">授权并继续</button>
    </form>
    <details><summary>用终端获取授权码</summary>
      <p>在 codex-remote-mcp 项目目录运行以下命令，授权码会复制到剪贴板。</p>
      <code>npm run ctl -- copy-code ${requestId}</code>
    </details>
    <details><summary>连接详情（系统自动处理，无需点击）</summary><code>${escapeHtml(redirectUri)}</code></details>`,
    `<script src="/oauth/copy.js" nonce="${scriptNonce}" defer></script>`));
}

function prefersHtml(req: Request) {
  return Boolean(req.get("Accept")?.split(",").some(value=>/^text\/html(?:\s*;|$)/i.test(value.trim()))) &&
    req.accepts(["application/json","text/html"]) === "text/html";
}

export function installOAuth(app: express.Express, db: DatabaseSync, base: string) {
  const resource = base + "/mcp/v1";
  const cookieName = "__Host-codex_approval";
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;");
  db.exec([
    "CREATE TABLE IF NOT EXISTS clients(id TEXT PRIMARY KEY, method TEXT, secret_hash TEXT, uris TEXT)",
    "CREATE TABLE IF NOT EXISTS codes(hash TEXT PRIMARY KEY, client TEXT, uri TEXT, challenge TEXT, resource TEXT, expires INTEGER)",
    "CREATE TABLE IF NOT EXISTS grants(id TEXT PRIMARY KEY, client TEXT, refresh_hash TEXT UNIQUE, expires INTEGER)",
    "CREATE TABLE IF NOT EXISTS access(hash TEXT PRIMARY KEY, grant_id TEXT REFERENCES grants(id) ON DELETE CASCADE, resource TEXT, expires INTEGER)"
  ].join(";"));
  db.exec("CREATE TABLE IF NOT EXISTS m1_codes(hash TEXT PRIMARY KEY REFERENCES codes(hash) ON DELETE CASCADE); CREATE TABLE IF NOT EXISTS m1_grants(id TEXT PRIMARY KEY REFERENCES grants(id) ON DELETE CASCADE)");
  const {OAUTH_STATIC_CLIENT_ID:id,OAUTH_STATIC_CLIENT_SECRET:secret,OAUTH_STATIC_REDIRECT_URIS:uris} = process.env;
  let preset:Client|undefined;
  if (id || secret || uris) {
    if (!id || !secret || !uris) throw new Error("Incomplete static OAuth client configuration");
    const metadata=registration.parse({redirect_uris:JSON.parse(uris),token_endpoint_auth_method:process.env.OAUTH_STATIC_AUTH_METHOD??"client_secret_post"});
    if (metadata.token_endpoint_auth_method==="none") throw new Error("Static OAuth client requires secret authentication");
    preset={id,secret_hash:digest(secret),method:metadata.token_endpoint_auth_method,uris:JSON.stringify(metadata.redirect_uris)};
  }
  const client = (id: string) => preset?.id===id ? preset : db.prepare("SELECT * FROM clients WHERE id=?").get(id) as Client | undefined;
  const pending = new Map<string, {
    params: z.infer<typeof authParams>;
    browserHash: string;
    expires: number;
    approval?: { hash: string; expires: number; attempts: number };
  }>();
  const approvalSecret=randomBytes(32);
  const approvalHash=(requestId:string,code:string)=>
    createHmac("sha256",approvalSecret).update(requestId).update(code).digest("base64url");
  function issueApprovalCode(requestId:string) {
    const tx=pending.get(requestId);
    const issued=Date.now();
    if(!tx || tx.expires<=issued) return;
    const code=Array.from(randomBytes(8),byte=>approvalAlphabet[byte & 31]).join("");
    tx.approval={hash:approvalHash(requestId,code),expires:Math.min(tx.expires,issued+approvalLifetime),attempts:0};
    return code;
  }
  function cleanup() {
    for (const [key, tx] of pending) if (tx.expires <= Date.now()) pending.delete(key);
    for (const table of ["codes", "access", "grants"]) db.prepare("DELETE FROM " + table + " WHERE expires<=?").run(now());
  }
  function budget(max: number) {
    let until = 0, hits = 0;
    return (_req: Request, res: Response, next: express.NextFunction) => {
      if (now() >= until) { hits = 0; until = now() + 60; }
      if (++hits > max) { res.set("Retry-After", String(until - now())); return invalid(res, "rate_limited", 429); }
      next();
    };
  }
  app.use("/oauth", (req, res, next) => {
    res.set({"Cache-Control":"no-store", "Referrer-Policy":"no-referrer","Content-Security-Policy":oauthCsp});
    if (req.path !== "/style.css" && req.path !== "/copy.js") cleanup();
    next();
  });
  app.get("/oauth/style.css", (_req,res)=>res.type("css").sendFile(stylesheet));
  app.get("/oauth/copy.js", (_req,res)=>res.type("js").sendFile(copyScript));
  app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp/v1"],
    (_req, res) => { res.json({resource, authorization_servers:[base], bearer_methods_supported:["header"],resource_logo_uri:base+"/codex-remote.png"}); });
  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({issuer:base, authorization_endpoint:base+"/oauth/authorize", token_endpoint:base+"/oauth/token",
      registration_endpoint:base+"/oauth/register", revocation_endpoint:base+"/oauth/revoke",
      response_types_supported:["code"], grant_types_supported:["authorization_code","refresh_token"],
      code_challenge_methods_supported:["S256"], token_endpoint_auth_methods_supported:method.options});
  });
  app.post("/oauth/register", budget(20), (req, res) => {
    const parsed = registration.safeParse(req.body);
    if (!parsed.success) return invalid(res, "invalid_client_metadata");
    const { token_endpoint_auth_method: auth, redirect_uris: uris } = parsed.data;
    const id = random(), secret = auth === "none" ? undefined : random();
    db.prepare("INSERT INTO clients VALUES(?,?,?,?)").run(id,auth,secret ? digest(secret) : "",JSON.stringify(uris));
    console.info("oauth registered method=" + auth);
    res.status(201).json({client_id:id, client_secret:secret, client_secret_expires_at:secret ? 0 : undefined,
      token_endpoint_auth_method:auth, redirect_uris:uris, response_types:["code"],
      grant_types:secret ? ["authorization_code","refresh_token"] : ["authorization_code"]});
  });
  app.get("/oauth/authorize", budget(60), (req, res) => {
    const parsed = authParams.safeParse(req.query);
    if (!parsed.success) return invalid(res,"invalid_request");
    const p = parsed.data, c = client(p.client_id);
    if (!c || !JSON.parse(c.uris).includes(p.redirect_uri)) return invalid(res,"invalid_request");
    if (p.resource !== undefined && p.resource !== resource) return invalid(res,"invalid_target");
    if (p.scope?.trim()) return invalid(res,"invalid_scope");
    const nonce = random(), cookie = random();
    let requestId:string;
    do {requestId=randomBytes(6).toString("hex").toUpperCase();} while(pending.has(requestId));
    pending.set(requestId,{params:p,browserHash:digest(nonce+cookie),expires:Date.now()+300_000});
    res.cookie(cookieName,cookie,{secure:true,httpOnly:true,sameSite:"lax",path:"/",maxAge:300000});
    return codePage(res,200,nonce,requestId,p.redirect_uri);
  });
  app.post("/oauth/authorize", budget(10), (req, res) => {
    const cookie = req.headers.cookie?.split(/;\s*/).find(v=>v.startsWith(cookieName+"="))?.slice(cookieName.length+1);
    const {request_id:requestId,nonce,approval_code:submitted}=req.body??{};
    const tx=typeof requestId==="string"?pending.get(requestId):undefined;
    if(!tx || typeof nonce!=="string" || !cookie || !same(digest(nonce+cookie),tx.browserHash)){
      if(prefersHtml(req))return res.status(400).type("html").send(approvalPage("授权连接到本地 Codex",
        '<p class="error" role="alert">本次连接请求已失效，请回到 Gemini 重新发起连接。</p>'));
      return invalid(res,"invalid_request");
    }
    const attempt=tx.approval;
    const codeInput=typeof submitted==="string"?submitted.trim().toUpperCase():"";
    const exhausted="尝试次数已用完，请在本机重新获取授权码。";
    let denied:string|undefined;
    if(!attempt || attempt.expires<=Date.now())denied="请在本机获取新的授权码，再粘贴到此处。";
    else if(attempt.attempts>=maxApprovalAttempts)denied=exhausted;
    else if(!/^[0-9A-HJKMNP-TV-Z]{8}$/.test(codeInput) || !same(approvalHash(requestId,codeInput),attempt.hash)){
      attempt.attempts++;
      denied=attempt.attempts>=maxApprovalAttempts?exhausted:"授权码不正确，请核对后重试。";
    }
    if(denied){
      res.vary("Accept");
      if(prefersHtml(req))return codePage(res,403,nonce,requestId,tx.params.redirect_uri,denied);
      return invalid(res,"access_denied",403);
    }
    pending.delete(requestId); res.clearCookie(cookieName,{path:"/",secure:true,httpOnly:true,sameSite:"lax"});
    const p = tx.params, code = random();
    db.prepare("INSERT INTO codes VALUES(?,?,?,?,?,?)").run(digest(code),p.client_id,p.redirect_uri,p.code_challenge,resource,now()+300);
    db.prepare("INSERT INTO m1_codes VALUES(?)").run(digest(code));
    const u = new URL(p.redirect_uri); u.searchParams.set("code",code);
    if (p.state !== undefined) u.searchParams.set("state",p.state);
    // End the authorization form submission on this origin. Continue as an ordinary
    // navigation so Google's redirect chain is independent of form-action.
    const href = escapeHtml(u.href);
    res.type("html").send(approvalPage("授权成功，正在返回 Gemini",
      `<p class="intro">若页面未自动跳转，请点击下方按钮继续。</p><a href="${href}" class="action">继续返回 Gemini</a>`,
      `<meta http-equiv="refresh" content="0;url=${href}">`));
  });
  function authenticate(req: Request): Client | undefined {
    let id = req.body?.client_id, secret = req.body?.client_secret;
    let actual: Client["method"] = secret === undefined ? "none" : "client_secret_post";
    if (req.headers.authorization !== undefined) {
      if (secret !== undefined || !/^Basic [A-Za-z0-9+/]+=*$/i.test(req.headers.authorization)) return;
      const raw = Buffer.from(req.headers.authorization.slice(6),"base64").toString();
      const idx = raw.indexOf(":"); if (idx < 1) return;
      try {
        const basicId = decodeURIComponent(raw.slice(0,idx));
        if (id !== undefined && id !== basicId) return;
        id = basicId; secret = decodeURIComponent(raw.slice(idx+1)); actual = "client_secret_basic";
      } catch { return; }
    }
    if (typeof id !== "string") return;
    const c = client(id);
    if (c?.method === actual && (actual === "none" || (typeof secret === "string" && same(c.secret_hash,digest(secret))))) return c;
  }
  function access(grantId: string) {
    const token = random();
    db.prepare("INSERT INTO access VALUES(?,?,?,?)").run(digest(token),grantId,resource,now()+3600);
    return token;
  }
  app.post("/oauth/token", budget(120), (req,res) => {
    const c = authenticate(req);
    if (!c) return invalid(res,"invalid_client",401);
    const b = req.body;
    if (b.resource !== undefined && b.resource !== resource) return invalid(res,"invalid_target");
    if (b.grant_type === "authorization_code") {
      const code = db.prepare("SELECT * FROM codes WHERE hash=?").get(digest(String(b.code))) as Code | undefined;
      if (!code || code.client !== c.id || code.uri !== b.redirect_uri || code.expires <= now() || code.resource !== resource
          || typeof b.code_verifier !== "string" || !/^[\w.~\-]{43,128}$/.test(b.code_verifier)
          || !same(digest(b.code_verifier),code.challenge)) return invalid(res,"invalid_grant");
      const refresh = c.method === "none" ? undefined : random(), grantId = random();
      db.exec("BEGIN IMMEDIATE");
      let token;
      try {
        const full=db.prepare("SELECT 1 FROM m1_codes WHERE hash=?").get(digest(b.code));
        db.prepare("DELETE FROM codes WHERE hash=?").run(digest(b.code));
        db.prepare("INSERT INTO grants VALUES(?,?,?,?)").run(grantId,c.id,refresh ? digest(refresh) : null,now()+(refresh ? 90*86400 : 3600));
        if(full)db.prepare("INSERT INTO m1_grants VALUES(?)").run(grantId);
        token = access(grantId); db.exec("COMMIT");
      } catch (err) { db.exec("ROLLBACK"); throw err; }
      console.info("oauth exchange grant=authorization_code authenticated_method=" + c.method);
      res.json({token_type:"Bearer",access_token:token,expires_in:3600,refresh_token:refresh}); return;
    }
    if (b.grant_type !== "refresh_token") return invalid(res,"unsupported_grant_type");
    const g = db.prepare("SELECT * FROM grants WHERE client=? AND refresh_hash=? AND expires>?")
      .get(c.id,digest(String(b.refresh_token)),now()) as Grant | undefined;
    if (!g || c.method === "none") return invalid(res,"invalid_grant");
    const token = access(g.id);
    db.prepare("UPDATE grants SET expires=? WHERE id=?").run(now()+90*86400,g.id);
    console.info("oauth exchange grant=refresh_token authenticated_method=" + c.method);
    res.json({token_type:"Bearer",access_token:token,expires_in:3600,refresh_token:b.refresh_token});
  });
  app.post("/oauth/revoke", budget(120), (req,res) => {
    const c = authenticate(req); if (!c) return invalid(res,"invalid_client",401);
    if (typeof req.body.token !== "string") return invalid(res,"invalid_request");
    const hash = digest(req.body.token);
    db.prepare("DELETE FROM grants WHERE client=? AND refresh_hash=?").run(c.id,hash);
    db.prepare("DELETE FROM access WHERE hash=? AND grant_id IN (SELECT id FROM grants WHERE client=?)").run(hash,c.id);
    res.status(200).end();
  });
  function authorize(req: Request,res: Response,next: express.NextFunction) {
    const token = /^Bearer ([\w-]+)$/i.exec(req.headers.authorization ?? "")?.[1];
    const authorized=token && db.prepare("SELECT grant_id FROM access WHERE hash=? AND resource=? AND expires>?").get(digest(token),resource,now());
    if (authorized) {
      res.locals.fullGrant=!!db.prepare("SELECT 1 FROM m1_grants WHERE id=?").get(authorized.grant_id);
      return next();
    }
    res.set("WWW-Authenticate",'Bearer realm="codex-remote-mcp", resource_metadata="'+base+'/.well-known/oauth-protected-resource/mcp/v1"');
    invalid(res,"invalid_token",401);
  }
  return {authorize,issueApprovalCode};
}

