import { accessSync, closeSync, constants, globSync, mkdirSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLocalLock, isLocalLockHeld } from "./local-lock.js";

export const projectRoot = fileURLToPath(new URL("../",import.meta.url));
export const envFile = path.join(projectRoot,".env");

export function loadBridgeEnv() {
  try {
    process.loadEnvFile(envFile);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Unable to load the project .env.");
    return false;
  }
}

export function bridgePort() {
  const raw = process.env.PORT ?? "19224";
  const port = Number(raw);
  if (!/^\d{1,5}$/.test(raw) || port>65535) throw new Error("PORT must be an integer from 0 to 65535.");
  return port;
}

export function publicOrigin() {
  try {
    const base = new URL(process.env.PUBLIC_BASE_URL ?? "");
    if (base.protocol==="https:" && base.href===base.origin+"/") return base.origin;
  } catch { /* Do not expose an invalid URL that might contain credentials. */ }
  throw new Error("PUBLIC_BASE_URL must be an HTTPS origin.");
}

export function dataDirectory() {
  if (process.env.CODEX_BRIDGE_DATA_DIR) {
    return path.resolve(projectRoot,process.env.CODEX_BRIDGE_DATA_DIR);
  }
  let parent: string;
  if (process.platform === "win32") {
    if (!process.env.LOCALAPPDATA) throw new Error("Set LOCALAPPDATA or CODEX_BRIDGE_DATA_DIR.");
    parent = process.env.LOCALAPPDATA;
  } else if (process.platform === "darwin") {
    parent = path.join(os.homedir(),"Library","Application Support");
  } else {
    parent = process.env.XDG_DATA_HOME || path.join(os.homedir(),".local","share");
  }
  return path.resolve(parent,"codex-remote-mcp");
}

export function lockDataDirectory(directory: string) {
  mkdirSync(directory,{recursive:true,mode:0o700});
  return acquireLocalLock(path.join(directory,"bridge.lock"),"A bridge already uses this data directory.");
}

export function dataDirectoryLocked(directory: string) {
  return isLocalLockHeld(path.join(directory,"bridge.lock"));
}

function validateExecutable(file: string) {
  if (!path.isAbsolute(file)) throw new Error("CODEX_EXE must be an absolute path.");
  const real = realpathSync.native(file);
  if (!statSync(real).isFile()) throw new Error("Expected a Codex executable file.");
  accessSync(real,constants.X_OK);
  if (process.platform === "win32") {
    const normalized = real.replaceAll("\\","/");
    if (path.extname(real).toLowerCase() !== ".exe" ||
      /(?:\/WindowsApps\/|\/Codex\/.*?resources\/)/i.test(normalized) ||
      /\/app\/resources\/codex\.exe$/i.test(normalized)) {
      throw new Error("Use the standalone native Codex CLI executable.");
    }
    const fd = openSync(real,"r");
    try {
      const magic = Buffer.alloc(2);
      if (readSync(fd,magic) !== 2 || magic.toString("ascii") !== "MZ") throw new Error("Expected a native Windows executable.");
    } finally { closeSync(fd); }
  }
  return real;
}

export function codexExecutable() {
  if (process.env.CODEX_EXE !== undefined) return validateExecutable(process.env.CODEX_EXE);
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    const directory = entry.replace(/^"(.*)"$/,"$1");
    if (!path.isAbsolute(directory)) continue;
    const candidates = [path.join(directory,process.platform === "win32" ? "codex.exe" : "codex")];
    if (process.platform === "win32") {
      const npmRoot = path.join(directory,"node_modules","@openai","codex");
      const triple = process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
      for (const file of globSync([
        "vendor/"+triple+"/codex/codex.exe",
        "vendor/"+triple+"/bin/codex.exe",
        "node_modules/@openai/codex-win32-"+process.arch+"/vendor/"+triple+"/bin/codex.exe"
      ],{cwd:npmRoot})) candidates.push(path.join(npmRoot,file));
    }
    for (const candidate of candidates) {
      try { return validateExecutable(candidate); } catch { continue; }
    }
  }
  throw new Error("Set CODEX_EXE to the standalone Codex CLI executable.");
}
