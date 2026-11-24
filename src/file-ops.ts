import * as fs from "node:fs";
import path from "node:path";
import {createHash,randomUUID} from "node:crypto";
import {diskPathKey} from "./projects.js";
const maxBytes=5*1024*1024;
const binaryExtensions=new Set(".pdf .png .jpg .jpeg .webp .gif .ico .xlsx .xls .docx .pptx .zip .7z .tar .gz .exe .dll .so .dylib .wasm .sqlite .db .mp3 .mp4 .mov .ttf .woff .woff2".split(" "));
function parts(s:string){
  const list=s.split(/[\\/]/);
  if(list.some(p=>!p || p==="." || p===".." || /[:*?"<>|\x00-\x1f~]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\.|$)/i.test(p))) throw Error("invalid_path");
  return list;
}
function checked(root:string,target:string){
  const real=fs.realpathSync.native(target);
  const rel=path.relative(root,real);
  if(path.isAbsolute(rel)||rel===".."||rel.startsWith(".."+path.sep))throw Error("invalid_path");
  return real;
}
function permitted(rel:string){
  if(parts(rel).some(p=>/^(\.git|\.env(?:\..*)?|id_rsa.*|.*\.(pem|key|pfx|p12)|.*password.*\.txt)$/i.test(p)) || /(?:^|[\\/])\.codex[\\/]auth\.json$/i.test(rel)) throw Error("blocked_sensitive_path");
}
function checkedFile(root:string,relative:string) {
  permitted(relative);
  const real=checked(root,path.join(root,...parts(relative)));
  permitted(path.relative(root,real));
  return real;
}

function withRegularFile<T>(root:string,real:string,limit:number,use:(fd:number,stat:fs.Stats)=>T):T {
  const check=(stat:fs.Stats)=>{
    if(!stat.isFile())throw Error("not_regular_file");
    if(stat.nlink>1)throw Error("hardlink_not_allowed");
    if(stat.size>limit)throw Error("file_too_large");
  };
  const before=fs.lstatSync(real);
  check(before);
  const fd=fs.openSync(real,fs.constants.O_RDONLY | (process.platform==="win32" ? 0 : fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK));
  try {
    const stat=fs.fstatSync(fd);
    check(stat);
    if(stat.dev!==before.dev || stat.ino!==before.ino)throw Error("file_changed");
    const current=checked(root,real);
    permitted(path.relative(root,current));
    if(diskPathKey(current)!==diskPathKey(real))throw Error("file_changed");
    return use(fd,stat);
  } finally {fs.closeSync(fd);}
}

function decodeText(bytes:Buffer) {
  if(bytes.subarray(0,5).toString("ascii")==="%PDF-")throw Error("binary_file");
  const bom=bytes.length>=2 ? bytes.readUInt16BE() : 0;
  if(bom===0xfffe || bom===0xfeff){
    if(bytes.length%2)throw Error("binary_file");
    try {
      return new TextDecoder(bom===0xfffe?"utf-16le":"utf-16be",{fatal:true}).decode(bytes);
    } catch {throw Error("binary_file");}
  }
  if(bytes.includes(0))throw Error("binary_file");
  return bytes.toString("utf8");
}
const hash=(b:Buffer)=>createHash("sha256").update(b).digest("hex");
export interface ReadOptions {relative_path:string;start_line?:number;end_line?:number;search_query?:string;context_lines?:number;with_line_numbers?:boolean;max_chars?:number}
export function readFile(root:string,o:ReadOptions){
  const real=checkedFile(root,o.relative_path);
  const bytes=withRegularFile(root,real,maxBytes,(fd,st)=>{
    if([real,o.relative_path].some(file=>binaryExtensions.has(path.extname(file).toLowerCase())))throw Error("binary_file");
    const buf=Buffer.alloc(st.size+1);
    let n=0;
    while(n<buf.length){const count=fs.readSync(fd,buf,n,buf.length-n,null);if(!count)break;n+=count;}
    if(n>st.size)throw Error("file_changed");
    return buf.subarray(0,n);
  });
  const lines=decodeText(bytes).split(/\r\n|\r|\n/);
  if(lines.at(-1)==="")lines.pop();
  const start=o.start_line??1, end=o.end_line??(start+299);
  if(end<start||end-start>=500)throw Error("invalid_range");
  const indices=new Set<number>(), q=o.search_query?.toLowerCase();
  let matches=0, last=0, truncated=false;
  if(q){
    const context=o.context_lines??5;
    for(let i=start;i<=lines.length;i++)if(lines[i-1].toLowerCase().includes(q)){
      if(matches===10){truncated=true;break;}
      matches++;last=i;
      for(let j=Math.max(1,i-context);j<=Math.min(lines.length,i+context);j++)indices.add(j);
    }
  }else for(let i=start;i<=Math.min(end,lines.length);i++)indices.add(i);
  let content="",returned=0;
  const cap=o.max_chars??20000;
  for(const i of indices){
    const line=(returned?"\n":"")+(o.with_line_numbers===false?"":"L"+i+": ")+lines[i-1];
    const remaining=cap-content.length;
    if(line.length>remaining){if(remaining){content+=line.slice(0,remaining);returned=i;}truncated=true;break;}
    content+=line;returned=i;
  }
  if(!q && returned<lines.length && indices.size)truncated=true;
  return {path:o.relative_path,size_bytes:bytes.length,sha256:hash(bytes),total_lines:lines.length,mode:q?"search":"range",
    match_count:q?matches:undefined,returned_range:returned?[indices.values().next().value,returned]:null,
    content,truncated,next_start_line:truncated?(q?Math.min(last,returned||last):returned)+1:null};
}

export interface ListOptions {
  subdir?:string;
  max_depth?:number;
  limit?:number;
  filter?:string;
}
const scanLimit=5000;
function permittedListPath(relative:string){
  permitted(relative);
  if(parts(relative).some(part=>part.toLowerCase()==="node_modules"))throw Error("blocked_sensitive_path");
}

export function listFiles(root:string,{subdir,max_depth=3,limit=100,filter}:ListOptions) {
  let start=root, prefix="";
  if(subdir!==undefined){
    permittedListPath(subdir);
    for(const part of parts(subdir)){
      const candidate=path.join(start,part);
      if(!fs.lstatSync(candidate).isDirectory())throw Error("invalid_path");
      start=checked(root,candidate);
      permittedListPath(path.relative(root,start));
    }
    prefix=parts(subdir).join("/")+"/";
  }
  const entries:{path:string;type:"file"|"dir";size_bytes?:number}[]=[];
  const query=filter?.toLowerCase();
  let scanned=0, responseBytes=0, truncated=false;
  function walk(directory:string,relative:string,depth:number){
    const handle=fs.opendirSync(directory);
    try{
      for(let child=handle.readSync();child;child=handle.readSync()){
        if(scanned++>=scanLimit){truncated=true;return;}
        const name=relative+child.name;
        const candidate=path.join(directory,child.name);
        let stat:fs.Stats, real:string;
        try{
          // A literal backslash in a POSIX name cannot be addressed by the MCP path syntax.
          if(child.name.includes("\\"))continue;
          permittedListPath(name);
          if(!child.isDirectory() && !child.isFile())continue;
          stat=fs.lstatSync(candidate);
          if(!stat.isDirectory() && (!stat.isFile() || stat.nlink>1))continue;
          real=checked(root,candidate);
          permittedListPath(path.relative(root,real));
          if(diskPathKey(candidate)!==diskPathKey(real))continue;
        }catch{continue;}
        if(!query || name.toLowerCase().includes(query)){
          const entry={path:name,type:stat.isDirectory() ? "dir" as const : "file" as const,
            ...(stat.isFile() ? {size_bytes:stat.size} : {})};
          const cost=Buffer.byteLength(JSON.stringify(JSON.stringify(entry)))+1;
          if(entries.length>=limit || responseBytes+cost>120*1024){truncated=true;return;}
          entries.push(entry);
          responseBytes+=cost;
        }
        if(stat.isDirectory() && depth<max_depth)walk(real,name+"/",depth+1);
        if(truncated)return;
      }
    }finally{handle.closeSync();}
  }
  walk(start,prefix,1);
  return {entries,truncated};
}

export function resolveLocalImages(root:string,files:readonly string[]){
  if(files.length>4)throw Error("too_many_images");
  const png=Buffer.from("89504e470d0a1a0a","hex");
  return files.map(relative=>{
    const absolutePath=checkedFile(root,relative);
    return withRegularFile(root,absolutePath,10*1024*1024,(fd,stat)=>{
      const extension=(name:string)=>path.extname(name).toLowerCase().replace(/^\.jpeg$/,".jpg");
      const ext=extension(relative);
      if(ext!==extension(absolutePath))throw Error("invalid_image");
      const head=Buffer.alloc(12);
      const bytes=head.subarray(0,fs.readSync(fd,head,0,head.length,0));
      const ascii=(start:number,end:number)=>bytes.subarray(start,end).toString("latin1");
      const valid = ext===".png" ? bytes.subarray(0,8).equals(png)
        : ext===".jpg" ? bytes.length>=3 && bytes[0]===0xff && bytes[1]===0xd8 && bytes[2]===0xff
        : ext===".gif" ? ["GIF87a","GIF89a"].includes(ascii(0,6))
        : ext===".webp" && ascii(0,4)==="RIFF" && ascii(8,12)==="WEBP";
      if(!valid)throw Error("invalid_image");
      return {absolutePath,relativePath:diskPathKey(path.relative(root,absolutePath)).split(path.sep).join("/"),
        size:stat.size,mtimeMs:stat.mtimeMs};
    });
  });
}
export function writeFile(root:string,filename:string,content:string,overwrite=true){
  const names=parts(filename), leaf=names.pop()!;
  const data=Buffer.from(content);
  if(data.length>1024*1024)throw Error("file_too_large");
  let dir=root;
  for(const name of [".ai-handoff",...names]){
    dir=path.join(dir,name);
    if(!fs.existsSync(dir))fs.mkdirSync(dir);
    if(fs.lstatSync(dir).isSymbolicLink()||!fs.statSync(dir).isDirectory())throw Error("invalid_path");
    dir=checked(root,dir);
  }
  const dest=path.join(dir,leaf), tmp=path.join(dir,randomUUID()+".tmp");
  fs.writeFileSync(tmp,data,{flag:"wx"});
  try{if(overwrite)fs.renameSync(tmp,dest);else fs.linkSync(tmp,dest);}
  finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
  return {written_path:".ai-handoff/"+[...names,leaf].join("/"),size_bytes:data.length,sha256:hash(data)};
}
export function attachments(root:string,text:string){
  const result:Record<string,unknown>[]=[],seen=new Set<string>();
  let available=18000,n=0;
  for(const match of text.matchAll(/^\[\[ATTACH_FILE:\s*([^\r\n\]]+?)\]\]\s*$/gm)){
    if(++n>10)break;
    const [,file,a,b]=/^(.*?)(?::(\d+)-(\d+))?$/.exec(match[1].trim())!;
    const start=Number(a??1),end=Number(b??150),key=JSON.stringify([diskPathKey(file.replaceAll("\\","/")),start,end]);
    if(seen.has(key))continue;
    seen.add(key);
    try{
      if(result.filter(x=>"content" in x).length>=3 || end-start>=200 || available<=0)throw Error("budget_exceeded");
      if(start<1||end<start)throw Error("invalid_range");
      const chunk=readFile(root,{relative_path:file,start_line:start,end_line:end,max_chars:available+1});
      if(chunk.content.length>available)throw Error("budget_exceeded");
      result.push({path:file,start_line:start,end_line:end,content:chunk.content});available-=chunk.content.length;
    }catch(e){result.push({path:file,skipped_reason:fileError(e)});}
  }
  return result;
}
export function fileError(e:unknown){
  if(e instanceof Error && /^[a-z_]+$/.test(e.message))return e.message;
  const code=(e as NodeJS.ErrnoException)?.code;
  return code==="ENOENT"?"not_found":code==="EEXIST"?"already_exists":"file_unavailable";
}

