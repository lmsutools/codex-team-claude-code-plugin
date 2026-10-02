/** End-to-end same-job decision pipeline with isolated state and a fake model. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fixture, S, R } from "./job-b-fixture.mjs";
import { snapshot, git } from "../scripts/git.mjs";
import { captureBytes, exactHunks, boundedBytes } from "../scripts/baseline-bytes.mjs";
import { buildReviewerPrompt, validateReviewerResult, runReviewer } from "../scripts/reviewer.mjs";
import { boundedPacket, resolvePacketEvidence } from "../scripts/decision-packet.mjs";
import { compactJob } from "../scripts/tool-output.mjs";
import { packet } from "../scripts/wait.mjs";
import { autoVerifyGate } from "../scripts/auto-verify.mjs";
import { resolveCheckExecutable, hostEnvironment } from "../scripts/check-executable.mjs";
import { workerEnvironment } from "../scripts/gates.mjs";
const f = fixture("decision");
const finish = f.done;
// A status long-poll may validly return while the additional native pass is active.
// Keep waiting for the lifecycle result; this is not a performance assertion.
f.done = async job => {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const state = await R.statusJob({ cwd: job.cwd, jobId: job.jobId, waitSeconds: 30 });
    if (!S.active.has(state.status)) return finish(job);
  }
  assert.fail("Decision fixture did not finish within 180 seconds.");
};
const start = (cwd, extra = {}) => f.start(cwd, { autoVerify: true, prompt: "WRITE_CODE", ...extra });
const control = value => {
  const file = path.join(f.root, "reviewer-control.json");
  fs.writeFileSync(file, JSON.stringify(value)); process.env.CODEX_TEAM_FAKE_REVIEWER = file;
};
async function phase(job, phase) {
  const end = Date.now() + 180000;
  while (Date.now() < end) {
    const state = S.read(job.jobId);
    if (state.livePhase === phase) return state;
    if (!S.active.has(state.status)) assert.fail(JSON.stringify(state));
    await new Promise(r => setTimeout(r, 25));
  }
  assert.fail("Phase never reached: " + phase);
}
test("explicit opt-in auto verification, exact packet, fresh read-only reviewer and lead acceptance", async () => {
  const cwd = f.project();
  // Exercise the production default, without the historical fixture opt-out.
  const job = R.startJob({ autoVerify: true, cwd, requestId: randomUUID(), assignment: f.assignment(), prompt: "WRITE_CODE" });
  const done = await f.done(job);
  assert.equal(done.autoVerify, true);
  assert.equal(done.status, "verified", JSON.stringify(done));
  assert.equal(done.decisionPacket.status, "ready");
  assert.ok(done.implementationFinishedAt);
  assert.equal(done.execs.length, 3); // 1.2 adds a native first pass on a clean baseline.
  assert.deepEqual(done.execs.map(e => e.role), ["implementation", "reviewer", "reviewer"]);
  const advisory = done.execs.find(e => e.reviewRunId === 'advisory');
  assert.notEqual(done.execs[0].threadId, advisory.threadId);
  assert.equal(advisory.usage.input_tokens, 7);
  const captured = JSON.parse(fs.readFileSync(path.join(S.jobDir(job.jobId), "reviewer-captured.json")));
  assert.ok(!captured.args.includes("resume"));
  assert.equal(captured.args[captured.args.indexOf("--sandbox") + 1], "read-only");
  assert.ok(captured.args.includes('approval_policy="never"'));
  assert.ok(captured.args.includes("project_doc_max_bytes=0"));
  assert.equal(captured.args.at(-1), "-");
  assert.ok(done.verification.checks[0].tests);
  assert.equal(done.decisionPacket.hunks[0].before, "");
  assert.ok(fs.existsSync(done.decisionPacketPath));
  const accepted = f.accept(done, { evidence: "packet" });
  assert.equal(accepted.status, "accepted");
  assert.equal(S.read(job.jobId).reviews.at(-1).evidence[0].source, "reviewer");
  assert.equal(fs.existsSync(S.read(job.jobId).baselineBytes.directory), false);
});
test("opt-out is request identity; manual verification shares reviewer pipeline", async () => {
  const cwd = f.project(), input = { cwd, requestId: randomUUID(), assignment: f.assignment(), prompt: "WRITE_CODE", autoVerify: false };
  const job = R.startJob(input);
  assert.throws(() => R.startJob({ ...input, autoVerify: true }), /different inputs/);
  const done = await f.done(job);
  assert.equal(done.status, "implementation_finished"); assert.equal(done.verification, undefined); assert.equal(done.livePhase, null);
  R.verifyJob({ cwd, jobId: job.jobId });
  assert.equal((await f.done(job)).decisionPacket.status, "ready");
});
test("legacy, read-only and scout jobs never automatically launch checks", async () => {
  for (const extra of [{ assignment: undefined, prompt: "Legacy" }, { readOnly: true, prompt: "Read" }, { mode: "scout", prompt: "Explore", assignment: f.assignment({ verification: [] }) }]) {
    const job = start(f.project(), extra), done = await f.done(job);
    assert.equal(done.status, "implementation_finished");
    assert.equal(done.autoVerify, false); assert.equal(done.verification, undefined);
    assert.equal(done.execs.length, 1);
  }
});
test("dirty tracked and untracked baselines use captured bytes; legacy and skipped bytes are explicit", () => {
  const cwd = f.project();
  fs.writeFileSync(path.join(cwd, "existing.txt"), "User dirty\nunchanged\n");
  fs.writeFileSync(path.join(cwd, "untracked.txt"), "User untracked\n");
  fs.writeFileSync(path.join(cwd, "binary.bin"), Buffer.from([0, 1]));
  fs.writeFileSync(path.join(cwd, "big.txt"), "x".repeat(300000));
  const baseline = snapshot(cwd), assignment = { scope: ["."] };
  const baselineBytes = captureBytes(cwd, baseline, assignment.scope, path.join(f.root, "bytes"));
  assert.match(baselineBytes.files["binary.bin"].skipped, /binary/);
  assert.equal(baselineBytes.files["big.txt"].skipped, "oversized");
  fs.writeFileSync(path.join(cwd, "existing.txt"), "User dirty\nCodex replacement\n");
  fs.appendFileSync(path.join(cwd, "untracked.txt"), "Codex addition\n");
  const state = { baseline, baselineBytes, assignment, executionCwd: cwd }, current = snapshot(cwd);
  const hunks = exactHunks(state, current);
  assert.equal(hunks.hunks[0].before, "unchanged\n");
  assert.equal(hunks.hunks[1].before, "");
  assert.ok(!JSON.stringify(hunks.hunks).includes("User dirty"));
  assert.equal(exactHunks({ ...state, baselineBytes: undefined }, current).available, false);
  assert.equal(exactHunks({ ...state, baselineBytes: undefined }, current).hunks.length, 0);
  const profile = { components: { secrets: { level: "enforce", forbiddenPaths: ["existing.txt"] } } };
  assert.equal(captureBytes(cwd, current, ["."], path.join(f.root, "forbidden"), profile).files["existing.txt"].skipped, "profile-forbidden");
});
test("strict verdict validation rejects unknown, duplicate, missing, failed-check and out-of-range evidence", () => {
  const state = { assignment: f.assignment(), verification: { checks: [{ id: "ok", exitCode: 0, status: "passed" }, { id: "failed", exitCode: 0, status: "failed" }] } };
  const hunks = { available: true, hunks: [{ file: "answer.mjs", startLine: 2, endLine: 3 }] };
  const valid = { criteria: [{ criterionIndex: 0, verdict: "met", evidence: "checked", checkIds: ["ok"], failingCheckIds: [], hunks: [{ file: "answer.mjs", startLine: 2, endLine: 3 }] }], risks: [] };
  assert.deepEqual(validateReviewerResult(valid, state, hunks), valid);
  for (const mutate of [r => r.criteria.push(r.criteria[0]), r => r.criteria.pop(), r => r.criteria[0].criterionIndex = 2,
    r => r.criteria[0].checkIds = [], r => r.criteria[0].verdict = "yes", r => r.criteria[0].checkIds = ["failed"], r => r.criteria[0].checkIds = ["missing"],
    r => r.criteria[0].hunks[0].file = "../outside", r => r.criteria[0].hunks[0].endLine = 4, r => r.extra = true]) {
    const report = structuredClone(valid); mutate(report); assert.throws(() => validateReviewerResult(report, state, hunks));
  }
});
test("invalid reviewer yields incomplete packet, unmet needs lead override, and stale packets refuse acceptance", async () => {
  control({ invalid: true });
  const job = start(f.project()); let done = await f.done(job);
  assert.equal(done.decisionPacket.status, "incomplete");
  assert.throws(() => f.accept(done, { evidence: "packet" }), /overrides required/);
  control({ verdict: "unmet" });
  R.verifyJob({ cwd: job.cwd, jobId: job.jobId }); done = await f.done(job);
  assert.equal(done.decisionPacket.criteria[0].verdict, "unmet");
  assert.throws(() => f.accept(done, { evidence: "packet" }), /overrides required/);
  assert.equal(f.accept(done, { evidence: "packet", packetEvidenceOverrides: f.evidence }).status, "accepted");
  fs.appendFileSync(path.join(job.cwd, "answer.mjs"), "// stale\n");
  assert.throws(() => f.accept(done, { evidence: "packet", packetEvidenceOverrides: f.evidence }), /stale/);
  assert.throws(() => resolvePacketEvidence({ ...done, assignment: { ...done.assignment, objective: "changed" } }), /stale/);
  delete process.env.CODEX_TEAM_FAKE_REVIEWER;
});
test("continuous reservation covers host checks and review; cancellation in both phases", async () => {
  for (const target of ["verification", "reviewer"]) {
    control({ delay: target === "reviewer" ? 600 : 0 });
    const assignment = f.assignment({ verification: [{ id: "answer", command: process.execPath, allowInline: true,
      args: ["-e", target === "verification" ? "setTimeout(()=>{},600)" : "process.exit(0)"], timeoutSeconds: 10 }] });
    const cwd = f.project(); fs.writeFileSync(path.join(cwd, "answer.mjs"), "// dirty user baseline\n");
    const job = start(cwd, { assignment });
    await phase(job, target);
    assert.throws(() => start(job.cwd), /active job/);
    // Durable cancellation marker is what codex_cancel writes; avoids requiring taskkill in the sandbox.
    fs.writeFileSync(path.join(S.jobDir(job.jobId), "cancel"), "cancel");
    const done = await f.done(job);
    assert.equal(done.status, "verification_failed", JSON.stringify(done));
    assert.equal(done.cancelled, true); assert.equal(done.livePhase, null);
    const baselineBytes = S.read(job.jobId).baselineBytes;
    assert.equal(fs.readFileSync(path.join(baselineBytes.directory, baselineBytes.files["answer.mjs"].hash), "utf8"), "// dirty user baseline\n");
    control({}); R.verifyJob({ cwd: job.cwd, jobId: job.jobId });
    const retried = await f.done(job); assert.equal(retried.status, "verified"); assert.equal(retried.cancelled, false);
    assert.equal(retried.decisionPacket.hunks[0].before, "// dirty user baseline\n");
  }
  delete process.env.CODEX_TEAM_FAKE_REVIEWER;
});
test("scope and git metadata guards prevent automatic host commands", async () => {
  const job = start(f.project(), { prompt: "WRITE_CODE OUT_OF_SCOPE" });
  const done = await f.done(job);
  assert.equal(done.status, "implementation_finished"); assert.equal(done.livePhase, null);
  assert.match(done.autoVerifySkipped.reason, /Out-of-scope/);
  assert.ok(compactJob(done).autoVerifySkipped); assert.ok(packet(done).autoVerifySkipped);
  assert.equal(done.verification, undefined);
  const manual = start(f.project(), { autoVerify: false }); await f.done(manual);
  git(manual.cwd, ["add", "answer.mjs"]);
  assert.throws(() => R.verifyJob({ cwd: manual.cwd, jobId: manual.jobId }), /Git metadata/);
});
test("C8 browser/owner evidence stays a lead obligation", async () => {
  const cwd = f.project({ leadEvidence: { level: "enforce", requireForCriteriaTagged: { owner: "ownerDecision" },
    kinds: { ownerDecision: { requiredFields: ["quote", "date"] } } } });
  f.approve(cwd);
  const job = start(cwd, { assignment: f.assignment({ acceptanceCriteria: [{ text: "Owner approves", tags: ["owner"] }] }) });
  const done = await f.done(job);
  assert.equal(f.accept(done, { evidence: "packet" }).status, "pending_lead_evidence");
  const override = [{ ...f.evidence[0], leadObservation: { kind: "ownerDecision", quote: "Approved", date: "2026-09-28" } }];
  assert.equal(f.accept(done, { evidence: "packet", packetEvidenceOverrides: override }).status, "accepted");
});
test("packet and compact output caps include explicit omission counts", async () => {
  const done = await f.done(start(f.project()));
  const large = { ...done.decisionPacket, hunks: Array(200).fill({ file: "answer.mjs", before: "\u0001".repeat(1000), after: "x".repeat(1000) }),
    criteria: Array(200).fill({ verdict: "unclear", evidence: "long".repeat(1000) }), risks: Array(200).fill("risk".repeat(1000)) };
  assert.ok(JSON.stringify(boundedPacket(large)).length <= 6000);
  assert.ok(boundedPacket(large).omittedHunks > 0);
  assert.equal(boundedPacket(large).untrustedCodexText.content.risks.length, 5);
  assert.equal(boundedPacket(large).omittedRisks, 195);
  assert.ok(JSON.stringify(packet({ ...done, decisionPacket: large })).length <= 6000);
  assert.ok(JSON.stringify(compactJob({ ...done, decisionPacket: large })).length <= 1500);
  const skipped = { ...done, autoVerifySkipped: { reason: "\u0001".repeat(1000), paths: Array(30).fill("\u0001".repeat(300)) } };
  assert.ok(JSON.stringify(compactJob(skipped)).length <= 1500);
  assert.ok(JSON.stringify(packet({ ...skipped, decisionPacket: null })).length <= 6000);
});
test("shared gate planning rejects forbidden commands in automatic and manual paths", async () => {
  for (const autoVerify of [true, false]) {
    const cwd = f.project({ gates: { level: "enforce", neverRun: [{ command: ["FORBIDDEN_FIXTURE"], reason: "fixture denial" }] } });
    f.approve(cwd);
    const job = start(cwd, { autoVerify, assignment: f.assignment({ verification: [{ id: "answer", command: process.execPath, allowInline: true, args: ["-e", "// FORBIDDEN_FIXTURE"], timeoutSeconds: 10 }] }) });
    const done = await f.done(job);
    if (autoVerify) { assert.equal(done.status, "implementation_finished"); assert.match(done.autoVerifySkipped.reason, /forbidden by profile/); }
    else assert.throws(() => R.verifyJob({ cwd, jobId: job.jobId }), /forbidden by profile/);
    assert.equal(fs.existsSync(path.join(S.jobDir(job.jobId), "verify-answer.stdout.log")), false);
  }
});
test("automatic and manual checks share leases, keep reservation while queued, and release leases", async () => {
  for (const autoVerify of [true, false]) {
    const cwd = f.project({ gates: { level: "enforce", maxParallelChecks: 1, checks: {} } });
    const profile = f.approve(cwd), leaseId = randomUUID();
    // A live existing holder models a check running in another authorized worktree.
    S.save({ jobId: leaseId, cwd: f.project(), status: "verifying", workerPid: process.pid, startedAt: S.now(), heartbeatAt: S.now() });
    S.setExtension("check-leases", profile.repoId, { jobs: [leaseId] });
    const job = start(cwd, { autoVerify });
    if (!autoVerify) { await f.done(job); R.verifyJob({ cwd, jobId: job.jobId }); }
    await phase(job, "verification");
    await new Promise(r => setTimeout(r, 300));
    assert.equal(fs.existsSync(path.join(S.jobDir(job.jobId), "verify-answer.stdout.log")), false);
    assert.throws(() => start(cwd), /active job/);
    S.patch(leaseId, { status: "verified" });
    const done = await f.done(job);
    assert.equal(done.status, "verified");
    assert.deepEqual(S.extension("check-leases", profile.repoId).jobs, []);
  }
});
test("legacy stored job without captured bytes gets unavailable hunks and requires lead evidence", async () => {
  const job = start(f.project(), { autoVerify: false }); await f.done(job);
  S.patch(job.jobId, { baselineBytes: null });
  R.verifyJob({ cwd: job.cwd, jobId: job.jobId });
  const done = await f.done(job);
  assert.equal(done.decisionPacket.hunks.length, 0);
  assert.match(done.decisionPacket.unavailableHunks[0].reason, /legacy/);
  assert.equal(done.decisionPacket.criteria[0].verdict, "unclear");
  assert.throws(() => f.accept(done, { evidence: "packet" }), /file observations|overrides required/);
});
test("cancellation during implementation prevents automatic commands and reviewer execution", async () => {
  const job = start(f.project(), { prompt: "SLOW_EVENTS WRITE_CODE" });
  await phase(job, "implementation");
  fs.writeFileSync(path.join(S.jobDir(job.jobId), "cancel"), "cancel");
  const done = await f.done(job);
  assert.equal(done.status, "cancelled");
  assert.equal(done.verification, undefined);
  assert.equal(done.livePhase, null); assert.equal(fs.existsSync(S.read(job.jobId).baselineBytes.directory), false);
  assert.ok(!(done.execs || []).some(e => e.role === "reviewer"));
});
test("reviewer process failure produces incomplete packet; non-profile test counts are parsed", async () => {
  control({ fail: true });
  try {
    const job = start(f.project(), { assignment: f.assignment({ verification: [{ id: "answer", command: process.execPath, allowInline: true,
      args: ["-e", "console.log('# pass 3\\n# fail 0')"], timeoutSeconds: 10 }] }) });
    const done = await f.done(job);
    assert.equal(done.decisionPacket.status, "incomplete");
    assert.equal(done.execs.find(e => e.reviewRunId === 'advisory').outcome, "failed");
    assert.deepEqual(done.decisionPacket.checks[0].tests, { pass: 3, fail: 0, format: "node" });
    assert.throws(() => f.accept(done, { evidence: "packet" }), /overrides required/);
  } finally { delete process.env.CODEX_TEAM_FAKE_REVIEWER; }
});

test("reviewer usage is separately budgeted and exhausted budgets prevent a reviewer call", async () => {
  for (const limit of [100, 10]) {
    const cwd = f.project({ budget: { level: "enforce", perJob: { inputTokens: limit } } });
    f.approve(cwd);
    const done = await f.done(start(cwd));
    if (limit === 100) {
      assert.equal(done.budget.task.inputTokens, 19); // Includes native fixture usage (2).
      assert.equal(done.execs.filter(e => e.role === "reviewer").length, 2);
      assert.equal(done.decisionPacket.status, "ready");
    } else {
      assert.equal(done.execs.filter(e => e.role === "reviewer").length, 0);
      assert.equal(done.decisionPacket.status, "incomplete");
      assert.match(done.decisionPacket.reviewerError, /budget exhausted/);
    }
  }
});


test("sandboxed checks are unaffected by filenames and inline forms",()=>{
 const state={assignment:{verification:[{command:"python",args:["-c","code"]}]}};
 assert.equal(autoVerifyGate(state,["argparse/__init__.py","package.json","ci/private.txt"]),null);
 assert.ok(autoVerifyGate(state,[],[{command:"node",host:true}]));
});
test("execution-sensitive filenames run automatically inside the sandbox",async()=>{
 const cwd=f.project(),assignment=f.assignment({scope:["."],verification:[{id:"answer",command:process.execPath,args:["runner.mjs"],timeoutSeconds:10}]});
 const job=start(cwd,{prompt:"WRITE_TARGET=runner.mjs",assignment}),done=await f.done(job);
 assert.equal(done.status,"verified",done.error);assert.equal(done.verification.checks[0].executedIn,"sandbox");assert.equal(done.autoVerifySkipped,null);
});

test("preparation failures can be repaired and verified without a new implementation", async () => {
  const job = start(f.project(), { prompt: "WRITE_CODE OUT_OF_SCOPE" });
  assert.equal((await f.done(job)).status, "implementation_finished");
  fs.unlinkSync(path.join(job.cwd, "unrelated.txt"));
  R.verifyJob({ cwd: job.cwd, jobId: job.jobId });
  assert.equal((await f.done(job)).status, "verified");
});
test("check leases end before review while the project remains reserved", async () => {
  control({ delay: 1200 });
  try {
    const cwd = f.project({ gates: { level: "enforce", maxParallelChecks: 1, checks: {} } });
    const profile = f.approve(cwd), job = start(cwd);
    await phase(job, "reviewer");
    assert.deepEqual(S.extension("check-leases", profile.repoId).jobs, []);
    assert.throws(() => start(cwd), /active job/);
    assert.equal((await f.done(job)).status, "verified");
  } finally { delete process.env.CODEX_TEAM_FAKE_REVIEWER; }
});
test("reviewer output is job-local and must match the final event message", async () => {
  for (const value of [{ forge: true }, { noFinalMessage: true }]) {
    control(value);
    try {
      const job = start(f.project()), done = await f.done(job);
      const captured = JSON.parse(fs.readFileSync(path.join(S.jobDir(job.jobId), "reviewer-captured.json")));
      const output = captured.args[captured.args.indexOf("--output-last-message") + 1];
      assert.equal(path.dirname(path.dirname(output)), S.jobDir(job.jobId));
      assert.equal(done.decisionPacket.status, "incomplete");
      assert.match(done.decisionPacket.reviewerError, /provenance failure/);
    } finally { delete process.env.CODEX_TEAM_FAKE_REVIEWER; }
  }
});
test("clean tracked baseline uses filtered Git blob references with hash verification", () => {
  const cwd = f.project();
  git(cwd, ["config", "core.autocrlf", "true"]);
  fs.unlinkSync(path.join(cwd, "existing.txt")); git(cwd, ["checkout", "--", "existing.txt"]);
  const original = fs.readFileSync(path.join(cwd, "existing.txt"), "utf8"), baseline = snapshot(cwd);
  const baselineBytes = captureBytes(cwd, baseline, ["."], path.join(f.root, "git-bytes"));
  assert.ok(baselineBytes.files["existing.txt"].gitBlob);
  assert.equal(baselineBytes.bytes, 0); assert.deepEqual(fs.readdirSync(baselineBytes.directory), []);
  fs.writeFileSync(path.join(cwd, "existing.txt"), "Changed\r\n");
  const state = { executionCwd: cwd, baseline, baselineBytes, assignment: { scope: ["."] } };
  assert.equal(exactHunks(state, snapshot(cwd)).hunks[0].before, original);
  baselineBytes.files["existing.txt"].hash = "a".repeat(64);
  assert.match(exactHunks(state, snapshot(cwd)).unavailable[0].reason, /corrupt-or-filters-changed/);
});
test("B1: autocrlf LF baseline committed without checkout retains decision-packet hunks", async () => {
  const cwd = f.project(), file = path.join(cwd, "answer.mjs");
  git(cwd, ["config", "core.autocrlf", "true"]);
  const original = "export const answer = 0;\n";
  fs.writeFileSync(file, original);
  git(cwd, ["add", "--", "answer.mjs"]);
  git(cwd, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "LF baseline without checkout"]);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.equal(git(cwd, ["status", "--porcelain"]).stdout, "", "LF worktree is clean under autocrlf");
  const job = start(cwd), done = await f.done(job);
  assert.equal(done.status, "verified", JSON.stringify(done));
  const captured = S.read(job.jobId).baselineBytes.files["answer.mjs"];
  assert.ok(captured.gitBlob, "clean baseline remains a Git blob reference");
  const filtered = git(cwd, ["cat-file", "--filters", "--path=answer.mjs", captured.gitBlob]).stdout;
  assert.equal(filtered, original.replaceAll("\n", "\r\n"), "filtered bytes differ from the captured LF worktree");
  assert.deepEqual(done.decisionPacket.unavailableHunks, []);
  const hunk = done.decisionPacket.hunks.find(entry => entry.file === "answer.mjs");
  assert.ok(hunk, "the decision packet includes the modified file's hunk");
  assert.equal(hunk.before, original);
  assert.equal(hunk.after, "export const answer = 42;\n");
});

test("capture checks remaining budget before reads; exhausted capture does not inspect later sources", () => {
  const cwd = f.project();
  for (const [file, text] of [["a.txt", "12345"], ["b.txt", "123"], ["c.txt", "SENSITIVE"]]) fs.writeFileSync(path.join(cwd, file), text);
  const baseline = snapshot(cwd), opened = [], statted = [], open = fs.openSync, stat = fs.statSync;
  fs.openSync = function(file, ...args) { opened.push(String(file)); return open.call(this, file, ...args); };
  fs.statSync = function(file, ...args) { statted.push(String(file)); return stat.call(this, file, ...args); };
  let captured;
  try { captured = captureBytes(cwd, baseline, ["a.txt", "b.txt", "c.txt"], path.join(f.root, "limited"), undefined, { budget: 3 }); }
  finally { fs.openSync = open; fs.statSync = stat; }
  assert.equal(captured.files["a.txt"].skipped, "capture-budget");
  assert.equal(captured.files["c.txt"].skipped, "capture-budget");
  assert.equal(captured.bytes, 3);
  assert.ok(!opened.includes(path.join(cwd, "a.txt"))); assert.ok(!opened.includes(path.join(cwd, "c.txt")));
  assert.ok(!statted.includes(path.join(cwd, "c.txt")));
  assert.throws(() => boundedBytes(path.join(cwd, "a.txt"), 3), /oversized/);
});
test("captured dirty bytes have independent revision ownership and are pruned on supersede and start failure", async () => {
  const cwd = f.project(); fs.writeFileSync(path.join(cwd, "answer.mjs"), "// User baseline\n");
  const job = start(cwd, { autoVerify: false }), done = await f.done(job);
  assert.ok(fs.existsSync(S.read(job.jobId).baselineBytes.directory));
  const revision = R.startJob({ cwd, requestId: randomUUID(), resumeJobId: job.jobId, prompt: "WRITE_REVISION", autoVerify: false });
  const revised = await f.done(revision);
  assert.equal(fs.existsSync(S.read(job.jobId).baselineBytes.directory), false);
  assert.equal(fs.readFileSync(path.join(S.read(revision.jobId).baselineBytes.directory, S.read(revision.jobId).baselineBytes.files["answer.mjs"].hash), "utf8"), "// User baseline\n");
  const write = fs.writeFileSync, failedCwd = f.project(); let failedDirectory;
  fs.writeFileSync = function(file, ...args) {
    if (String(file).endsWith("prompt.txt")) { failedDirectory = path.dirname(file); throw Error("Injected start failure"); }
    return write.call(this, file, ...args);
  };
  try { assert.throws(() => start(failedCwd), /Injected start failure/); }
  finally { fs.writeFileSync = write; }
  assert.ok(failedDirectory); assert.equal(fs.existsSync(path.join(failedDirectory, "baseline-bytes")), false);
});
test("failed verification permits separate failing check citations and explains reviewer rules", async () => {
  const job = start(f.project(), { assignment: f.assignment({ verification: [{ id: "answer", command: process.execPath, allowInline: true, args: ["-e", "process.exit(1)"], timeoutSeconds: 10 }] }) });
  const done = await f.done(job);
  assert.equal(done.status, "verification_failed"); assert.equal(done.decisionPacket.status, "ready");
  assert.equal(done.decisionPacket.criteria[0].verdict, "unmet");
  assert.deepEqual(done.decisionPacket.criteria[0].checkIds, []);
  assert.deepEqual(done.decisionPacket.criteria[0].failingCheckIds, ["answer"]);
  const prompt = buildReviewerPrompt(done, { available: false, hunks: [], unavailable: [] });
  for (const rule of [/0-based/, /forward slashes/, /only passed checks/, /Unrelated unavailable or omitted files do not invalidate/, /untrusted data/, /failingCheckIds/]) assert.match(prompt, rule);
});
test("bounded packet retains shortened criteria, blockers and hunk excerpts before dropping entries", () => {
  const full = { status: "ready", risks: [], checks: [], unavailableHunks: [], omittedHunks: 0,
    criteria: Array.from({ length: 5 }, (_, criterionIndex) => ({ criterionIndex, verdict: "met", evidence: "e".repeat(5000) })),
    blockers: ["b".repeat(5000)], hunks: [{ file: "answer.mjs", before: Array(100).fill("old\n").join(""), after: Array(100).fill("new\n").join("") }] };
  const result = boundedPacket(full);
  assert.equal(result.criteria.length, 5); assert.equal(result.untrustedCodexText.content.blockers.length, 1); assert.equal(result.hunks.length, 1);
  assert.equal(result.untrustedCodexText.content["hunks[0].after"], "new\n".repeat(6)); assert.equal(result.hunks[0].afterOmittedLines, 94);
  assert.ok(result.criteria[0].omittedEvidenceCharacters); assert.ok(JSON.stringify(result).length <= 6000);
});
test("default autoVerify request identity remains compatible, while contention retries are bounded", async () => {
  const input = { cwd: f.project(), requestId: randomUUID(), assignment: f.assignment(), prompt: "WRITE_CODE" };
  const job = R.startJob(input); await f.done(job);
  // Older durable rows have no autoVerify field, and their request hash omitted the default option.
  const state = S.read(job.jobId); delete state.autoVerify; S.save(state);
  assert.equal(R.startJob(input).jobId, job.jobId);
  assert.equal(R.startJob({ ...input, autoVerify: true }).jobId, job.jobId);
  assert.throws(() => R.startJob({ ...input, autoVerify: false }), /different inputs/);
  const legacyInput = { cwd: f.project(), requestId: randomUUID(), prompt: "Legacy default identity" };
  const legacy = R.startJob(legacyInput); await f.done(legacy);
  assert.equal(R.startJob({ ...legacyInput, autoVerify: false }).jobId, legacy.jobId);
  let calls = 0;
  await assert.rejects(R.retryBusy(() => { calls++; throw Error("SQLITE_BUSY"); }, { timeoutMs: 5, delayMs: 1 }), /Database remained busy for 5 ms/);
  assert.ok(calls > 1);
});
test("packet binding metadata survives hex-pattern secret sanitization", () => {
  const assignmentHash = "a".repeat(64), fingerprint = "b".repeat(64), jobId = randomUUID();
  S.save({ jobId, cwd: f.project(), startedAt: S.now(), status: "verified", profile: { components: { secrets: { level: "enforce", patterns: ["[a-f0-9]{64}"] } } },
    decisionPacket: { assignmentHash, fingerprint, criteria: [{ evidence: assignmentHash }] } });
  const value = S.read(jobId).decisionPacket;
  assert.equal(value.assignmentHash, assignmentHash); assert.equal(value.fingerprint, fingerprint);
  assert.equal(value.criteria[0].evidence, "[REDACTED]");
});


test("reviewer persists cleanup sandbox limits and distinguishes secrets, budget, exit and invalid reports", async () => {
  for (const kind of ["cleanup", "secrets", "exit", "invalid"]) {
    const cwd = f.project(), current = snapshot(cwd), jobId = randomUUID();
    const state = { jobId, cwd, executionCwd: cwd, startedAt: S.now(), status: "verifying", assignment: f.assignment(),
      baseline: current, baselineBytes: captureBytes(cwd, current, ["answer.mjs"], path.join(S.jobDir(jobId), "baseline-bytes")),
      verifiedFingerprint: current.fingerprint, verification: { status: "passed", checks: [{ id: "answer", status: "passed", exitCode: 0 }] },
      result: { summary: "Worker done", blockers: [] }, execs: [], review: {native:false} };
    S.save(state);
    const rm = fs.rmSync;
    if (kind === "cleanup") fs.rmSync = function(file, ...args) {
      if (path.dirname(file) === S.jobDir(jobId) && path.basename(file).startsWith("reviewer-output-")) throw Object.assign(Error("cleanup EPERM"), { code: "EPERM" });
      return rm.call(this, file, ...args);
    };
    try {
      await runReviewer(state, current, true, {
        buildArgs: (_, output) => ["--output-schema", "schema", "--output-last-message", output], resolveCodex: () => ({ command: "fake", prefix: [] }),
        persist: async (id, updates) => S.patch(id, updates), progressWriter: () => ({ note() {}, flush() {}, take() { return {}; } }), retryBusy: async op => op(),
        runProcess: async (_, command, args, options) => {
          options.onEvent({ type: "thread.started", thread_id: randomUUID() });
          const value = { criteria: [{ criterionIndex: 0, verdict: "met", evidence: "checked", checkIds: kind === "invalid" ? [] : ["answer"], failingCheckIds: [], hunks: [] }], risks: [] };
          const text = JSON.stringify(value); fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], text);
          options.onEvent({ type: "item.completed", item: { type: "agent_message", text } });
          options.onEvent({ type: "turn.completed" });
          return { code: kind === "exit" ? 9 : 0, secretCount: kind === "secrets" ? 1 : 0 };
        },
      });
    } finally { fs.rmSync = rm; }
    const done = S.read(jobId);
    if (kind === "cleanup") {
      assert.deepEqual(done.result.sandboxLimits, ["Reviewer cleanup: EPERM"]);
      assert.equal(done.decisionPacket.sandboxLimitsCount, 1); assert.equal(done.decisionPacket.status, "ready");
    } else {
      assert.equal(done.decisionPacket.status, "incomplete");
      assert.match(done.decisionPacket.reviewerError, kind === "exit" ? /exit-code failure: 9/ : kind === "secrets" ? /secrets failure/ : /invalid report/);
    }
  }
});


test("A: bare check resolution excludes planted Windows executables and project PATH directories", async () => {
  const cwd = f.project();
  for (const name of ["node.exe", "node.cmd", "node.com", "node.bat"]) fs.writeFileSync(path.join(cwd, name), "not the trusted executable");
  fs.mkdirSync(path.join(cwd, "tools")); fs.writeFileSync(path.join(cwd, "tools/node.exe"), "planted");
  const environment = { ...process.env, PATH: [cwd, path.join(cwd, "tools"), path.dirname(process.execPath)].join(path.delimiter) };
  assert.equal(resolveCheckExecutable("node", cwd, environment).toLowerCase(), fs.realpathSync(process.execPath).toLowerCase());
  assert.throws(() => resolveCheckExecutable("node", cwd, { PATH: cwd }), /only inside the project/);
  for (const autoVerify of [true, false]) {
    const project = f.project(); fs.writeFileSync(path.join(project, "node.cmd"), "@exit /b 73");
    fs.writeFileSync(path.join(project, "node.exe"), "planted invalid executable");
    const job = start(project, { autoVerify, assignment: f.assignment({ verification: [{ id: "answer", command: "node", allowInline: true, args: ["-e", "if(process.env.NoDefaultCurrentDirectoryInExePath!=='1')process.exit(74)"], timeoutSeconds: 10 }] }) });
    if (!autoVerify) { await f.done(job); R.verifyJob({ cwd: project, jobId: job.jobId }); }
    assert.equal((await f.done(job)).status, "verified");
  }
  assert.equal(workerEnvironment({}, true).NoDefaultCurrentDirectoryInExePath, "1");
  assert.equal(hostEnvironment({ NoDefaultCurrentDirectoryInExePath: "0" }).NoDefaultCurrentDirectoryInExePath, "1");
});
test("B: ignored executable changes remain advisory for sandboxed auto-verification",async()=>{
 const cwd=f.project();fs.writeFileSync(path.join(cwd,".gitignore"),"dist/\n");fs.mkdirSync(path.join(cwd,"dist"));fs.writeFileSync(path.join(cwd,"dist/check.mjs"),"// before");
 const job=start(cwd,{prompt:"WRITE_CODE WRITE_TARGET=dist/check.mjs",assignment:f.assignment({scope:["."],verification:[{id:"answer",command:process.execPath,args:["dist/check.mjs"],timeoutSeconds:10}]})});
 const done=await f.done(job);assert.equal(done.status,"verified",done.error);assert.equal(done.verification.checks[0].executedIn,"sandbox");
});

test("D: changed instructions allow sandboxed checks but prevent an advisory reviewer call", async () => {
  for (const file of ["AGENTS.md", "AGENTS.override.md", ".codex/config.toml"]) {
    const cwd = f.project(); fs.writeFileSync(path.join(cwd, ".gitignore"), ".codex/\n");
    const job = start(cwd, { prompt: "WRITE_CODE WRITE_TARGET=" + file, assignment: f.assignment({ scope: ["."] }) });
    const checked = await f.done(job); assert.equal(checked.status, "verified");
    assert.equal(checked.decisionPacket.status, "incomplete"); assert.match(checked.decisionPacket.reviewerError, /instruction|configuration/i);
    assert.equal(checked.execs.filter(e => e.role === "reviewer").length, 0);
  }
});
test("E: failure saving an automatic verification plan retains a repairable implementation", async () => {
  const cwd = f.project(), baseline = snapshot(cwd), jobId = randomUUID();
  const state = { jobId, cwd, executionCwd: cwd, baseline, verificationBaseline: baseline, assignment: f.assignment(), startedAt: S.now(), status: "verifying", implementationFinishedAt: S.now() };
  S.save(state);
  let writes = 0;
  assert.equal(await R.prepareAutomaticVerification(jobId, { prepare: value => value, save: async (id, updates) => {
    if (!writes++) throw Error("database is locked after bounded persist retries");
    return R.persist(id, updates);
  } }), false);
  const done = S.read(jobId); assert.equal(writes, 2); assert.equal(done.status, "implementation_finished");
  assert.equal(done.livePhase, null); assert.match(done.autoVerifySkipped.reason, /database is locked/);
});
test("G: unrelated unavailable hunks do not reject met; unavailable and omitted citations do", () => {
  const state = { assignment: f.assignment({ scope: ["."] }), verification: { checks: [{ id: "answer", status: "passed", exitCode: 0 }] } };
  const report = { criteria: [{ criterionIndex: 0, verdict: "met", evidence: "checked", checkIds: ["answer"], failingCheckIds: [], hunks: [{ file: "answer.mjs", startLine: 1, endLine: 1 }] }], risks: [] };
  const hunks = { available: true, omitted: 1, unavailable: [{ file: "unrelated.bin", reason: "binary" }], hunks: [{ file: "answer.mjs", startLine: 1, endLine: 1 }] };
  assert.deepEqual(validateReviewerResult(report, state, hunks), report);
  for (const file of ["unrelated.bin", "omitted.mjs"]) {
    const invalid = structuredClone(report); invalid.criteria[0].hunks[0].file = file;
    assert.throws(() => validateReviewerResult(invalid, state, hunks), /outside/);
  }
});
test("H: every terminal worker update and interrupted recovery clears an inherited live phase", async () => {
  const cwd = f.project();
  for (const status of ["verification_failed", "timed_out", "blocked_runtime", "budget_exhausted", "failed", "cancelled", "implementation_finished"]) {
    const jobId = randomUUID(); S.save({ jobId, cwd, status: "running", livePhase: "verification", startedAt: S.now() });
    await R.persist(jobId, { status }); assert.equal(S.read(jobId).livePhase, null, status);
  }
  const past = new Date(Date.now() - 60000).toISOString();
  for (const extra of [{}, { reservation: { pid: 99999999, at: past }, recoveryPhase: "backoff" }]) {
    const jobId = randomUUID(), state = { jobId, cwd, startedAt: past, heartbeatAt: past, workerPid: 99999999, status: "running", livePhase: "implementation", ...extra };
    S.save(state); const recovered = S.recover(state); assert.equal(recovered.status, "interrupted"); assert.equal(recovered.livePhase, null);
  }
});
test("I: union baseline unavailability survives revisions and criterion hunk citations are shortened first", async () => {
  const job = start(f.project(), { autoVerify: false }); await f.done(job);
  const reason = "batch-union-baseline-bytes-not-captured-before-integration";
  S.patch(job.jobId, { baselineBytes: null, baselineBytesUnavailableReason: reason });
  const revision = R.startJob({ cwd: job.cwd, requestId: randomUUID(), resumeJobId: job.jobId, prompt: "WRITE_REVISION", autoVerify: false });
  await f.done(revision); assert.equal(S.read(revision.jobId).baselineBytesUnavailableReason, reason);
  const full = { status: "ready", checks: [], risks: [], blockers: [], hunks: [], unavailableHunks: [], omittedHunks: 0,
    criteria: Array.from({ length: 4 }, (_, criterionIndex) => ({ criterionIndex, verdict: "met", evidence: "checked", hunks: Array.from({ length: 100 }, (_, i) => ({ file: "file" + i, startLine: 1, endLine: 1 })) })) };
  const result = boundedPacket(full); assert.equal(result.criteria.length, 4);
  assert.equal(result.criteria[0].hunks.length, 3); assert.equal(result.criteria[0].omittedHunkReferences, 97);
});


test("B: legacy revisions without a stored listing report advisory visibility unavailable",async()=>{
 const cwd=f.project(),job=f.start(cwd,{prompt:"WRITE_CODE"});await f.done(job);
 S.patch(job.jobId,{visibilityRecorded:false,hiddenChanges:null});
 const revised=f.start(cwd,{resumeJobId:job.jobId,requestId:randomUUID(),prompt:"Revision",autoVerify:false});
 const done=await f.done(revised);assert.equal(done.hiddenChanges.status,"unavailable");assert.equal(S.read(revised.jobId).verificationInputs,undefined);
});
