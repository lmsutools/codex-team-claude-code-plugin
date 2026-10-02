/** Git configuration evidence is captured by workers, never by status polling. */
import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {stateRoot} from "./state-reader.mjs";
import {spawnSync} from "node:child_process";
import {trustedExecutable,checkEnvironment} from "./host-security.mjs";
const digest=value=>createHash("sha256").update(value).digest("hex");
export function gitSafetyArgs() {
  const empty=path.join(stateRoot(),"empty-hooks");
  fs.mkdirSync(empty,{recursive:true});
  if(fs.readdirSync(empty).length) throw Error("The plugin's empty hooks directory is not empty.");
  return ["-c","core.fsmonitor=false","-c","core.hooksPath="+empty,"-c","commit.gpgSign=false","-c","tag.gpgSign=false","-c","protocol.ext.allow=never"];
}
export function gitDirectory(root) {
  let dir=path.join(root,".git"); if(fs.statSync(dir).isFile()) dir=path.resolve(root,fs.readFileSync(dir,"utf8").trim().replace(/^gitdir: /,""));
  if(fs.existsSync(path.join(dir,"commondir"))) dir=path.resolve(dir,fs.readFileSync(path.join(dir,"commondir"),"utf8").trim());
  return dir;
}
export function gitSecuritySnapshot(root) {
  const dir=gitDirectory(root), entries={};
  // Hash the effective configuration, including origins and conditional includes, without executing programs.
  const config=spawnSync(trustedExecutable("git",root),["-C",root,"config","--list","--show-origin","--includes"],{env:checkEnvironment(process.env),encoding:"utf8",windowsHide:true,timeout:5000,maxBuffer:1048576});
  if(config.status!==0 || config.error) throw Error("Git configuration observation unavailable: "+(config.error?.message || config.stderr));
  entries.effectiveConfig=digest(config.stdout);
  for(const name of ["config","info/attributes","info/exclude"]) {const file=path.join(dir,name);try {const stat=fs.statSync(file);if(stat.size>1048576) throw Error("Git metadata exceeds 1 MiB");entries[name]=digest(fs.readFileSync(file));}catch(error){if(error.code==="ENOENT")entries[name]=null;else throw error;}}
  const hooks=path.join(dir,"hooks"); entries.hooks={};let hookBytes=0;
  for(const name of fs.existsSync(hooks)?fs.readdirSync(hooks).sort():[]) { const file=path.join(hooks,name),info=fs.lstatSync(file); if(!info.isFile() || (hookBytes+=info.size)>1048576) throw Error("Hook contents cannot be safely observed.");entries.hooks[name]=digest(fs.readFileSync(file)); }
  return {entries,hash:digest(JSON.stringify(entries))};
}
export function compareGitSecurity(before,after) {
  if(!before || before.error || after.error) return {changed:true,unavailable:true,paths:[],heading:"Git configuration changed: observation unavailable",...((before?.error||after.error)?{error:before?.error||after.error}:{})};
  const paths=Object.keys(after.entries).filter(key=>JSON.stringify(before.entries[key])!==JSON.stringify(after.entries[key]));
  return {changed:paths.length>0,paths,hash:after.hash,heading:paths.length?"Git configuration changed":"Git configuration unchanged"};
}
