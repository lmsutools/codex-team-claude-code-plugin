/** Advisory observations never wait for a lock or share the urgent progress writer. */
import * as S from "./store.mjs";
export function observationWriter(jobId, {
  now = Date.now,
  lastWriteAt = -Infinity,
  write = changes => S.withBusyTimeout(0, () => S.patch(jobId, changes)),
  onError = () => {},
} = {}) {
  let pending = null, lastAttempt = lastWriteAt, finished = false;
  function flush(force = false) {
    if (!pending || finished || (!force && now() - lastAttempt < 5000)) return;
    lastAttempt = now();
    try { write(pending); pending = null; }
    catch (error) { if (!S.isBusy(error)) onError(error); }
  }
  return {
    note(changes) { if (!finished) { pending = {...pending, ...changes}; flush(); } },
    flush() { flush(); },
    finish(changes = {}) {
      if (finished) return;
      pending = {...pending, ...changes};
      flush(true);
      finished = true;
    },
  };
}
