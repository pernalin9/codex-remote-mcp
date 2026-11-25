import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { z } from "zod";

export function hotFile<T>(file: URL, parse: (input: string)=>T, maxBytes = 128 * 1024) {
  let cached: { key: string; value: T } | undefined;
  return () => {
    let fd: number;
    try {
      fd = openSync(file,"r");
    } catch (error) {
      cached = undefined;
      throw error;
    }
    try {
      const stat = fstatSync(fd,{bigint:true});
      if (!stat.isFile() || stat.size > BigInt(maxBytes)) throw new Error("CONFIG_TOO_LARGE: "+file.pathname.split("/").at(-1));
      const key = [stat.ino,stat.mtimeNs,stat.ctimeNs,stat.size].join(":");
      if (cached?.key === key) return cached.value;
      const value = parse(readFileSync(fd,"utf8"));
      cached = {key,value};
      return value;
    } finally { closeSync(fd); }
  };
}
export function parseRules(raw: string) {
  if (!raw.trim()) throw new Error("EMPTY_WORKFLOW_RULES");
  if ([...raw].length > 6000) throw new Error("WORKFLOW_RULES_OVER_6000");
  return raw;
}

const userRulesHeading = "# 以下为用户自定义规则";
const systemRules = hotFile(new URL("../config/gemini-instructions.md",import.meta.url),parseRules,24000);
const userRules = hotFile(new URL("../config/user-instructions.md",import.meta.url),raw=>raw);

export function readWorkflowRules() {
  const system = systemRules();
  let user = "";
  try {
    user = userRules();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const userContent = user.trimStart();
  if (!userContent) return {text:system,userLoaded:false};

  const separator = userContent.startsWith(userRulesHeading) ? "\n\n" : "\n\n"+userRulesHeading+"\n\n";
  return {text:parseRules(system+separator+user),userLoaded:true};
}

export const rules = () => readWorkflowRules().text;
const profile = z.object({model:z.string().min(1),reasoningEffort:z.enum(["low","medium","high","xhigh"])});
export const profiles = hotFile(new URL("../config/profiles.json",import.meta.url),raw=>
  z.record(profile).refine(entries=>entries.default && entries.coding).parse(JSON.parse(raw)));

