import fs from "node:fs";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-compat-"));
const cwd = path.join(root, "project");
fs.mkdirSync(cwd);
process.env.CODEX_TEAM_STATE = path.join(root, "state");
process.env.CODEX_TEAM_CODEX = fileURLToPath(
  new URL("./fake-codex.mjs", import.meta.url),
);
process.env.CODEX_HOME = path.join(root, "isolated-codex-config");
fs.mkdirSync(process.env.CODEX_HOME);
const runtime = path.resolve(process.argv[2]);
const original = await import(pathToFileURL(runtime));
const { invokeTool } = await import("../scripts/tool-output.mjs");
// Exercise explicit full presentation while preserving the strict business API.
const names = { doctor: "doctor", contextJob: "context", startJob: "start", statusJob: "status", verifyJob: "verify", reviewJob: "review", integrateJob: "integrate", cancelJob: "cancel" };
const R = Object.fromEntries(Object.entries(names).map(([name, tool]) => [name,
  input => invokeTool("codex_" + tool, original[name], { ...input, detail: "full" }),
]));
const S = await import(
  pathToFileURL(path.join(path.dirname(runtime), "store.mjs"))
);
const git = (args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
};
const results = {};
try {
  git(["init", "--quiet", "-b", "main"]);
  git(["config", "user.name", "Fixture"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  git(["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(cwd, "base.txt"), "baseline\n");
  git(["add", "."]);
  git(["commit", "-qm", "fixture"]);
  results.doctor = await R.doctor({ cwd });
  results.context = await R.contextJob({ cwd });
  results.contextUpdate = await R.contextJob({
    cwd,
    action: "update",
    expectedVersion: 0,
    decisions: ["Preserve the baseline"],
    dependencies: [],
    openQuestions: [],
  });
  results.start = await R.startJob({ autoVerify: false,
    cwd,
    requestId: "compatibility",
    isolation: "worktree",
    assignment: {
      objective: "WRITE_CODE",
      scope: ["answer.mjs"],
      acceptanceCriteria: ["answer is 42"],
      verification: [
        {
          id: "answer",
          command: process.execPath, allowInline: true,
          args: [
            "--input-type=module",
            "-e",
            "import {answer} from './answer.mjs';if(answer!==42)process.exit(1);",
          ],
          timeoutSeconds: 10,
        },
      ],
    },
  });
  const jobId = results.start.jobId;
  results.status = await R.statusJob({ cwd, jobId, waitSeconds: 30 });
  if (results.status.status !== "implementation_finished")
    throw new Error(JSON.stringify(results.status));
  // Terminal output can precede the detached supervisor's ownership cleanup.
  const cleanupDeadline = Date.now() + 10000;
  while (S.readRaw(jobId).supervisorPid && Date.now() < cleanupDeadline)
    await new Promise(resolve => setTimeout(resolve, 25));
  results.status = await R.statusJob({ cwd, jobId });
  results.verify = await R.verifyJob({ cwd, jobId });
  results.verified = await R.statusJob({ cwd, jobId, waitSeconds: 30 });
  results.review = await R.reviewJob({
    cwd,
    jobId,
    action: "accept",
    summary: "Add answer",
    evidence: [
      {
        criterionIndex: 0,
        checkId: "answer",
        observation: "Read and verified the value.",
      },
    ],
  });
  results.integrate = await R.integrateJob({ cwd, jobId });
  results.cancel = await R.cancelJob({ cwd, jobId });
  // Validate volatile identities before normalizing their per-project values.
  for (const result of [results.status, results.verify, results.verified, results.review, results.integrate]) {
    assert.match(result.reviewFingerprintWithoutProfile, /^[a-f0-9]{64}$/);
    assert.equal(result.reviewFingerprintWithoutProfile, result.reviewFingerprint);
    assert.equal(result.lineStats.fileIds.length, result.lineStats.files);
    for (const id of result.lineStats.fileIds) assert.match(id, /^[a-f0-9]{64}$/);
    assert.deepEqual(result.lineStats, results.status.lineStats);
    assert.ok(Number.isFinite(Date.parse(result.lineStatsAt)));
  }
  for (const result of [results.verified, results.review, results.integrate]) {
    assert.match(result.findingPacketHash, /^[a-f0-9]{64}$/);
    assert.equal(result.findingPacketHash, results.verified.findingPacketHash);
  }
  for (const result of [results.review, results.integrate])
    assert.deepEqual(result.reviews[0].findingPacketHash, Array.from(Buffer.from(result.findingPacketHash, "hex")));
  // Values known to vary by execution or platform; every other field remains comparable.
  const volatile = new Set([
    "workerPid",
    "supervisorPid",
    "deadlineAt",
    "implementationFinishedAt",
    "verificationChildStartedAt",
    "reviewerStartedAt",
    "decisionReadyAt",
    "assignmentHash",
    "childPid",
    "codexPid",
    "pid",
    "node",
    "durationMs",
    "elapsedMs",
    "ageSeconds",
    "startedAt",
    "childStartedAt",
    "modelChildStartedAt",
    "finishedAt",
    "heartbeatAt",
    "updatedAt",
    "verifiedAt",
    "acceptedAt",
    "reviewedAt",
    "checkedAt",
    "at",
    "fingerprint",
    "acceptedFingerprint",
    "implementationFingerprint",
    "verifiedFingerprint",
    "head",
    "indexHash",
    "runtimeFingerprint",
    "reviewFingerprint",
    "reviewObservedAt",
    "reviewFingerprintWithoutProfile",
    "lineStatsAt",
  ]);
  // Additive 1.2 run metadata is asserted in runs.test.mjs. This golden keeps
  // checking the existing 1.1.x response fields without freezing optional additions.
  const additions = new Set(["runningCommandStartedAt", "runningCommandCount", "runningCommandSeconds", "timeoutBasis", "typicalDurationSeconds", "salvageSeconds", "salvage", "lastEventAt", "secondsSinceLastEvent", "readableTail", "bootstrapReads", "resumeHint", "otherActiveJobs", "totalJobCount", "jobsDetail"]);
  function normalize(value, key = "") {
    if (value === null) return null;
    if (key === "findingPacketHash") return Array.isArray(value) ? value.map(() => 0) : "<findingPacketHash>";
    if (key === "fileIds") return value.map(() => "<file-id>");
    if (volatile.has(key)) return "<" + key + ">";
    if (Array.isArray(value)) return value.map((v) => normalize(v));
    if (typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).filter(([k]) => !additions.has(k)).map(([k, v]) => [k, key === "gitConfigChanged" && k === "hash" ? "<git-config-hash>" : normalize(v, k)]),
      );
    if (typeof value !== "string") return value;
    if (key === "version" && /^1\.\d+\.\d+$/.test(value)) return "<plugin-version>";
    return value
      .replaceAll(root, "<TEMP>")
      .replaceAll(root.toLowerCase(), "<TEMP>")
      .replaceAll(process.execPath, "<NODE>")
      .replaceAll(process.env.CODEX_TEAM_CODEX, "<FAKE>")
      .replaceAll(path.dirname(runtime), "<RUNTIME>")
      .replaceAll(path.dirname(runtime).replaceAll("\\", "/"), "<RUNTIME>")
      .replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g, "<UUID>");
  }
  const output = JSON.stringify(normalize(results), null, 2) + "\n";
  if (process.argv[3]) fs.writeFileSync(process.argv[3], output);
  else process.stdout.write(output);
} finally {
  for (const j of S.projectJobs(cwd)) {
    try {
      await R.cancelJob({ cwd, jobId: j.jobId });
      await R.statusJob({ cwd, jobId: j.jobId, waitSeconds: 30 });
    } catch {}
  }
  S.closeStores();
  if (
    path.dirname(root) !== path.resolve(os.tmpdir()) ||
    !path.basename(root).startsWith("codex-team-compat-")
  )
    throw new Error("Unexpected test cleanup root");
  fs.rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
