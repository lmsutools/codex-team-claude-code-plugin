/** Bounded, read-only previews of proposed knowledge and host commands. */
import { createHash } from "node:crypto";
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const draftHash = draft => createHash("sha256").update(JSON.stringify(canonical(draft))).digest("hex");
export const SCOUT_NEXT = "Read the full draft with detail 'full' before confirmDraftHash; use fromScout for a fresh implementation.";
export function reportPreview(state, commandLimit = 350) {
  const notes = state.result?.handbookNotes || [];
  const draft = state.result?.draftAssignment;
  const scope = draft?.scope || [];
  const scopePreview = scope.slice(0, 10).map(p => JSON.stringify(p)).join("\n");
  const commands = draft?.verification || [];
  const preview = commands.map(c => JSON.stringify({ command: c.command, args: c.args || [] })).join("\n");
  return {
    handbookNotesCount: notes.length,
    handbookNotesPreview: notes.map((note, index) => `[${index}] ${note}`).join("\n").slice(0, 300),
    ...(draft ? { draftScopeCount: scope.length,
      draftScopePreview: scopePreview.slice(0, 300), draftScopeTruncated: scope.length > 10 || scopePreview.length > 300,
      draftVerificationCount: commands.length,
      draftVerificationPreview: preview.slice(0, commandLimit), draftVerificationTruncated: preview.length > commandLimit } : {}),
  };
}
