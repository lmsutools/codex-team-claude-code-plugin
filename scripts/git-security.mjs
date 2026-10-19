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
/**
 * Branch-tracking entries that sibling worktrees write to the shared common
 * config (git push -u, git branch --track, git worktree add). No Git operation
 * of this plugin reads them: commits name exact paths and pushes name an exact
 * remote and refspec. Every other key, including remote URLs, filters, hooks,
 * includes and core settings, still counts.
 */
export const BENIGN_BRANCH_KEY=/^branch\..+\.(?:remote|pushremote|merge|rebase|description|vscode-merge-base)$/i;
/** Observer environment: core OS names only, never Git's injected configuration. */
export function observerEnvironment(environment=process.env) {
  // checkEnvironment keeps core OS names only; drop every GIT_* name explicitly
  // (GIT_CONFIG_COUNT/KEY_n/VALUE_n, GIT_CONFIG_PARAMETERS, GIT_DIR, ...) as Codex
  // and other tools inject them into child environments.
  return Object.fromEntries(Object.entries(checkEnvironment(environment)).filter(([key])=>!/^GIT_/i.test(key)));
}
/** Parses `git config --list -z` output, optionally with --show-origin. */
export function configEntries(stdout,withOrigin=false) {
  const parts=String(stdout||"").split("\0");if(parts.at(-1)==="")parts.pop();
  const entries=[];
  for(let i=0;i<parts.length;) {
    const origin=withOrigin?parts[i++]:null, pair=parts[i++] ?? "", newline=pair.indexOf("\n");
    entries.push({origin,key:newline<0?pair:pair.slice(0,newline),value:newline<0?null:pair.slice(newline+1)});
  }
  return entries;
}
/** Security-relevant entries and benign branch-tracking entries, separately. */
export function partitionConfig(entries) {
  const relevant=[],benign=[];
  for(const entry of entries) {
    // "command line:" entries come from -c, GIT_CONFIG_COUNT/KEY/VALUE or GIT_CONFIG_PARAMETERS; never repository state.
    if(entry.origin?.startsWith("command line:")) continue;
    (BENIGN_BRANCH_KEY.test(entry.key)?benign:relevant).push(entry);
  }
  return {relevant,benign};
}
/** Whether a --show-origin "file:<path>" origin names `file` (Git prints it relative to root or absolute). */
function sameFile(root,origin,file) {
  if(!origin?.startsWith("file:")) return false;
  const fold=value=>process.platform==="win32" ? value.toLowerCase() : value;
  return fold(path.resolve(root,origin.slice(5)))===fold(path.resolve(file));
}
const gitConfig=(root,args)=>spawnSync(trustedExecutable("git",root),["-C",root,"config",...args],{env:observerEnvironment(),encoding:"utf8",windowsHide:true,timeout:15000,maxBuffer:4*1048576});
export function gitSecuritySnapshot(root,{legacy:withLegacy=false}={}) {
  const dir=gitDirectory(root), entries={}, legacy={}, benign={};
  // Effective configuration, including origins and conditional includes, without executing programs.
  const config=gitConfig(root,["--list","--show-origin","--includes","-z"]);
  if(config.status!==0 || config.error) throw Error("Git configuration observation unavailable: "+(config.error?.message || config.stderr));
  const listing=configEntries(config.stdout,true), effective=partitionConfig(listing);
  entries.effectiveConfig=digest(JSON.stringify(effective.relevant));
  benign.effectiveConfig=digest(JSON.stringify(effective.benign));
  // The raw 1.2.1 listing costs one more Git process; only a comparison with a 1.2.1 snapshot needs it.
  if(withLegacy) {
    const listed=spawnSync(trustedExecutable("git",root),["-C",root,"config","--list","--show-origin","--includes"],{env:observerEnvironment(),encoding:"utf8",windowsHide:true,timeout:15000,maxBuffer:4*1048576});
    legacy.effectiveConfig=listed.status===0 && !listed.error ? digest(listed.stdout) : null;
  }
  for(const name of ["config","info/attributes","info/exclude"]) {const file=path.join(dir,name);try {const stat=fs.statSync(file);if(stat.size>1048576) throw Error("Git metadata exceeds 1 MiB");const bytes=fs.readFileSync(file);legacy[name]=entries[name]=digest(bytes);
    if(name==="config") {
      // The common config file's own entries, as Git listed them with their origin (no extra process).
      const own=listing.filter(entry=>sameFile(root,entry.origin,file)).map(({key,value})=>({origin:null,key,value}));
      const split=partitionConfig(own);entries.config=digest(JSON.stringify(split.relevant));benign.config=digest(JSON.stringify(split.benign));
    }}catch(error){if(error.code==="ENOENT")legacy[name]=entries[name]=null;else throw error;}}
  const hooks=path.join(dir,"hooks"); entries.hooks={};let hookBytes=0;
  for(const name of fs.existsSync(hooks)?fs.readdirSync(hooks).sort():[]) { const file=path.join(hooks,name),info=fs.lstatSync(file); if(!info.isFile() || (hookBytes+=info.size)>1048576) throw Error("Hook contents cannot be safely observed.");entries.hooks[name]=digest(fs.readFileSync(file)); }
  legacy.hooks=entries.hooks;
  let shared=false;try{shared=fs.statSync(path.join(root,".git")).isFile();}catch{}
  return {version:2,entries,benign,legacy,shared,hash:digest(JSON.stringify(entries))};
}
export function compareGitSecurity(before,after) {
  if(!before || before.error || after.error) return {changed:true,unavailable:true,paths:[],heading:"Git configuration changed: observation unavailable",...((before?.error||after.error)?{error:before?.error||after.error}:{})};
  // A 1.2.1 snapshot holds raw digests: compare it with this snapshot's raw digests.
  const current=before.version===2?after.entries:{...after.entries,...(after.legacy||{})};
  const paths=Object.keys(after.entries).filter(key=>JSON.stringify(before.entries[key])!==JSON.stringify(current[key]));
  const benignPaths=before.version===2?Object.keys(after.benign||{}).filter(key=>!paths.includes(key) && before.benign?.[key]!==after.benign[key]):[];
  const shared=!!after.shared;
  return {changed:paths.length>0,paths,hash:after.hash,
    heading:(paths.length?"Git configuration changed":"Git configuration unchanged")+(shared && paths.some(p=>p!=="effectiveConfig")?" (common Git directory shared with sibling worktrees; another worktree may have made this change)":""),
    ...(benignPaths.length?{ignored:{paths:benignPaths,reason:"Only branch-tracking entries (branch.<name>.remote/merge/...) changed; sibling worktrees write these and no plugin Git operation reads them."}}:{}),
    ...(shared?{sharedGitDirectory:true}:{})};
}
