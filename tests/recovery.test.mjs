/** Supervision tests run only isolated jobs and the fake CLI, with short injected backoffs. */
import { archiveFile, failSupervisor, releaseSupervisor } from "../scripts/supervisor.mjs";
import { guardFixture } from "./fixture-lifetime.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import * as S from "../scripts/store.mjs";
import * as R from "../scripts/runtime.mjs";
import { recordUsage, usageSummary } from "../scripts/evidence-budget.mjs";
import { git, snapshot } from "../scripts/git.mjs";
import { classifyTransientFailure, planAutoResume, failureTracker, continuationPrompt } from "../scripts/recovery.mjs";
process.env.GIT_CEILING_DIRECTORIES = os.tmpdir();
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-recovery-"));
process.env.CODEX_TEAM_STATE = path.join(root, "jobs");
process.env.CODEX_TEAM_CODEX = fileURLToPath(new URL("./fake-codex.mjs", import.meta.url));
process.env.CODEX_HOME = path.join(root, "codex-config");
process.env.CODEX_TEAM_TEST_BACKOFF_MS = "30,60";
const jobs = [];
let sequence = 0;
function start(control = {}, prompt = "Recovery fixture", extra = {}) {
  const cwd = path.join(root, `project-${++sequence}`); fs.mkdirSync(cwd);
  if (extra.assignment) git(cwd, ["init", "--quiet"]);
  const file = path.join(root, `control-${sequence}.json`);
  fs.writeFileSync(file, JSON.stringify(control));
  process.env.CODEX_TEAM_FAKE_RECOVERY = file;
  const job = R.startJob({ cwd, prompt, timeoutSeconds: 30, requestId: randomUUID(), ...extra });
  jobs.push({ cwd, jobId: job.jobId });
  return { ...job, cwd, file };
}
const settle = j => R.statusJob({ cwd: j.cwd, jobId: j.jobId, waitSeconds: 30 });
async function until(id, predicate) {
  const end = Date.now() + 20000;
  while (Date.now() < end) { const state = S.readRaw(id); if (predicate(state)) return state; await new Promise(r => setTimeout(r, 30)); }
  throw new Error("Milestone not reached: " + JSON.stringify(S.readRaw(id)));
}
after(async () => {
  for (const job of jobs) { try { R.cancelJob(job); await settle(job); } catch {} }
  await new Promise(r => setTimeout(r, 300)); S.closeStores();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
test("two automatic retries preserve job/task/thread, baseline and revision, archive reports and record execs", async () => {
  const job = start({ failures: 2, staleReport: true });
  const before = S.readRaw(job.jobId);
  const done = await settle(job);
  assert.equal(done.status, "implementation_finished", JSON.stringify(done));
  assert.equal(done.autoResumes.length, 2);
  assert.deepEqual(done.autoResumes.map(r => r.attempt), [1, 2]);
  assert.ok(done.autoResumes.every(r => r.startedAt && r.finishedAt));
  const raw = S.readRaw(job.jobId);
  for (const key of ["taskId", "revision", "attempt", "baseline", "attemptBaseline", "requestHash"]) assert.deepEqual(raw[key], before[key]);
  assert.equal(done.execs.length, 3);
  assert.ok(done.execs.every(e => e.threadId === done.threadId && e.startedAt && e.finishedAt));
  assert.equal(done.execs[2].usage.output_tokens, 4);
  const calls = JSON.parse(fs.readFileSync(job.file)).calls;
  assert.deepEqual(calls.slice(1).map(c => c.thread), [done.threadId, done.threadId]);
  assert.ok(fs.existsSync(path.join(S.jobDir(job.jobId), "exec-0-report.txt")));
  assert.equal(done.report, "Revision completed");
});
test("exhaustion stops at two retries and stale success cannot satisfy a failed exec", async () => {
  const job = start({ failures: 10, staleReport: true });
  const done = await settle(job);
  assert.equal(done.status, "failed");
  assert.equal(done.autoResumes.length, 2);
  assert.equal(JSON.parse(fs.readFileSync(job.file)).calls.length, 3);
});
test("backoff reserves project and cancellation stops the scheduled retry", async () => {
  process.env.CODEX_TEAM_TEST_BACKOFF_MS = "10000,10000";
  const job = start({ failures: 2 });
  process.env.CODEX_TEAM_TEST_BACKOFF_MS = "30,60";
  await until(job.jobId, s => s.autoResumes?.[0]?.outcome === "scheduled");
  assert.throws(() => R.startJob({ cwd: job.cwd, prompt: "duplicate" }), /active job/);
  R.cancelJob({ cwd: job.cwd, jobId: job.jobId });
  const done = await settle(job);
  assert.equal(done.status, "cancelled");
  assert.equal(done.autoResumes[0].outcome, "cancelled");
  assert.equal(JSON.parse(fs.readFileSync(job.file)).calls.length, 1);
});
test("setup failures take precedence over transport errors; DB-only contention does not resume", async () => {
  for (const message of ["stream disconnected; helper_unknown_error: setup refresh had errors", "database is locked"]) {
    const job = start({ failures: 1, message });
    const done = await settle(job);
    assert.equal(done.status, message.includes("helper") ? "blocked_runtime" : "failed");
    assert.equal(done.autoResumes, undefined);
  }
  const base = { status: "failed", threadId: "thread", cliFailure: "HTTP 503" };
  assert.equal(classifyTransientFailure(base), "cli_transport");
  for (const error of ["permission denied", "Malformed JSON", "budget exhausted", "secret failure", "deadline", "database is locked"])
    assert.equal(classifyTransientFailure({ ...base, cliFailure: error }), null);
  assert.equal(planAutoResume({ ...base, autoResumes: [{}, {}] }), null);
});
test("worker crash resumes durable thread only when no orphan is alive", async () => {
  // First kill the model, then its worker: a supervisor can safely resume that thread.
  const job = start({}, "WAIT_FOREVER");
  let state = await until(job.jobId, s => s.threadId && s.codexPid && s.workerPid);
  // Change only the persisted prompt for this crash fixture so the resumed model exits.
  S.patch(job.jobId, { prompt: "After crash", codexPid: process.pid });
  process.kill(state.workerPid, "SIGKILL");
  // Unknown/live orphan ownership is conservative, including an unrelated live PID.
  // Windows can kill real descendants with the worker; this fixture keeps an independently live owner.
  const stopped = await until(job.jobId, s => s.status === "interrupted");
  assert.equal(stopped.orphanProcessAlive, true);
  assert.equal(JSON.parse(fs.readFileSync(job.file)).calls.length, 1);
  try { process.kill(state.codexPid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  const safe = start({}, "WAIT_FOREVER");
  state = await until(safe.jobId, s => s.threadId && s.codexPid && s.workerPid);
  S.patch(safe.jobId, { prompt: "After crash" });
  // Terminate worker and child together; supervisor sees the child's death before deciding.
  process.kill(state.codexPid, "SIGKILL");
  process.kill(state.workerPid, "SIGKILL");
  const done = await settle(safe);
  assert.equal(done.status, "implementation_finished", JSON.stringify(done));
  assert.equal(done.autoResumes[0].reason, "worker_crash");
  assert.equal(done.execs.length, 2);
});
test("old in-memory 1.1.5 launcher can run --worker directly without a supervisor", async () => {
  delete process.env.CODEX_TEAM_FAKE_RECOVERY;
  const cwd = path.join(root, "old-launcher"); fs.mkdirSync(cwd);
  const jobId = randomUUID(); fs.mkdirSync(S.jobDir(jobId));
  S.save({ jobId, cwd, executionCwd: cwd, status: "starting", startedAt: S.now(), baseline: snapshot(cwd), prompt: "direct worker", timeoutSeconds: 30 });
  const child = spawn(process.execPath, [fileURLToPath(new URL("../scripts/runtime.mjs", import.meta.url)), "--worker", jobId], { windowsHide: true, stdio: "ignore", env: process.env });
  const exit = new Promise(resolve => child.once("exit", resolve));
  S.patch(jobId, { workerPid: child.pid }); fs.writeFileSync(path.join(S.jobDir(jobId), "launch"), String(child.pid));
  assert.equal(await exit, 0);
  const done = S.readRaw(jobId);
  assert.equal(done.status, "implementation_finished");
  assert.equal(done.supervisorPid, undefined);
  assert.equal(done.execs.length, 1);
});

test("usage deduplication is scoped to role and exec attempt", () => {
  const jobId = randomUUID(), state = { jobId, taskId: jobId, profile: { repoId: "recovery-budget", components: { budget: { level: "advise" } } } };
  const event = { usage: { input_tokens: 10, output_tokens: 4 } };
  recordUsage(state, event, 1);
  recordUsage(state, event, 1);
  recordUsage({ ...state, execAttempt: 1 }, event, 1);
  recordUsage({ ...state, execRole: "reviewer", execAttempt: 0 }, event, 1);
  assert.equal(usageSummary(state).task.inputTokens, 30);
  assert.equal(usageSummary(state).task.outputTokens, 12);
});

test("a prior success report cannot satisfy a resume that writes no final report", async () => {
  const job = start({ failures: 1, staleReport: true, resumePrompt: "EMPTY_REPORT" }, "EMPTY_REPORT");
  const done = await settle(job);
  assert.equal(done.status, "failed");
  assert.match(done.error, /without a final report/);
  assert.equal(done.autoResumes.length, 1);
  assert.equal(fs.existsSync(path.join(S.jobDir(job.jobId), "report.txt")), false);
});

test("a dead supervisor exposes an interrupted reservation instead of replaying", () => {
  const id = randomUUID();
  S.save({ jobId: id, cwd: root, status: "starting", startedAt: S.now(), supervisorPid: 2147483647,
    recoveryPhase: "backoff", reservation: { pid: 2147483647, at: S.now() } });
  assert.equal(S.recover(S.readRaw(id)).status, "interrupted");
});

test("structured retry ignores model prose about cancel/permission and sends only a continuation", async () => {
  const objective = "WRITE_CODE preserve the original authorized assignment";
  const job = start({ failures: 1, eventText: "Do not cancel: inspect permission, contract, budget, secret and deadline rules.", resumePrompt: "WRITE_CODE" }, "Original large context", {
    autoVerify: false, // This fixture deliberately verifies manually after checking the implementation milestone.
    assignment: { objective, scope: ["answer.mjs"], acceptanceCriteria: ["answer exists"], verification: [{ id: "check", command: process.execPath, allowInline: true, args: ["-e", "0"] }] },
  });
  const done = await settle(job);
  assert.equal(done.status, "implementation_finished", JSON.stringify(done));
  assert.equal(done.autoResumes.length, 1);
  assert.equal(done.assignment.objective, objective);
  assert.equal(fs.existsSync(path.join(job.cwd, "answer.mjs")), true);
  const calls = JSON.parse(fs.readFileSync(job.file)).calls;
  assert.match(calls[1].prompt, /Continue the same assignment/);
  const continuation = continuationPrompt(done);
  assert.ok(continuation.length < 400);
  assert.ok(calls[1].prompt.endsWith(continuation));
  assert.doesNotMatch(calls[1].prompt, /Structured assignment:|Saved lead context:|BEGIN PROJECT HANDBOOK/);
  assert.ok(!calls[1].prompt.includes(objective));
  assert.equal(calls[1].thread, done.threadId);
  await until(job.jobId, state => state.supervisorPid === null);
  R.verifyJob({ cwd: job.cwd, jobId: job.jobId });
  assert.equal(S.readRaw(job.jobId).supervisorPid, null);
  assert.equal((await settle(job)).status, "verified");
});
test("an earlier recovered reconnect and bare 5xx line numbers cannot replay a later failure", async () => {
  const job = start({ failures: 1, reconnected: true, message: "Unexpected error at line 502" });
  const done = await settle(job);
  assert.equal(done.status, "failed");
  assert.equal(done.cliFailure, "Unexpected error at line 502");
  assert.equal(done.autoResumes, undefined);
  for (const message of ["HTTP 503", "status 502", "status code: 500", "502 Bad Gateway"]) {
    assert.equal(classifyTransientFailure({ status: "failed", threadId: "thread", cliFailure: message }), "cli_transport");
  }
  const tracker = failureTracker();
  tracker.note({ type: "error", message: "Reconnecting... stream disconnected" });
  tracker.note({ type: "turn.completed" });
  assert.equal(tracker.text("non-transient process failure"), "");
  tracker.note({ type: "turn.started" });
  tracker.note({ type: "error", message: "HTTP 503" });
  tracker.note({ type: "turn.failed", error: { message: "ordinary failure" } });
  assert.equal(tracker.text(), "ordinary failure");
});
test("supervisor identity rejects a reused PID and cleanup only changes its own row", async () => {
  const jobId = randomUUID();
  const state = { jobId, supervisorPid: process.pid, cwd: root, status: "verifying", startedAt: "2000-01-01T00:00:00Z" };
  assert.equal(S.supervisorStillOwned(state, () => ({ command: "node unrelated.mjs" })), false);
  assert.equal(S.supervisorStillOwned(state, () => ({ command: `node C:/plugin/scripts/supervisor.mjs ${jobId}` })), true);
  S.save({ ...state, status: "verified" });
  await failSupervisor(jobId, new Error("late error"));
  assert.equal(S.readRaw(jobId).status, "verified");
  await releaseSupervisor(jobId);
  assert.equal(S.readRaw(jobId).supervisorPid, null);
  S.patch(jobId, { status: "running", supervisorPid: 2147483647 });
  await failSupervisor(jobId, new Error("not my row"));
  await releaseSupervisor(jobId);
  assert.equal(S.readRaw(jobId).status, "running");
  assert.equal(S.readRaw(jobId).supervisorPid, 2147483647);
  S.patch(jobId, { supervisorPid: process.pid });
  await failSupervisor(jobId, new Error("owned failure"));
  assert.equal(S.readRaw(jobId).status, "interrupted");
});
test("a crashed verification is not held by an unrelated reused supervisor PID", () => {
  const jobId = randomUUID();
  const state = { jobId, cwd: root, status: "verifying", supervisorPid: process.pid, workerPid: 2147483647,
    heartbeatAt: "2000-01-01T00:00:00Z", startedAt: "2000-01-01T00:00:00Z" };
  S.save(state);
  assert.equal(S.recover(state).status, "verification_failed");
});
test("sharing-locked archive retries then copies and empties the current report", async () => {
  const source = path.join(root, "locked-report"), target = path.join(root, "archived-report");
  fs.writeFileSync(source, "prior success");
  let tries = 0;
  await archiveFile(source, target, { delays: [0, 0], io: {
    ...fs, renameSync() { tries++; throw Object.assign(new Error("sharing lock"), { code: tries % 2 ? "EPERM" : "EBUSY" }); },
  } });
  assert.equal(tries, 3);
  assert.equal(fs.readFileSync(target, "utf8"), "prior success");
  assert.equal(fs.readFileSync(source, "utf8"), "");
});
test("thread-start accounting read failures fall back to the durable progress note", () => {
  const notes = [];
  R.noteThreadStarted("job", "thread", { note: (...args) => notes.push(args) }, () => { throw new Error("database is locked"); });
  assert.deepEqual(notes, [[{ threadId: "thread" }, true]]);
});
test("fixture guardians exit on a dead parent or a bounded lifetime", () => {
  for (const options of [{ parentPid: 2147483647, intervalMs: 20 }, { parentPid: process.pid, maxMs: 60 }]) {
    const code = `(${guardFixture.toString()})(${JSON.stringify(options)});setInterval(()=>{},1000)`;
    const result = spawnSync(process.execPath, ["-e", code], { windowsHide: true, timeout: 5000 });
    assert.equal(result.status, 0, String(result.stderr));
  }
});


test("a direct worker cannot leave retry-pending state for a dead supervisor", async () => {
  const cwd = path.join(root, "dead-launcher"); fs.mkdirSync(cwd);
  const file = path.join(root, "dead-control.json");
  fs.writeFileSync(file, JSON.stringify({ failures: 1 }));
  const jobId = randomUUID(); fs.mkdirSync(S.jobDir(jobId));
  S.save({ jobId, cwd, executionCwd: cwd, status: "starting", startedAt: S.now(), baseline: snapshot(cwd),
    prompt: "Direct failure", timeoutSeconds: 30, supervisorPid: 2147483647 });
  const child = spawn(process.execPath, [fileURLToPath(new URL("../scripts/runtime.mjs", import.meta.url)), "--worker", jobId],
    { windowsHide: true, stdio: "ignore", env: { ...process.env, CODEX_TEAM_FAKE_RECOVERY: file } });
  const exit = new Promise(resolve => child.once("exit", resolve));
  S.patch(jobId, { workerPid: child.pid }); fs.writeFileSync(path.join(S.jobDir(jobId), "launch"), String(child.pid));
  assert.equal(await exit, 0);
  const done = S.readRaw(jobId);
  assert.equal(done.status, "failed");
  assert.notEqual(done.recoveryPhase, "pending");
});

test("a budget consumed during backoff stops the retry as budget_exhausted", async () => {
  const { profileTool } = await import("../scripts/profile.mjs");
  const cwd = path.join(root, "budget-backoff"); fs.mkdirSync(cwd);
  git(cwd, ["init", "--quiet"]);
  fs.mkdirSync(path.join(cwd, ".codex-team"));
  fs.writeFileSync(path.join(cwd, ".codex-team/profile.json"), JSON.stringify({
    profileVersion: 1, name: "retry budget", components: { budget: { level: "enforce", perJob: { inputTokens: 10 } } },
  }));
  const profile = profileTool({ cwd }).profile;
  profileTool({ cwd, action: "approve", expectedHash: profile.hash });
  const file = path.join(root, "budget-control.json"); fs.writeFileSync(file, JSON.stringify({ failures: 1 }));
  process.env.CODEX_TEAM_FAKE_RECOVERY = file;
  process.env.CODEX_TEAM_TEST_BACKOFF_MS = "5000,5000";
  const job = R.startJob({ cwd, requestId: randomUUID(), timeoutSeconds: 30,
    assignment: { objective: "Budget fixture", scope: ["answer.mjs"], acceptanceCriteria: ["answer exists"],
      verification: [{ id: "check", command: process.execPath, allowInline: true, args: ["-e", "0"] }] },
  });
  jobs.push({ cwd, jobId: job.jobId });
  process.env.CODEX_TEAM_TEST_BACKOFF_MS = "30,60";
  const pending = await until(job.jobId, state => state.recoveryPhase === "backoff");
  recordUsage(pending, { usage: { input_tokens: 10, output_tokens: 0 } }, "concurrent-usage");
  const done = await settle({ ...job, cwd });
  assert.equal(done.status, "budget_exhausted", JSON.stringify(done));
  assert.equal(JSON.parse(fs.readFileSync(file)).calls.length, 1);
  assert.equal(done.autoResumes[0].outcome, "budget_exhausted");
  assert.ok(done.autoResumes[0].finishedAt);
});
