import { guardFixture } from "./fixture-lifetime.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  startJob,
  statusJob,
  cancelJob,
  verifyJob,
  reviewJob,
  contextJob,
  integrateJob,
} from "../scripts/runtime.mjs";
import * as S from "../scripts/store.mjs";
import { git, snapshot } from "../scripts/git.mjs";
import { integrateFiles } from "../scripts/git.mjs";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-v11-"));
process.env.CODEX_TEAM_STATE = path.join(root, "state");
process.env.CODEX_TEAM_CODEX = fileURLToPath(
  new URL("./fake-codex.mjs", import.meta.url),
);
let sequence = 0;
const jobs = [];
function project() {
  const dir = path.join(root, "project-" + ++sequence);
  fs.mkdirSync(dir);
  git(dir, ["init", "--quiet"]);
  fs.writeFileSync(path.join(dir, "existing.txt"), "existing user content\n");
  git(dir, ["add", "existing.txt"]);
  git(dir, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "fixture",
  ]);
  return fs.realpathSync(dir);
}
function assignment(overrides = {}) {
  return {
    objective: "WRITE_CODE Create answer.mjs",
    scope: ["answer.mjs"],
    constraints: ["Preserve other files."],
    acceptanceCriteria: ["Exports answer equal to 42"],
    verification: [
      {
        id: "answer",
        command: process.execPath, allowInline: true,
        args: [
          "--input-type=module",
          "-e",
          'import {answer} from "./answer.mjs"; if(answer!==42)process.exit(1);console.log("answer verified");',
        ],
        timeoutSeconds: 10,
      },
    ],
    ...overrides,
  };
}
function start(cwd, extra = {}) {
  const j = startJob({ autoVerify: false,
    cwd,
    requestId: randomUUID(),
    assignment: assignment(),
    ...extra,
  });
  jobs.push(j);
  return j;
}
async function done(j) {
  const s = await statusJob({ cwd: j.cwd, jobId: j.jobId, waitSeconds: 30 });
  assert.ok(!S.active.has(s.status), JSON.stringify(s));
  return s;
}
const evidence = [
  {
    criterionIndex: 0,
    checkId: "answer",
    observation: "Read the export and independently executed the assertion.",
  },
];
async function accepted(j) {
  await done(j);
  verifyJob({ cwd: j.cwd, jobId: j.jobId });
  const v = await done(j);
  assert.equal(v.status, "verified", JSON.stringify(v));
  return reviewJob({
    cwd: j.cwd,
    jobId: j.jobId,
    action: "accept",
    summary: "Inspected the diff and recorded checks.",
    evidence,
  });
}
after(async () => {
  for (const j of jobs) {
    try {
      cancelJob({ cwd: j.cwd, jobId: j.jobId });
      await done(j);
    } catch {}
  }
  S.closeStores();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith("codex-team-v11-"));
  fs.rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
});
test("structured execution, verification, and acceptance are distinct durable states", async () => {
  const cwd = project(),
    j = start(cwd);
  const result = await done(j);
  assert.equal(result.status, "implementation_finished");
  assert.deepEqual(result.changes.files, ["answer.mjs"]);
  assert.equal(result.result.summary, "Implementation completed");
  assert.throws(
    () =>
      reviewJob({
        cwd,
        jobId: j.jobId,
        action: "accept",
        summary: "premature",
        evidence,
      }),
    /independent verification/,
  );
  const a = await accepted(j);
  assert.equal(a.status, "accepted");
  assert.equal(
    (await statusJob({ cwd, jobId: j.jobId })).acceptanceCurrent,
    null,
  );
  assert.equal(
    fs.readFileSync(path.join(cwd, "existing.txt"), "utf8"),
    "existing user content\n",
  );
});
test("same request ID returns the original job and rejects changed input", async () => {
  const cwd = project(),
    requestId = "network-retry",
    input = { cwd, requestId, assignment: assignment() };
  const first = startJob({ autoVerify: false, ...input });
  jobs.push(first);
  const retry = startJob({ autoVerify: false, ...input });
  assert.equal(retry.jobId, first.jobId);
  assert.equal(retry.replayed, true);
  assert.throws(
    () => startJob({ autoVerify: false, ...input, prompt: "different" }),
    /different inputs/,
  );
  await done(first);
  assert.equal(startJob({ autoVerify: false, ...input }).jobId, first.jobId);
});
test("concurrent separate processes claim exactly one job for a request", async () => {
  const cwd = project(),
    input = { cwd, requestId: "concurrent", assignment: assignment() };
  const moduleUrl = new URL("../scripts/runtime.mjs", import.meta.url).href;
  const code =
    "import {startJob} from " +
    JSON.stringify(moduleUrl) +
    ";console.log(JSON.stringify(startJob(JSON.parse(process.argv[1]))));";
  const invoke = () =>
    new Promise((resolve, reject) => {
      const p = spawn(
        process.execPath,
        ["--input-type=module", "-e", code, JSON.stringify(input)],
        {
          env: process.env,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let out = "",
        err = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("error", reject);
      p.on("close", (c) =>
        c ? reject(new Error(err)) : resolve(JSON.parse(out)),
      );
    });
  const [a, b] = await Promise.all([invoke(), invoke()]);
  jobs.push(a);
  assert.equal(a.jobId, b.jobId);
  assert.equal([a, b].filter((j) => j.replayed).length, 1);
  await done(a);
});
test("empty reports and missing completion events never count as finished", async () => {
  for (const marker of ["EMPTY_REPORT", "NO_TURN"]) {
    const j = start(project(), { prompt: marker });
    const s = await done(j);
    assert.equal(s.status, "failed");
    assert.throws(
      () => verifyJob({ cwd: j.cwd, jobId: j.jobId }),
      /completed implementation/,
    );
  }
});
test("startup cancellation prevents execution and deadlines stop hung workers", async () => {
  const cwd = project();
  const j = start(cwd, { prompt: "WAIT_FOREVER" });
  cancelJob({ cwd, jobId: j.jobId });
  assert.equal((await done(j)).status, "cancelled");
  const timeout = start(cwd, { prompt: "WAIT_FOREVER", timeoutSeconds: 1 });
  assert.equal((await done(timeout)).status, "timed_out");
  assert.equal((await done(start(cwd))).status, "implementation_finished");
});
test("dead worker recovery is persisted with stable timestamp and releases project", async () => {
  const cwd = project(),
    jobId = randomUUID(),
    past = new Date(Date.now() - 30000).toISOString();
  S.transaction(() =>
    S.save({
      jobId,
      cwd,
      startedAt: past,
      heartbeatAt: past,
      status: "running",
      workerPid: 99999999,
      codexPid: 99999998,
    }),
  );
  fs.mkdirSync(S.jobDir(jobId));
  const a = await statusJob({ cwd, jobId }),
    b = await statusJob({ cwd, jobId });
  assert.equal(a.status, "interrupted");
  assert.equal(a.finishedAt, b.finishedAt);
  await done(start(cwd));
});
test("out-of-scope edits and worker blockers prevent acceptance", async () => {
  const cwd = project(),
    j = start(cwd, { prompt: "OUT_OF_SCOPE" });
  const result = await done(j);
  assert.deepEqual(result.changes.outOfScope, ["unrelated.txt"]);
  assert.throws(() => verifyJob({ cwd, jobId: j.jobId }), /Out-of-scope/);
  const c = project(),
    block = start(c, { prompt: "BLOCKER" });
  await done(block);
  verifyJob({ cwd: c, jobId: block.jobId });
  await done(block);
  assert.throws(
    () =>
      reviewJob({
        cwd: c,
        jobId: block.jobId,
        action: "accept",
        summary: "reviewed",
        evidence,
      }),
    /blockers/,
  );
});
test("failed independent checks cannot be replaced by claimed success", async () => {
  const cwd = project(),
    j = start(cwd, {
      assignment: assignment({
        verification: [
          {
            id: "answer",
            command: process.execPath, allowInline: true,
            args: ["-e", "process.exit(7)"],
          },
        ],
      }),
    });
  await done(j);
  verifyJob({ cwd, jobId: j.jobId });
  const v = await done(j);
  assert.equal(v.status, "verification_failed");
  assert.equal(v.verification.checks[0].exitCode, 7);
  assert.throws(
    () =>
      reviewJob({
        cwd,
        jobId: j.jobId,
        action: "accept",
        summary: "worker says passed",
        evidence,
      }),
    /independent verification/,
  );
});
test("verification and review refuse stale or incomplete evidence", async () => {
  const cwd = project(),
    j = start(cwd);
  await done(j);
  verifyJob({ cwd, jobId: j.jobId });
  await done(j);
  assert.throws(
    () =>
      reviewJob({
        cwd,
        jobId: j.jobId,
        action: "accept",
        summary: "missing",
        evidence: [],
      }),
    /one evidence/,
  );
  assert.throws(
    () =>
      reviewJob({
        cwd,
        jobId: j.jobId,
        action: "accept",
        summary: "invented",
        evidence: [{ ...evidence[0], checkId: "unknown" }],
      }),
    /passed recorded check/,
  );
  fs.writeFileSync(path.join(cwd, "answer.mjs"), "export const answer=0;");
  assert.throws(
    () =>
      reviewJob({
        cwd,
        jobId: j.jobId,
        action: "accept",
        summary: "stale",
        evidence,
      }),
    /changed after verification/,
  );
  verifyJob({ cwd, jobId: j.jobId });
  assert.equal((await done(j)).status, "verification_failed");
});
test("checks that alter reviewed files cannot produce verified status", async () => {
  const cwd = project(),
    j = start(cwd, {
      assignment: assignment({
        verification: [
          {
            id: "answer",
            command: process.execPath, allowInline: true,
            args: [
              "-e",
              'require("fs").writeFileSync("answer.mjs","changed");',
            ],
          },
        ],
      }),
    });
  await done(j);
  verifyJob({ cwd, jobId: j.jobId });
  const result = await done(j);
  assert.equal(result.status, "verification_failed");
  assert.equal(result.verification.filesChangedDuringChecks, true);
});
test("context version conflicts, restart recovery, review feedback and revision limits", async () => {
  const cwd = project();
  contextJob({
    cwd,
    action: "update",
    expectedVersion: 0,
    decisions: ["ES modules"],
    dependencies: ["local node"],
  });
  assert.throws(
    () =>
      contextJob({ cwd, action: "update", expectedVersion: 0, decisions: [] }),
    /Context changed/,
  );
  const j = start(cwd, { maxRevisions: 1 });
  await done(j);
  reviewJob({
    cwd,
    jobId: j.jobId,
    action: "request_changes",
    summary: "Add an edge case.",
  });
  S.closeStores();
  const recovered = contextJob({ cwd });
  assert.equal(recovered.context.decisions[0], "ES modules");
  assert.equal(recovered.jobs[0].jobId, j.jobId);
  assert.match(recovered.jobsDetail, /codex_status with jobId/);
  assert.equal((await statusJob({ cwd, jobId: j.jobId })).reviews[0].summary, "Add an edge case.");
  const next = start(cwd, { resumeJobId: j.jobId, prompt: "Address feedback" });
  assert.equal(next.contextAtStart.decisions[0], "ES modules");
  const result = await done(next);
  assert.equal(
    result.threadId,
    (await statusJob({ cwd, jobId: j.jobId })).threadId,
  );
  assert.throws(
    () => start(cwd, { resumeJobId: next.jobId, prompt: "third" }),
    /Revision limit/,
  );
  assert.throws(
    () => start(cwd, { resumeJobId: j.jobId, prompt: "bypass via ancestor" }),
    /superseded|latest/i,
  );
});
test("worktree isolates edits, accepts them, and integrates without commits", async () => {
  const cwd = project(),
    original = snapshot(cwd),
    j = start(cwd, { isolation: "worktree" });
  await done(j);
  assert.equal(fs.existsSync(path.join(cwd, "answer.mjs")), false);
  assert.notEqual(j.executionCwd, cwd);
  await accepted(j);
  const merged = integrateJob({ cwd, jobId: j.jobId });
  assert.equal(merged.integration.status, "applied");
  assert.equal(
    fs.readFileSync(path.join(cwd, "answer.mjs"), "utf8"),
    "export const answer = 42;\n",
  );
  assert.equal(snapshot(cwd).head, original.head);
  assert.equal(snapshot(cwd).indexHash, original.indexHash);
  assert.equal(
    integrateJob({ cwd, jobId: j.jobId }).integration.at,
    merged.integration.at,
  );
});
test("worktree integration refuses newer original edits; dirty worktree starts are refused", async () => {
  const cwd = project(),
    j = start(cwd, { isolation: "worktree" });
  await accepted(j);
  fs.writeFileSync(path.join(cwd, "existing.txt"), "new user edit");
  assert.throws(
    () => integrateJob({ cwd, jobId: j.jobId }),
    /Original project changed/,
  );
  assert.equal(
    fs.readFileSync(path.join(cwd, "existing.txt"), "utf8"),
    "new user edit",
  );
  assert.throws(() => start(cwd, { isolation: "worktree" }), /clean Git/);
});
test("read-only revisions cannot gain write access and runtime overrides preserve guardrails", async () => {
  const cwd = project(),
    j = start(cwd, {
      readOnly: true,
      workerProfile: "local-code",
      model: "fixture-model",
      effort: "low",
    });
  await done(j);
  assert.throws(() => verifyJob({ cwd, jobId: j.jobId }), /Read-only/);
  assert.throws(
    () => start(cwd, { resumeJobId: j.jobId, readOnly: false }),
    /preserve readOnly/,
  );
  const captured = JSON.parse(
    fs.readFileSync(path.join(j.logDirectory, "captured.json"), "utf8"),
  );
  assert.ok(captured.args.includes("read-only"));
  assert.ok(captured.args.includes("fixture-model"));
  assert.ok(captured.args.includes('web_search="disabled"'));
  assert.ok(
    !captured.args.some((a) =>
      /ignore-rules|ignore-user-config|dangerously|hooks.*false/.test(a),
    ),
  );
});
test("verification refuses edits between request and worker startup", async () => {
  const cwd = project(),
    j = start(cwd);
  await done(j);
  const before = snapshot(cwd);
  fs.writeFileSync(
    path.join(cwd, "existing.txt"),
    "outside-scope edit after the request",
  );
  // Reproduce the launch gap deterministically using the public worker entrypoint.
  S.patch(j.jobId, {
    status: "verifying",
    verificationBaseline: before,
    workerPid: null,
  });
  const runtime = fileURLToPath(
    new URL("../scripts/runtime.mjs", import.meta.url),
  );
  const child = spawn(process.execPath, [runtime, "--verify", j.jobId], {
    env: process.env,
    windowsHide: true,
    stdio: "ignore",
  });
  S.patch(j.jobId, { workerPid: child.pid });
  fs.writeFileSync(path.join(j.logDirectory, "launch"), String(child.pid));
  await new Promise((resolve) => child.on("exit", resolve));
  const result = await done(j);
  assert.equal(result.status, "verification_failed");
  assert.match(result.error, /between verification request/);
});
test("integration never overwrites ignored origin content absent from baseline", () => {
  const cwd = project();
  fs.writeFileSync(path.join(cwd, ".gitignore"), "scratch.txt\n");
  git(cwd, ["add", ".gitignore"]);
  git(cwd, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "ignore fixture",
  ]);
  fs.writeFileSync(path.join(cwd, "scratch.txt"), "USER NOTES");
  const before = snapshot(cwd);
  const worktree = path.join(root, "ignored-collision");
  git(cwd, ["worktree", "add", "--detach", worktree, "HEAD"]);
  fs.writeFileSync(path.join(worktree, ".gitignore"), "");
  fs.writeFileSync(path.join(worktree, "scratch.txt"), "GENERATED");
  const after = snapshot(fs.realpathSync(worktree));
  assert.throws(
    () => integrateFiles(cwd, worktree, before, after),
    /overwrite an existing/,
  );
  assert.equal(
    fs.readFileSync(path.join(cwd, "scratch.txt"), "utf8"),
    "USER NOTES",
  );
  assert.equal(
    fs.readFileSync(path.join(cwd, ".gitignore"), "utf8"),
    "scratch.txt\n",
  );
});

test("an integrated worktree can receive and integrate a later revision", async () => {
  const cwd = project(),
    j = start(cwd, { isolation: "worktree" });
  await accepted(j);
  integrateJob({ cwd, jobId: j.jobId });
  const next = start(cwd, { resumeJobId: j.jobId, prompt: "WRITE_REVISION" });
  await accepted(next);
  const merged = integrateJob({ cwd, jobId: next.jobId });
  assert.equal(merged.integration.status, "applied");
  assert.equal(
    fs.readFileSync(path.join(cwd, "answer.mjs"), "utf8"),
    "// revised\nexport const answer = 42;\n",
  );
});

test("a recycled worker PID does not leave a stale job permanently active", async () => {
  const cwd = project(),
    jobId = randomUUID(),
    past = new Date(Date.now() - 30000).toISOString();
  S.transaction(() =>
    S.save({
      jobId,
      cwd,
      startedAt: past,
      heartbeatAt: past,
      status: "running",
      workerPid: process.pid,
      codexPid: process.pid,
    }),
  );
  fs.mkdirSync(S.jobDir(jobId));
  assert.equal((await statusJob({ cwd, jobId })).status, "interrupted");
  assert.equal(S.alive(process.pid), true);
  await done(start(cwd));
});

test("an identified live orphan still blocks a competing worker", async () => {
  const cwd = project(),
    jobId = randomUUID(),
    past = new Date(Date.now() - 30000).toISOString();
  const child = spawn(
    process.execPath,
    ["-e", `(${guardFixture.toString()})();setInterval(()=>{},1000)`, "--", "--output-last-message", jobId],
    { windowsHide: true, stdio: "ignore" },
  );
  const stopped = new Promise((resolve) => child.once("exit", resolve));
  try {
    S.transaction(() =>
      S.save({
        jobId,
        cwd,
        startedAt: past,
        heartbeatAt: past,
        status: "running",
        workerPid: 99999999,
        codexPid: child.pid,
        childRole: "codex",
      }),
    );
    fs.mkdirSync(S.jobDir(jobId));
    const result = await statusJob({ cwd, jobId });
    assert.equal(result.status, "interrupted");
    assert.equal(result.orphanProcessAlive, true);
    assert.throws(() => start(cwd), /live Codex process/);
    S.patch(jobId, {
      status: "failed",
      cancellationError: "Could not terminate process tree",
    });
    assert.throws(() => start(cwd), /live Codex process/);
  } finally {
    child.kill();
    await stopped;
  }
  await done(start(cwd));
});
