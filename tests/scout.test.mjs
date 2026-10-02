/** Scout validation, runtime controls, draft provenance and compact handoff coverage. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { fixture, R, S } from "./job-b-fixture.mjs";
import * as C from "../scripts/contracts.mjs";
import { packet } from "../scripts/wait.mjs";
import { compactJob } from "../scripts/tool-output.mjs";
import { draftHash } from "../scripts/report-preview.mjs";
import { snapshot, git } from "../scripts/git.mjs";
const F = fixture("scout");
const finish = F.done;
F.done = async job => {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const state = await R.statusJob({ cwd: job.cwd, jobId: job.jobId, waitSeconds: 30 });
    if (!S.active.has(state.status)) return finish(job);
  }
  assert.fail("Scout fixture did not finish within 180 seconds.");
};
const hashFor = job => draftHash(S.read(job.jobId).result.draftAssignment);
const brief = () => ({ summary: "Explore", files: [{ path: "src/a.mjs", lines: [{ startLine: 1, endLine: 3 }], why: "entry" }], dataFlow: [],
  draftAssignment: F.assignment(), risks: [], openQuestions: [] });
test("strict scout report bounds, literal paths, ordered ranges and normal draft checks", () => {
  C.scoutReport(brief());
  const literal = brief(); literal.files[0].path = "src/[id]/page.mjs"; C.scoutReport(literal);
  const invalid = [
    b => b.extra = true, b => delete b.risks, b => b.files[0].path = "../escape", b => b.files[0].path = "src/*.mjs",
    b => b.files[0].path = "C:/file", b => b.files[0].lines[0].startLine = 0, b => b.files[0].lines[0].endLine = 0,
    b => b.files[0].lines.push({ startLine: 2, endLine: 5 }), b => b.files[0].lines[0].extra = true,
    b => b.files = Array(201).fill(b.files[0]), b => b.summary = "x".repeat(20001),
    b => b.draftAssignment.verification = [], b => b.openQuestions = ["x".repeat(5001)],
  ];
  for (const mutate of invalid) { const b = brief(); mutate(b); assert.throws(() => C.scoutReport(b)); }
  assert.throws(() => C.assignment(F.assignment({ verification: [] })), /1-20/);
  assert.equal(C.assignment(F.assignment({ verification: [] }), { scout: true }).verification.length, 0);
});
test("scouts stay read-only through profile and resume, cannot enter code lifecycle", async () => {
  const cwd = F.project({ branchMode: { level: "enforce", trunk: "main", branchTemplate: "codex/{topic}", worktreeDir: ".artifacts/{topic}" } });
  F.approve(cwd, { branch: "codex/scout" });
  const before = snapshot(cwd);
  const job = F.start(cwd, { mode: "scout", branch: "codex/scout", assignment: F.assignment({ verification: [] }) });
  const result = await F.done(job);
  assert.equal(result.status, "implementation_finished", JSON.stringify(result));
  assert.equal(result.readOnly, true);
  assert.ok(R.buildArgs({ ...result, readOnly: false }, "report.json").includes("read-only"));
  assert.equal(result.isolation, "direct");
  assert.equal(result.executionCwd, cwd);
  assert.equal(snapshot(cwd).fingerprint, before.fingerprint);
  const captured = JSON.parse(fs.readFileSync(path.join(S.jobDir(job.jobId), "captured.json")));
  assert.ok(captured.args.includes("read-only"));
  assert.match(captured.prompt, /Explore only/);
  assert.doesNotMatch(captured.prompt, /Implement only this/);
  assert.throws(() => R.verifyJob({ cwd, jobId: job.jobId }), /Scouts/);
  assert.throws(() => F.accept(job), /Scouts/);
  assert.throws(() => R.integrateJob({ cwd, jobId: job.jobId }), /Scouts/);
  for (const extra of [{ readOnly: false }, { mode: "implementation" }, { isolation: "worktree" }])
    assert.throws(() => F.start(cwd, { resumeJobId: job.jobId, ...extra }), /read-only|preserve mode|read-only exploration/);
  const resumed = F.start(cwd, { resumeJobId: job.jobId, assignment: undefined });
  assert.equal((await F.done(resumed)).mode, "scout");
  assert.equal(resumed.readOnly, true);
  const p = packet(result);
  assert.equal(p.untrustedCodexText.content.draftObjective, result.result.draftAssignment.objective);
  assert.equal(p.untrustedCodexText.content.reportSummary, result.result.summary);
  assert.ok(JSON.stringify(p).length <= 6000);
  assert.equal(compactJob(result).mode, "scout");
});
test("invalid scout fails clearly; fromScout rejects wrong project/type/state and resume", async () => {
  const cwd = F.project();
  const job = F.start(cwd, { mode: "scout", prompt: "INVALID_SCOUT" });
  const result = await F.done(job);
  assert.equal(result.status, "failed");
  assert.match(result.error, /Invalid structured report/);
  assert.equal(result.contractFailure, true);
  assert.throws(() => F.start(cwd, { fromScout: job.jobId }), /completed, validated/);
  const good = F.start(cwd, { mode: "scout" });
  assert.throws(() => F.start(cwd, { fromScout: good.jobId }), /completed, validated/);
  await F.done(good);
  assert.throws(() => F.start(F.project(), { fromScout: good.jobId }), /same project/);
  assert.throws(() => F.start(cwd, { fromScout: good.jobId, resumeJobId: good.jobId }), /cannot be combined/);
  S.patch(good.jobId, { result: { ...brief(), files: [{ path: "../bad" }] } });
  assert.throws(() => F.start(cwd, { fromScout: good.jobId }), /Invalid fromScout/);
  const normal = F.start(F.project()); await F.done(normal);
  assert.throws(() => F.start(normal.cwd, { fromScout: normal.jobId }), /scout job/);
});
test("fromScout shallow overrides, provenance, identity and fresh write-capable thread", async () => {
  const cwd = F.project();
  const scout = F.start(cwd, { mode: "scout" }); await F.done(scout);
  const input = { cwd, requestId: randomUUID(), fromScout: scout.jobId, confirmDraftHash: hashFor(scout), assignment: { verification: S.read(scout.jobId).result.draftAssignment.verification, objective: "WRITE_CODE", constraints: ["Keep baseline"], scope: ["answer.mjs"] } };
  const job = R.startJob({ autoVerify: true, ...input });
  assert.equal(job.autoVerify, false);
  assert.equal(job.provenance.draftSourced, true);
  assert.equal(job.readOnly, false);
  assert.equal(job.threadId, null);
  assert.equal(job.resumeJobId, null);
  assert.equal(job.assignment.objective, "WRITE_CODE");
  assert.deepEqual(job.assignment.constraints, ["Keep baseline"]);
  assert.equal(job.assignment.verification.length, 1);
  assert.equal(job.provenance.scoutJobId, scout.jobId);
  assert.match(job.provenance.draftHash, /^[a-f0-9]{64}$/);
  assert.equal(R.startJob({ autoVerify: false, ...input }).jobId, job.jobId);
  assert.throws(() => R.startJob({ autoVerify: false, ...input, assignment: { ...input.assignment, objective: "Different" } }), /different inputs/);
  assert.equal((await F.done(job)).status, "implementation_finished");
  const captured = JSON.parse(fs.readFileSync(path.join(S.jobDir(job.jobId), "captured.json")));
  assert.ok(captured.args.includes("workspace-write"));
  assert.ok(!captured.args.includes("resume"));
  assert.throws(() => F.start(cwd, { fromScout: scout.jobId, assignment: { verification: [] } }), /1-20/);
  assert.throws(() => F.start(cwd, { fromScout: scout.jobId, assignment: { unknown: true } }), /Unexpected/);
  const oversized = { ...(await R.statusJob({ cwd, jobId: scout.jobId })), result: { summary: '\\'.repeat(20000), draftAssignment: { objective: '\\'.repeat(20000) } } };
  assert.ok(JSON.stringify(packet(oversized)).length <= 6000);
});

test("fromScout still requires profile approval and enforced criteria expansion", async () => {
  const cwd = F.project();
  const scout = F.start(cwd, { mode: "scout" }); await F.done(scout);
  fs.mkdirSync(path.join(cwd, ".codex-team"));
  fs.writeFileSync(path.join(cwd, ".codex-team/profile.json"), JSON.stringify({ profileVersion: 1, name: "criteria", components: {
    criteria: { level: "enforce", templates: { additional: { suggestWhen: "always", criteria: ["Additional criterion"] } } },
  } }));
  const input = { cwd, requestId: randomUUID(), fromScout: scout.jobId, confirmDraftHash: hashFor(scout), assignment: { verification: S.read(scout.jobId).result.draftAssignment.verification } };
  assert.throws(() => R.startJob({ autoVerify: false, ...input }), /approval|approved/i);
  F.approve(cwd);
  assert.throws(() => R.startJob({ autoVerify: false, ...input }), /Template requires inclusion/);
  const job = R.startJob({ autoVerify: false, ...input, criteriaTemplates: ["additional"] });
  assert.equal(job.assignment.acceptanceCriteria.length, 2);
  assert.equal((await F.done(job)).status, "implementation_finished");
});
test("draft commands are visible and fromScout requires exact confirmation or a verification override", async () => {
  const cwd = F.project(), scout = F.start(cwd, { mode: "scout" });
  const finished = await F.done(scout);
  for (const view of [compactJob(finished), packet(finished)]) {
    assert.equal(view.draftHash, undefined);
    assert.match(view.untrustedCodexText.content.draftVerificationPreview, /command.*node.*args/);
    assert.equal(view.draftVerificationCount, 1);
    assert.equal(view.draftScopeCount, 1);
    assert.equal(view.untrustedCodexText.content.draftScopePreview, '"answer.mjs"');
    assert.equal(view.draftScopeTruncated, false);
    assert.match(view.next, /detail 'full' before confirmDraftHash/);
  }
  assert.throws(() => R.startJob({ autoVerify: false, cwd, requestId: randomUUID(), fromScout: scout.jobId }), /explicit verification array/);
  assert.throws(() => R.startJob({ autoVerify: false, cwd, requestId: randomUUID(), fromScout: scout.jobId, confirmDraftHash: "wrong" }), /does not match/);
  const overridden = R.startJob({ autoVerify: false, cwd, requestId: randomUUID(), fromScout: scout.jobId,
    assignment: { verification: [{ id: "lead-check", command: process.execPath, allowInline: true, args: ["-e", "process.exit(0)"] }] } });
  assert.equal(overridden.assignment.verification[0].id, "lead-check");
  assert.equal(overridden.provenance.draftSourced, false);
  await F.done(overridden);
  const oldHash = hashFor(scout), source = S.read(scout.jobId);
  source.result.draftAssignment.verification[0].args = ["-e", "process.exit(1)"];
  S.patch(scout.jobId, { result: source.result });
  assert.throws(() => R.startJob({ autoVerify: false, cwd, requestId: randomUUID(), fromScout: scout.jobId, confirmDraftHash: oldHash }), /does not match/);
  const large = { ...finished, result: { ...finished.result, handbookNotes: ["\\".repeat(5000)],
    draftAssignment: { ...finished.result.draftAssignment, scope: Array(20).fill("\\".repeat(200)), verification: [{ command: "node", args: ["\\".repeat(20000)] }] } } };
  for (const [view, limit] of [[compactJob(large), 1500], [packet(large), 6000]]) {
    assert.ok(JSON.stringify(view).length <= limit);
    assert.equal(view.draftVerificationTruncated, true);
    assert.equal(view.draftScopeTruncated, true);
    assert.equal(view.draftScopeCount, 20);
    assert.ok(view.untrustedCodexText.content.draftScopePreview.length <= 300);
    assert.match(view.next, /detail 'full' before confirmDraftHash/);
    assert.ok(view.untrustedCodexText.content.draftVerificationPreview.includes("command"));
  }
});
test("a scout that changes any project file fails even after a valid brief", async () => {
  const cwd = F.project(), scout = F.start(cwd, { mode: "scout", prompt: "OUT_OF_SCOPE" });
  const result = await F.done(scout);
  assert.equal(result.status, "failed");
  assert.match(result.error, /Read-only scout changed project files/);
  assert.deepEqual(result.changes.files, ["unrelated.txt"]);
  assert.throws(() => R.startJob({ autoVerify: false, cwd, requestId: randomUUID(), fromScout: scout.jobId }), /completed, validated/);
});
test("old-server attempts recover scout controls from ancestry or a read-only marker", async () => {
  const cwd = F.project(), original = F.start(cwd, { mode: "scout" }); await F.done(original);
  for (const markerOnly of [false, true]) {
    const saved = S.read(original.jobId), jobId = randomUUID();
    fs.mkdirSync(S.jobDir(jobId));
    fs.writeFileSync(path.join(S.jobDir(jobId), "report-schema.json"), JSON.stringify(C.reportSchema));
    const worker = spawn(process.execPath, [fileURLToPath(new URL("../scripts/runtime.mjs", import.meta.url)), "--worker", jobId],
      { windowsHide: true, stdio: "ignore", env: process.env });
    const exited = new Promise((resolve, reject) => { worker.once("exit", resolve); worker.once("error", reject); });
    const state = { ...saved, jobId, mode: undefined, readOnlyDraft: markerOnly, readOnly: false,
      assignment: { ...saved.assignment, constraints: [] }, resumeJobId: markerOnly ? null : original.jobId,
      status: "starting", workerPid: worker.pid, supervisorPid: null, execAttempt: 0, execs: [],
      result: null, error: null, contractFailure: false, prompt: "Inspect only", heartbeatAt: S.now(),
      deadlineAt: new Date(Date.now() + 30000).toISOString() };
    S.save(state);
    fs.writeFileSync(path.join(S.jobDir(jobId), "launch"), String(worker.pid));
    const result = await F.done({ cwd, jobId });
    await exited;
    assert.equal(result.status, "implementation_finished", JSON.stringify(result));
    assert.equal(result.mode, "scout");
    assert.equal(result.readOnly, true);
    const captured = JSON.parse(fs.readFileSync(path.join(S.jobDir(jobId), "captured.json")));
    assert.ok(captured.args.includes("read-only"));
    assert.match(captured.prompt, /Explore only/);
    assert.ok(JSON.parse(fs.readFileSync(path.join(S.jobDir(jobId), "report-schema.json"))).properties.draftAssignment);
    assert.throws(() => R.verifyJob({ cwd, jobId }), /Scouts/);
    assert.throws(() => F.accept({ cwd, jobId }), /Scouts/);
    assert.throws(() => R.integrateJob({ cwd, jobId }), /Scouts/);
  }
});
test("concurrent identical scout requests yield one job and one replay while other requests stay excluded", async () => {
  const cwd = F.project(), input = { cwd, mode: "scout", requestId: "shared-request", prompt: "SLOW_EVENTS", assignment: F.assignment() };
  const code = `const {startJob}=await import(process.argv[1]); console.log(JSON.stringify(startJob(JSON.parse(process.argv[2]))));`;
  const invoke = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code,
      new URL("../scripts/runtime.mjs", import.meta.url).href, JSON.stringify(input)],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let output = "", error = "";
    child.stdout.on("data", chunk => output += chunk); child.stderr.on("data", chunk => error += chunk);
    child.once("error", reject); child.once("close", code => code ? reject(new Error(error)) : resolve(JSON.parse(output)));
  });
  const results = await Promise.all([invoke(), invoke()]);
  assert.equal(results[0].jobId, results[1].jobId);
  assert.equal(results.filter(result => result.replayed).length, 1);
  assert.equal(S.projectJobs(cwd).length, 1);
  assert.throws(() => R.startJob({ autoVerify: false, ...input, requestId: "other-request" }), /active job/);
  assert.equal((await F.done(results[0])).status, "implementation_finished");
});


test("resumed scouts compare only changes made during the current attempt", async () => {
  const cwd = F.project(), original = F.start(cwd, { mode: "scout" });
  assert.equal((await F.done(original)).status, "implementation_finished");
  fs.writeFileSync(path.join(cwd, "existing.txt"), "Lead edit between attempts\n");
  const resumed = F.start(cwd, { resumeJobId: original.jobId, assignment: undefined });
  const clean = await F.done(resumed);
  assert.equal(clean.status, "implementation_finished", JSON.stringify(clean));
  assert.deepEqual(clean.changes.files, []);
  const edited = F.start(cwd, { resumeJobId: resumed.jobId, prompt: "OUT_OF_SCOPE", assignment: undefined });
  const dirty = await F.done(edited);
  assert.equal(dirty.status, "failed");
  assert.match(dirty.error, /Read-only scout changed project files/);
  assert.deepEqual(dirty.changes.files, ["unrelated.txt"]);
});

test("scouts reject Git metadata changes even when project file contents stay unchanged", async () => {
  const cwd = F.project(), scout = F.start(cwd, { mode: "scout", prompt: "SLOW_EVENTS" });
  git(cwd, ["rm", "--cached", "existing.txt"]);
  const result = await F.done(scout);
  assert.equal(result.status, "failed");
  assert.deepEqual(result.changes.files, []);
  assert.equal(result.changes.gitMetadataChanged, true);
  assert.match(result.error, /Read-only scout changed.*Git metadata/);
});

test("scout scope previews include at most the first ten paths", () => {
  const scope = Array.from({ length: 11 }, (_, i) => `src/file-${i}.mjs`);
  const state = { jobId: randomUUID(), mode: "scout", status: "implementation_finished", assignment: F.assignment(),
    result: { ...brief(), draftAssignment: F.assignment({ scope }) } };
  for (const [view, limit] of [[compactJob(state), 1500], [packet(state), 6000]]) {
    assert.equal(view.draftScopeCount, 11);
    assert.equal(view.draftScopeTruncated, true);
    assert.match(view.untrustedCodexText.content.draftScopePreview, /file-9/);
    assert.doesNotMatch(view.untrustedCodexText.content.draftScopePreview, /file-10/);
    assert.match(view.next, /detail 'full' before confirmDraftHash/);
    assert.ok(JSON.stringify(view).length <= limit);
  }
});
