/** Test-only orphan guard. Finite lifetime even when Windows denies taskkill. */
export function guardFixture({ parentPid = process.ppid, maxMs = 120000, intervalMs = 250 } = {}) {
  const duration = Math.min(120000, Math.max(1, maxMs));
  const limit = Date.now() + duration;
  setTimeout(() => process.exit(0), duration).unref();
  const timer = setInterval(() => {
    if (Date.now() >= limit) process.exit(0);
    try { process.kill(parentPid, 0); }
    catch (error) { if (error.code !== "EPERM") process.exit(0); }
  }, intervalMs);
  timer.unref();
  return timer;
}
