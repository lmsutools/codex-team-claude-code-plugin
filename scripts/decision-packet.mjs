/** Advisory decision evidence, bounded presentation, and explicit lead acceptance mapping. */
import path from "node:path";
import { jobDirectory } from "./state-reader.mjs";
import { reportPreview } from "./report-preview.mjs";
import { untrustedOutput } from "./untrusted-output.mjs";
import { digest } from "./policy-core.mjs";
import { mergeFindings } from './review-order.mjs';
export function buildPacket(state, hunks, reviewer, error = null) {
  return { version: 1, jobId: state.jobId, assignmentHash: digest(state.assignment),
    fingerprint: state.verifiedFingerprint, status: reviewer && !error ? "ready" : "incomplete",
    ...(state.review ? { reviewMode: state.review.mode } : {}),
    ...(state.nativeReview ? { nativeReview: {status:state.nativeReview.status,...(state.nativeReview.reason?{reason:state.nativeReview.reason}:{}),...(state.nativeReview.droppedNativeFindings !== undefined ? {droppedNativeFindings:state.nativeReview.droppedNativeFindings}:{})} } : {}),
    ...(state.reviewFindings || reviewer?.findings ? {findings:mergeFindings(state.reviewFindings || reviewer.findings.map(f=>({...f,source:'reviewer'})))} : {}),
    ...(reviewer?.evidenceFloor ? {evidenceFloor:reviewer.evidenceFloor} : {}),
    hiddenChanges: state.hiddenChanges || null,
    gitConfigChanged: state.gitConfigChanged || null,
    presentationOmittedFiles: [...new Set(hunks.hunks.filter(h => ["before", "after"].some(k => String(h[k] || "").length > 400 || (String(h[k] || "").match(/[^\n]*\n|[^\n]+$/g)?.length || 0) > 6)).map(h => h.file))],
    changedFiles: state.changes?.files || [],
    checks: (state.verification?.checks || []).map(c => ({ id: c.id, executedIn: c.executedIn, sandboxLimited: c.sandboxLimited || false, criteria: c.criteria || [], status: c.status, exitCode: c.exitCode, tests: c.tests ?? null })),
    criteria: reviewer?.criteria || [], risks: reviewer?.risks || [], reviewerError: error,
    hunksAvailable: hunks.available, hunks: hunks.hunks, omittedHunks: hunks.omitted, unavailableHunks: hunks.unavailable,
    blockers: state.result?.blockers || [], sandboxLimitsCount: state.result?.sandboxLimits?.length || 0 };
}
export function boundedPacket(packet, max = 6000) {
  const result = structuredClone(packet);
  result.omittedFindings = 0;
  result.omittedChangedFiles = 0; result.omittedPresentationFiles = 0;
  result.omittedCriteria = 0; result.omittedChecks = 0; result.omittedRisks = Math.max(0, result.risks.length - 5);
  result.risks = result.risks.slice(0, 5).map(risk => risk.length > 400 ? risk.slice(0, 397) + "..." : risk);
  result.omittedUnavailable = 0; result.omittedBlockers = 0;
  if (result.reviewerError) result.reviewerError = String(result.reviewerError).slice(0, 400);
  // Keep every criterion and blocker when shortening text is sufficient.
  for (const criterion of result.criteria) {
    if (criterion.hunks?.length > 3) { criterion.omittedHunkReferences = criterion.hunks.length - 3; criterion.hunks = criterion.hunks.slice(0, 3); }
    const text = String(criterion.evidence || "");
    criterion.evidence = text.slice(0, 320);
    if (text.length > 320) criterion.omittedEvidenceCharacters = text.length - 320;
  }
  result.blockers = result.blockers.map(value => String(value).length > 320 ? String(value).slice(0, 317) + "..." : value);
  result.hunks = result.hunks.map(hunk => {
    const excerpt = { ...hunk };
    for (const key of ["before", "after"]) {
      const lines = String(hunk[key] || "").match(/[^\n]*\n|[^\n]+$/g) || [];
      const text = lines.slice(0, 6).join("");
      excerpt[key] = text.slice(0, 400);
      excerpt[key + "OmittedLines"] = Math.max(0, lines.length - 6);
      excerpt[key + "OmittedCharacters"] = Math.max(0, text.length - 400);
    }
    return excerpt;
  });
  const length = () => JSON.stringify(untrustedOutput(result)).length;
  for (const [key, omitted] of [["hunks", "omittedHunks"], ["findings", "omittedFindings"], ["unavailableHunks", "omittedUnavailable"], ["criteria", "omittedCriteria"], ["checks", "omittedChecks"], ["blockers", "omittedBlockers"], ["risks", "omittedRisks"], ["changedFiles", "omittedChangedFiles"], ["presentationOmittedFiles", "omittedPresentationFiles"]])
    while (length() > max && result[key]?.length) { result[key].pop(); result[omitted]++; }
  if (length() > max) result.reviewerError = String(result.reviewerError || "").slice(0, 200);
  while (length() > max && result.hiddenChanges?.entries.length) { result.hiddenChanges.entries.pop(); result.hiddenChanges.omitted++; }
  if (length() > max) throw Error("Decision packet metadata exceeds output cap.");
  return untrustedOutput(result);
}
export function resolvePacketEvidence(state, overrides = [], currentFingerprint = state.verifiedFingerprint, fileObservations = []) {
  const packet = state.decisionPacket;
  if (!packet || packet.assignmentHash !== digest(state.assignment) || packet.fingerprint !== state.verifiedFingerprint || packet.fingerprint !== currentFingerprint)
    throw Error("Decision packet is missing or stale; verify again.");
  if (!Array.isArray(overrides)) throw Error("packetEvidenceOverrides must be an array.");
  const observed = new Set();
  for (const observation of fileObservations) {
    if (!observation || typeof observation.file !== "string" || typeof observation.observation !== "string" || !observation.observation.trim()) throw Error("Invalid packet file observation.");
    observed.add(observation.file);
  }
  const view = { risks: [], blockers: [], hunks: [], checks: [], criteria: [], omittedHunks: 0, ...packet };
  if(state.jobId) Object.assign(view, { packetStatus: packet.status, status: state.status, ...reportPreview(state,300), ...(state.handbookPublication ? {handbookPublication:state.handbookPublication} : {}), artifactPath: state.decisionPacketPath || path.join(jobDirectory(state.jobId),"decision-packet.json") });
  const shown = boundedPacket(view);
  const omitted = (packet.hunks || []).filter(h => (packet.hunks || []).filter(v=>v.file===h.file).length > (shown.hunks || []).filter(v=>v.file===h.file).length).map(h=>h.file);
  for(const h of shown.hunks || []) if(["beforeOmittedLines","afterOmittedLines","beforeOmittedCharacters","afterOmittedCharacters"].some(k=>h[k]>0)) omitted.push(h.file);
  const required = new Set([...(packet.presentationOmittedFiles || []), ...omitted, ...(packet.hiddenChanges?.entries || []).map(e => e.file), ...(packet.unavailableHunks || []).map(h => h.file), ...((packet.omittedHunks || packet.hunksAvailable === false) ? packet.changedFiles || state.changes?.files || [] : [])]);
  if (packet.hiddenChanges?.omitted) throw Error("Hidden changes were omitted from the packet; use explicit lead evidence.");
  if ((packet.omittedHunks || packet.hunksAvailable === false) && !required.size) throw Error("Unavailable or omitted hunks require file observations.");
  if ([...required].some(file => !observed.has(file))) throw Error("Lead file observations required for omitted/unavailable hunks or hidden changes: " + [...required].filter(f => !observed.has(f)).join(", "));
  const byIndex = new Map();
  for (const entry of overrides) {
    if (!Number.isInteger(entry.criterionIndex) || entry.criterionIndex < 0 || entry.criterionIndex >= state.assignment.acceptanceCriteria.length || byIndex.has(entry.criterionIndex))
      throw Error("Invalid or duplicate packet evidence override.");
    byIndex.set(entry.criterionIndex, entry);
  }
  const missing = [], evidence = state.assignment.acceptanceCriteria.map((_, i) => {
    if (byIndex.has(i)) return byIndex.get(i);
    const verdict = packet.criteria.find(c => c.criterionIndex === i);
    const checkId = verdict?.checkIds.find(id => state.verification.checks.some(c => c.id === id && c.status === "passed" && c.exitCode === 0 && (state.assignment.verification.find(v => v.id === id)?.criteria || c.criteria || []).includes(i)));
    if (packet.evidenceFloor === "failed" || verdict?.evidenceFloor === "failed" || packet.status !== "ready" || verdict?.verdict !== "met" || !checkId) { missing.push(i); return null; }
    return { criterionIndex: i, checkId, observation: verdict.evidence, source: "reviewer" };
  });
  if (missing.length) throw Error("Lead overrides required for criteria: " + missing.join(", "));
  return evidence;
}
