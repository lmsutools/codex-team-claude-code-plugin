/** 1.2.2: latest Codex CLI, service tiers and load-resilient verification. Fake CLI only; no provider calls. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
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
import { toolchainPassEnv, toolchainHint, workerToolchainEnv } from "../scripts/toolchain-env.mjs";
import { checkInvocation } from "../scripts/sandbox-checks.mjs";
import { tierLabel, tierShort, effectiveTier, omittedTier, catalogAdvice, configuredTier, assertTierSupported, resetFeatureCache, validateTier } from "../scripts/service-tier.mjs";
import { packet } from "../scripts/wait.mjs";
import { summarize, render } from "../scripts/tokens.mjs";
import { salvageRun } from "../scripts/salvage.mjs";
import { instructionSnapshot } from "../scripts/review-instructions.mjs";
import { reportSchema } from "../scripts/contracts.mjs";
import { snapshot } from "../scripts/git.mjs";
import { cliCompatibility, REQUIRED } from "../scripts/cli-compat.mjs";
import { sandboxProbe } from "../scripts/sandbox-probe.mjs";
import { runInNewContext } from "node:vm";
// Resolve before the fixture substitutes fake-codex: the opt-in real-CLI test checks the selected launcher.
const realCli = process.env.CODEX_TEAM_REAL_CLI === "1" ? (() => { try { return { binary: R.resolveCodex(), home: process.env.CODEX_HOME || path.join(os.homedir(), ".codex") }; } catch (error) { return { error }; } })() : null;
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

// ── P5: commits after acceptance ──

test("P5: accepted work names who commits it: the lead, codex_integrate for worktrees", async () => {
  const cwd = F.project();
  const job = F.start(cwd, { prompt: "WRITE_CODE" });
  await F.done(job);
  R.verifyJob({ cwd, jobId: job.jobId });
  await settle(job);
  const accepted = F.accept(job);
  assert.equal(accepted.status, "accepted");
  assert.match(compactJob(accepted).next, /Codex never commits.*git add -- <files> and git commit/);
  const isolated = F.start(F.project(), { prompt: "WRITE_CODE", isolation: "worktree" });
  await F.done(isolated);
  R.verifyJob({ cwd: isolated.cwd, jobId: isolated.jobId });
  await settle(isolated);
  assert.match(F.accept(isolated).next, /codex_integrate copies the reviewed files/);
});

// ── P6: Rust toolchain homes in the network-off sandbox ──

test("P6: cargo/rustc/rustup checks receive CARGO_HOME/RUSTUP_HOME; other checks do not", () => {
  const env = { CARGO_HOME: "D:/tools/cargo", rustup_home: "D:/tools/rustup", PATH: "x" };
  assert.deepEqual(toolchainPassEnv("C:/tools/cargo/bin/cargo.exe", [], env), ["CARGO_HOME", "RUSTUP_HOME"]);
  assert.deepEqual(toolchainPassEnv("rustup", ["CARGO_HOME"], env), ["RUSTUP_HOME"]);
  assert.deepEqual(toolchainPassEnv("cargo-nextest", [], env), ["CARGO_HOME", "RUSTUP_HOME"]);
  assert.deepEqual(toolchainPassEnv(process.execPath, [], env), []);
  assert.deepEqual(toolchainPassEnv("cargo", [], { PATH: "x" }), []);
  assert.deepEqual(workerToolchainEnv(env), ["CARGO_HOME", "RUSTUP_HOME"]);
  const offline = "error: no matching package named `serde` found\nlocation searched: registry `crates-io`";
  assert.match(toolchainHint({ passEnv: [] }, offline, env), /did not receive CARGO_HOME and RUSTUP_HOME.*passEnv: \["CARGO_HOME","RUSTUP_HOME"\]/);
  assert.match(toolchainHint({ passEnv: ["CARGO_HOME"], autoPassEnv: ["RUSTUP_HOME"] }, offline, env), /although CARGO_HOME\/RUSTUP_HOME were passed/);
  assert.match(toolchainHint({}, "error: toolchain 'stable-x86_64-pc-windows-msvc' is not installed", { PATH: "x" }), /not set on the host/);
  assert.equal(toolchainHint({}, "assertion failed", env), null);
  assert.equal(toolchainHint({ host: true }, offline, env), null);
});

test("P6: the sandboxed check invocation and Codex's shell policy carry the toolchain homes", async () => {
  await withEnv({ CARGO_HOME: path.join(F.root, "cargo-home"), RUSTUP_HOME: path.join(F.root, "rustup-home") }, async () => {
    const cwd = F.project(), jobId = randomUUID();
    const invocation = checkInvocation({ executionCwd: cwd, jobId }, { command: "C:/tools/cargo/bin/cargo.exe", args: ["test", "--offline"] }, R.resolveCodex());
    try {
      assert.deepEqual(invocation.autoPassEnv, ["CARGO_HOME", "RUSTUP_HOME"]);
      assert.equal(invocation.env.CARGO_HOME, process.env.CARGO_HOME);
      const policy = invocation.args.find(a => a.startsWith("shell_environment_policy.include_only="));
      assert.match(policy, /CARGO_HOME/); assert.match(policy, /RUSTUP_HOME/);
      const node = checkInvocation({ executionCwd: cwd, jobId }, { command: process.execPath, args: ["-v"] }, R.resolveCodex());
      try { assert.deepEqual(node.autoPassEnv, []); assert.equal(node.env.CARGO_HOME, undefined); } finally { node.cleanup?.(); }
    } finally { invocation.cleanup?.(); }
    const args = R.buildArgs({ jobId, cwd, executionCwd: cwd, threadId: null }, "report.txt");
    assert.match(args.find(a => a.startsWith("shell_environment_policy.include_only=")), /CARGO_HOME.*RUSTUP_HOME|RUSTUP_HOME.*CARGO_HOME/);
    assert.equal(R.doctor({}).toolchain.CARGO_HOME, "set");
  });
});

test("P6: a sandboxed check that fails like offline cargo carries a toolchain hint", async () => {
  await withEnv({ CARGO_HOME: path.join(F.root, "cargo-home") }, async () => {
    const cwd = F.project();
    const script = 'console.error("error: no matching package named `serde` found");process.exit(101)';
    const job = F.start(cwd, { prompt: "WRITE_CODE", assignment: F.assignment({ verification: [{ id: "answer", allowInline: true, criteria: [0], command: process.execPath, args: ["-e", script], timeoutSeconds: 30 }] }) });
    await F.done(job);
    R.verifyJob({ cwd, jobId: job.jobId });
    const state = await settle(job);
    assert.equal(state.verification.checks[0].status, "failed");
    assert.match(state.verification.checks[0].toolchainHint, /did not receive CARGO_HOME.*passEnv: \["CARGO_HOME"/);
  });
});

// ── P7: service tiers ──

test("P7: serviceTier is validated, passed as -c service_tier, inherited by revisions and shown everywhere", async () => {
  resetFeatureCache();
  assert.throws(() => validateTier("turbo"), /serviceTier must be default, fast, priority or ultrafast/);
  assert.throws(() => F.start(F.project(), { prompt: "WRITE_CODE", serviceTier: "turbo" }), /serviceTier must be/);
  const cwd = F.project();
  const job = F.start(cwd, { prompt: "WRITE_CODE", serviceTier: "ultrafast" });
  assert.equal(compactJob({ ...job }).serviceTier, "ultrafast");
  const done = await F.done(job);
  assert.equal(done.serviceTier, "ultrafast");
  assert.deepEqual(done.effectiveServiceTier, { requested: "ultrafast", source: "explicit", effective: "ultrafast" });
  const captured = JSON.parse(fs.readFileSync(path.join(S.jobDir(job.jobId), "captured.json"), "utf8"));
  assert.ok(captured.args.includes('service_tier="ultrafast"'), captured.args.join(" "));
  assert.equal(packet(S.readRaw(job.jobId), process.env.CODEX_TEAM_STATE).serviceTier, "ultrafast");
  const revision = F.start(cwd, { resumeJobId: job.jobId, prompt: "WRITE_REVISION" });
  assert.equal(revision.serviceTier, "ultrafast");
  await F.done(revision);
  const resumed = JSON.parse(fs.readFileSync(path.join(S.jobDir(revision.jobId), "captured.json"), "utf8"));
  assert.ok(resumed.args.includes("resume") && resumed.args.includes('service_tier="ultrafast"'));
  const plain = F.start(F.project(), { prompt: "WRITE_CODE" });
  assert.equal("serviceTier" in S.readRaw(plain.jobId), false, "no tier key: 1.2.1 request identities are unchanged");
  await F.done(plain);
});

test("P7: an explicit tier the selected CLI cannot honor fails with a clear error", async () => {
  const binary = R.resolveCodex();
  for (const [features, tier, pattern] of [
    ["fast_mode=true", "ultrafast", /not supported by .*no ultrafast_mode feature.*0\.153\.2 does not/],
    ["fast_mode=true,ultrafast_mode=false", "ultrafast", /disabled in .*ultrafast_mode is off/],
    ["fail", "fast", /cannot be confirmed .*features list/],
  ]) {
    resetFeatureCache();
    await withEnv({ CODEX_TEAM_FAKE_FEATURES: features }, async () => {
      assert.throws(() => assertTierSupported(tier, binary), pattern);
      assert.throws(() => F.start(F.project(), { prompt: "WRITE_CODE", serviceTier: tier }), pattern);
    });
  }
  resetFeatureCache();
  await withEnv({ CODEX_TEAM_FAKE_FEATURES: "fast_mode=true" }, async () => {
    assert.equal(assertTierSupported("priority", binary).feature, "fast_mode");
    assert.equal(assertTierSupported("default", binary).checked, false, "default needs no feature");
  });
  resetFeatureCache();
});

test("P7: an inherited or dropped tier is reported honestly in status, waiter and footer", async () => {
  const home = process.env.CODEX_HOME, config = path.join(home, "config.toml"), catalog = path.join(home, "models_cache.json");
  fs.writeFileSync(config, 'model = "gpt-test"\nservice_tier = "ultrafast"\n[profiles.other]\nservice_tier = "fast"\n');
  fs.writeFileSync(catalog, JSON.stringify({ fetched_at: "2026-10-19T01:56:30Z", client_version: "0.163.0", models: [{ slug: "gpt-test", service_tiers: [{ id: "priority", name: "Fast" }], additional_speed_tiers: ["fast"] }] }));
  try {
    assert.deepEqual(configuredTier(F.root, home), { tier: "ultrafast", file: config });
    assert.match(catalogAdvice("ultrafast", "gpt-test", home), /does not advertise "ultrafast" for gpt-test \(advertised: priority, fast\)/);
    assert.equal(catalogAdvice("priority", "gpt-test", home), null);
    const cwd = F.project();
    const job = F.start(cwd, { prompt: "WRITE_CODE" });
    assert.equal(job.serviceTierInherited.tier, "ultrafast");
    assert.match(compactJob(job, { showAutoVerify: true }).serviceTierAdvice, /does not advertise "ultrafast"/);
    assert.equal(compactJob(job).serviceTier, "ultrafast (config)");
    await F.done(job);
    const captured = JSON.parse(fs.readFileSync(path.join(S.jobDir(job.jobId), "captured.json"), "utf8"));
    assert.equal(captured.args.some(a => a.startsWith("service_tier=")), false, "an inherited tier is left to the CLI");
  } finally { fs.rmSync(config, { force: true }); fs.rmSync(catalog, { force: true }); }
  await withEnv({ CODEX_TEAM_FAKE_UNADVERTISED: "ultrafast" }, async () => {
    const job = F.start(F.project(), { prompt: "WRITE_CODE", serviceTier: "ultrafast" });
    const done = await F.done(job);
    assert.deepEqual({ tier: done.serviceTierOmitted.tier, model: done.serviceTierOmitted.model }, { tier: "ultrafast", model: "gpt-test" });
    assert.equal(compactJob(done).serviceTier, "default (ultrafast omitted by the CLI: not advertised for gpt-test)");
    assert.match(packet(S.readRaw(job.jobId), process.env.CODEX_TEAM_STATE).serviceTier, /omitted by the CLI/);
    assert.equal(effectiveTier(done).effective, "default");
  });
  assert.deepEqual(omittedTier({ type: "item.completed", item: { type: "error", message: "Configured service tier `ultrafast` is not advertised as supported for model `gpt-6-astra` and will be omitted from requests." } }), { tier: "ultrafast", model: "gpt-6-astra" });
  assert.equal(omittedTier({ type: "item.completed", item: { type: "agent_message", text: "Configured service tier `ultrafast` is not advertised as supported for model `x`" } }), null, "model prose is not a CLI notice");
  assert.equal(tierShort({ serviceTier: "ultrafast", serviceTierOmitted: { tier: "ultrafast", model: "m" } }), "ultrafast→default (omitted)");
  assert.equal(tierShort({ serviceTierInherited: { tier: "priority" } }), "priority (config)");
  assert.equal(tierLabel({}), null);
  const now = Date.now(), job = { jobId: randomUUID(), status: "implementation_finished", serviceTier: "ultrafast", serviceTierOmitted: { tier: "ultrafast", model: "m" },
    execs: [{ startedAt: new Date(now - 2000).toISOString(), finishedAt: new Date(now - 1000).toISOString(), usage: { input_tokens: 10, output_tokens: 2 }, model: "m" }] };
  const summary = summarize({ transcript: { calls: [], replyFrom: 0, replyStartAt: new Date(now - 60000).toISOString() }, jobs: [job] });
  assert.deepEqual(summary.contributor.tiers, ["ultrafast→default (omitted)"]);
  assert.match(render({ ...summary, windows: [] }), /Re-reads: .* · Codex tier ultrafast→default \(omitted\)/);
});

// ── P8: newer CLI event shapes and the compatibility check ──

test("P8: CLI notice items do not count as tool use in the tool-free finalize turn", async t => {
  t.after(() => delete process.env.CODEX_TEAM_FAKE_RECOVERY);
  const cwd = F.project(), jobId = randomUUID(), dir = S.jobDir(jobId);
  fs.mkdirSync(dir, { recursive: true });
  const state = { jobId, cwd, executionCwd: cwd, status: "running", baseline: snapshot(cwd), reviewInstructionBaseline: instructionSnapshot(cwd), startedAt: S.now(), threadId: randomUUID(), timeoutSeconds: 30, salvageSeconds: 10 };
  S.save(state);
  fs.writeFileSync(path.join(dir, "report-schema.json"), JSON.stringify(reportSchema));
  const control = path.join(F.root, "finalize-" + jobId + ".json");
  fs.writeFileSync(control, JSON.stringify({ runs: true, finalizeItem: "error" }));
  process.env.CODEX_TEAM_FAKE_RECOVERY = control;
  const result = await salvageRun(state, { runProcess: R.runProcess, buildArgs: R.buildArgs, binary: R.resolveCodex(), reportPath: path.join(dir, "report.txt"), eventsFile: path.join(dir, "events.jsonl"), errorFile: path.join(dir, "stderr.log"), persist: R.persist });
  assert.equal(result.salvage.outcome, "salvaged", JSON.stringify(result.salvage));
  S.patch(jobId, { status: "failed" });
});

test("P8: a recovered reconnect notice does not fail the reviewer or the native review", async t => {
  const file = path.join(F.root, "reviewer-reconnect.json");
  fs.writeFileSync(file, JSON.stringify({ reconnect: true }));
  process.env.CODEX_TEAM_FAKE_REVIEWER = file;
  t.after(() => delete process.env.CODEX_TEAM_FAKE_REVIEWER);
  const job = F.start(F.project(), { prompt: "WRITE_CODE", autoVerify: true });
  const done = await settle(job);
  assert.equal(done.status, "verified", JSON.stringify({ status: done.status, packet: done.decisionPacket?.status, error: done.decisionPacket?.reviewerError }));
  assert.equal(done.decisionPacket.status, "ready", done.decisionPacket.reviewerError);
  assert.equal(done.nativeReview.status, "completed", done.nativeReview.reason);
});

test("P8: the compatibility check names every missing flag", () => {
  const help = { exec: REQUIRED.exec.join(" "), "exec resume": REQUIRED["exec resume"].join(" "), "exec review": "--uncommitted", sandbox: REQUIRED.sandbox.join(" ") };
  const run = (command, args) => {
    const joined = args.slice(1).join(" ");
    if (joined === "--version") return { status: 0, stdout: "codex-cli 9.9.9\n" };
    if (joined === "features list") return { status: 0, stdout: "fast_mode    stable    true\nultrafast_mode    stable    true\n" };
    const surface = args.slice(1, -1).join(" ");
    return { status: 0, stdout: help[surface] ?? "" };
  };
  resetFeatureCache();
  const ok = cliCompatibility({ command: process.execPath, prefix: ["fake-compat-a.js"] }, { run });
  assert.equal(ok.compatible, true, JSON.stringify(ok));
  assert.deepEqual(ok.serviceTiers, { default: true, fast: true, priority: true, ultrafast: true });
  help.sandbox = "--cd --config";
  const broken = cliCompatibility({ command: process.execPath, prefix: ["fake-compat-b.js"] }, { run });
  assert.equal(broken.compatible, false);
  assert.deepEqual(broken.surfaces.sandbox.missing, ["--permission-profile", "--include-managed-config"]);
  resetFeatureCache();
});

test("P8: the real selected Codex CLI is compatible (opt-in)", { skip: realCli ? false : "Set CODEX_TEAM_REAL_CLI=1 (and CODEX_TEAM_CODEX) to check a real CLI without model calls." }, t => {
  assert.ifError(realCli.error);
  resetFeatureCache();
  const report = cliCompatibility(realCli.binary);
  t.diagnostic("Real CLI: " + report.version + " · " + report.executable + " · tiers " + JSON.stringify(report.serviceTiers));
  assert.equal(report.compatible, true, JSON.stringify(report.surfaces));
  assert.match(report.version, /codex-cli \d+\.\d+\.\d+/);
  if (process.platform === "win32") {
    // The host's Codex home: a fresh home selects the default sandbox mode without its setup.
    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = realCli.home;
    let probe;
    try {
      const cwd = F.project(), runtime = D.inspectRuntime(realCli.binary, cwd);
      probe = D.probeRuntime(realCli.binary, runtime, cwd, { force: true, timeoutMs: 300000 });
    } finally { process.env.CODEX_HOME = previousHome; }
    t.diagnostic("Real preflight: " + probe.status + " · first run " + probe.firstRun + " · attempts " + JSON.stringify(probe.attempts));
    assert.equal(probe.status, "passed", JSON.stringify(probe.failure || probe));
  }
  resetFeatureCache();
});

test("P8: Codex's network-off sentinel env is recognised by value; a real proxy value still counts as leaked", () => {
  const cwd = F.project(), binary = { command: process.execPath, prefix: [] };
  const sentinels = { ALL_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", NO_PROXY: "localhost,127.0.0.1,::1",
    GIT_HTTP_PROXY: "http://127.0.0.1:9", GIT_HTTPS_PROXY: "http://127.0.0.1:9", GIT_SSH_COMMAND: "cmd /c exit 1", GIT_ALLOW_PROTOCOLS: "",
    CARGO_NET_OFFLINE: "true", NPM_CONFIG_OFFLINE: "true", PIP_NO_INDEX: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1", SBX_NONET_ACTIVE: "1" };
  for (const [extra, expectUnexpected] of [[{}, []], [{ HTTP_PROXY: "http://user:secret@corp-proxy:8080" }, ["HTTP_PROXY"]], [{ GIT_SSH_COMMAND: "ssh -i key" }, ["GIT_SSH_COMMAND"]]]) {
    const run = (_executable, args, options) => {
      let stdout = "";
      const includeOnly = JSON.parse(args.find(a => a.startsWith("shell_environment_policy.include_only=")).slice("shell_environment_policy.include_only=".length));
      const env = { ...Object.fromEntries(Object.entries(options.env).filter(([name]) => includeOnly.includes(name))), ...sentinels, ...extra };
      runInNewContext(args.at(-1), {
        process: { env }, console: { log: value => { stdout = value + "\n"; } },
        require: name => name === "node:path" ? path : { writeFileSync: file => { if (file !== "inside" && file !== path.join(env.TEMP, "private-probe")) throw Object.assign(Error("denied"), { code: "EPERM" }); } },
      });
      return { status: 0, stdout, stderr: "" };
    };
    const result = sandboxProbe(binary, cwd, { run });
    assert.deepEqual(result.unexpectedNames, expectUnexpected, JSON.stringify(result));
    assert.equal(result.status, expectUnexpected.length ? "failed" : "passed");
    if (!expectUnexpected.length) assert.deepEqual(result.networkGuard, Object.keys(sentinels).sort());
    assert.doesNotMatch(JSON.stringify(result), /secret|127\.0\.0\.1:9/, "names only, never values");
  }
});

test("P1: a runtime file held by another process (os error 32) is named, retried once and explained", { skip: process.platform !== "win32" ? "Windows sandbox preflight only" : false }, async () => {
  const line = String.raw`[t] runtime read/execute validation failed: validate runtime read/execute access on C:\Users\U\AppData\Local\OpenAI\Codex\runtimes\cua_node\x\VCRUNTIME140_1.dll: open ACL target for root-only update: The process cannot access the file because it is being used by another process. (os error 32)`;
  const findings = D.logFindings(line, "D:\\project");
  assert.deepEqual(findings.map(f => f.kind), ["runtime_file_in_use"]);
  assert.match(findings[0].path, /VCRUNTIME140_1\.dll$/);
  assert.match(D.recovery("D:\\project", null, { probe: { findings } }).steps[0], /another process holds it \(os error 32\).*desktop app/);
  assert.match(D.versionHint("codex-cli 0.162.1", { check: { failure: { diagnostics: { probe: { findings } } } } }), /held by another process/);
  const control = path.join(F.root, "probe-in-use.json");
  const mode = m => { fs.writeFileSync(control, JSON.stringify({ mode: m })); fs.rmSync(control + ".calls", { force: true }); };
  await withEnv({ CODEX_TEAM_FAKE_PROBE: control }, async () => {
    const binary = R.resolveCodex();
    mode("in-use-once");
    const cwd = F.project(), runtime = D.inspectRuntime(binary, cwd);
    const retried = D.probeRuntime(binary, runtime, cwd, { force: true, timeoutMs: 30000 });
    assert.equal(retried.status, "passed", JSON.stringify(retried));
    assert.deepEqual(retried.attempts.map(a => a.outcome), ["runtime_file_in_use", "passed"]);
    mode("in-use-always");
    const held = F.project();
    const blocked = D.probeRuntime(binary, D.inspectRuntime(binary, held), held, { force: true, timeoutMs: 30000 });
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.failure.code, "sandbox_setup_failed");
    assert.deepEqual(blocked.attempts.map(a => a.outcome), ["runtime_file_in_use", "runtime_file_in_use"]);
    assert.match(blocked.failure.recovery.steps[0], /os error 32/);
    mode("pass");
  });
});
