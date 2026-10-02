/** Validated scout provenance and shallow lead overrides for a fresh implementation. */
import { scoutEvidenceFloor, scoutThreadEvents } from './review-evidence.mjs';
import * as S from "./store.mjs";
import * as C from "./contracts.mjs";
import { draftHash } from "./report-preview.mjs";
import { scoutMode } from "./scout-controls.mjs";
export function resolveScout(input, cwd) {
  if (input.fromScout === undefined) {
    if (input.confirmDraftHash !== undefined) throw new Error("confirmDraftHash requires fromScout.");
    return { input, provenance: null };
  }
  if (input.resumeJobId) throw new Error("fromScout cannot be combined with resumeJobId.");
  if (input.mode === "scout") throw new Error("fromScout starts an implementation, not another scout.");
  const scout = S.read(input.fromScout);
  if (S.key(scout.cwd) !== S.key(cwd)) throw new Error("fromScout must reference a scout of the same project.");
  if (!scoutMode(scout, id => S.read(id))) throw new Error("fromScout requires a scout job.");
  if (scout.status !== "implementation_finished" || !scout.result || scout.contractFailure)
    throw new Error("fromScout requires a completed, validated scout report.");
  let brief;
  try { brief = C.scoutReport(scout.result); }
  catch (error) { throw new Error("Invalid fromScout report: " + error.message); }
  if ((scout.evidenceFloor?.version === 2 ? scout.evidenceFloor : scoutEvidenceFloor(scout, brief, scoutThreadEvents(scout))).status !== 'passed') throw Error('fromScout no-evidence: project reads and an existing file line range are required.');
  if (input.assignment !== undefined)
    C.object(input.assignment, "assignment override", Object.keys(brief.draftAssignment));
  const confirmedHash = draftHash(brief.draftAssignment);
  if (input.confirmDraftHash !== undefined && input.confirmDraftHash !== confirmedHash)
    throw new Error("confirmDraftHash does not match the current scout draft.");
  if (!Array.isArray(input.assignment?.verification)) throw Error("fromScout requires an explicit verification array.");
  if(input.autoVerify!==undefined && typeof input.autoVerify!=="boolean")throw Error("autoVerify must be a boolean.");
  const draftedCommands = new Set(brief.draftAssignment.verification.map(normalizedCheck));
  const draftCheckOverlap = input.assignment.verification.some(check => draftedCommands.has(normalizedCheck(check)));
  // Keep the existing exact-draft inspection contract; normalized overlap controls
  // execution eligibility even for an edited/reordered lead override.
  const copiedDraft = draftHash(input.assignment.verification) === draftHash(brief.draftAssignment.verification);
  if (copiedDraft && input.confirmDraftHash !== confirmedHash) throw Error("Draft verification requires confirmDraftHash after inspection.");
  return {
    input: { ...input, autoVerify: input.autoVerify === true && !draftCheckOverlap, assignment: { ...brief.draftAssignment, ...input.assignment } },
    provenance: { scoutJobId: scout.jobId, draftHash: confirmedHash, draftedFields: ["objective", "acceptanceCriteria", "scope"].filter(key => !Object.hasOwn(input.assignment, key)), draftSourced: copiedDraft, draftCheckOverlap },
  };
}
/** Ignore check metadata/order; preserve argument case and whitespace that affect execution. */
export function normalizedCheck(check) {
  let command = String(check?.command || "").trim().replaceAll("\\", "/");
  if (process.platform === "win32") command = command.toLowerCase().replace(/\.exe$/i, "");
  return JSON.stringify([command, ...(check?.args || []).map(String)]);
}
