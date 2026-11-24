import * as fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {randomUUID} from "node:crypto";
import {parseCatalog, repoLabel} from "./projects.js";
import {acquireLocalLock} from "./local-lock.js";
const file=fileURLToPath(new URL("../config/repos.json",import.meta.url));
const [action,label,dir,option,note]=process.argv.slice(2);
const name=label?.trim();
type Entry=string|{path:string;note?:string;aliases?:string[]};
function load():Record<string,Entry>{return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,"utf8")):{};}
if(action==="list")console.log(JSON.stringify(load(),null,2));
else{
  if(!name || !["add","remove"].includes(action) || (action==="add" && (!dir || (option && (option!=="--note" || !note)))))throw Error("repo list | add <alias> <path> [--note text] | remove <alias>");
  const lock=file+".lock",tmp=file+"."+randomUUID()+".tmp";
  const release=acquireLocalLock(lock+".sqlite","Project catalog is locked");
  try{
    // Older CLI versions use an empty sentinel for a synchronous edit.
    if (fs.existsSync(lock) && Date.now()-fs.lstatSync(lock).mtimeMs>60_000) fs.unlinkSync(lock);
    const fd=fs.openSync(lock,"wx");
    try{
    const entries=load();
    const match=parseCatalog(JSON.stringify(entries)).byName.get(repoLabel(name));
    if(action==="add"){
      if(match||["__proto__","constructor","prototype"].includes(repoLabel(name)))throw Error("Alias already exists or is reserved");
      const root=fs.realpathSync.native(path.resolve(dir));if(!fs.statSync(root).isDirectory())throw Error("Expected a directory");
      entries[name]={path:root,note:note??""};
    }else{if(!match)throw Error("Unknown alias");delete entries[match.name];}
    const content=JSON.stringify(entries,null,2)+"\n";
    parseCatalog(content);
    fs.writeFileSync(tmp,content,{flag:"wx"});
    fs.renameSync(tmp,file);
    }finally{
      fs.closeSync(fd);
      fs.unlinkSync(lock);
      if(fs.existsSync(tmp))fs.unlinkSync(tmp);
    }
  }finally{release();}
}

