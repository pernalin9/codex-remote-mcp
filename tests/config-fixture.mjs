import fs from "node:fs";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

export function configuredBridge(t) {
  const home=fs.mkdtempSync(fileURLToPath(new URL("./bridge-fixture-",import.meta.url)));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const config=path.join(home,"config");
  fs.mkdirSync(config);
  const target=path.join(home,"project");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(config,"repos.json"),JSON.stringify({
    Picsort:{path:target,aliases:["pic"]},Other:home
  }));
  const profile={model:"fixture-model",reasoningEffort:"medium"};
  fs.writeFileSync(path.join(config,"profiles.json"),JSON.stringify({default:profile,coding:profile,probe:profile}));
  fs.writeFileSync(path.join(config,"gemini-instructions.md"),"Fixture workflow rules.");
  const dist=path.join(home,"dist");
  fs.mkdirSync(dist);
  for(const name of fs.readdirSync(new URL("../dist/",import.meta.url)).filter(name=>name.endsWith(".js"))) {
    fs.copyFileSync(new URL("../dist/"+name,import.meta.url),path.join(dist,name));
  }
  fs.cpSync(new URL("../assets/",import.meta.url),path.join(home,"assets"),{recursive:true});
  return name=>import(pathToFileURL(path.join(dist,name+".js")).href);
}
