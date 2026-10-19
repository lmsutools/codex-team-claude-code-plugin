/** Terminal verification records: never leave "running" behind a finished job. */
export function checkCounts(checks = []) {
  return {
    total: checks.length,
    passed: checks.filter(c => c.status === "passed").length,
    failed: checks.filter(c => c.status !== "passed" && c.status !== "running").length,
  };
}
/**
 * The verification record and progress line for a verification that ended
 * without its normal result. "observer_timeout" means the checks ran but the
 * post-check observation (content hash, hidden listing, Git configuration)
 * did not finish in time; it is not a check failure.
 */
export function verificationOutcome(previous, checks, error, { cancelled = false, at = new Date().toISOString() } = {}) {
  const counts = checkCounts(checks || []);
  const status = cancelled ? "cancelled" : error?.observerTimeout ? "observer_timeout" : "error";
  const ran = `${counts.total} check(s) ran: ${counts.passed} passed, ${counts.failed} failed`;
  const progress = status === "observer_timeout"
    ? `Verification incomplete: ${ran}, then the post-check observation timed out under machine load. The checks did not fail because of it; run codex_verify again when load drops.`
    : status === "cancelled" ? `Verification cancelled; ${ran} before cancellation.`
    : `Verification stopped before a result; ${ran}.`;
  return {
    progress,
    verification: {
      ...(previous || {}),
      status,
      checks: checks || [],
      finishedAt: at,
      ...(status === "observer_timeout" ? { observerTimeout: {
        operation: error.operation || null,
        attempts: Array.isArray(error.attempts) ? error.attempts : [],
        checksPassed: counts.passed,
        checksFailed: counts.failed,
      } } : {}),
    },
  };
}
