/** Presentation at the public MCP boundary; internal calls retain complete records. */
import { runObservation, otherActiveJobs } from "./run-observation.mjs";
import { untrustedOutput } from "./untrusted-output.mjs";
import { reportPreview, SCOUT_NEXT } from "./report-preview.mjs";
import { fileURLToPath } from "node:url";
export function validateDetail(detail = "compact") {
  if (!["compact", "full"].includes(detail)) throw new Error("Invalid detail; use compact or full.");
  return detail;
}
export const oneLine = (value, limit = 200) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
export function waitCommand(jobId, script = fileURLToPath(new URL("./wait.mjs", import.meta.url))) {
  if (typeof jobId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(jobId) || typeof script !== "string") return;
  const file = script.replaceAll("\\", "/");
  // Both shells expand these characters even within double quotes.
  if (/["`$!\x00-\x1f\u201c\u201d\u201e]/.test(file) || file.length > 600 || !/^(?:[A-Za-z]:\/|\/)/.test(file))
    return;
  return `node --no-warnings "${file}" ${jobId} --for decision`;
}
export function checksSummary(state) {
  const checks = state.verification?.checks || [];
  return { status: oneLine(state.verification?.status || "not_run", 40), total: checks.length,
    passed: checks.filter(c => c.status === "passed").length,
    failed: checks.filter(c => c.status !== "passed" && c.status !== "running").length };
}
export function compactJob(state, { waitScript, showAutoVerify = false } = {}) {
  const active = ["starting", "running", "verifying"].includes(state.status);
  const finishedScout = state.mode === "scout" && state.status === "implementation_finished";
  const command = active ? waitCommand(state.jobId, waitScript) : undefined;
  const result = {
    ...runObservation(state),
    ...(state.timeoutSeconds !== undefined ? {timeoutSeconds:state.timeoutSeconds,...(state.timeoutBasis !== undefined ? {timeoutBasis:state.timeoutBasis} : {})} : {}),
    ...(state.typicalDurationSeconds !== undefined ? {typicalDurationSeconds:state.typicalDurationSeconds} : {}),
    ...(state.otherActiveJobs ? {otherActiveJobs:state.otherActiveJobs.map(job=>({...job}))} : {}),
    ...(state.review ? { reviewMode: state.review.mode } : {}),
    ...(showAutoVerify && state.autoVerify !== undefined ? {autoVerify:state.autoVerify,autoVerifyReason:state.autoVerifyReason} : {}),
    jobId: state.jobId, status: oneLine(state.status, 60),
    progress: oneLine(state.progress || state.status),
    ...(state.mode ? { mode: state.mode } : {}),
    ...reportPreview(state),
    ...(state.handbookPublication ? { handbookPublication: state.handbookPublication } : {}),
    sandboxLimitsCount: state.result?.sandboxLimits?.length || 0,
    ...(state.hiddenChanges ? { hiddenChanges: { ...state.hiddenChanges, reason: oneLine(state.hiddenChanges.reason, 160), entries: state.hiddenChanges.entries.slice(0, 2).map(e => ({ ...e, file: oneLine(e.file, 80) })), omitted: Math.max(0, state.hiddenChanges.total - 2) } } : {}),
    ...(state.reviewFingerprint !== undefined ? {reviewFingerprint:state.reviewFingerprint,...(state.reviewFingerprintReason?{reviewFingerprintReason:oneLine(state.reviewFingerprintReason,160)}:{})} : {}),
    ...(state.gitConfigChanged ? {gitConfigChanged:state.gitConfigChanged} : {}),
    changedFileCount: state.changes?.files?.length ?? 0,
    checks: checksSummary(state),
    ...(state.decisionPacket ? { packet: { status: state.decisionPacket.status,
      met: state.decisionPacket.criteria.filter(c => c.verdict === "met").length,
      total: state.assignment?.acceptanceCriteria?.length ?? state.decisionPacket.criteria.length,
      risks: state.decisionPacket.risks.length, omittedHunks: state.decisionPacket.omittedHunks } } : {}),
    ...(state.livePhase ? { livePhase: state.livePhase } : {}),
    ...(state.autoVerifySkipped ? { autoVerifySkipped: { reason: oneLine(state.autoVerifySkipped.reason, 160), paths: (state.autoVerifySkipped.paths || []).slice(0, 2).map(p => oneLine(p, 80)), omittedPaths: Math.max(0, (state.autoVerifySkipped.paths?.length || 0) - 2) } } : {}),
    ...(state.cancelled ? { cancelled: true } : {}),
    pendingEvidence: state.pendingEvidence?.length || 0,
    next: active && !command ? "Wait command unavailable for this path; poll codex_status with waitSeconds=20." : finishedScout ? SCOUT_NEXT : oneLine(state.next, 160),
    ...(command ? { waitCommand: command } : {}),
  };
  for (const key of ["cancellationRequested", "acceptanceCurrent", "orphanProcessAlive", "commandDenied", "contractFailure"])
    if (state[key] !== undefined) result[key] = !!state[key];
  if (state.error) result.error = oneLine(state.error, 120);
  if (state.runtimeFailure) result.runtimeFailure = oneLine(state.runtimeFailure.code || state.runtimeFailure.category || "blocked_runtime", 80);
  if (state.cancellationError) result.cancellationError = oneLine(state.cancellationError, 80);
  if (state.result?.blockers?.length) result.blockerCount = state.result.blockers.length;
  if (state.autoResumes?.length) result.autoResumeCount = state.autoResumes.length;
  // Completed scout previews take priority over optional learned-timing detail.
  // Otherwise accumulated run statistics can truncate a one-file draft scope.
  if (finishedScout && JSON.stringify(untrustedOutput(result)).length > 1500) {
    delete result.timeoutBasis; delete result.typicalDurationSeconds;
  }
  // Escape-heavy diagnostic text must also respect the serialized character cap.
  for (const key of ["progress", "readableTail", ...(finishedScout ? [] : ["next"]), "error", "cancellationError", "runtimeFailure", "status", "draftScopePreview", "draftVerificationPreview", "handbookNotesPreview"])
    while (JSON.stringify(untrustedOutput(result)).length > 1500 && result[key]?.length > (key === "draftVerificationPreview" ? 48 : 0))
      {
        result[key] = result[key].slice(0, Math.max(key === "draftVerificationPreview" ? 48 : 0, Math.floor(result[key].length / 2)));
        if (key === "draftScopePreview") result.draftScopeTruncated = true;
        if (key === "draftVerificationPreview") result.draftVerificationTruncated = true;
      }
  while (JSON.stringify(untrustedOutput(result)).length > 1500 && result.autoVerifySkipped?.paths.length) {
    result.autoVerifySkipped.paths.pop(); result.autoVerifySkipped.omittedPaths++;
  }
  while (JSON.stringify(untrustedOutput(result)).length > 1500 && result.autoVerifySkipped?.reason.length)
    result.autoVerifySkipped.reason = result.autoVerifySkipped.reason.slice(0, Math.floor(result.autoVerifySkipped.reason.length / 2));
  while (JSON.stringify(untrustedOutput(result)).length > 1500 && result.hiddenChanges?.entries.length) { result.hiddenChanges.entries.pop(); result.hiddenChanges.omitted++; }
  while (JSON.stringify(untrustedOutput(result)).length > 1500 && result.otherActiveJobs?.length) result.otherActiveJobs.pop();
  while (JSON.stringify(untrustedOutput(result)).length > 1500 && result.bootstrapReads?.paths?.length) result.bootstrapReads = { ...result.bootstrapReads, paths: result.bootstrapReads.paths.slice(0, -1) };
  return untrustedOutput(result);
}
const pick = (value, keys, limit = 200) => Object.fromEntries(keys.filter(k => value?.[k] !== undefined).map(k => [k,
  typeof value[k] === "string" ? oneLine(value[k], limit) : value[k]]));
export function compactResult(name, value) {
  if (name === "codex_start" && !Object.hasOwn(value,"otherActiveJobs")) value = { ...value, otherActiveJobs: otherActiveJobs(value.jobId) };
  if (value.jobId && value.status) return compactJob(value, {showAutoVerify:name === "codex_start"});
  if (name === "codex_status") return { jobs: (value.jobs || []).slice(0, 3).map(compactJob), total: value.jobs?.length || 0, omitted: Math.max(0, (value.jobs?.length || 0) - 3) };
  switch (name) {
    case "codex_doctor": return {
      ...pick(value, ["available", "authenticated", "version", "readiness", "error", "hint"]),
      verificationSandbox: value.verificationSandbox,
      sandbox: { ...pick(value.sandbox, ["status"]), ...pick(value.sandbox?.failure, ["code"]) },
      runtimeFailure: value.job?.runtimeFailure
        ? oneLine(value.job.runtimeFailure.code || value.job.runtimeFailure.category) : null,
      ownership: {
        ...pick(value.diagnostics?.ownership, ["mismatch", "orphanedOwner"]),
        ...pick(value.diagnostics?.ownership, ["detail"], 600),
        ...pick(value.diagnostics?.ownership?.repair, ["requiresAdministrator"]),
        repair: pick(value.diagnostics?.ownership?.repair, ["command"], 600),
      },
    };
    case "codex_context": return { ...(value.jobs && value.context ? {context:value.context} : {}), ...(value.jobs ? {jobs:value.jobs,totalJobCount:value.totalJobCount,jobsDetail:value.jobsDetail} : {}), ...(value.context || value.version !== undefined ? { version: value.version ?? value.context.version } : {}),
      ...(value.handbook ? { handbook: pick(value.handbook, ["size", "version"]) } : {}) };
    case "codex_profile": return { present: !!value.profile, hash: value.profile?.hash || null, approved: !!value.approved, compatibleWith: value.compatibleWith };
    case "codex_batch": return { ...pick(value, ["batchId", "status", "unionJobId", "reviewFingerprint", "gitConfigChanged"]), children: (value.children || []).slice(0, 20).map(c => pick(c, ["jobId", "status"])), childCount: value.children?.length || 0 };
    case "codex_report": return { ...pick(value, ["status", "commit", "path", "expectedTargetHash"]), target: pick(value.target, ["file", "expectedTargetHash"]), rendered: !!value.markdown };
    case "codex_handoff": return { ...pick(value, ["file", "written", "expectedTargetHash"]), version: value.contextVersion ?? value.context?.version ?? value.version ?? null, contentHash: value.contentHash, exported: !!value.text };
    case "codex_hygiene": return { ...pick(value, ["fingerprint"]), findingCount: value.findings?.length || 0, fixedCount: value.fixed?.length || 0 };
    default: return pick(value, ["status", "commit", "branch", "remote", "pushed", "cancellationRequested"]);
  }
}
export async function invokeTool(name, handler, input = {}) {
  const { detail, ...business } = input;
  const mode = validateDetail(detail);
  const result = await handler(business);
  return untrustedOutput(mode === "full" ? result : compactResult(name, result));
}
