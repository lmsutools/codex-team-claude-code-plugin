/** Verification containment and explicit, fingerprint-bound host execution. */
import path from "node:path";
import fs from "node:fs";
import {stateRoot,jobDirectory} from "./state-reader.mjs";
import {hash,changes} from "./git.mjs";
import {inside} from "./check-executable.mjs";
import {checkEnvironment,shellEnvironmentPolicy,inlineCommand} from "./host-security.mjs";
export const verificationCommands = state => state.checkPlan?.checks || state.assignment?.verification || [];
export function reviewFingerprint(state,content=state.verifiedFingerprint || state.implementationFingerprint || state.baseline?.fingerprint) {
  return hash(JSON.stringify({content,hiddenChanges:state.hiddenChanges||null,gitConfigChanged:state.gitConfigChanged||null,verification:verificationCommands(state)}));
}
export function reviewInputDetails(state,content) {
  const fingerprint=reviewFingerprint(state,typeof content === "object" ? content.fingerprint : content);
  const baseline=state.reviewBaseline || state.verificationBaseline || state.baseline;
  const delta=typeof content === "object" && baseline?.available ? changes(baseline,content) : {files:[]};
  const oldHidden=new Map((state.reviewVisibility?.hiddenChanges?.entries || []).map(e=>[e.file,JSON.stringify(e)]));
  const newHidden=new Map((state.hiddenChanges?.entries || []).map(e=>[e.file,JSON.stringify(e)]));
  const hidden=[...new Set([...oldHidden.keys(),...newHidden.keys()])].filter(file=>oldHidden.get(file)!==newHidden.get(file));
  const gitPaths=state.reviewVisibility?.gitConfigChanged?.hash && state.reviewVisibility.gitConfigChanged.hash===state.gitConfigChanged?.hash ? [] : state.gitConfigChanged?.paths || [];
  const paths=[...new Set([...delta.files,...hidden,...gitPaths,...(delta.gitMetadataChanged?["Git metadata"]:[])])].slice(0,40);
  return {fingerprint,paths,text:"Current reviewFingerprint: "+fingerprint+". Changed paths versus stored review: "+(paths.join(", ") || "none observed; check plan or visibility changed")+". Use codex_status refresh:true after inspection."};
}
export function requireHostAck(state,acknowledgment,content) {
  if(acknowledgment===reviewFingerprint(state,typeof content === "object" ? content.fingerprint : content)) return;
  const details=reviewInputDetails(state,content);
  const error=Error("Host execution requires hostAck equal to the current reviewFingerprint after lead review. "+details.text);
  error.reviewFingerprint=details.fingerprint;error.changedPaths=details.paths;throw error;
}
export function checkInvocation(state,check,binary) {
  const env=checkEnvironment(process.env,check.passEnv);
  if(check.host===true) return {command:check.command,args:check.args||[],env,executedIn:"host",advisory:inlineCommand([check.command,...(check.args||[])])?"Inline code: inspect before authorizing host execution.":null};
  // The launcher needs its runtime home. Its child command gets only the shell policy.
  if(process.env.CODEX_HOME) env.CODEX_HOME=process.env.CODEX_HOME;
  if(!binary?.command || !path.isAbsolute(binary.command)) throw Error("A pinned Codex launcher is required for sandboxed checks.");
  const root=fs.realpathSync(state.executionCwd || process.cwd());
  for(const file of [binary.command,...(binary.prefix || [])]) if(path.isAbsolute(file) && inside(fs.realpathSync(file),root)) throw Error("Pinned Codex launcher must be outside the execution folder.");
  const artifactRoot=state.jobId ? jobDirectory(state.jobId) : path.join(stateRoot(),"sandbox-probes");
  fs.mkdirSync(artifactRoot,{recursive:true});
  if(inside(fs.realpathSync(artifactRoot),root)) throw Error("Check artifacts must be outside the execution folder.");
  const temp=fs.mkdtempSync(path.join(artifactRoot,"check-temp-"));
  for(const key of Object.keys(env)) if(["TEMP","TMP","TMPDIR"].includes(key.toUpperCase())) delete env[key];
  Object.assign(env,{TEMP:temp,TMP:temp,TMPDIR:temp});
  return {command:binary.command,args:[...(binary.prefix || []),"sandbox","-c",'sandbox_mode="workspace-write"',"-c","sandbox_workspace_write.network_access=false","-c","sandbox_workspace_write.exclude_tmpdir_env_var=true","-c","sandbox_workspace_write.exclude_slash_tmp=true","-c","sandbox_workspace_write.writable_roots="+JSON.stringify([temp.replaceAll("\\","/")]),...shellEnvironmentPolicy(check.passEnv),"--",check.command,...(check.args||[])],env,executedIn:"sandbox",tempDirectory:temp,cleanup:()=>fs.rmSync(temp,{recursive:true,force:true})};
}
export function sandboxLimitation(text,cwd) {
  if(/CreateProcessAsUserW|(?:taskkill|WMI|Win32_Process)[\s\S]{0,400}(?:Access (?:is )?denied|EPERM|EACCES)/i.test(text)) return true;
  if(!/EPERM|EACCES|Access is denied/i.test(text)) return false;
  return (text.match(/[A-Za-z]:[\\/][^\r\n'"<>]+|\/(?:tmp|home|etc|var|Users)\/[^\r\n'"<> ]+/g)||[]).some(file=>!inside(path.resolve(file.trim()),path.resolve(cwd)));
}
