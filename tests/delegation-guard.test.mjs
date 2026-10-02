/** Guard wire contract, exact threshold, source exclusions and atomic reminder behavior. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { spawn, spawnSync } from "node:child_process";
import { fixture } from "./observer-fixture.mjs";
import { evaluateGuard } from "../scripts/delegation-guard.mjs";
import { classifySourcePath, estimateChangedLines } from "../scripts/delegation-policy.mjs";
import { createHash } from "node:crypto";
import { fold } from "../scripts/observer.mjs";
test("stale guard lock is removed before acquiring and cannot disable the guard", t => {
  const f = fixture(t); f.put();
  const input = { cwd: f.cwd, session_id: "stale", transcript_path: f.transcript, tool_name: "Write", tool_input: { file_path: "new.ts", content: "x" } };
  const key = createHash("sha256").update([input.session_id, fold(f.cwd), fold(path.join(f.cwd, "new.ts"))].join("\0")).digest("hex");
  const lock = path.join(f.root, "guard", key + ".lock"); fs.mkdirSync(lock, { recursive: true });
  fs.utimesSync(lock, new Date(Date.now() - 20000), new Date(Date.now() - 20000));
  assert.equal(evaluateGuard(input, { root: f.root, home: f.home }).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(fs.existsSync(lock), false);
});
test("remind denies atomically once per session/file; block and off are explicit", t => {
  const f = fixture(t); f.put();
  const input = { cwd: f.cwd, session_id: "session", transcript_path: f.transcript, tool_name: "Write", tool_input: { file_path: "new.ts", content: "one line" } };
  const options = { root: f.root, home: f.home };
  const start = performance.now();
  const denied = evaluateGuard(input, options);
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /retry/);
  assert.equal(evaluateGuard(input, options), null);
  assert.equal(evaluateGuard(input, { ...options, mode: "block" }).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(evaluateGuard(input, { ...options, mode: "off" }), null);
  assert.ok(evaluateGuard({ ...input, session_id: "other" }, options));
  assert.ok(performance.now() - start < 300);
});
test("no Git/session job means no guard, and source policy excludes notes/config/data", t => {
  const f = fixture(t);
  const input = { cwd: f.cwd, session_id: "s", transcript_path: f.transcript, tool_name: "Write", tool_input: { path: "new.py", content: "x" } };
  assert.equal(evaluateGuard(input, { root: f.root }), null);
  f.put(); fs.rmdirSync(path.join(f.cwd, ".git"));
  assert.equal(evaluateGuard(input, { root: f.root }), null);
  for (const file of ["a.md", "a.json", "a.png", "../outside.js"])
    assert.equal(classifySourcePath(file, f.cwd, f.home), null, file);
  for (const file of ["a.ts", "a.py", "a.ipynb", "Dockerfile", "src/a.cpp", "memory.ts", "plan.ts", "src/memory/a.ts", "plan-mode/a.ts", "scratchpad.py"])
    assert.ok(classifySourcePath(file, f.cwd, f.home), file);
});
test("20/21 lines, replacement multiplicity, MultiEdit aggregation and notebook cells", t => {
  const f = fixture(t), file = path.join(f.cwd, "a.js");
  fs.writeFileSync(file, "a\n".repeat(20));
  const ten = Array.from({ length: 10 }, (_, i) => "n" + i).join("\n");
  assert.equal(estimateChangedLines("Edit", { old_string: "a\n".repeat(10).trimEnd(), new_string: ten }, file), 20);
  assert.equal(estimateChangedLines("Edit", { old_string: "a\n".repeat(10).trimEnd(), new_string: ten + "\nx" }, file), 21);
  assert.equal(estimateChangedLines("Edit", { old_string: "a", new_string: "b", replace_all: true }, file), 40);
  assert.equal(estimateChangedLines("MultiEdit", { edits: [{ old_string: "a", new_string: "b" }, { old_string: "a", new_string: "c", replace_all: true }] }, file), 40);
  assert.equal(estimateChangedLines("Write", { content: fs.readFileSync(file, "utf8") }, file), 0);
  const original = Array.from({ length: 100 }, (_, i) => "line" + i);
  fs.writeFileSync(file, original.join("\n"));
  const edited = [...original]; edited[1] = "changed"; edited[98] = "also changed";
  assert.equal(estimateChangedLines("Write", { content: edited.join("\n") }, file), 4, "unchanged middle lines do not count");
  fs.writeFileSync(file, JSON.stringify({ cells: [{ id: "cell", source: ["a"], cell_type: "code" }] }));
  assert.equal(estimateChangedLines("NotebookEdit", { cell_id: "cell", new_source: "b" }, file), 2);
  assert.equal(estimateChangedLines("Write", {}, path.join(f.cwd, "missing.js")), null);
  assert.equal(estimateChangedLines("NotebookEdit", { edit_mode: "insert", cell_type: "markdown", new_source: "a\n".repeat(30) }, file), 0);
});
test("hook faults exit zero with no stdout", () => {
  const child = spawnSync(process.execPath, ["--no-warnings", "scripts/delegation-guard.mjs"], { input: "{bad", encoding: "utf8" });
  assert.equal(child.status, 0); assert.equal(child.stdout, "");
});
test("concurrent first attempts produce exactly one reminder; path aliases share the marker", async t => {
  const f = fixture(t); f.put();
  const input = { cwd: f.cwd, session_id: "race", transcript_path: f.transcript, tool_name: "Write", tool_input: { file_path: "new.js", content: "x" } };
  const runs = Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-warnings", "scripts/delegation-guard.mjs"], { windowsHide: true, env: { ...process.env, CODEX_TEAM_STATE: f.root, CODEX_TEAM_GUARD: "remind" } });
    let out = ""; child.stdout.on("data", data => { out += data; });
    child.on("error", reject); child.on("close", code => code === 0 ? resolve(out) : reject(Error(String(code))));
    child.stdin.end(JSON.stringify(input));
  }));
  assert.equal((await Promise.all(runs)).filter(Boolean).length, 1);
  assert.equal(evaluateGuard({ ...input, tool_input: { ...input.tool_input, file_path: "./nested/../new.js" } }, { root: f.root }), null);
});

test("small edits accumulate before any DB access; scratchpad paths and stale markers are precise", async t => {
  const f = fixture(t), file = path.join(f.cwd, "memory.ts");
  fs.writeFileSync(file, "a\n".repeat(20));
  const input = { cwd: f.cwd, session_id: "chunks", tool_name: "Edit", tool_input: { path: file, old_string: "a\n".repeat(10).trimEnd(), new_string: "b\n".repeat(10).trimEnd() } };
  // First 20 changed lines do not open SQLite, even when that DB is invalid.
  const badRoot = path.join(f.dir, "bad"); fs.mkdirSync(badRoot); fs.writeFileSync(path.join(badRoot, "state.sqlite"), "bad sqlite");
  assert.equal(evaluateGuard(input, { root: badRoot, home: f.home }), null);
  f.put();
  assert.equal(evaluateGuard(input, { root: f.root, home: f.home }), null);
  assert.ok(evaluateGuard(input, { root: f.root, home: f.home }));
  assert.equal(evaluateGuard(input, { root: f.root, home: f.home }), null);
  const scratch = path.join(f.cwd, "scratch"); fs.mkdirSync(scratch);
  assert.equal(classifySourcePath("scratch/a.ts", f.cwd, f.home, scratch), null);
  assert.ok(classifySourcePath("scratch/a.ts", f.cwd, f.home));
  assert.equal(classifySourcePath(path.join(f.home, ".claude", "plans", "a.ts"), f.home, f.home), null);
  const { pruneMarkers } = await import("../scripts/delegation-guard.mjs");
  const dir = path.join(f.root, "guard"), marker = path.join(dir, "a".repeat(64));
  fs.writeFileSync(marker, "{}"); fs.utimesSync(marker, new Date(0), new Date(0));
  pruneMarkers(dir); assert.equal(fs.existsSync(marker), false);
});

test("after clear guard activates for running or recently finished project jobs", t => {
  const f = fixture(t), now = Date.now();
  const input = { cwd: f.cwd, session_id: "clear", tool_name: "Write", tool_input: { path: "plan.ts", content: "x" } };
  const options = { root: f.root, home: f.home, mode: "block", now };
  f.put({ startedAt: new Date(now - 86400000).toISOString(), status: "running" });
  assert.ok(evaluateGuard(input, options));
  f.put({ status: "accepted", finishedAt: new Date(now - 3600000).toISOString() });
  assert.ok(evaluateGuard(input, options));
  f.put({ status: "accepted", finishedAt: new Date(now - 3 * 3600000).toISOString() });
  assert.equal(evaluateGuard(input, options), null);
});
