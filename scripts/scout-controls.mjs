/** Scout identity survives old-server resumes; this module has no store dependency. */
export const SCOUT_MARKER = "[codex-team:read-only-scout]";
export function scoutMode(state, readPrevious) {
  const seen = new Set();
  while (state) {
    if (state.mode === "scout" || state.readOnlyDraft === true ||
        state.assignment?.constraints?.includes(SCOUT_MARKER)) return true;
    if (!readPrevious || !state.resumeJobId || seen.has(state.resumeJobId)) return false;
    seen.add(state.resumeJobId);
    state = readPrevious(state.resumeJobId);
  }
  return false;
}
