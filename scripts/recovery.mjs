/** Pure recovery policy and final-turn diagnostics; model prose is not failure evidence. */
import { classifyFailure } from "./diagnostics.mjs";
const prohibited = /denied|not authorized|permission|contract|invalid structured|malformed|budget|secret|cancel|deadline|timed.out|database.*(?:locked|busy)|SQLITE_(?:BUSY|LOCKED)/i;
const transport = /stream (?:disconnected|closed)|connection (?:reset|closed)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network (?:error|failure)|error sending request|failed to (?:fetch|connect)|rate.?limit|\b429\b/i;
const http5xx = /\b(?:HTTP(?:\/\d(?:\.\d)?)?\s*[:=]?\s*|status(?:\s+code)?[\s:=]+)5\d\d\b|\b5\d\d\s+(?:Bad Gateway|Internal Server Error|Service Unavailable|Gateway Time(?:out|[- ]out)|HTTP Version Not Supported)\b/i;
/** Reconnect notices from recovered turns must not classify a later failure. */
export function failureTracker() {
  let completed = false, failed = "", lastError = "";
  return {
    note(event) {
      if (event.type === "turn.started") {
        completed = false; failed = ""; lastError = "";
      } else if (event.type === "turn.completed") {
        completed = true; failed = ""; lastError = "";
      } else if (event.type === "turn.failed") {
        completed = false;
        failed = event.error?.message || event.message || "Codex turn failed.";
      } else if (event.type === "error") {
        lastError = event.message || event.error?.message || "";
      }
    },
    text(stderr = "") { return (failed || (completed ? "" : lastError || stderr)).slice(-6000); },
  };
}
/**
 * A Windows sandbox runner that did not start in time (spawn_ready) is a load or
 * first-run symptom, not a permission failure. The same thread may resume once
 * the next preflight (with the long first-run bound) proves the runner starts.
 */
function spawnTimeoutResumable(state, orphanAlive) {
  const failure = state.runtimeFailure;
  if (failure?.code !== "sandbox_spawn_timeout" || !failure.transient) return false;
  if (!["blocked_runtime", "starting"].includes(state.status)) return false;
  if (state.contractFailure || state.commandDenied || state.cancellationRequested) return false;
  if (state.deadlineAt && Date.now() >= Date.parse(state.deadlineAt)) return false;
  if (!state.threadId || orphanAlive || state.budget?.exceeded?.length || state.budget?.atLimit?.length) return false;
  return !(state.autoResumes || []).some(r => r.reason === "sandbox_spawn_timeout");
}
export function classifyTransientFailure(state, { crashed = false, orphanAlive = false } = {}) {
  if (!crashed && spawnTimeoutResumable(state, orphanAlive)) return "sandbox_spawn_timeout";
  // A completed worker already recorded structured exclusions. Crash diagnostics
  // come only from stderr/worker-fault, never model or command events.jsonl text.
  const text = crashed
    ? [state.workerFault?.message, state.recoveryDiagnostics].filter(Boolean).join("\n")
    : state.cliFailure || "";
  if (
    state.runtimeFailure || classifyFailure(text) || prohibited.test(text) ||
    state.contractFailure || state.commandDenied || state.cancellationRequested ||
    (state.deadlineAt && Date.now() >= Date.parse(state.deadlineAt))
  ) return null;
  if (!["failed", "running", "starting", "interrupted"].includes(state.status)) return null;
  if (!state.threadId || orphanAlive || state.budget?.exceeded?.length || state.budget?.atLimit?.length) return null;
  if (crashed) return "worker_crash";
  if (transport.test(text) || http5xx.test(text))
    return /rate.?limit|\b429\b/i.test(text) ? "rate_limit" : "cli_transport";
  return null;
}
export function planAutoResume(state, options = {}) {
  const reason = classifyTransientFailure(state, options);
  const attempt = (state.autoResumes?.length || 0) + 1;
  if (!reason || attempt > 2) return null;
  const delays = options.delays || [30000, 120000];
  return {
    attempt, reason,
    scheduledAt: new Date((options.now ?? Date.now()) + delays[attempt - 1]).toISOString(),
    startedAt: null, finishedAt: null, outcome: "scheduled",
  };
}
export function continuationPrompt(state) {
  const reason = state.autoResumes?.at(-1)?.reason || "interruption";
  if (state.mode === "scout") return "Continue the same read-only exploration; do not implement or edit. Return the strict scout brief.";
  if (reason === "sandbox_spawn_timeout") return "The Windows sandbox runner timed out while starting (spawn_ready). It has been re-checked and starts again. Continue the same assignment from where you stopped: retry the tool call that failed, re-check the working tree before editing, and do not redo completed edits. Return the requested final report.";
  return `You were interrupted by a transient ${reason}. Continue the same assignment from where you stopped; re-check the working tree before editing; do not redo completed edits. Return the requested final report.`;
}
export function resetExecState(state) {
  return {
    status: "starting", recoveryPhase: null, reservation: null,
    error: null, lastDiagnostic: null, cliFailure: null,
    contractFailure: false, commandDenied: false,
    result: null, runtimeFailure: null, finishedAt: null, exitCode: null, signal: null,
    usage: null, progress: "Automatically resuming the saved thread.", modelStarted: false,
    durationMs: null, childStartedAt: null, modelChildStartedAt: null,
    lastCommand: null, lastCommandStatus: null, lastCommandExitCode: null,
    codexPid: null, workerPid: null, implementationFingerprint: null, implementationFinishedAt: null,
    verification: null, verifiedFingerprint: null, acceptedFingerprint: null,
    workerFault: null, orphanProcessAlive: false,
    execAttempt: (state.execAttempt || 0) + 1,
  };
}
