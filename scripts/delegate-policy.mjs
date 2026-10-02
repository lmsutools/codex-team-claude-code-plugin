/** A host ownership delegate is usable only from its unchanged, reviewed execution folder. */
import fs from "node:fs";
import path from "node:path";
import {inside} from "./check-executable.mjs";
import {digest,readProject,expand} from "./policy-core.mjs";
import {variables} from "./profile.mjs";
export function delegateInputs(profile,cwd) {
  const config=profile.components?.ownership;
  if(!config?.delegateCommand) return null;
  const names=new Set([...(config.delegateFiles || []),...Object.keys(profile.references || {})]);
  for(const token of expand(config.delegateCommand,variables(profile,cwd,{worktree:cwd}))) {
    const file=path.resolve(cwd,token);
    if(inside(file,cwd) && fs.existsSync(file) && fs.statSync(file).isFile()) names.add(path.relative(cwd,file).replaceAll("\\","/"));
  }
  const hashes={};for(const name of names) hashes[name]=digest(readProject(profile,cwd,name));
  return {hashes,folders:[...new Set([...names].map(name=>path.posix.dirname(name)))].length ? [...new Set([...names].map(name=>path.posix.dirname(name)))] : ["."]};
}
export function delegateUnavailable(state,changed) {
  if(path.resolve(state.executionCwd).toLowerCase()!==path.resolve(state.cwd).toLowerCase()) return "Ownership delegate unavailable: isolated execution folder; sandboxed delegates are deferred to 1.1.7.";
  const inputs=state.policyBaseline?.delegate;
  if(!inputs) return "Ownership delegate unavailable: no execution-folder baseline.";
  if(state.hiddenChanges?.status!=="available" || state.hiddenChanges.omitted) return "Ownership delegate unavailable: hidden changes are not fully observed.";
  const files=[...changed,...state.hiddenChanges.entries.map(e=>e.file)];
  if(files.some(file=>inputs.folders.some(folder=>folder==="." || file===folder || file.startsWith(folder+"/") || folder.startsWith(file.endsWith("/")?file:file+"/")))) return "Ownership delegate unavailable: job changed a tracked or hidden path under the delegate folder.";
  const current=delegateInputs(state.profile,state.executionCwd);
  if(JSON.stringify(current.hashes)!==JSON.stringify(inputs.hashes)) return "Ownership delegate unavailable: delegate or reference hashes changed in execution folder.";
  return null;
}
