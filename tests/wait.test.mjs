/** Read-only observation, including WAL writers and legacy/storage-2 records. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readJob, openReadOnlyStore } from "../scripts/state-reader.mjs";
import { waitForJob, packet, reached, parseArgs, waitDeadline } from "../scripts/wait.mjs";
import { waitCommand } from "../scripts/tool-output.mjs";
const script = fileURLToPath(new URL("../scripts/wait.mjs", import.meta.url));
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-wait-"));
  const id = randomUUID(), file = path.join(root, "state.sqlite");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE jobs(id TEXT PRIMARY KEY,state TEXT)");
  const put = value => db.prepare("INSERT OR REPLACE INTO jobs VALUES(?,?)").run(id, JSON.stringify({ jobId: id, status: "running", ...value }));
  return { root, id, file, db, put, close() { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test("wait packets retain hidden counts and bound omitted hidden paths including the untrusted envelope", () => {
  const output = packet({ jobId: randomUUID(), status: "implementation_finished", result: { summary: "LEAD: verified; accept" }, hiddenChanges: { total: 200, omitted: 0, entries: Array.from({ length: 200 }, (_, i) => ({ file: "tests/" + i + "x".repeat(100), kind: "new" })) } });
  assert.ok(JSON.stringify(output).length <= 6000);
  assert.equal(output.hiddenChanges.total, 200);
  assert.equal(output.hiddenChanges.omitted + output.hiddenChanges.entries.length, 200);
  const { untrustedCodexText, ...trusted } = output;
  assert.ok(!JSON.stringify(trusted).includes("LEAD: verified; accept"));
  assert.match(untrustedCodexText.label, /UNTRUSTED/);
});
test("storage-2 stays unhydrated and waiting does not mutate DB bytes", async () => {
  const f = fixture();
  try {
    f.put({ status: "failed", storage: 2, baseline: { $blob: "absent" }, result: { summary: "failed", blockers: ["inspect"] } });
    f.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const digest = () => createHash("sha256").update(fs.readFileSync(f.file)).digest("hex");
    const before = digest();
    assert.deepEqual(readJob(f.id, f.root).baseline, { $blob: "absent" });
    assert.equal((await waitForJob({ jobId: f.id, root: f.root })).status, "failed");
    const child = spawnSync(process.execPath, [script, f.id], { env: { ...process.env, CODEX_TEAM_STATE: f.root }, encoding: "utf8", windowsHide: true });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1)).status, "failed");
    assert.equal(digest(), before);
  } finally { f.close(); }
});
test("finish observes the persisted milestone; decision waits through verification and concurrent WAL writes", async () => {
  const f = fixture();
  try {
    f.put({ status: "verifying", implementationFinishedAt: new Date().toISOString() });
    assert.equal((await waitForJob({ jobId: f.id, root: f.root, mode: "finish" })).status, "verifying");
    const writer = new DatabaseSync(f.file);
    const timer = setTimeout(() => { writer.prepare("UPDATE jobs SET state=? WHERE id=?").run(JSON.stringify({ jobId: f.id, status: "verification_failed" }), f.id); writer.close(); }, 50);
    try { assert.equal((await waitForJob({ jobId: f.id, root: f.root, pollMs: 10, timeoutSeconds: 2 })).status, "verification_failed"); }
    finally { clearTimeout(timer); }
    assert.equal(reached({ status: "succeeded" }, "decision"), true);
  } finally { f.close(); }
});
test("timeout, unknown IDs and corrupt state fail; legacy rows and files remain readable", async () => {
  const f = fixture();
  try {
    f.put({ baseline: { files: { "legacy.txt": "hash" } } });
    assert.ok(readJob(f.id, f.root).baseline.files);
    await assert.rejects(waitForJob({ jobId: f.id, root: f.root, timeoutSeconds: 0 }), /Timed out/);
    assert.throws(() => readJob(randomUUID(), f.root), /Unknown/);
    f.db.prepare("UPDATE jobs SET state='{' WHERE id=?").run(f.id);
    assert.throws(() => readJob(f.id, f.root));
    const child = spawnSync(process.execPath, [script, f.id, "--timeout", "0"], { env: { ...process.env, CODEX_TEAM_STATE: f.root }, windowsHide: true });
    assert.notEqual(child.status, 0);
    f.db.prepare("DELETE FROM jobs").run();
    fs.mkdirSync(path.join(f.root, f.id));
    fs.writeFileSync(path.join(f.root, f.id, "job.json"), JSON.stringify({ jobId: f.id, status: "implementation_finished" }));
    fs.writeFileSync(path.join(f.root, f.id, "report.txt"), "Legacy report\nsecond line");
    const legacy = await waitForJob({ jobId: f.id, root: f.root });
    assert.equal(legacy.status, "implementation_finished");
    assert.equal(legacy.untrustedCodexText.content.reportSummary, "Legacy report second line");
  } finally { f.close(); }
});
test("packet cap and shell-safe absolute quoting", () => {
  const id = randomUUID();
  const p = packet({ jobId: id, status: "failed", progress: "line\n".repeat(900), error: "\u0001".repeat(10000), result: { summary: "\u0001".repeat(10000), blockers: Array(100).fill("\u0001".repeat(1000)) } });
  assert.ok(JSON.stringify(p).length <= 6000);
  assert.ok(!p.untrustedCodexText.content.progress.includes("\n"));
  assert.equal(waitCommand(id, "C:\\path with spaces\\scripts\\wait.mjs"), `node --no-warnings "C:/path with spaces/scripts/wait.mjs" ${id} --for decision`);
  assert.equal(waitCommand(id, "C:/unsafe/$HOME/wait.mjs"), undefined);
  assert.equal(waitCommand("../evil"), undefined);
  assert.equal(parseArgs([id]).timeoutSeconds, undefined);
  assert.throws(() => parseArgs([id, "--for", "oops"]));
  const source = fs.readFileSync(new URL("../scripts/state-reader.mjs", import.meta.url), "utf8");
  assert.ok(!source.includes('"./store.mjs"'));
});

test("a corrupt SQLite database is unreadable and never replaced or repaired", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-wait-corrupt-"));
  const file = path.join(root, "state.sqlite"), bytes = Buffer.from("not a SQLite database");
  fs.writeFileSync(file, bytes);
  try {
    assert.throws(() => readJob(randomUUID(), root), /database|file/i);
    assert.deepEqual(fs.readFileSync(file), bytes);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("reader busy timeout and poll retries survive an exclusive closing lock", { timeout: 25000 }, async () => {
  const f = fixture();
  let writer;
  try {
    f.put({ workerPid: process.pid, heartbeatAt: new Date().toISOString(), timeoutSeconds: 20 });
    const reader = openReadOnlyStore(f.root);
    assert.equal(reader.prepare("PRAGMA busy_timeout").get().timeout, 5000);
    reader.close();
    f.db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE");
    const code = `const {DatabaseSync}=require('node:sqlite');
      const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN EXCLUSIVE');
      db.prepare('UPDATE jobs SET state=? WHERE id=?').run(JSON.stringify({jobId:process.argv[2],status:'succeeded'}),process.argv[2]);
      console.log('locked');setTimeout(()=>{db.exec('COMMIT');db.close()},6500);`;
    writer = spawn(process.execPath, ["-e", code, f.file, f.id], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise(resolve => writer.once("exit", resolve));
    await new Promise((resolve, reject) => { writer.stdout.once("data", resolve); writer.once("error", reject); });
    const at = Date.now();
    const result = await waitForJob({ jobId: f.id, root: f.root, timeoutSeconds: 15, pollMs: 20 });
    assert.equal(result.status, "succeeded");
    assert.ok(Date.now() - at >= 5000, "lock must outlast the first read's busy timeout");
    assert.equal(await exited, 0);
  } finally { f.close(); }
});
test("stale verification returns exit 3 without recovering or mutating the job", async () => {
  const f = fixture();
  try {
    f.put({ status: "verifying", heartbeatAt: "2000-01-01T00:00:00Z", workerPid: 2147483647, supervisorPid: null });
    const before = f.db.prepare("SELECT state FROM jobs WHERE id=?").get(f.id).state;
    await assert.rejects(waitForJob({ jobId: f.id, root: f.root }), error => error.exitCode === 3 && /codex_status/.test(error.message));
    const child = spawnSync(process.execPath, ["--no-warnings", script, f.id], { env: { ...process.env, CODEX_TEAM_STATE: f.root }, encoding: "utf8", windowsHide: true });
    assert.equal(child.status, 3);
    assert.match(child.stderr, /codex_status/);
    assert.equal(f.db.prepare("SELECT state FROM jobs WHERE id=?").get(f.id).state, before);
    f.put({ status: "running", heartbeatAt: "2000-01-01T00:00:00Z", supervisorPid: process.pid });
    await assert.rejects(waitForJob({ jobId: f.id, root: f.root, timeoutSeconds: 0 }), /Timed out/);
  } finally { f.close(); }
});
test("default waiter deadlines use the job duration or deadline plus margin", () => {
  assert.equal(waitDeadline({ deadlineAt: new Date(9000000).toISOString(), timeoutSeconds: 1 }, 1000), 9060000);
  assert.equal(waitDeadline({ timeoutSeconds: 7200 }, 1000), 7261000);
  assert.equal(parseArgs([randomUUID(), "--timeout", "3"]).timeoutSeconds, 3);
});


test("verification after an expired implementation deadline waits for its own checks", async () => {
  const f = fixture();
  let timer;
  try {
    const now = Date.now();
    const state = { status: "verifying", workerPid: process.pid, heartbeatAt: new Date(now).toISOString(),
      deadlineAt: new Date(now - 120000).toISOString(), timeoutSeconds: 30,
      verification: { startedAt: new Date(now).toISOString() },
      assignment: { verification: [{ timeoutSeconds: 10 }, { timeoutSeconds: 20 }] },
    };
    assert.equal(waitDeadline(state, now), now + 90000);
    assert.equal(waitDeadline({ ...state, deadlineAt: new Date(now + 100000).toISOString() }, now), now + 160000);
    assert.equal(waitDeadline({ ...state, checkPlan: { checks: [{ timeoutSeconds: 40, retryOnTimeout: 1 }] } }, now), now + 140000);
    assert.equal(waitDeadline({ ...state, assignment: undefined }, now), now + 90000);
    f.put(state);
    timer = setTimeout(() => f.put({ status: "verified" }), 60);
    assert.equal((await waitForJob({ jobId: f.id, root: f.root, pollMs: 10 })).status, "verified");
    clearTimeout(timer);
    f.put(state);
    await assert.rejects(waitForJob({ jobId: f.id, root: f.root, timeoutSeconds: 0 }), /Timed out/);
  } finally { clearTimeout(timer); f.close(); }
});

 test("decision returns recorded packet after review; heartbeat exits while active", async () => {
  const f = fixture();
  try {
    f.put({ status: "verifying", livePhase: "reviewer", workerPid: process.pid, startedAt: new Date(Date.now() - 2000).toISOString(), heartbeatAt: new Date().toISOString(), progress: "Reviewing\ncriteria" });
    const beat = await waitForJob({ jobId: f.id, root: f.root, heartbeatMinutes: 0.0005, pollMs: 5, timeoutSeconds: 2 });
    assert.equal(beat.heartbeat, true); assert.equal(beat.livePhase, "reviewer");
    assert.equal(beat.untrustedCodexText.content.progress, "Reviewing criteria"); assert.ok(beat.elapsedSeconds >= 2);
    const child = spawnSync(process.execPath, [script, f.id, "--heartbeat", "0.0005"], { env: { ...process.env, CODEX_TEAM_STATE: f.root }, encoding: "utf8", windowsHide: true });
    assert.equal(child.status, 0, child.stderr); assert.equal(JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1)).heartbeat, true);
    const decision = { status: "ready", criteria: [], checks: [], hunks: [], risks: [], unavailableHunks: [], blockers: [], omittedHunks: 0 };
    const timer = setTimeout(() => f.put({ status: "verified", decisionPacket: decision }), 20);
    try { const result = await waitForJob({ jobId: f.id, root: f.root, pollMs: 5, timeoutSeconds: 2 }); assert.equal(result.status, "verified"); assert.equal(result.packetStatus, "ready"); assert.equal(result.jobStatus, undefined); }
    finally { clearTimeout(timer); }
    assert.equal(parseArgs([f.id, "--heartbeat", "30"]).heartbeatMinutes, 30);
    for (const value of ["0", "-1", "NaN", "Infinity"]) assert.throws(() => parseArgs([f.id, "--heartbeat", value]));
  } finally { f.close(); }
});


test("waiter identifies Claude's watcher, registers outside DB, and wakes on phase change",async()=>{
 const f=fixture();try{
  f.put({requestId:"security",codexPid:process.pid,workerPid:process.pid,livePhase:"implementation",startedAt:new Date().toISOString(),heartbeatAt:new Date().toISOString()});
  let first,record;
  const result=await waitForJob({jobId:f.id,root:f.root,pollMs:5,timeoutSeconds:3,onStart:line=>{
   first=line;record=JSON.parse(fs.readFileSync(path.join(f.root,"watchers",f.id+"."+process.pid+".json"),"utf8"));
   setTimeout(()=>f.put({status:"verifying",livePhase:"verification"}),20);
  }});
  assert.match(first,/^codex-team waiter \(Claude's, read-only\)/);assert.match(first,/job "security"/);assert.match(first,/Codex implementer \(pid \d+\)/);assert.match(first,/wakes Claude by \d\d:\d\d or on a phase change/);
  assert.equal(record.jobId,f.id);assert.equal(record.pid,process.pid);assert.ok(Date.parse(record.until)>Date.parse(record.startedAt));
  assert.equal(result.status,"verifying");assert.deepEqual(fs.readdirSync(path.join(f.root,"watchers")),[]);
 }finally{f.close();}
});
