import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  buildArgs,
  workspace,
  doctor,
  startJob,
  statusJob,
  cancelJob,
} from "../scripts/runtime.mjs";
import { closeStores } from "../scripts/store.mjs";

process.env.GIT_CEILING_DIRECTORIES = os.tmpdir();
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-test-"));
const project = path.join(root, "project with spaces");
const other = path.join(root, "other");
fs.mkdirSync(project);
fs.mkdirSync(other);
process.env.CODEX_TEAM_STATE = path.join(root, "jobs");
process.env.CODEX_TEAM_CODEX = fileURLToPath(
  new URL("./fake-codex.mjs", import.meta.url),
);
const created = [];
const start = (input) => {
  const job = startJob({ autoVerify: false, cwd: project, ...input });
  created.push(job);
  return job;
};
async function finish(job) {
  const state = await statusJob({
    cwd: project,
    jobId: job.jobId,
    waitSeconds: 30,
  });
  assert.ok(
    !["starting", "running"].includes(state.status),
    JSON.stringify(state),
  );
  return state;
}
after(async () => {
  for (const job of created) {
    try {
      cancelJob({ cwd: project, jobId: job.jobId });
      await statusJob({ cwd: project, jobId: job.jobId, waitSeconds: 10 });
    } catch {}
  }
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith("codex-team-test-"));
  closeStores();
  await new Promise((r) => setTimeout(r, 100));
  fs.rmSync(root, { recursive: true, force: true });
});
test("explicit existing project root and safe CLI invocation", () => {
  assert.throws(() => workspace("."), /absolute/);
  assert.throws(() => workspace(path.join(root, "absent")));
  const args = buildArgs({ cwd: project, readOnly: false }, "report.txt");
  assert.equal(args[args.indexOf("--sandbox") + 1], "workspace-write");
  assert.ok(args.includes('approval_policy="never"'));
  assert.ok(!args.some((a) => a.includes("dangerously")));
  assert.equal(
    buildArgs({ cwd: project, readOnly: true }, "r")[4],
    "read-only",
  );
});
test("doctor checks binary and authentication without a task", () => {
  const result = doctor();
  assert.equal(result.available, true);
  assert.equal(result.authenticated, true);
});
test("non-Git prompt support does not authorize structured verification or worktree isolation", () => {
  assert.throws(() => start({ requestId: "non-git-structured", assignment: {
    objective: "Inspect the project", scope: ["answer.mjs"], acceptanceCriteria: ["answer exists"],
    verification: [{ id: "answer", command: process.execPath, args: ["--version"] }],
  } }), /Structured verification requires a Git repository root/);
  assert.throws(() => start({ prompt: "Inspect", isolation: "worktree" }), /Worktree mode requires a clean Git root/);
});
let completed;
test("background task captures literal input, thread ID, usage and final report", async () => {
  const prompt =
    'Implement literal text: $(should-not-run) `backticks` "quotes"\nsecond line';
  completed = start({ prompt });
  const result = await finish(completed);
  assert.equal(result.status, "implementation_finished");
  assert.equal(result.report, "Implementation completed");
  assert.equal(result.usage.output_tokens, 4);
  assert.ok(result.threadId);
  const captured = JSON.parse(
    fs.readFileSync(path.join(project, "captured.json")),
  );
  assert.ok(captured.prompt.endsWith(prompt));
  assert.equal(
    captured.args[captured.args.indexOf("--cd") + 1],
    fs.realpathSync(project),
  );
});
test("revision targets exact thread and preserves access mode and project", async () => {
  assert.throws(
    () =>
      start({ prompt: "Revise", resumeJobId: completed.jobId, readOnly: true }),
    /preserve/,
  );
  assert.throws(
    () =>
      startJob({ autoVerify: false, cwd: other, prompt: "Revise", resumeJobId: completed.jobId }),
    /different project/,
  );
  const revised = await finish(
    start({ prompt: "Address review feedback", resumeJobId: completed.jobId }),
  );
  assert.equal(revised.report, "Revision completed");
  const captured = JSON.parse(
    fs.readFileSync(path.join(project, "captured.json")),
  );
  assert.equal(
    captured.args[captured.args.indexOf("resume") + 1],
    revised.threadId,
  );
  assert.ok(!captured.args.includes("--last"));
});
test("failed turn is a failure even when process exits zero", async () => {
  const result = await finish(start({ prompt: "FAIL_FIXTURE" }));
  assert.equal(result.status, "failed");
  assert.match(result.errorLogTail, /Intentional fixture error/);
  assert.match(result.error, /failed turn/);
});
test("CLI exit completes the job even when a descendant keeps stdout open", async () => {
  const job = start({ prompt: "KEEP_PIPE_OPEN" });
  const childRecord = path.join(project, "pipe-child.json");
  try {
    const result = await finish(job);
    assert.equal(
      result.status,
      "implementation_finished",
      JSON.stringify(result),
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.report, "Implementation completed");
    const { pid } = JSON.parse(fs.readFileSync(childRecord, "utf8"));
    // The keeper holds stdout until its worker exits, then self-cleans even
    // when sandboxed taskkill cannot terminate descendants.
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      try { process.kill(pid, 0); } catch { break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally {
    if (fs.existsSync(childRecord)) {
      const { pid } = JSON.parse(fs.readFileSync(childRecord, "utf8"));
      try {
        process.kill(pid);
      } catch (e) {
        if (e.code !== "ESRCH") throw e;
      }
    }
  }
});
test("active jobs lock a workspace and cancellation waits for process termination", async () => {
  const job = start({ prompt: "WAIT_FOREVER" });
  await new Promise((r) => setTimeout(r, 500));
  assert.throws(() => start({ prompt: "duplicate" }), /active job/);
  await assert.rejects(
    statusJob({ cwd: other, jobId: job.jobId }),
    /different project/,
  );
  assert.throws(
    () => cancelJob({ cwd: other, jobId: job.jobId }),
    /different project/,
  );
  const cancelled = cancelJob({ cwd: project, jobId: job.jobId });
  assert.equal(cancelled.cancellationRequested, true);
  const result = await finish(job);
  assert.equal(result.status, "cancelled");
  assert.equal(
    (await finish(start({ prompt: "After cancel" }))).status,
    "implementation_finished",
  );
});
test("status recovery is project scoped; invalid IDs and parameters are rejected", async () => {
  const own = await statusJob({ cwd: project });
  assert.ok(own.jobs.length >= 4);
  assert.deepEqual((await statusJob({ cwd: other })).jobs, []);
  await assert.rejects(
    statusJob({ cwd: project, jobId: "../other" }),
    /Invalid job ID/,
  );
  await assert.rejects(
    statusJob({ cwd: project, jobId: completed.jobId, waitSeconds: 31 }),
    /waitSeconds/,
  );
  assert.throws(() => start({ prompt: "" }), /prompt/);
  assert.throws(() => start({ prompt: "read", readOnly: "false" }), /boolean/);
});
test("MCP protocol exposes all tools, rejects extra execution flags, handles bad JSON", async () => {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../scripts/server.mjs", import.meta.url))],
    { env: process.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  const pending = new Map();
  let seq = 0;
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => reject(new Error("MCP timed out")), 30000);
      pending.set(id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  try {
    const init = await call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    assert.equal(init.result.serverInfo.name, "codex-team");
    const tools = await call("tools/list", {});
    assert.equal(tools.result.tools.length, 14);
    assert.equal(new Set(tools.result.tools.map((t) => t.name)).size, 14);
    const health = await call("tools/call", {
      name: "codex_doctor",
      arguments: {},
    });
    assert.equal(JSON.parse(health.result.content[0].text).authenticated, true);
    const extra = await call("tools/call", {
      name: "codex_start",
      arguments: {
        cwd: project,
        prompt: "test",
        sandbox: "danger-full-access",
      },
    });
    assert.equal(extra.result.isError, true);
    assert.match(extra.result.content[0].text, /Unexpected argument/);
    const unknown = await call("tools/call", {
      name: "__proto__",
      arguments: {},
    });
    assert.equal(unknown.result.isError, true);
    const parse = new Promise((resolve) => pending.set(null, resolve));
    child.stdin.write("{invalid\n");
    assert.equal((await parse).error.code, -32700);
  } finally {
    child.stdin.end();
    await new Promise((resolve) => child.on("exit", resolve));
    lines.close();
  }
});
