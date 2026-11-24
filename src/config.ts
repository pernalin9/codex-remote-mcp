import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { z } from "zod";

export function hotFile<T>(file: URL, parse: (input: string)=>T, maxBytes = 128 * 1024) {
  let cached: { key: string; value: T } | undefined;
  return () => {
    const fd = openSync(file,"r");
    try {
      const stat = fstatSync(fd,{bigint:true});
      if (!stat.isFile() || stat.size > BigInt(maxBytes)) throw new Error("CONFIG_TOO_LARGE: "+file.pathname.split("/").at(-1));
      const key = [stat.ino,stat.mtimeNs,stat.size].join(":");
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
export const rules = hotFile(new URL("../config/gemini-instructions.md",import.meta.url),parseRules,24000);
const profile = z.object({model:z.string().min(1),reasoningEffort:z.enum(["low","medium","high","xhigh"])});
export const profiles = hotFile(new URL("../config/profiles.json",import.meta.url),raw=>
  z.record(profile).refine(entries=>entries.default && entries.coding).parse(JSON.parse(raw)));

