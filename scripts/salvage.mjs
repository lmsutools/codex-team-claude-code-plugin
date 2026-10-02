/** One bounded same-thread read-only final report, never a replay of implementation. */
import fs from "node:fs";
import path from "node:path";
import { assertReviewInstructions } from "./review-instructions.mjs";
import { snapshot } from "./git.mjs";
import { report, scoutReport } from "./contracts.mjs";
export const salvageSeconds = state => state.salvageSeconds ?? Math.min(300, state.timeoutSeconds * .1);
export function canSalvage(state, result, cancelled = false) {
  return !cancelled && result.stopReason === "timed_out" && !!state.threadId && !state.salvage && salvageSeconds(state) > 0;
}
export async function salvageRun(state, { runProcess, buildArgs, binary, reportPath, eventsFile, errorFile, persist, onEvent }) {
  const at = new Date().toISOString(), until = new Date(Date.now()+salvageSeconds(state)*1000).toISOString();
  let salvage = {reason:"deadline", at, until, execAttempt:(state.execAttempt || 0)+1, outcome:"running"};
  await persist(state.jobId,{salvage,livePhase:"finalizing"});
  let result = {code:null,stopReason:"timed_out"}, completed = false, failed = false, usedTool = false;
  try {
    const before = snapshot(state.executionCwd);
    if (!before.available) throw Error("Finalize requires an available Git snapshot");
    if (Date.now() >= Date.parse(until)) throw Error("Finalize window expired");
    if(fs.existsSync(reportPath)) fs.unlinkSync(reportPath);
    const finalState = {...state, salvage, readOnly:true, assignment:state.assignment || {}, execAttempt:salvage.execAttempt};
    const args=buildArgs(finalState,reportPath);
    args.splice(1,0,"-c","project_doc_max_bytes=0");
    try { assertReviewInstructions(state); }
    catch (error) { salvage.outcome="config_changed"; salvage.error=error.message; throw error; }
    result = await runProcess(finalState,binary.command,[...binary.prefix,...args],{
      input:(state.mode === "scout" ? "DEADLINE FINALIZE: Return the scout brief with files citing existing file line ranges already read in this thread. " : "DEADLINE FINALIZE: ") + " No tools. Return the final JSON report now. Mark all unfinished or unverified work explicitly; checks are claims, not verification. Do not edit any project file. This is the sole read-only finalize turn.\n",
      eventsFile,errorFile,stopRequested: () => usedTool ? "failed" : null,timeoutSeconds:Math.max(0,(Date.parse(until)-Date.now())/1000),onEvent: event => {
        if (event.item && !["agent_message", "reasoning", "todo_list"].includes(event.item.type)) usedTool = true;
        if (event.type === "turn.started") { completed = false; failed = false; }
        if (event.type === "turn.completed") completed = true;
        if (event.type === "turn.failed") failed = true;
        onEvent?.(event);
      },
    });
    if(result.stopReason === "cancelled" || fs.existsSync(path.join(path.dirname(eventsFile), "cancel"))) salvage.outcome="cancelled";
    else if(result.stopReason === "timed_out" || Date.now()>Date.parse(until)) salvage.outcome="window_overrun";
    else {
      const after = snapshot(state.executionCwd);
      if (!after.available) throw Error("Finalize requires an available Git snapshot");
      if (Date.now() >= Date.parse(until)) salvage.outcome = "window_overrun";
      else if (before.fingerprint !== after.fingerprint) salvage.outcome = "files_changed";
      else {
        const value=JSON.parse(fs.readFileSync(reportPath,"utf8"));
        if(state.mode === "scout") scoutReport(value); else report(value);
        salvage.outcome=result.code === 0 && completed && !failed && !usedTool && !result.parseError ? "salvaged" : "invalid_report";
      }
    }
  } catch { if (salvage.outcome !== "config_changed") salvage.outcome=Date.now() >= Date.parse(until) ? "window_overrun" : "invalid_report"; }
  await persist(state.jobId,{salvage});
  return {...result,stopReason:salvage.outcome === "salvaged" ? null : salvage.outcome === "cancelled" ? "cancelled" : "timed_out",salvage};
}
