/** Exercise presentation through the real stdio MCP registry; only local fake-CLI jobs. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as S from "../scripts/store.mjs";
import { git } from "../scripts/git.mjs";
import { ownershipReport } from "../scripts/diagnostics.mjs";
import { compactJob, compactResult, invokeTool, waitCommand } from "../scripts/tool-output.mjs";
const secret = "ASSIGNMENT_CONTEXT_PROMPT_MUST_NOT_LEAK";
test("every MCP registry tool supports compact/default/full; replay ignores detail", { timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-output-"));
  const cwd = path.join(root, "project with spaces"); fs.mkdirSync(cwd);
  process.env.CODEX_TEAM_STATE = path.join(root, "jobs");
  process.env.CODEX_TEAM_CODEX = fileURLToPath(new URL("./fake-codex.mjs", import.meta.url));
  const env = { ...process.env, CODEX_HOME: path.join(root, "codex-config") };
  git(cwd, ["init", "-q"]);
  fs.mkdirSync(path.join(cwd, ".codex-team"));
  fs.writeFileSync(path.join(cwd, ".codex-team/profile.json"), JSON.stringify({ profileVersion: 1, name: "fixture", components: {
    report: { level: "advise", target: { file: "DELIVERY.md" } }, textHygiene: { level: "advise" }, continuity: { level: "advise", contextKey: "cwd" },
  } }));
  const child = spawn(process.execPath, [fileURLToPath(new URL("../scripts/server.mjs", import.meta.url))], { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map(), seen = new Set(); let seq = 0;
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", line => { const m = JSON.parse(line); pending.get(m.id)?.(m.result); pending.delete(m.id); });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq, timer = setTimeout(() => reject(new Error("MCP timeout")), 40000);
    pending.set(id, result => { clearTimeout(timer); resolve(result); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const tool = async (name, input = {}, detail) => {
    const response = await call("tools/call", { name, arguments: { ...input, ...(detail ? { detail } : {}) } });
    seen.add(name);
    const text = response.content[0].text;
    if (detail !== "full") { assert.ok(text.length <= (name === "codex_status" && !input.jobId ? 6000 : 1500), name + " output too large"); assert.ok(!text.includes(secret), name + " leaked input"); }
    return response.isError ? { error: text } : JSON.parse(text);
  };
  try {
    const registry = (await call("tools/list")).tools;
    assert.equal(registry.length, 14);
    for (const entry of registry) {
      assert.deepEqual(entry.inputSchema.properties.detail.enum, ["compact", "full"]);
      assert.equal(entry.inputSchema.properties.detail.default, "compact");
      const invalid = await call("tools/call", { name: entry.name, arguments: { detail: "verbose" } });
      assert.equal(invalid.isError, true);
    }
    assert.equal((await tool("codex_doctor", { cwd })).authenticated, true);
    assert.equal((await tool("codex_doctor", { cwd }, "full")).available, true);
    assert.equal((await tool("codex_context", { cwd, action: "update", expectedVersion: 0, decisions: [secret] })).version, 1);
    assert.equal((await tool("codex_context", { cwd }, "full")).context.decisions[0], secret);
    const profile = await tool("codex_profile", { cwd }, "full");
    assert.equal((await tool("codex_profile", { cwd, action: "approve", expectedHash: profile.profile.hash })).approved, true);
    const input = { cwd, autoVerify: false, requestId: "identity", assignment: { objective: secret, scope: ["."], acceptanceCriteria: [secret], verification: [{ id: "check", command: process.execPath, allowInline: true, args: ["-e", "setTimeout(()=>{},2500)"] }] } };
    const started = await tool("codex_start", input);
    assert.ok(started.waitCommand.includes('"'));
    const replay = await tool("codex_start", input, "full");
    assert.equal(replay.jobId, started.jobId);
    assert.equal(replay.assignment.objective, secret);
    const job = { cwd, jobId: started.jobId };
    const done = await tool("codex_status", { ...job, waitSeconds: 30 }, "full");
    assert.equal(done.status, "implementation_finished", JSON.stringify(done));
    const compactDone = await tool("codex_status", job);
    assert.equal(compactDone.status, done.status);
    assert.equal(Object.hasOwn(compactDone, "waitCommand"), false);
    assert.equal(compactDone.next, done.next);
    assert.equal((await tool("codex_cancel", job)).cancellationRequested, false);
    assert.equal((await tool("codex_cancel", job, "full")).status, done.status);
    assert.equal((await tool("codex_verify", { ...job })).status, "verifying");
    const childDeadline = Date.now() + 15000;
    let live = S.readRaw(job.jobId);
    while (live.childRole !== "verification" && Date.now() < childDeadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
      live = S.readRaw(job.jobId);
    }
    assert.equal(live.childRole, "verification");
    assert.ok(S.alive(live.codexPid), "inspect the live verification child");
    assert.equal(live.childStartedAt, live.verificationChildStartedAt);
    assert.notEqual(live.childStartedAt, done.childStartedAt);
    assert.equal(live.modelChildStartedAt, done.childStartedAt);
    assert.equal(live.modelChildStartedAt, live.execs.at(-1).startedAt);
    const verified = await tool("codex_status", { ...job, waitSeconds: 30 }, "full");
    assert.equal(verified.status, "verified");
    assert.equal(verified.childRole, "reviewer");
    assert.equal(verified.childStartedAt, verified.modelChildStartedAt);
    assert.equal(verified.modelChildStartedAt, verified.execs.at(-1).startedAt);
    assert.notEqual(verified.childStartedAt, verified.verificationChildStartedAt);
    assert.ok(verified.verificationChildStartedAt);
    assert.deepEqual(verified.execs.slice(0, -1), done.execs);
    assert.equal(verified.execs.at(-1).role, "reviewer");
    assert.notEqual(verified.execs.at(-1).threadId, done.threadId);
    assert.equal((await tool("codex_verify", job, "full")).status, "verified");
    const evidence = [{ criterionIndex: 0, checkId: "check", observation: secret }];
    assert.equal((await tool("codex_review", { ...job, action: "accept", summary: secret, evidence })).status, "accepted");
    assert.equal((await tool("codex_review", { ...job, action: "note", summary: secret }, "full")).status, "accepted");
    for (const detail of ["compact", "full"]) {
      assert.ok((await tool("codex_integrate", job, detail)).error); // direct mode correctly refuses integration
      assert.ok((await tool("codex_push", { ...job, expectedCommit: "0".repeat(40) }, detail)).error); // no push is authorized
      const hygiene = await tool("codex_hygiene", job, detail);
      assert.ok(hygiene.fingerprint, JSON.stringify(hygiene));
      const report = await tool("codex_report", { ...job, action: "render", ownerSummary: secret }, detail);
      assert.ok(report.target.expectedTargetHash);
      const handoff = await tool("codex_handoff", { cwd, action: "export" }, detail);
      assert.ok(handoff.contentHash);
    }
    const batchId = randomUUID();
    S.setExtension("batch", batchId, { batchId, cwd: fs.realpathSync(cwd), status: "running", authorization: secret, assignments: [input.assignment], children: [{ cwd, jobId: job.jobId }] });
    assert.equal((await tool("codex_batch", { cwd, batchId, action: "status" })).children[0].jobId, job.jobId);
    assert.equal((await tool("codex_batch", { cwd, batchId, action: "status" }, "full")).children[0].assignment.objective, secret);
    assert.equal(seen.size, registry.length);
    // Worst-case persisted progress and failed checks, through the server's serialization.
    S.patch(job.jobId, { progress: "\u0001".repeat(3000), error: "failure ".repeat(3000), cancellationRequested: true, cancellationError: "error ".repeat(3000), acceptanceCurrent: false, runtimeFailure: { code: "sandbox_setup_failed" }, result: { blockers: Array(100).fill(secret) } });
    fs.writeFileSync(path.join(cwd, "changed-after-acceptance.txt"), "stale");
    const compact = await tool("codex_status", job);
    assert.equal(compact.runtimeFailure, "sandbox_setup_failed");
    assert.equal(compact.acceptanceCurrent, false);
  } finally {
    child.stdin.end(); await new Promise(resolve => child.once("exit", resolve)); lines.close(); S.closeStores();
    await new Promise(resolve => setTimeout(resolve, 200));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
test("presentation strips detail before business hashing and retains failure indicators under caps", async () => {
  const input = { value: secret };
  const handler = args => { assert.deepEqual(args, input); return { target: { expectedTargetHash: "a".repeat(64) }, markdown: secret }; };
  assert.deepEqual(await invokeTool("codex_report", handler, { ...input, detail: "compact" }), compactResult("codex_report", await handler(input)));
  assert.equal((await invokeTool("codex_report", handler, { ...input, detail: "full" })).markdown, secret);
  const state = { jobId: randomUUID(), status: "failed", progress: "p\n".repeat(4000), assignment: secret, prompt: secret, context: secret, cancellationRequested: true, acceptanceCurrent: false, orphanProcessAlive: true, error: "\u0001".repeat(5000) };
  const compact = compactJob(state);
  assert.ok(JSON.stringify(compact).length <= 1500);
  assert.ok(compact.untrustedCodexText.content.progress.length <= 200);
  assert.equal(compact.acceptanceCurrent, false);
  assert.equal(compact.orphanProcessAlive, true);
  assert.ok(!JSON.stringify(compact).includes(secret));
});

test("unsafe wait paths omit the command with poll guidance, including smart quotes", () => {
  const jobId = randomUUID();
  for (const part of ['$HOME', '`expression`', '"quote', '\u201c', '\u201d', '\u201e']) {
    const waitScript = `C:/plugin/${part}/scripts/wait.mjs`;
    assert.equal(waitCommand(jobId, waitScript), undefined);
    const compact = compactJob({ jobId, status: "running" }, { waitScript });
    assert.equal(Object.hasOwn(compact, "waitCommand"), false);
    assert.match(compact.next, /poll codex_status/);
  }
});
test("compact diagnosis retains runtime, sandbox and ownership blockers plus evidence count", () => {
  const value = compactResult("codex_doctor", {
    available: true, readiness: "blocked", job: { runtimeFailure: { code: "sandbox_setup_failed" } },
    sandbox: { status: "blocked", failure: { code: "probe_failed" } },
    diagnostics: { ownership: { mismatch: true, orphanedOwner: true, repair: { requiresAdministrator: true } } },
  });
  assert.equal(value.runtimeFailure, "sandbox_setup_failed");
  assert.equal(value.sandbox.code, "probe_failed");
  assert.equal(value.ownership.mismatch, true);
  assert.equal(value.ownership.orphanedOwner, true);
  assert.equal(value.ownership.requiresAdministrator, true);
  assert.equal(compactJob({ jobId: randomUUID(), status: "pending_lead_evidence", pendingEvidence: [{}, {}] }).pendingEvidence, 2);
});


test("terminal compact jobs retain next guidance even when waiter paths are unsafe", () => {
  const next = "Inspect changes, then codex_verify and codex_review.";
  for (const status of ["implementation_finished", "verified", "failed", "cancelled"]) {
    for (const waitScript of ["C:/plugin/scripts/wait.mjs", "C:/$unsafe/scripts/wait.mjs"]) {
      const result = compactJob({ jobId: randomUUID(), status, next }, { waitScript });
      assert.equal(result.next, next);
      assert.equal(Object.hasOwn(result, "waitCommand"), false);
    }
  }
});

test("compact doctor preserves recorded ownership repair, full SID detail and unavailable CLI errors", () => {
  const cwd = "D:\\Git_tests\\project with spaces";
  const ownership = ownershipReport({
    user: "S-1-5-21-1111111111-2222222222-3333333333-1001",
    items: [{ path: cwd, owner: "S-1-5-21-4444444444-5555555555-6666666666-1001", ownerName: null }],
  }, cwd);
  assert.ok(ownership.detail.length > 200 && ownership.detail.length < 600);
  const result = compactResult("codex_doctor", {
    available: true, readiness: "blocked", diagnostics: { ownership },
  });
  assert.equal(result.ownership.detail, ownership.detail);
  assert.equal(result.ownership.repair.command, ownership.repair.command);
  assert.equal(result.ownership.requiresAdministrator, true);
  assert.ok(JSON.stringify(result).length <= 1500);
  const error = "Codex CLI not found. Install/login or set CODEX_TEAM_CODEX to its absolute executable path.";
  assert.equal(compactResult("codex_doctor", { available: false, readiness: "unavailable", error }).error, error);
  assert.equal(compactResult("codex_doctor", {
    diagnostics: { ownership: { detail: "x".repeat(2000) } },
  }).ownership.detail.length, 600);
});
