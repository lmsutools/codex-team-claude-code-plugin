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
