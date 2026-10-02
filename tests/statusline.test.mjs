/** Status display is read-only, bounded, expires finished jobs and composes stdin with --base. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { fixture, rollout, sample, at } from "./observer-fixture.mjs";
import { statusLines } from "../scripts/statusline.mjs";
import { trustedExecutable } from "../scripts/host-security.mjs";

test("R1: relay preserves inherited pipes, trusted shell argv and exit status", () => {
  const source = fs.readFileSync(new URL("../scripts/base-relay.cjs", import.meta.url), "utf8");
  const shell = "C:\\trusted tools\\cmd.exe", command = '"C:\\tools\\node.exe" "C:\\project folder\\stdin.cjs" | findstr base:';
  for (const outcome of [0, 7, null, "error", "throw"]) {
    const child = new EventEmitter(), exits = [], environment = {};
    runInNewContext(source, {
      process: { argv: ["node", "relay", shell, command], env: environment, exit: code => exits.push(code) },
      require: name => {
        assert.equal(name, "node:child_process");
        return { spawn: (executable, args, options) => {
          assert.equal(executable, shell);
          assert.deepEqual(Array.from(args), ["/d", "/s", "/c", '"' + command + '"']);
          assert.equal(options.detached, false); assert.equal(options.stdio, "inherit");
          assert.equal(options.windowsVerbatimArguments, true); assert.equal(options.windowsHide, true);
          if (outcome === "throw") throw Error("fixture spawn error");
          return child;
        } };
      },
    });
    assert.equal(environment.NoDefaultCurrentDirectoryInExePath, "1");
    if (outcome === "error") child.emit("error", Error("fixture spawn error"));
    else if (outcome !== "throw") child.emit("exit", outcome);
    assert.deepEqual(exits, [typeof outcome === "number" ? outcome : 1]);
  }
});
test("active phase and live tokens are read without DB writes", t => {
  const f = fixture(t);
  f.put({ status: "verifying", livePhase: "reviewer", progress: "z".repeat(200), execs: [{ startedAt: at(1), threadId: "thread", freshThread: true }] });
  rollout(f.home, "thread", [sample(2, 1000, 100)]);
  const file = path.join(f.root, "state.sqlite"), before = fs.readFileSync(file);
  const start = performance.now();
  const out = statusLines({ cwd: f.cwd }, { root: f.root, home: f.home, now: Date.parse(at(20)) });
  assert.match(out, /reviewing/); assert.match(out, /1,100 tokens/);
  assert.ok(!out.includes("z".repeat(61))); assert.ok(performance.now() - start < 200);
  assert.deepEqual(fs.readFileSync(file), before);
});
test("final state lasts ten minutes; unrelated projects remain silent", t => {
  const f = fixture(t); f.put({ status: "accepted", finishedAt: at(10), usage: { input_tokens: 1 } });
  assert.match(statusLines({ cwd: f.cwd }, { root: f.root, now: Date.parse(at(100)) }), /waiting for Claude/);
  assert.equal(statusLines({ cwd: f.cwd }, { root: f.root, now: Date.parse(at(611)) }), "");
  assert.equal(statusLines({ cwd: f.home }, { root: f.root }), "");
});
test("base receives the same stdin and is preserved when the job DB is absent", t => {
  const f = fixture(t), base = path.join(f.dir, "base.mjs");
  fs.writeFileSync(base, 'import fs from "node:fs"; console.log("base:" + JSON.parse(fs.readFileSync(0,"utf8")).session_id);');
  const child = spawnSync(process.execPath, ["--no-warnings", "scripts/statusline.mjs", "--base", `"${process.execPath}" "${base}"`], {
    input: JSON.stringify({ cwd: f.cwd, session_id: "s" }), encoding: "utf8", env: { ...process.env, CODEX_TEAM_STATE: path.join(f.dir, "missing") },
  });
  assert.equal(child.status, 0); assert.equal(child.stdout, "base:s");
});

test("R1: Windows base preserves stdin through external findstr and a pipeline", { skip: process.platform !== "win32" ? "Windows cmd relay coverage; POSIX composition uses /bin/sh." : false }, t => {
  const f = fixture(t), findstr = trustedExecutable("findstr.exe"), input = JSON.stringify({ cwd: f.cwd, session_id: "relay-pipe" });
  const filter = `"${findstr}" session_id`;
  for (const command of [filter, `${filter} | ${filter}`]) {
    const child = spawnSync(process.execPath, ["--no-warnings", "scripts/statusline.mjs", "--base", command], {
      input, encoding: "utf8", windowsHide: true, timeout: 3000,
      env: { ...process.env, CODEX_TEAM_STATE: path.join(f.dir, "missing") },
    });
    assert.equal(child.status, 0, child.error?.message || child.stderr);
    assert.equal(child.stdout, input, command);
  }
});

test("status uses last meaningful progress line and never reads final exec rollouts", t => {
  const f = fixture(t); f.put({ progress: "old step\n\nLatest meaningful step\n  ", execs: [{ startedAt: at(1), finishedAt: at(10), usage: { input_tokens: 42 }, threadId: "finished" }] });
  const original = fs.readdirSync; let reads = 0;
  fs.readdirSync = (...args) => { reads++; return original(...args); };
  let text;
  try { text = statusLines({ cwd: f.cwd }, { root: f.root, now: Date.parse(at(20)), home: f.home }); }
  finally { fs.readdirSync = original; }
  assert.equal(reads, 0, "final exec does not discover a rollout");
  assert.match(text, /Latest meaningful step/); assert.doesNotMatch(text, /old step/); assert.match(text, /42 tokens/);
});

test("hook end-to-end latency with nine 1 MB inline legacy rows", t => {
  const f = fixture(t);
  for (let i = 0; i < 9; i++) f.put({ jobId: `${String(i).padStart(8, "0")}-1111-1111-1111-111111111111`, baseline: { inline: "x".repeat(1024 * 1024) }, usage: { input_tokens: 42 }, finishedAt: at(10) });
  const input = { cwd: f.cwd, session_id: "perf", tool_name: "Write", tool_input: { path: "new.ts", content: "x" } };
  for (const [script, limit] of [["delegation-guard", 300], ["statusline", 200]]) {
    const times = [];
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      const run = spawnSync(process.execPath, ["--no-warnings", `scripts/${script}.mjs`], {
        input: JSON.stringify({ ...input, session_id: "perf" + i }), encoding: "utf8", windowsHide: true,
        env: { ...process.env, CODEX_TEAM_STATE: f.root, CODEX_TEAM_GUARD: "block", CODEX_HOME: f.home },
      });
      times.push(performance.now() - start);
      assert.equal(run.status, 0); assert.ok(run.stdout, run.stderr);
    }
    const median = [...times].sort((a, b) => a - b)[1];
    t.diagnostic(`${script} wall ms: ${times.map(n => n.toFixed(1)).join(", ")}`);
    assert.ok(median < limit, `${script} median ${median.toFixed(1)}ms exceeds ${limit}ms`);
  }
});

test("all hook entry points execute through a directory junction or symlink", async t => {
  const f = fixture(t); f.put();
  const { refreshStateCard } = await import("../scripts/lead-state.mjs");
  refreshStateCard(f.db, process.platform === "win32" ? f.cwd.toLowerCase() : f.cwd);
  const link = path.join(f.dir, "linked-scripts");
  try { fs.symlinkSync(path.resolve("scripts"), link, process.platform === "win32" ? "junction" : "dir"); }
  catch (e) { if (["EPERM", "EACCES"].includes(e.code)) { t.skip(`sandbox limitation creating link: ${e.code}`); return; } throw e; }
  for (const [script, input] of [
    ["delegation-guard", { cwd: f.cwd, session_id: "linked", tool_name: "Write", tool_input: { path: "new.ts", content: "x" } }],
    ["statusline", { cwd: f.cwd }], ["session-start", { cwd: f.cwd, source: "clear" }],
    ["size-warning", { tool_response: "x".repeat(80001) }],
  ]) {
    const run = spawnSync(process.execPath, ["--no-warnings", path.join(link, script + ".mjs")], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, CODEX_TEAM_STATE: f.root, CODEX_HOME: f.home } });
    assert.equal(run.status, 0); assert.ok(run.stdout, script + ": " + run.stderr);
  }
});

test("status lines redact progress and lastCommand without a project profile", t => {
  const f = fixture(t);
  for (const fields of [{ progress: "TOKEN=secret-fixture" }, { progress: "", lastCommand: "PASSWORD=secret-fixture" }]) {
    f.put({ ...fields, profile: null });
    const output = statusLines({ cwd: f.cwd }, { root: f.root, home: f.home });
    assert.doesNotMatch(output, /secret-fixture/); assert.match(output, /REDACTED/);
  }
});


import {registerWatcher,liveWatchers,actor} from "../scripts/watchers.mjs";
test("job phases and live Claude wake time identify who is working",t=>{
 const f=fixture(t),jobId="aaaaaaaa-1111-1111-1111-111111111111",now=Date.now();
 f.put({jobId,status:"verifying",requestId:"security",assignment:{verification:[{host:false}]},startedAt:new Date(now-5000).toISOString()});
 const cleanup=registerWatcher(f.root,jobId,now+60000);t.after(cleanup);
 let output=statusLines({cwd:f.cwd},{root:f.root,now});assert.match(output,/Codex ▸ security · running checks \(sandboxed\)/);assert.match(output,/Claude checks \d\d:\d\d/);
 assert.equal(actor({status:"verifying",assignment:{verification:[{host:true}]}}).phase,"running checks (host)");
 assert.equal(actor({status:"running"}).phase,"coding");assert.match(actor({status:"verifying",livePhase:"reviewer",codexPid:123}).who,/reviewer \(pid 123\)/);
 cleanup();assert.doesNotMatch(statusLines({cwd:f.cwd},{root:f.root,now}),/Claude checks/);
 const dir=path.join(f.root,"watchers");for(const [pid,until] of [[process.pid,now-1],[2147483647,now+60000]])fs.writeFileSync(path.join(dir,jobId+"."+pid+".json"),JSON.stringify({jobId,pid,until:new Date(until).toISOString()}));
 assert.deepEqual(liveWatchers(f.root,jobId,now),[]);
});
