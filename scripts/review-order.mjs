/** Dependency-free packet ordering, also safe for lightweight status/waiter imports. */
const severity = { critical: 0, high: 1, medium: 2, low: 3 };
export function reviewAttempt(state, offset = 0) {
  return Math.max(-1, ...(state.execs || []).filter(e=>e.role==='reviewer').map(e=>e.attempt ?? 0)) + 1 + offset;
}
export function mergeFindings(...groups) {
  return groups.flat().map((f, order) => ({ ...f, order })).sort((a,b) => severity[a.severity] - severity[b.severity] || (b.confidence ?? -1) - (a.confidence ?? -1) || a.order - b.order)
    .map(({ order, ...f }, findingIndex) => ({ ...f, findingIndex }));
}
