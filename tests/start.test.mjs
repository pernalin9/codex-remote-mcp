import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, writeFileSync, utimesSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {hotFile, parseRules} from "../dist/config.js";

test("workflow rules preserve raw text, reload same-size edits, fail closed and recover",t=>{
  const dir=mkdtempSync(path.join(tmpdir(),"gemini-rules-"));
  const name=path.join(dir,"rules.md");
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const read=hotFile(pathToFileURL(name),parseRules,40000);
  writeFileSync(name,"a\r\n");
  assert.equal(read(),"a\r\n");
  writeFileSync(name,"b\r\n"); utimesSync(name,1,1);
  assert.equal(read(),"b\r\n");
  writeFileSync(name,"界".repeat(10001));
  assert.throws(read,/OVER_10000/);
  writeFileSync(name,"🌱".repeat(10000));
  assert.equal([...read()].length,10000);
});

