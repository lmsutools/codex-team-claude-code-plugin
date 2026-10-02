// Many Claude sessions and Codex workers share one state database. These
// tests pin the 1.1.5 rules: slow work never runs under the write lock, a busy
// database never stops a worker, and one project never gets two active jobs.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import {
  startJob,
  statusJob,
  cancelJob,
  verifyJob,
  reviewJob,
} from "../scripts/runtime.mjs";
import * as S from "../scripts/store.mjs";
import { snapshot } from "../scripts/git.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-concurrency-"));
const jobsRoot = path.join(root, "jobs");
process.env.CODEX_TEAM_STATE = jobsRoot;
process.env.CODEX_TEAM_CODEX = fileURLToPath(
  new URL("./fake-codex.mjs", import.meta.url),
);
// Short, so a lock held by another process outlasts it.
process.env.CODEX_TEAM_DB_BUSY_MS = "1000";
const runtimeUrl = pathToFileURL(
  fileURLToPath(new URL("../scripts/runtime.mjs", import.meta.url)),
).href;
const created = [];

function repo(name, files = 0) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
  };
  git("init", "-q");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Fixture");
  git("config", "core.autocrlf", "false");
  for (let i = 0; i < files; i++) {
    const sub = path.join(dir, "src", "d" + (i % 40));
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, `f${i}.txt`), `file ${i}\n`.repeat(40));
  }
  fs.writeFileSync(path.join(dir, "README.md"), "fixture\n");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  return fs.realpathSync(dir);
}
const start = (input) => {
  const job = startJob({ autoVerify: false, ...input });
  created.push({ cwd: input.cwd, jobId: job.jobId });
  return job;
};
async function settle(cwd, jobId, seconds = 30) {
  const deadline = Date.now() + seconds * 1000;
  let state;
  do state = await statusJob({ cwd, jobId, waitSeconds: 5 });
  while (S.active.has(state.status) && Date.now() < deadline);
  return state;
}
const rawRow = (id) =>
  S.db().prepare("SELECT state FROM jobs WHERE id=?").get(id).state;
function script(name, source) {
  const file = path.join(root, name);
  fs.writeFileSync(file, source);
  return file;
}
function run(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "",
      err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(err || `exit ${code}`)),
    );
  });
}
const task = (id) => ({
  objective: "Fixture change",
  scope: ["."],
  acceptanceCriteria: ["The fixture check passes."],
  verification: [{ id, command: process.execPath, allowInline: true, args: ["-e", "0"] }],
});

