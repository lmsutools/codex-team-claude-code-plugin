/** Check request freshness without ignored walks or timestamp fingerprints. */
import {gitSecuritySnapshot} from "./git-security.mjs";
import {snapshot} from "./git.mjs";
import {requireHostAck,verificationCommands} from "./sandbox-checks.mjs";
import {finishVisibility} from "./visibility.mjs";
import {jobDirectory} from "./state-reader.mjs";
import {changes} from "./git.mjs";
export const orderedChecks = state => [...verificationCommands(state)].sort((a,b)=>Number(!!b.host)-Number(!!a.host));
export function inspectHostCheck(state) {
  const before=snapshot(state.executionCwd),observed=finishVisibility(state,jobDirectory(state.jobId));
  const current={...state,...observed};
  try {requireHostAck(current,state.hostAck,before);}
  catch (failure) {
    const paths=[...changes(state.verificationBaseline,before).files,...observed.hiddenChanges.entries.map(e=>e.file),...(observed.gitConfigChanged.changed?observed.gitConfigChanged.paths:[])];
    const error=Error("Host check refused: "+failure.message+" Paths: "+([...new Set(paths)].slice(0,40).join(", ") || "Git/hidden listing unavailable or changed"));
    error.visibility=observed;throw error;
  }
  return {before,...observed};
}
export function inspectVerificationRequest(state) {
  const before=snapshot(state.executionCwd);
  if(before.fingerprint!==state.verificationBaseline.fingerprint) {
    if(verificationCommands(state).some(check=>check.host)) inspectHostCheck(state);
    throw Error("Files changed between verification request and worker startup; inspect and verify again.");
  }
  if(verificationCommands(state).some(check=>check.host)) {
    if(state.gitConfigChanged?.hash && gitSecuritySnapshot(state.executionCwd).hash!==state.gitConfigChanged.hash) inspectHostCheck(state);
    requireHostAck(state,state.hostAck,before.fingerprint);
  }
  return {before};
}
