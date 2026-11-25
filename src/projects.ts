import { realpathSync } from "node:fs";
import { hotFile } from "./config.js";
import path from "node:path";
import { z } from "zod";

const repoConfig = z.object({path:z.string().min(1), aliases:z.array(z.string().min(1)).default([]),note:z.string().default("")});
export const repoLabel = (label: string) => label.trim().toLowerCase();

export function parseCatalog(raw: string) {
  const records = z.record(z.union([z.string().transform(path=>({path,aliases:[],note:""})),repoConfig])).parse(JSON.parse(raw));
  const projects = Object.entries(records).map(([name,p])=>({name,...p}));
  const byName = new Map<string,typeof projects[number]>();
  for (const project of projects) {
    for (const label of [project.name,...project.aliases]) {
      const key = repoLabel(label);
      if (!key || byName.has(key) || !path.isAbsolute(project.path)) throw new Error("Invalid project configuration");
      byName.set(key,project);
    }
  }
  return {projects,byName};
}
const loadCatalog = hotFile(new URL("../config/repos.json",import.meta.url),parseCatalog);
export function projectCatalog(){
  try{return loadCatalog();}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return {projects:[],byName:new Map<string,ReturnType<typeof loadCatalog>["projects"][number]>()};throw e;}
}
export function diskPathKey(real: string) {
  return process.platform === "win32" ? real.toLowerCase() : real;
}

export function directoryKey(directory: string) {
  return diskPathKey(realpathSync.native(directory));
}

export function fullAccessProjects() {
  const {byName}=projectCatalog();
  const allowed=new Map<string,string>();
  const unknown:string[]=[];
  for(const label of (process.env.ALLOW_FULL_ACCESS_REPOS??"").split(/[,，]/).map(value=>value.trim()).filter(Boolean)){
    const project=byName.get(repoLabel(label));
    if(!project){unknown.push(label);continue;}
    try {allowed.set(directoryKey(project.path),project.name);}
    catch {unknown.push(label);}
  }
  return {allowed,unknown};
}

export function projectPath(name?: string) {
  const {byName,projects} = projectCatalog();
  const label = name ?? process.env.DEFAULT_REPO;
  const project = label === undefined ? (byName.get(repoLabel("通用")) ?? projects[0]) : byName.get(repoLabel(label));
  return project && realpathSync.native(project.path);
}

export function exposedDirectory(cwd: string, selected?: string) {
  const actual = directoryKey(cwd);
  const roots = selected ? [selected] : projectCatalog().projects.map(p=>p.path);
  return roots.some(root=>{
    try { return directoryKey(root) === actual; }
    catch { return false; }
  });
}