after(async () => {
  for (const job of created) {
    try {
      cancelJob(job);
      await statusJob({ ...job, waitSeconds: 10 });
    } catch {}
  }
  S.closeStores();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test("snapshots are stored once, outside the job row", async () => {
  const cwd = repo("blobs", 300);
  const before = snapshot(cwd);
  const job = start({ cwd, prompt: "Quick fixture" });
  assert.equal((await settle(cwd, job.jobId)).status, "implementation_finished");
  const raw = JSON.parse(rawRow(job.jobId));
  assert.equal(raw.storage, S.STORAGE_VERSION);
  for (const key of ["baseline", "attemptBaseline", "originBaseline"])
    assert.match(raw[key].$blob, /^sha256:[0-9a-f]{64}$/, key);
  // The three baselines of an untouched project are one blob.
  assert.equal(raw.baseline.$blob, raw.attemptBaseline.$blob);
  assert.equal(raw.baseline.$blob, raw.originBaseline.$blob);
  assert.ok(rawRow(job.jobId).length < 40 * 1024, "job row stays small");
  const full = S.read(job.jobId);
  assert.equal(Object.keys(full.baseline.files).length, 301);
  assert.deepEqual(full.baseline.files, before.files);
  // Status and listing never load snapshots.
  assert.deepEqual(S.read(job.jobId, { blobs: false }).baseline, raw.baseline);
});

test("start, verify and accept hash the project without holding the write lock", async t => {
  const previousTrace = process.env.CODEX_TEAM_LOCK_TRACE;
  process.env.CODEX_TEAM_LOCK_TRACE = "1";
  t.after(() => { if (previousTrace === undefined) delete process.env.CODEX_TEAM_LOCK_TRACE; else process.env.CODEX_TEAM_LOCK_TRACE = previousTrace; });
  const cwd = repo("large", 2000);
  const t0 = performance.now();
  snapshot(cwd);
  const hashing = performance.now() - t0;
  const limit = Math.max(25, hashing / 3);

  S.resetLockStatistics();
  const job = start({ cwd, requestId: "lock-hold", assignment: task("ok") });
  const startStats = S.lockStatistics();
  assert.ok(
    startStats.maxHoldMs < limit,
    `start held the lock ${startStats.maxHoldMs.toFixed(1)} ms; hashing takes ${hashing.toFixed(0)} ms`,
  );
  assert.equal((await settle(cwd, job.jobId)).status, "implementation_finished");

  S.resetLockStatistics();
  const verificationStart = performance.now();
  verifyJob({ cwd, jobId: job.jobId });
  const verifyStats = S.lockStatistics();
  assert.ok(
    verifyStats.maxHoldMs < limit,
    `verify held the lock ${verifyStats.maxHoldMs.toFixed(1)} ms; hashing takes ${hashing.toFixed(0)} ms`,
  );
  // Hidden-input rechecks plus the 2,000-file snapshot measured 62.4 s on this host; keep lock assertions unchanged.
  const verified = await settle(cwd, job.jobId, 90);
  t.diagnostic(`large-project hashing=${hashing.toFixed(1)}ms verify+review=${(performance.now() - verificationStart).toFixed(1)}ms`);
  assert.equal(verified.status, "verified", JSON.stringify({ status: verified.status, phase: verified.livePhase, error: verified.error, cancellationError: verified.cancellationError }));

  const workerSaves = fs.readFileSync(path.join(jobsRoot, "lock-trace.jsonl"), "utf8").trim().split("\n").map(JSON.parse).filter(row => row.pid !== process.pid && row.label === "patch");
  assert.ok(workerSaves.length >= 3, "worker later saves are traced");
  t.diagnostic(`worker later-save maximum lock=${Math.max(...workerSaves.map(row => row.ms)).toFixed(1)}ms across ${workerSaves.length} saves; limit=${limit.toFixed(1)}ms`);
  assert.ok(Math.max(...workerSaves.map(row => row.ms)) < limit, `worker later saves held lock ${Math.max(...workerSaves.map(row => row.ms)).toFixed(1)}ms; limit=${limit.toFixed(1)}ms`);
  S.resetLockStatistics();
  const accepted = reviewJob({
    cwd,
    jobId: job.jobId,
    action: "accept",
    summary: "Fixture accepted.",
    evidence: [{ criterionIndex: 0, checkId: "ok", observation: "Check passed." }],
  });
  const reviewStats = S.lockStatistics();
  assert.equal(accepted.status, "accepted");
  assert.ok(
    reviewStats.maxHoldMs < limit,
    `accept held the lock ${reviewStats.maxHoldMs.toFixed(1)} ms; hashing takes ${hashing.toFixed(0)} ms`,
  );
});

test("a worker finishes while another process holds the database past its busy timeout", async () => {
  const cwd = repo("contended");
  const locker = script(
    "locker.mjs",
    `import { DatabaseSync } from "node:sqlite";
const [file, ms] = process.argv.slice(2);
const db = new DatabaseSync(file);
db.exec("PRAGMA busy_timeout=30000");
db.exec("BEGIN IMMEDIATE");
const at = Date.now();
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(ms));
db.exec("COMMIT");
console.log(JSON.stringify({ heldMs: Date.now() - at }));
`,
  );
  const job = start({ cwd, prompt: "SLOW_EVENTS" });
  await new Promise((r) => setTimeout(r, 500));
  // 3 s under the lock: three times the worker's busy timeout, while it streams events.
  const held = JSON.parse(
    await run(locker, [path.join(jobsRoot, "state.sqlite"), "3000"]),
  );
  assert.ok(held.heldMs >= 2900);
  const result = await settle(cwd, job.jobId);
  assert.equal(result.status, "implementation_finished", JSON.stringify(result));
  assert.equal(result.progress, "Step 8");
  assert.ok(result.threadId);
  assert.equal(result.usage.output_tokens, 4);
});

test("two sessions starting in one project at once: exactly one job starts", async () => {
  const cwd = repo("race");
  const go = path.join(root, "race-go");
  const racer = script(
    "racer.mjs",
    `import fs from "node:fs";
const [runtimeUrl, cwd, requestId, go] = process.argv.slice(2);
const { startJob } = await import(runtimeUrl);
while (!fs.existsSync(go)) await new Promise((r) => setTimeout(r, 2));
try {
  const job = startJob({ autoVerify: false, cwd, prompt: "WAIT_FOREVER", requestId });
  console.log(JSON.stringify({ ok: true, jobId: job.jobId }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e.message }));
}
`,
  );
  const racing = [1, 2].map((n) => run(racer, [runtimeUrl, cwd, `race-${n}`, go]));
  await new Promise((r) => setTimeout(r, 1500));
  fs.writeFileSync(go, "");
  const results = (await Promise.all(racing)).map((line) => JSON.parse(line));
  const winners = results.filter((r) => r.ok);
  assert.equal(winners.length, 1, JSON.stringify(results));
  created.push({ cwd, jobId: winners[0].jobId });
  assert.match(results.find((r) => !r.ok).error, /active job/);
  cancelJob({ cwd, jobId: winners[0].jobId });
  assert.equal((await settle(cwd, winners[0].jobId)).status, "cancelled");
});

test("a start that fails after reserving leaves no record and frees the project", async () => {
  const cwd = repo("failed-start");
  fs.writeFileSync(path.join(cwd, "dirty.txt"), "uncommitted\n");
  assert.throws(
    () => start({ cwd, prompt: "Quick fixture", isolation: "worktree", requestId: "wt" }),
    /clean Git root/,
  );
  assert.deepEqual((await statusJob({ cwd })).jobs, []);
  // The same request ID fails the same way instead of replaying a stale record.
  assert.throws(
    () => start({ cwd, prompt: "Quick fixture", isolation: "worktree", requestId: "wt" }),
    /clean Git root/,
  );
  const job = start({ cwd, prompt: "Quick fixture" });
  assert.equal((await settle(cwd, job.jobId)).status, "implementation_finished");
});

test("a reservation holds its project while its process lives, and is released when it dies", async () => {
  const cwd = repo("reservation");
  const reserve = (pid) => {
    const at = S.now();
    const state = {
      jobId: randomUUID(),
      cwd,
      executionCwd: cwd,
      status: "starting",
      storage: S.STORAGE_VERSION,
      startedAt: at,
      heartbeatAt: at,
      reservation: { pid, at },
    };
    fs.mkdirSync(S.jobDir(state.jobId), { recursive: true });
    S.save(state);
    return state.jobId;
  };
  const live = reserve(process.pid);
  assert.throws(() => start({ cwd, prompt: "Quick fixture" }), /active job/);
  S.remove(live);
  const dead = reserve(2147483647);
  const job = start({ cwd, prompt: "Quick fixture" });
  assert.equal(S.read(dead).status, "failed");
  assert.match(S.read(dead).error, /before Codex was launched/);
  assert.equal((await settle(cwd, job.jobId)).status, "implementation_finished");
});

test("status polling reads without taking the write lock", async () => {
  const cwd = repo("polling");
  const job = start({ cwd, prompt: "WAIT_FOREVER" });
  const deadline = Date.now() + 15000;
  while ((await statusJob({ cwd, jobId: job.jobId })).status !== "running") {
    assert.ok(Date.now() < deadline, "job never reached running");
    await new Promise((r) => setTimeout(r, 100));
  }
  S.resetLockStatistics();
  const polled = await statusJob({ cwd, jobId: job.jobId, waitSeconds: 2 });
  await statusJob({ cwd });
  assert.equal(polled.status, "running");
  assert.equal(S.lockStatistics().transactions, 0);
  cancelJob({ cwd, jobId: job.jobId });
  assert.equal((await settle(cwd, job.jobId)).status, "cancelled");
});

test("rows written by 1.1.4 keep their snapshots inline", () => {
  const cwd = repo("legacy-row", 50);
  const id = randomUUID();
  const baseline = snapshot(cwd);
  fs.mkdirSync(S.jobDir(id), { recursive: true });
  S.save({ jobId: id, cwd, startedAt: S.now(), status: "implementation_finished", baseline });
  S.patch(id, { progress: "note" });
  const raw = JSON.parse(rawRow(id));
  assert.deepEqual(raw.baseline, baseline, "1.1.4 servers still read this row");
  assert.equal(S.read(id).progress, "note");
});

test("a transaction held for seconds is logged for diagnosis", () => {
  const log = path.join(jobsRoot, "lock-slow.log");
  fs.rmSync(log, { force: true });
  S.transaction(
    () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2100),
    "fixture:slow",
  );
  const entry = JSON.parse(fs.readFileSync(log, "utf8").trim().split("\n").at(-1));
  assert.equal(entry.label, "fixture:slow");
  assert.ok(entry.ms >= 2000);
  assert.match(entry.caller, /concurrency\.test\.mjs/);
});
