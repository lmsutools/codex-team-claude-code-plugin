/** Context economics use observed per-call input, not accumulated session usage. Advice never resets. */
export function contextAdvice(transcript, jobs = [], now = Date.now()) {
  const context = transcript.calls.at(-1)?.usage.input || 0;
  const top = [...(transcript.toolResults || [])].sort((a, b) => b.characters - a.characters).slice(0, 3);
  const phaseCalls = [];
  const phase = jobs.find(j => ["starting", "running", "verifying"].includes(j.status))?.livePhase || "implementation";
  for (const job of jobs.slice(0, 20)) {
    const start = Date.parse(phase === "reviewer" ? job.reviewerStartedAt : phase === "verification" ? job.implementationFinishedAt : job.startedAt);
    const end = Date.parse(phase === "implementation" ? job.implementationFinishedAt || job.finishedAt : phase === "verification" ? job.reviewerStartedAt || job.finishedAt : job.finishedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const count = transcript.calls.filter(c => Date.parse(c.at) >= start && Date.parse(c.at) <= end).length;
    if (count) phaseCalls.push(count);
  }
  const expectedCalls = phaseCalls.length ? Math.max(1, Math.round(phaseCalls.reduce((a, b) => a + b, 0) / phaseCalls.length)) : 20;
  const replyStart = Date.parse(transcript.replyStartAt) || Infinity;
  const awaiting = jobs.some(j => ["starting", "running", "verifying"].includes(j.status) || (["implementation_finished", "verified", "verifying", "verification_failed", "pending_lead_evidence", "changes_requested"].includes(j.status) && !(now - Date.parse(j.finishedAt || j.updatedAt || j.startedAt) > 86400000)));
  const closed = !awaiting && jobs.some(j => [j.acceptedAt, j.committedAt, j.integration?.committedAt,
    j.delivery?.implementationCommit ? j.delivery.at : null].some(at => Date.parse(at) >= replyStart));
  const reset = closed ? "clear" : "compact", resetSize = 8000, resetCost = closed ? 0 : context;
  const live = jobs.filter(j => ["starting", "running", "verifying"].includes(j.status)).map(j => j.jobId || j.id);
  const advice = context >= 150000 && expectedCalls * (context - resetSize) > resetCost
    ? reset === "clear" ? "/clear" : `/compact Keep the codex-team state card, decisions, next steps, review findings and rules${live.length ? `; live jobs: ${live.join(", ")}` : ""}` : null;
  return { context, projectedInput: context * 10, top, expectedCalls, resetSize, resetCost, advice, liveJobs: live };
}
