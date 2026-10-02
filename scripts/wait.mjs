process.env.NoDefaultCurrentDirectoryInExePath = "1";
/** Background lead waiter: observes durable milestones, without writable-store imports. */
import { runObservation, stallCrossing } from "./run-observation.mjs";
import { registerWatcher, waiterLine } from "./watchers.mjs";
import { untrustedOutput } from "./untrusted-output.mjs";
import { boundedPacket } from "./decision-packet.mjs";
import { reportPreview, SCOUT_NEXT } from "./report-preview.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJob, jobDirectory, stateRoot, isBusy } from "./state-reader.mjs";
import { checksSummary, oneLine } from "./tool-output.mjs";
const active = new Set(["starting", "running", "verifying"]);
export function reached(state, mode) {
  return !active.has(state.status) || (mode === "finish" && !!state.implementationFinishedAt);
}
const alive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
};
export function stale(state, now = Date.now()) {
  const beat = Date.parse(state.heartbeatAt || state.updatedAt || state.startedAt);
  return active.has(state.status) && now - beat > 15000 &&
    !alive(state.workerPid) && !alive(state.supervisorPid);
}
/** Verification gets its own check budget even after the implementation deadline. */
export function waitDeadline(state, startedAt = Date.now()) {
  const original = Date.parse(state.deadlineAt), finalize = Date.parse(state.salvage?.until);
  const deadline = Number.isFinite(finalize) ? Math.max(original || 0, finalize) : original;
  const timeout = Number(state.timeoutSeconds) || 1800;
  if (state.livePhase === "reviewer") return Math.max(Number.isFinite(deadline) ? deadline : 0, Date.parse(state.reviewerStartedAt || state.verification?.finishedAt || new Date(startedAt).toISOString()) + (timeout + 60) * 1000);
  if (state.status === "verifying") {
    const checks = state.checkPlan?.checks || state.assignment?.verification || [];
    const budget = checks.reduce((sum, check) => sum +
      (Number(check.timeoutSeconds) || timeout) * (1 + (check.retryOnTimeout || 0)), 0) || timeout;
    const verificationStart = Date.parse(state.verification?.startedAt);
    const verificationDeadline = (Number.isFinite(verificationStart) ? verificationStart : startedAt) + (budget + 60) * 1000;
    return Math.max(verificationDeadline, Number.isFinite(deadline) ? deadline + 60000 : 0);
  }
  return Number.isFinite(deadline) ? deadline + 60000 : startedAt + (timeout + 60) * 1000;
}
function reportSummary(state, dir) {
  if (state.result?.summary !== undefined) return oneLine(state.result.summary, 800);
  if (state.assignment) return "";
  const file = path.join(dir, "report.txt");
  if (!fs.existsSync(file)) return "";
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(3200);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return oneLine(buffer.subarray(0, size).toString("utf8"), 800);
  } finally { fs.closeSync(fd); }
}
export function packet(state, root = stateRoot()) {
  const dir = jobDirectory(state.jobId, root);
  if (state.decisionPacket) return boundedPacket({ ...state.decisionPacket, ...runObservation(state), packetStatus: state.decisionPacket.status, status: state.status, ...(state.cancelled ? { cancelled: true } : {}), ...reportPreview(state, 300),
    ...(state.handbookPublication ? { handbookPublication: state.handbookPublication } : {}),
    artifactPath: state.decisionPacketPath || path.join(dir, "decision-packet.json") });
  const result = { ...runObservation(state), jobId: state.jobId, status: state.status, progress: oneLine(state.progress || state.status),
    ...(state.mode === "scout" ? { mode: "scout", draftObjective: oneLine(state.result?.draftAssignment?.objective, 800) } : {}),
    ...reportPreview(state, 1000),
    ...(state.mode === "scout" && state.status === "implementation_finished" ? { next: SCOUT_NEXT } : {}),
    ...(state.handbookPublication ? { handbookPublication: state.handbookPublication } : {}),
    sandboxLimitsCount: state.result?.sandboxLimits?.length || 0,
    ...(state.gitConfigChanged ? { gitConfigChanged: state.gitConfigChanged } : {}),
    ...(state.hiddenChanges ? { hiddenChanges: structuredClone(state.hiddenChanges) } : {}),
    changedFileCount: state.changes?.files?.length ?? 0, checks: checksSummary(state),
    blockers: (state.result?.blockers || []).slice(0, 8).map(v => oneLine(v, 250)),
    reportSummary: reportSummary(state, dir), error: oneLine(state.error, 400),
    reportPath: path.join(dir, "report.txt"), logDirectory: dir,
    logs: [path.join(dir, "events.jsonl"), path.join(dir, "stderr.log")] };
  if (state.autoVerifySkipped) result.autoVerifySkipped = { reason: oneLine(state.autoVerifySkipped.reason, 300), paths: (state.autoVerifySkipped.paths || []).slice(0, 8).map(p => oneLine(p, 160)), omittedPaths: Math.max(0, (state.autoVerifySkipped.paths?.length || 0) - 8) };
  if (state.cancelled) result.cancelled = true;
  if (state.runtimeFailure) result.runtimeFailure = oneLine(state.runtimeFailure.code || state.runtimeFailure.category);
  if (state.orphanProcessAlive) result.orphanProcessAlive = true;
  while (JSON.stringify(untrustedOutput(result)).length > 6000 && result.blockers.length) result.blockers.pop();
  for (const key of ["reportSummary", "draftObjective", "progress", "error", "draftScopePreview", "draftVerificationPreview", "handbookNotesPreview"])
    while (JSON.stringify(untrustedOutput(result)).length > 6000 && result[key]?.length) {
      result[key] = result[key].slice(0, Math.floor(result[key].length / 2));
      if (key === "draftScopePreview") result.draftScopeTruncated = true;
      if (key === "draftVerificationPreview") result.draftVerificationTruncated = true;
    }
  while (JSON.stringify(untrustedOutput(result)).length > 6000 && result.autoVerifySkipped?.paths.length) {
    result.autoVerifySkipped.paths.pop(); result.autoVerifySkipped.omittedPaths++;
  }
  while (JSON.stringify(untrustedOutput(result)).length > 6000 && result.hiddenChanges?.entries.length) { result.hiddenChanges.entries.pop(); result.hiddenChanges.omitted++; }
  if (JSON.stringify(untrustedOutput(result)).length > 6000) throw new Error("Artifact paths exceed waiter packet bound.");
  return untrustedOutput(result);
}
export function parseArgs(args) {
  const [jobId, ...options] = args;
  jobDirectory(jobId);
  const result = { jobId, mode: "decision" };
  const seen = new Set();
  for (let i = 0; i < options.length; i += 2) {
    const flag = options[i], value = options[i + 1];
    if (seen.has(flag) || value === undefined) throw new Error("Invalid waiter arguments.");
    seen.add(flag);
    if (flag === "--for" && ["finish", "decision"].includes(value)) result.mode = value;
    else if (flag === "--timeout" && /^\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value))) result.timeoutSeconds = Number(value);
    else if (flag === "--stall-minutes" && /^\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value))) result.stallMinutes = Number(value);
    else if (flag === "--heartbeat" && /^\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)) && Number(value) > 0) result.heartbeatMinutes = Number(value);
    else throw new Error("Usage: wait.mjs <jobId> [--for finish|decision] [--timeout seconds] [--heartbeat minutes]");
  }
  return result;
}
export async function waitForJob({ jobId, mode = "decision", timeoutSeconds, heartbeatMinutes, stallMinutes = 15, pollMs = 2000, root = stateRoot(), onStart }) {
  if (heartbeatMinutes !== undefined && (!Number.isFinite(heartbeatMinutes) || heartbeatMinutes <= 0)) throw Error("Invalid heartbeat minutes.");
  if (!Number.isFinite(stallMinutes) || stallMinutes < 0) throw Error("Invalid stall minutes.");
  const started = Date.now();
  const crossedStall = stallCrossing(stallMinutes, started);
  let deadline = started + (timeoutSeconds === undefined ? 30 : timeoutSeconds) * 1000;
  let loaded = false;
  let unregister = () => {}, initialPhase;
  try { while (true) {
    try {
      const state = readJob(jobId, root);
      if (timeoutSeconds === undefined && (!loaded || state.status === "verifying")) deadline = waitDeadline(state, started);
      if (!loaded) {
        const until = Math.min(deadline, heartbeatMinutes === undefined ? Infinity : started + heartbeatMinutes * 60000);
        unregister = registerWatcher(root, jobId, until);
        onStart?.(waiterLine(state, until));
        initialPhase = state.livePhase || state.status;
      }
      else if (initialPhase !== (state.livePhase || state.status)) return packet(state, root);
      loaded = true;
      if (reached(state, mode)) return packet(state, root);
      const observation = runObservation(state);
      if (crossedStall(observation)) return untrustedOutput({ jobId, stall:true, phase:state.livePhase || state.status, ...observation });
      if (heartbeatMinutes !== undefined && Date.now() - started >= heartbeatMinutes * 60000)
        return untrustedOutput({ ...runObservation(state), jobId, heartbeat: true, status: state.status, elapsedSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(state.startedAt || new Date(started).toISOString())) / 1000)),
          progress: oneLine(state.progress || state.status), livePhase: state.livePhase || state.status });
      if (stale(state)) {
        const error = new Error(`Worker is stale and no worker or supervisor is alive. Call codex_status for job ${jobId} to recover its state.`);
        error.exitCode = 3;
        throw error;
      }
    } catch (error) {
      if (!isBusy(error)) throw error;
    }
    if (Date.now() >= deadline) throw new Error("Timed out waiting for job.");
    await new Promise(resolve => setTimeout(resolve, Math.max(1, Math.min(pollMs, deadline - Date.now(), heartbeatMinutes === undefined ? Infinity : started + heartbeatMinutes * 60000 - Date.now()))));
  }} finally { unregister(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await waitForJob({ ...parseArgs(process.argv.slice(2)), onStart: line => console.log(line) }))); }
  catch (error) { console.error(oneLine(error.message, 500)); process.exitCode = error.exitCode || 1; }
}
