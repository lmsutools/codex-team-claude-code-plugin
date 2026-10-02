/** Supervisor/worker-only visibility observations, stored once per implementation. */
import fs from "node:fs";
import path from "node:path";
import {inventory,compareInventory} from "./hidden-inventory.mjs";
import {gitSecuritySnapshot,compareGitSecurity} from "./git-security.mjs";
import {inside} from "./check-executable.mjs";
const observeGit = root => {try{return gitSecuritySnapshot(root);}catch(error){return {error:error.message.slice(0,500)};}};
export function captureVisibility(state,dir) {
  const file=path.join(dir,"visibility-before.json");
  if(fs.existsSync(file)) return;
  const listing=inventory(state.executionCwd), git=observeGit(state.executionCwd);
  fs.writeFileSync(file,JSON.stringify({listing,git}),{mode:0o600});
}
export function inheritVisibility(previous,oldDir,newDir) {
  const source=path.join(oldDir,"visibility-before.json");
  if(!fs.existsSync(source)) return false;
  fs.copyFileSync(source,path.join(newDir,"visibility-before.json"));
  const current=path.join(oldDir,"visibility-current.json");
  if(fs.existsSync(current)) fs.copyFileSync(current,path.join(newDir,"visibility-current.json"));
  return previous.visibilityRecorded !== false && !previous.visibilityUnavailable;
}
export function finishVisibility(state,dir,reported=[]) {
  let before;try{before=JSON.parse(fs.readFileSync(path.join(dir,"visibility-before.json"),"utf8"));}catch{}
  const after=inventory(state.executionCwd), git=observeGit(state.executionCwd);
  const paths=[];
  const ignored=[...(before?.listing?.entries || []),...after.entries].filter(e=>e.ignored).map(e=>e.file);
  for(const value of reported) for(const token of String(value).slice(0,8192).split(/[\s'"\x60;,|<>]+/)) {
    if(paths.length>=2000) break;
    const file=path.resolve(state.executionCwd,token);
    const relative=path.relative(state.executionCwd,file).replaceAll("\\","/");
    if(inside(file,state.executionCwd) && ignored.some(p=>relative===p || relative.startsWith(p.endsWith("/")?p:p+"/"))) paths.push(relative);
  }
  let latest;try{latest=JSON.parse(fs.readFileSync(path.join(dir,"visibility-current.json"),"utf8"));}catch{}
  const hiddenChanges=compareInventory(state.visibilityUnavailable?null:before?.listing,after,paths,state.executionCwd);
  if(hiddenChanges.status==="available") {
    const recent=latest ? compareInventory(latest,after,paths,state.executionCwd) : hiddenChanges;
    const entries=new Map((state.hiddenChanges?.entries || []).map(e=>[e.file,e]));
    for(const e of [...hiddenChanges.entries,...recent.entries]) entries.set(e.file,e);
    const all=[...entries.values()].sort((a,b)=>a.file<b.file?-1:a.file>b.file?1:0);
    hiddenChanges.total=Math.max(all.length,hiddenChanges.total,recent.total,state.hiddenChanges?.total || 0);
    hiddenChanges.entries=all.slice(0,200);hiddenChanges.omitted=hiddenChanges.total-hiddenChanges.entries.length;
    hiddenChanges.counts={new:all.filter(e=>e.kind==="new").length,changed:all.filter(e=>["changed","reported"].includes(e.kind)).length,removed:all.filter(e=>e.kind==="removed").length};
  }
  if(after.status!=="unavailable") fs.writeFileSync(path.join(dir,"visibility-current.json"),JSON.stringify(after),{mode:0o600});
  return {visibilityRecorded:true,hiddenChanges,gitConfigChanged:compareGitSecurity(before?.git,git)};
}
