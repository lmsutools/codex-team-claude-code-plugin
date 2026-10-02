/** Explicit doctor probe for command, write and environment containment; network is opt-in. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {randomUUID} from "node:crypto";
import {spawnSync} from "node:child_process";
import {checkInvocation} from "./sandbox-checks.mjs";
import {CORE_ENV,checkEnvironment} from "./host-security.mjs";
export function sandboxProbe(binary,cwd,{probeNetwork,run=spawnSync}={}) {
  if(probeNetwork!==undefined && !/^(?:\[[0-9a-f:]+\]|[a-z0-9.-]+):(?:[1-9]\d{0,4})$/i.test(probeNetwork)) throw Error("probeNetwork must be a host:port.");
  if(probeNetwork && Number(probeNetwork.split(":").at(-1))>65535) throw Error("Invalid probeNetwork port.");
  const dir=fs.mkdtempSync(path.join(cwd,".codex-team-sandbox-probe-")),outside=path.join(os.tmpdir(),"codex-team-outside-probe-"+randomUUID());
  const script='const fs=require("node:fs");let inside=false,outsideBlocked=false;try{fs.writeFileSync("inside","probe");inside=true;}catch{}try{fs.writeFileSync('+JSON.stringify(outside)+',"probe");}catch(e){outsideBlocked=["EPERM","EACCES"].includes(e.code)||/Access is denied/i.test(e.message);}const allowed=new Set('+JSON.stringify(CORE_ENV.map(k=>k.toUpperCase()))+');const names=Object.keys(process.env);const codexInjected=names.filter(k=>/^(?:GIT_CONFIG_COUNT|GIT_CONFIG_(?:KEY|VALUE)_[0-9]+|GIT_PAGER|PAGER|LESS)$/.test(k)).sort();const injected=new Set(codexInjected);const unexpected=names.filter(k=>!allowed.has(k.toUpperCase())&&!injected.has(k));const result={commandRan:true,insideWrite:inside,outsideWriteBlocked:outsideBlocked,envAllowlist:unexpected.length===0,unexpectedNames:unexpected,codexInjected};'+(probeNetwork ? 'const net=require("node:net");const target='+JSON.stringify(probeNetwork)+';const port=Number(target.slice(target.lastIndexOf(":")+1)),host=target.slice(0,target.lastIndexOf(":")).replace(/^\\[|\\]$/g,"");const s=net.connect({host,port});let finished=false;const done=v=>{if(finished)return;finished=true;s.destroy();result.network=v;console.log(JSON.stringify(result));};s.on("connect",()=>done("reachable"));s.on("error",e=>done(["EPERM","EACCES"].includes(e.code)?"blocked":"inconclusive: "+e.code));s.setTimeout(3000,()=>done("inconclusive: timeout"));' : 'console.log(JSON.stringify(result));');
  let invocation;
  try {
    const probeScript=script.replace('const result={commandRan:true', 'let privateTempWrite=false;try{fs.writeFileSync(require("node:path").join(process.env.TEMP,"private-probe"),"probe");privateTempWrite=true;}catch{}const result={hostTempWriteBlocked:outsideBlocked,privateTempWrite,commandRan:true');
    invocation=checkInvocation({executionCwd:dir}, {command:process.execPath,args:["-e",probeScript]},binary);
    const result=run(invocation.command,invocation.args,{cwd:dir,env:invocation.env,encoding:"utf8",timeout:30000,windowsHide:true,maxBuffer:1048576});
    let observed;try{observed=JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));}catch{}
    const passed=result.status===0 && observed?.commandRan && observed.insideWrite && observed.hostTempWriteBlocked && observed.privateTempWrite && observed.envAllowlist;
    return {status:passed?"passed":"failed",probeExecuted:true,executedIn:"sandbox",...observed,...(probeNetwork?{probeNetwork}:{}),networkIsolation:observed?.network==="blocked"?"confirmed":"unconfirmed",...(passed?{}:{error:String(result.error?.message||result.stderr||"Containment probe failed").slice(-2000)})};
  } finally {invocation?.cleanup?.();fs.rmSync(dir,{recursive:true,force:true});fs.rmSync(outside,{force:true});}
}
