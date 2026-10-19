/** 1.2.2: latest Codex CLI, service tiers and load-resilient verification. Fake CLI only; no provider calls. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fixture, S, R } from "./job-b-fixture.mjs";
import { compactJob } from "../scripts/tool-output.mjs";
import { waitForJob, alreadyReached } from "../scripts/wait.mjs";
import { observationTimeoutMs, observeWithRetry, observerTimeoutError, OBSERVATION_MIN_MS, OBSERVATION_MAX_MS } from "../scripts/background-facts.mjs";
import { verificationOutcome } from "../scripts/verification-outcome.mjs";
import { buildStateCard } from "../scripts/lead-state.mjs";
import * as D from "../scripts/diagnostics.mjs";
import { classifyTransientFailure, continuationPrompt } from "../scripts/recovery.mjs";
import { buildWorkerPrompt } from "../scripts/worker-prompt.mjs";
import { gitSecuritySnapshot, compareGitSecurity, observerEnvironment, configEntries, partitionConfig } from "../scripts/git-security.mjs";
import { git } from "../scripts/git.mjs";
const F = fixture("v122");
const withEnv = async (values, run) => {
  const previous = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  Object.assign(process.env, values);
  try { return await run(); }
  finally { for (const [k, v] of Object.entries(previous)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
};
const settle = async job => {
  const end = Date.now() + 60000;
  let state;
  do { state = S.readRaw(job.jobId); if (!S.active.has(state.status)) break; await new Promise(r => setTimeout(r, 50)); } while (Date.now() < end);
  while ((S.readRaw(job.jobId).supervisorPid || S.alive(S.readRaw(job.jobId).workerPid)) && Date.now() < end) await new Promise(r => setTimeout(r, 25));
  return S.readRaw(job.jobId);
};

// ── P3: truncated status and waiters that exit at once ──

test("P3: compact output never shortens status, even when the result must be trimmed", () => {
  const state = { jobId: randomUUID(), status: "verification_failed", livePhase: null, progress: "p".repeat(5000), error: "e".repeat(5000),
    next: "n".repeat(500), readableTail: "r".repeat(500), verification: { status: "observer_timeout", checks: [{ id: "a", status: "passed" }] },
    hiddenChanges: { total: 50, reason: "x".repeat(300), entries: Array.from({ length: 50 }, (_, i) => ({ file: "f".repeat(70) + i, kind: "new" })) } };
  const view = compactJob(state);
  assert.equal(view.status, "verification_failed");
  assert.equal(view.checks.status, "observer_timeout");
  assert.ok(JSON.stringify(view).length <= 1500, JSON.stringify(view).length);
});

test("P3: a waiter started on a finished job says so; the state card hands out no wait command for it", async () => {
  const cwd = F.project();
  const job = F.start(cwd, { prompt: "WRITE_CODE" });
  await F.done(job);
  const result = await waitForJob({ jobId: job.jobId, pollMs: 10, timeoutSeconds: 5 });
  assert.equal(result.status, "implementation_finished");
  assert.equal(result.alreadyFinished, true);
  assert.match(result.waiterNote, /already implementation_finished.*do not re-arm/);
  const card = buildStateCard({}, [{ jobId: job.jobId, status: "verification_failed", livePhase: "verification" }]);
  assert.doesNotMatch(card, /wait\.mjs/);
  assert.doesNotMatch(card, /verification_failed verification/, "a stale live phase is not shown for a finished job");
  assert.match(alreadyReached({}, { status: "verifying", livePhase: "reviewer" }, "finish").waiterNote, /--for decision/);
});

// ── P2: post-check observation under load ──

test("P2: observation bounds are load-aware, capped and overridable", () => {
  assert.equal(observationTimeoutMs({}), OBSERVATION_MIN_MS);
  assert.equal(observationTimeoutMs({ verification: { observationCostMs: 60000 } }), 480000);
  assert.equal(observationTimeoutMs({ verification: { observationCostMs: 10 * 60000 } }), OBSERVATION_MAX_MS);
  assert.equal(observationTimeoutMs({}, { CODEX_TEAM_OBSERVATION_TIMEOUT_MS: "5000" }), 5000);
  assert.equal(observationTimeoutMs({}, { CODEX_TEAM_OBSERVATION_TIMEOUT_MS: "nonsense" }), OBSERVATION_MIN_MS);
});

test("P2: only an observer timeout is retried, once, with a doubled bound", async () => {
  const bounds = [];
  const flaky = async (_op, _state, { timeoutMs }) => { bounds.push(timeoutMs); if (bounds.length === 1) throw observerTimeoutError("verification", timeoutMs); return "observed"; };
  const ok = await observeWithRetry("verification", {}, { timeoutMs: 1000, run: flaky });
  assert.equal(ok.value, "observed");
  assert.deepEqual(bounds, [1000, 2000]);
  assert.deepEqual(ok.attempts.map(a => a.outcome), ["timed_out", "observed"]);
  const always = async (_op, _state, { timeoutMs }) => { throw observerTimeoutError("verification", timeoutMs); };
  await assert.rejects(observeWithRetry("verification", {}, { timeoutMs: 1000, run: always }), e => e.observerTimeout && e.attempts.length === 2 && /not a check failure/.test(e.message));
  let calls = 0;
  await assert.rejects(observeWithRetry("verification", {}, { timeoutMs: 1000, run: async () => { calls++; throw Error("git failed"); } }), /git failed/);
  assert.equal(calls, 1, "other failures are not retried");
});

test("P2: an observer timeout is recorded as observer_timeout with the passed checks, never as running", () => {
  const checks = [{ id: "a", status: "passed" }, { id: "b", status: "passed" }];
  const error = Object.assign(observerTimeoutError("verification", 1000), { attempts: [{ outcome: "timed_out" }, { outcome: "timed_out" }] });
  const { verification, progress } = verificationOutcome({ status: "running", startedAt: "x", observationCostMs: 9 }, checks, error);
  assert.equal(verification.status, "observer_timeout");
  assert.equal(verification.startedAt, "x");
  assert.deepEqual(verification.observerTimeout, { operation: "verification", attempts: error.attempts, checksPassed: 2, checksFailed: 0 });
  assert.match(progress, /2 passed, 0 failed.*did not fail/);
  assert.equal(verificationOutcome({}, checks, Error("x")).verification.status, "error");
  assert.equal(verificationOutcome({}, checks, Error("x"), { cancelled: true }).verification.status, "cancelled");
});

test("P2: a slow observation retries and still verifies; a persistent timeout is distinct from failed checks", async () => {
  const cwd = F.project();
  const job = F.start(cwd, { prompt: "WRITE_CODE" });
  await F.done(job);
  await withEnv({ CODEX_TEAM_OBSERVATION_TIMEOUT_MS: "3000", CODEX_TEAM_TEST_OBSERVATION_DELAY_MS: "4000" }, async () => {
    R.verifyJob({ cwd, jobId: job.jobId });
    const state = await settle(job);
    assert.equal(state.verification.status, "passed", JSON.stringify(state.verification));
    assert.deepEqual(state.verification.observation.attempts.map(a => a.outcome), ["timed_out", "observed"]);
    assert.ok(Number.isFinite(state.verification.observationCostMs));
  });
  await withEnv({ CODEX_TEAM_OBSERVATION_TIMEOUT_MS: "1000", CODEX_TEAM_TEST_OBSERVATION_DELAY_MS: "8000" }, async () => {
    R.verifyJob({ cwd, jobId: job.jobId });
    const state = await settle(job);
    assert.equal(state.status, "verification_failed");
    assert.equal(state.livePhase, null);
    assert.equal(state.verification.status, "observer_timeout");
    assert.equal(state.verification.observerTimeout.checksPassed, 1);
    assert.equal(state.verification.checks[0].status, "passed");
    assert.match(state.error, /not a check failure/);
    assert.match(state.progress, /did not fail/);
    assert.throws(() => F.accept(job), /post-check observation timed out under machine load.*codex_verify again/);
    const view = compactJob(state);
    assert.equal(view.status, "verification_failed");
    assert.equal(view.checks.status, "observer_timeout");
  });
});

// ── P1: first-run sandbox setup and runner start timeouts ──

test("P1: classification of runner start timeouts is narrow and transient", () => {
  const line = "2026-10-18T11:08:45Z ERROR codex_core::tools::router: error=apply_patch verification failed: fs sandbox helper failed with status exit code: 1: windows sandbox failed: timed out after 15000ms waiting for runner spawn_ready";
  assert.equal(D.classifyFailure(line).code, "sandbox_spawn_timeout");
  assert.equal(D.classifyFailure(line).transient, true);
  assert.equal(D.classifyFailure("windows sandbox failed: timed out after 15000ms waiting for runner spawn_ready\nmore", { source: "command" }).code, "sandbox_spawn_timeout");
  assert.equal(D.classifyFailure('const fixture = "timed out after 15000ms waiting for runner spawn_ready";', { source: "command" }), null, "command output that merely quotes it is not evidence");
  assert.equal(D.classifyFailure("helper_unknown_error: setup refresh had errors").code, "sandbox_setup_failed");
  assert.equal(D.recordFailure("C:/x", { fingerprint: "f" }, { transient: true, source: "stderr" }), null, "never cached as project health");
  assert.match(continuationPrompt({ autoResumes: [{ reason: "sandbox_spawn_timeout" }] }), /retry the tool call that failed/);
  const base = { status: "blocked_runtime", threadId: "t", runtimeFailure: { code: "sandbox_spawn_timeout", transient: true } };
  assert.equal(classifyTransientFailure(base), "sandbox_spawn_timeout");
  assert.equal(classifyTransientFailure({ ...base, autoResumes: [{ reason: "sandbox_spawn_timeout" }] }), null, "at most once");
  assert.equal(classifyTransientFailure({ ...base, threadId: null }), null);
  assert.equal(classifyTransientFailure({ ...base, cancellationRequested: true }), null);
  assert.equal(classifyTransientFailure({ ...base, runtimeFailure: { code: "sandbox_setup_failed" } }), null, "ACL setup failures are never replayed");
  const role = buildWorkerPrompt({ prompt: "x", timeoutSeconds: 60 });
  assert.match(role, /spawn_ready. is a transient runner start timeout/);
  assert.match(role, /Git metadata is read-only for you/);
});

test("P1: an unseen folder gets the long first-run bound, and one probe timeout or runner timeout is retried", { skip: process.platform !== "win32" ? "Windows sandbox preflight only" : false }, async () => {
  const control = path.join(F.root, "probe-control.json");
  const mode = m => { fs.writeFileSync(control, JSON.stringify({ mode: m })); fs.rmSync(control + ".calls", { force: true }); };
  assert.equal(D.probeBound({ firstRun: true, env: {} }), 180000);
  assert.equal(D.probeBound({ firstRun: false, env: {} }), 60000);
  await withEnv({ CODEX_TEAM_FAKE_PROBE: control, CODEX_TEAM_PROBE_TIMEOUT_MS: "1500" }, async () => {
    mode("timeout-once");
    const cwd = F.project(), binary = R.resolveCodex(), runtime = D.inspectRuntime(binary, cwd);
    const first = D.probeRuntime(binary, runtime, cwd, { force: true, timeoutMs: 20000 });
    assert.equal(first.status, "passed", JSON.stringify(first));
    assert.equal(first.firstRun, true);
    assert.deepEqual(first.attempts.map(a => a.outcome), ["timed_out", "passed"]);
    const second = D.probeRuntime(binary, runtime, cwd, { force: true, timeoutMs: 20000 });
    assert.equal(second.firstRun, false, "a folder set up once is warm");
    assert.equal(D.probeRuntime(binary, runtime, cwd, { force: true, timeoutMs: 20000, thorough: true }).firstRun, true);
    mode("spawn-once");
    const other = F.project();
    const third = D.probeRuntime(binary, runtime, other, { force: true, timeoutMs: 20000 });
    assert.deepEqual(third.attempts.map(a => a.outcome), ["runner_start_timeout", "passed"]);
    mode("spawn-always");
    const stuck = F.project();
    const blocked = D.probeRuntime(binary, runtime, stuck, { force: true, timeoutMs: 20000 });
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.failure.code, "sandbox_spawn_timeout");
    assert.equal(D.health(stuck, runtime), null, "a transient runner failure blocks this job only");
    mode("pass");
  });
});

test("P1: a runner start timeout that stopped the worker resumes the same thread once; a recovered one is only noted", async () => {
  await withEnv({ CODEX_TEAM_TEST_BACKOFF_MS: "50,50" }, async () => {
    const cwd = F.project();
    const job = F.start(cwd, { prompt: "SPAWN_TIMEOUT_STOP" });
    const state = await settle(job);
    assert.equal(state.status, "implementation_finished", JSON.stringify({ status: state.status, error: state.error, rf: state.runtimeFailure, ar: state.autoResumes }));
    assert.equal(state.autoResumes.length, 1);
    assert.equal(state.autoResumes[0].reason, "sandbox_spawn_timeout");
    const captured = JSON.parse(fs.readFileSync(path.join(S.jobDir(job.jobId), "captured.json"), "utf8"));
    assert.equal(captured.args[captured.args.indexOf("resume") + 1], "11111111-2222-3333-4444-555555555555");
    assert.match(captured.prompt, /retry the tool call that failed/);
    assert.equal(D.health(cwd, state.runtime), null, "project health is not poisoned");
    const recovered = F.start(F.project(), { prompt: "SPAWN_TIMEOUT_RECOVERED WRITE_CODE" });
    const done = await settle(recovered);
    assert.equal(done.status, "implementation_finished");
    assert.equal(done.runtimeFailure, null);
    assert.deepEqual({ count: done.sandboxSpawnTimeouts.count, recovered: done.sandboxSpawnTimeouts.recovered }, { count: 1, recovered: true });
    assert.equal(done.autoResumes, undefined);
  });
});

test("P1: a sandboxed check whose runner never started is run once more", async () => {
  const cwd = F.project(), marker = path.join(F.root, "runner-" + randomUUID());
  const script = `const fs=require("fs");const m=${JSON.stringify(marker)};if(!fs.existsSync(m)){fs.writeFileSync(m,"1");console.error("Error: windows sandbox failed: timed out after 15000ms waiting for runner spawn_ready");process.exit(1)}`;
  const job = F.start(cwd, { prompt: "WRITE_CODE", assignment: F.assignment({ verification: [{ id: "answer", allowInline: true, criteria: [0], command: process.execPath, args: ["-e", script], timeoutSeconds: 30 }] }) });
  await F.done(job);
  R.verifyJob({ cwd, jobId: job.jobId });
  const state = await settle(job);
  const check = state.verification.checks[0];
  assert.equal(check.status, "passed", JSON.stringify(check));
  assert.equal(check.attempts.length, 2);
  assert.equal(check.attempts[0].sandboxRunnerStartTimeout, true);
});

// ── P4: Git configuration observations in linked worktrees ──

test("P4: sibling branch-tracking entries and injected GIT_CONFIG_* never count as a configuration change", () => {
  const main = F.project(), linked = path.join(F.root, "linked-" + randomUUID().slice(0, 8));
  git(main, ["worktree", "add", "--quiet", "-b", "lane", linked]);
  const before = gitSecuritySnapshot(linked);
  assert.equal(before.version, 2);
  assert.equal(before.shared, true);
  // What `git push -u` from another worktree writes into the shared common config.
  git(main, ["config", "branch.platform/other-lane.remote", "origin"]);
  git(main, ["config", "branch.platform/other-lane.merge", "refs/heads/platform/other-lane"]);
  const tracking = compareGitSecurity(before, gitSecuritySnapshot(linked));
  assert.equal(tracking.changed, false, JSON.stringify(tracking));
  assert.deepEqual(tracking.ignored.paths.sort(), ["config", "effectiveConfig"]);
  assert.equal(tracking.sharedGitDirectory, true);
  const injected = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "evil", GIT_CONFIG_PARAMETERS: "'core.pager'='evil'" };
  const saved = Object.fromEntries(Object.keys(injected).map(k => [k, process.env[k]]));
  Object.assign(process.env, injected);
  let underInjection;
  try {
    assert.deepEqual(Object.keys(observerEnvironment()).filter(k => /^GIT_/i.test(k)), []);
    underInjection = gitSecuritySnapshot(linked);
  } finally { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  assert.equal(compareGitSecurity(before, underInjection).changed, false, "injected environment is not repository state");
  // A real change in the shared config still counts and says where it lives.
  git(main, ["config", "core.hooksPath", "elsewhere"]);
  const real = compareGitSecurity(before, gitSecuritySnapshot(linked));
  assert.equal(real.changed, true);
  assert.ok(real.paths.includes("config") && real.paths.includes("effectiveConfig"), JSON.stringify(real));
  assert.match(real.heading, /shared with sibling worktrees/);
  const entries = configEntries("file:a\0branch.x.remote\norigin\0command line:\0core.pager\nless\0", true);
  assert.deepEqual(partitionConfig(entries).relevant, []);
  assert.equal(partitionConfig(entries).benign.length, 1);
  assert.equal(partitionConfig(configEntries("remote.origin.url\nhttps://x\0branch.x.mergeoptions\n--no-ff\0")).relevant.length, 2, "remote URLs and merge options stay relevant");
});

test("P4: a 1.2.1 snapshot still compares by its raw digests", () => {
  const cwd = F.project();
  const now = gitSecuritySnapshot(cwd);
  const legacyBefore = { entries: now.legacy, hash: "old" };
  assert.equal(compareGitSecurity(legacyBefore, now).changed, false);
  git(cwd, ["config", "branch.main.description", "touched"]);
  assert.equal(compareGitSecurity(legacyBefore, gitSecuritySnapshot(cwd)).changed, true, "old snapshots keep their old, conservative meaning");
});
