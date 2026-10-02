process.env.NoDefaultCurrentDirectoryInExePath = "1";
/** Detached owner of one worker and at most two cancellable same-thread retries. */
import { recordFinishedExecs } from "./run-stats.mjs";
import fs from "node:fs";
import { assertReviewInstructions } from "./review-instructions.mjs";
import { captureVisibility } from "./visibility.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import * as S from "./store.mjs";
import { pruneBytes } from "./baseline-bytes.mjs";
import { hostEnvironment } from "./check-executable.mjs";
import { readTail } from "./diagnostics.mjs";
import { planAutoResume, resetExecState } from "./recovery.mjs";
const runtime = fileURLToPath(new URL("./runtime.mjs", import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const artifact = (id, name) => path.join(S.jobDir(id), name);
async function patch(id, changes) {
  for (;;) {
    try {
      if (changes.status && !S.active.has(changes.status)) {
        const state = S.readRaw(id);
        if (changes.status === "cancelled" && state.implementationFinishedAt) changes = { ...changes, status: "verification_failed", cancelled: true };
        changes = {
          livePhase: null,
          ...changes,
          reservation: null,
          execs: changes.execs || finishExecs(state, changes.status),
          ...(state.autoResumes?.length && !changes.autoResumes ? {
            autoResumes: state.autoResumes.map(r => r.finishedAt ? r : {
              ...r, finishedAt: S.now(), outcome: changes.status,
            }),
          } : {}),
        };
      }
      let previousExecs;
      if (changes.execs) try { previousExecs = S.readRaw(id).execs; } catch {}
      const saved = S.patch(id, changes);
      if (changes.execs) recordFinishedExecs(saved, previousExecs);
      if (saved.status === "cancelled" || saved.cancelled) {
        for (const name of saved.status === "cancelled" ? ["baseline-bytes", "review-copies"] : ["review-copies"]) try { pruneBytes(artifact(id, name)); }
        catch (error) { S.patch(id, { result: { ...saved.result, sandboxLimits: [...(saved.result?.sandboxLimits || []), "Baseline cleanup: " + error.code] } }); }
      }
      return saved;
    }
    catch (error) { if (!S.isBusy(error)) throw error; await sleep(250); }
  }
}
function cancelled(id) { return fs.existsSync(artifact(id, "cancel")); }
function deadline(state) { return state.deadlineAt && Date.now() >= Date.parse(state.deadlineAt); }
export function finishExecs(state, outcome) {
  return (state.execs || []).map(exec => {
    if (exec.finishedAt) return exec;
    const implementation = exec.role === "implementation" && exec.attempt === state.execAttempt;
    return { ...exec, threadId: exec.threadId || (implementation ? state.threadId : null),
      usage: exec.usage || (implementation ? state.usage : null) || null, finishedAt: S.now(), outcome };
  });
}
async function runWorker(state) {
  const child = spawn(process.execPath, [runtime, "--worker", state.jobId], {
    env: hostEnvironment(), cwd: state.executionCwd || state.cwd, windowsHide: true, stdio: "ignore",
  });
  const exited = new Promise(resolve => {
    child.once("error", error => resolve({ error: error.message }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (!child.pid) return exited;
  await patch(state.jobId, { workerPid: child.pid, heartbeatAt: S.now() });
  fs.writeFileSync(artifact(state.jobId, "launch"), String(child.pid));
  return { ...await exited, workerPid: child.pid };
}
export async function supervise(id, { delays = [30000, 120000] } = {}) {
  // A launcher records ownership before releasing this process.
  for (let i = 0; i < 4800; i++) {
    if (fs.existsSync(artifact(id, "supervisor-launch")) && fs.readFileSync(artifact(id, "supervisor-launch"), "utf8") === String(process.pid)) break;
    await sleep(25);
  }
  let state = S.readRaw(id);
  if (state.supervisorPid !== process.pid) return;
  while (true) {
    if (cancelled(id) || deadline(state)) {
      const status = cancelled(id) ? "cancelled" : "timed_out";
      await patch(id, { status, finishedAt: S.now(), autoResumes: (state.autoResumes || []).map(r => r.finishedAt ? r : { ...r, outcome: status, finishedAt: S.now() }) });
      return;
    }
    captureVisibility(state, S.jobDir(id));
    const exit = await runWorker(state);
    state = S.readRaw(id);
    // A completed worker owns its terminal write; never race a new verification/revision.
    if (exit.error) {
      await patch(id, { status: "failed", error: exit.error, finishedAt: S.now() });
      return;
    }
    if (!S.active.has(state.status) || state.workerPid !== exit.workerPid) return;
    if(state.status==="verifying") {await patch(id,{status:"verification_failed",error:"Verification worker exited without a terminal result.",finishedAt:S.now()});return;}
    const crashed = state.recoveryPhase !== "pending";
    // Unknown identity counts as alive; never duplicate a potentially orphaned model.
    const orphanAlive = S.alive(state.codexPid) || !!(crashed && !state.codexPid && state.execs?.some(exec => !exec.finishedAt));
    state = { ...state, cancellationRequested: cancelled(id) };
    if (crashed) {
      let workerFault = state.workerFault;
      try { workerFault = JSON.parse(readTail(artifact(id, "worker-fault.json"), 4096)); } catch {}
      state = { ...state, workerFault, recoveryDiagnostics: readTail(artifact(id, "stderr.log"), 6000) };
    }
    const plan = planAutoResume(state, { crashed, orphanAlive, delays });
    if (!plan) {
      const status = cancelled(id) ? "cancelled" : deadline(state) ? "timed_out" : crashed ? "interrupted" : "failed";
      await patch(id, { status, finishedAt: S.now(), orphanProcessAlive: orphanAlive,
        error: state.error || exit.error || "Worker exited without a final result.",
        execs: finishExecs(state, status),
        autoResumes: (state.autoResumes || []).map(r => r.finishedAt ? r : { ...r, outcome: status, finishedAt: S.now() }) });
      return;
    }
    const history = (state.autoResumes || []).map(r => r.finishedAt ? r : { ...r, outcome: "failed", finishedAt: S.now() });
    state = await patch(id, { status: "starting", recoveryPhase: "backoff", reservation: { pid: process.pid, at: S.now() }, execs: finishExecs(state, "interrupted"),
      autoResumes: [...history, plan], progress: `Automatic resume ${plan.attempt}/2 scheduled (${plan.reason}).` });
    while (Date.now() < Date.parse(plan.scheduledAt)) {
      if (cancelled(id) || deadline(state)) break;
      await sleep(Math.min(250, Date.parse(plan.scheduledAt) - Date.now()));
    }
    if (cancelled(id) || deadline(state)) continue;
    try { assertReviewInstructions(S.read(id)); }
    catch (error) {
      await patch(id,{status:"failed",error:"Automatic resume refused: " + error.message,finishedAt:S.now(),
        autoResumes:[...history,{...plan,outcome:"config_changed",finishedAt:S.now()}]});
      return;
    }
    // Archive all per-exec output outside the transaction: no stale final report can pass.
    for (const name of ["report.txt", "events.jsonl", "stderr.log", "worker-fault.json"])
      await archiveFile(artifact(id, name), artifact(id, `exec-${state.execAttempt || 0}-${name}`));
    state = await patch(id, { ...resetExecState(state), heartbeatAt: S.now(),
      autoResumes: [...history, { ...plan, startedAt: S.now(), outcome: "running" }] });
  }
}
/** Archive sharing-locked Windows logs without allowing stale reports into the next exec. */
export async function archiveFile(source, target, { io = fs, delays = [50, 150, 300] } = {}) {
  if (!io.existsSync(source)) return;
  const retry = async operation => {
    for (let attempt = 0; ; attempt++) {
      try { return operation(); }
      catch (error) {
        if (!["EBUSY", "EPERM"].includes(error.code) || attempt >= delays.length) throw error;
        await sleep(delays[attempt]);
      }
    }
  };
  try { await retry(() => io.renameSync(source, target)); }
  catch (error) {
    if (!["EBUSY", "EPERM"].includes(error.code)) throw error;
    await retry(() => { io.copyFileSync(source, target); io.truncateSync(source, 0); });
  }
}
async function ownedUpdate(id, changes) {
  for (;;) {
    try {
      return S.transaction(() => {
        const state = S.readRaw(id);
        if (state.supervisorPid !== process.pid) return;
        const update = changes(state);
        if (update) return S.save({ ...state, ...update });
      }, "supervisor:ownership");
    } catch (error) { if (!S.isBusy(error)) throw error; await sleep(250); }
  }
}
export function releaseSupervisor(id) {
  return ownedUpdate(id, () => ({ supervisorPid: null }));
}
export function failSupervisor(id, error) {
  return ownedUpdate(id, state => S.active.has(state.status) ? {
    status: "interrupted", livePhase: null, error: error.message, finishedAt: S.now(), reservation: null,
    execs: finishExecs(state, "interrupted"),
    autoResumes: (state.autoResumes || []).map(r => r.finishedAt ? r : {
      ...r, finishedAt: S.now(), outcome: "interrupted",
    }),
  } : null);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    // Test-only timing injection; production defaults remain 30s and 120s.
    const delays = process.env.CODEX_TEAM_TEST_BACKOFF_MS?.split(",").map(Number);
    if (delays && (delays.length !== 2 || delays.some(v => !Number.isFinite(v) || v < 0))) throw new Error("Invalid backoff timings.");
    await supervise(process.argv[2], delays ? { delays } : {});
  } catch (error) {
    try { await failSupervisor(process.argv[2], error); } catch {}
    process.exitCode = 1;
  } finally {
    try { await releaseSupervisor(process.argv[2]); } catch {}
    S.closeStores();
  }
}
