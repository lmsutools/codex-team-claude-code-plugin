import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  doctor,
  startJob,
  statusJob,
  cancelJob,
  verifyJob,
} from "../scripts/runtime.mjs";
import {
  logFindings,
  classifyFailure,
  inspectRuntime,
  inspectOwnership,
  ownershipReport,
  probeRuntime,
  recordFailure,
  recovery,
} from "../scripts/diagnostics.mjs";
import { resolveCodex } from "../scripts/runtime.mjs";
import { git } from "../scripts/git.mjs";
import * as S from "../scripts/store.mjs";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-diagnostics-"));
process.env.CODEX_TEAM_STATE = path.join(root, "state");
process.env.CODEX_HOME = path.join(root, "codex-home");
fs.mkdirSync(process.env.CODEX_HOME);
process.env.CODEX_TEAM_CODEX = fileURLToPath(
  new URL("./fake-codex.mjs", import.meta.url),
);
process.env.CODEX_TEAM_FAKE_PROBE = path.join(root, "control.json");
const jobs = [];
let seq = 0;
function control(mode) {
  fs.writeFileSync(process.env.CODEX_TEAM_FAKE_PROBE, JSON.stringify({ mode }));
}
control("pass");
function project() {
  const cwd = path.join(root, "project-" + ++seq);
  fs.mkdirSync(cwd);
  git(cwd, ["init", "--quiet"]);
  fs.writeFileSync(path.join(cwd, "user.txt"), "user content");
  return fs.realpathSync(cwd);
}
function task(cwd, extra = {}) {
  const j = startJob({
    autoVerify: false,
    cwd,
    requestId: randomUUID(),
    assignment: {
      objective: "WRITE_CODE Create answer",
      scope: ["answer.mjs"],
      acceptanceCriteria: ["answer is 42"],
      verification: [
        {
          id: "answer",
          command: process.execPath, allowInline: true,
          args: [
            "--input-type=module",
            "-e",
            'import {answer} from "./answer.mjs";if(answer!==42)process.exit(1)',
          ],
        },
      ],
    },
    ...extra,
  });
  jobs.push(j);
  return j;
}
async function done(j) {
  const result = await statusJob({
    cwd: j.cwd,
    jobId: j.jobId,
    waitSeconds: 30,
  });
  assert.ok(!S.active.has(result.status), JSON.stringify(result));
  return result;
}
function calls() {
  try {
    return fs
      .readFileSync(process.env.CODEX_TEAM_FAKE_PROBE + ".calls", "utf8")
      .trim()
      .split("\n")
      .filter(Boolean).length;
  } catch {
    return 0;
  }
}
after(async () => {
  for (const j of jobs) {
    try {
      cancelJob({ cwd: j.cwd, jobId: j.jobId });
      await done(j);
    } catch {}
  }
  S.closeStores();
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith("codex-team-diagnostics-"));
  fs.rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
});

test("log evidence distinguishes three setup failures and labels path inference", () => {
  const long = "C:\\Users\\User\\runtime\\" + "x".repeat(270);
  const text = `[2026-09-27T16:09:43Z] runtime read/execute validation failed: validate runtime read/execute access on ${long}: CreateFileW failed for ${long}\n[2026-09-27T16:09:43Z] write ACE grant failed on D:\\repo: SetNamedSecurityInfoW failed: 5\n[2026-09-27T16:09:43Z] deny ACE failed on D:\\repo\\.git: open deny ACL target for update\n[old] write ACE grant failed on D:\\repository: SetNamedSecurityInfoW failed: 5`;
  const findings = logFindings(text, "D:/repo", "fixture.log");
  assert.deepEqual(
    findings.map((f) => f.kind),
    ["runtime_read_execute", "project_write_acl", "git_protection_acl"],
  );
  assert.equal(findings[0].pathLength, long.length);
  assert.match(findings[0].hypothesis, /does not prove/);
  assert.equal(findings[1].windowsError, 5);
  assert.deepEqual(
    logFindings(
      "[old] write ACE grant failed on D:\\repository: SetNamedSecurityInfoW failed: 5",
      "D:/repo",
    ),
    [],
  );
  assert.equal(classifyFailure("Vitest failed with assertion mismatch"), null);
  assert.equal(
    classifyFailure("helper_unknown_error: setup refresh had errors").category,
    "sandbox_setup",
  );
});
test("a repeated log failure reports its latest occurrence and the Win32 code after a .git path", () => {
  const text = [
    "[2026-09-27T16:09:43Z] write ACE grant failed on D:\\repo: SetNamedSecurityInfoW failed: 5",
    "[2026-09-27T21:54:37Z] write ACE grant failed on D:\\repo: SetNamedSecurityInfoW failed: 5",
    "[2026-09-27T21:54:37Z] deny ACE failed on D:\\repo\\.git: SetNamedSecurityInfoW failed for D:\\repo\\.git: 5\r",
  ].join("\n");
  const findings = logFindings(text, "D:/repo");
  assert.deepEqual(
    findings.map((f) => [f.kind, f.observedAt, f.windowsError]),
    [
      ["project_write_acl", "2026-09-27T21:54:37Z", 5],
      ["git_protection_acl", "2026-09-27T21:54:37Z", 5],
    ],
  );
});
test("an orphaned project owner yields the exact administrator repair; a matching owner none", () => {
  const cwd = "D:\\Git_tests\\repo";
  const orphan = ownershipReport(
    {
      user: "S-1-5-21-2-1001",
      items: [
        { path: cwd, owner: "S-1-5-21-1-1001", ownerName: null },
        { path: cwd + "\\.git", owner: "S-1-5-21-1-1001", ownerName: null },
      ],
    },
    cwd,
  );
  assert.equal(orphan.mismatch, true);
  assert.equal(orphan.orphanedOwner, true);
  assert.equal(orphan.repair.requiresAdministrator, true);
  assert.equal(orphan.repair.command, 'takeown /F "D:\\Git_tests\\repo" /R /D Y');
  assert.match(orphan.detail, /S-1-5-21-1-1001, an account that no longer resolves/);
  const steps = recovery(cwd, null, { ownership: orphan }).steps;
  assert.ok(steps[0].includes(orphan.repair.command));
  assert.match(recovery(cwd).steps[0], /^Inspect the recorded executable/);
  // PowerShell serializes a one-element list as a bare object.
  const other = ownershipReport(
    { user: "S-1", items: { path: cwd, owner: "S-2", ownerName: "HOST\\admin" } },
    cwd,
  );
  assert.equal(other.orphanedOwner, false);
  assert.match(other.detail, /owned by HOST\\admin, not the current user/);
  const mine = ownershipReport(
    { user: "S-1", items: [{ path: cwd, owner: "S-1", ownerName: "HOST\\me" }] },
    cwd,
  );
  assert.equal(mine.mismatch, false);
  assert.equal(mine.repair, undefined);
});
test("the Windows owner query recognizes a project the current user owns", () => {
  if (process.platform !== "win32") return;
  const report = inspectOwnership(project());
  assert.ok(report, "owner query returned no result");
  assert.equal(report.mismatch, false);
  assert.equal(report.checked.length, 2);
});
test("a failed probe reports the setup lines it caused apart from older log lines", () => {
  if (process.platform !== "win32") return;
  const cwd = project(),
    dir = path.join(process.env.CODEX_HOME, ".sandbox");
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(
    path.join(dir, "sandbox.log"),
    "[2026-09-27T16:09:43Z] runtime read/execute validation failed: validate runtime read/execute access on C:\\old\\runtime: CreateFileW failed for C:\\old\\runtime\n",
  );
  control("fail-acl");
  try {
    const report = doctor({ cwd, probe: true });
    assert.equal(report.readiness, "blocked");
    const failure = report.sandbox.failure;
    assert.equal(failure.diagnostics.probe.historical, false);
    assert.deepEqual(
      failure.diagnostics.probe.findings.map((f) => [f.kind, f.windowsError]),
      [
        ["project_write_acl", 5],
        ["git_protection_acl", 5],
      ],
    );
    assert.ok(
      report.diagnostics.findings.some((f) => f.kind === "runtime_read_execute"),
    );
    assert.equal(failure.diagnostics.ownership.mismatch, false);
    assert.equal(report.diagnostics.ownership.mismatch, false);
  } finally {
    control("pass");
  }
});
test("doctor distinguishes installed/authenticated from sandbox readiness and handles missing executable", () => {
  const report = doctor({ cwd: project() });
  assert.equal(report.authenticated, true);
  assert.equal(report.available, true);
  assert.equal(report.readiness, "untested");
  assert.equal(report.argumentsPrefix[0], process.env.CODEX_TEAM_CODEX);
  assert.equal(report.diagnostics.historical, true);
  assert.throws(() => doctor({ probe: true }), /cwd is required/);
  const original = process.env.CODEX_TEAM_CODEX;
  try {
    process.env.CODEX_TEAM_CODEX = path.join(root, "missing.exe");
    assert.equal(doctor().readiness, "unavailable");
  } finally {
    process.env.CODEX_TEAM_CODEX = original;
  }
});
test("failed preflight preserves assignment, suppresses new and read-only model jobs, and resumes after repair", async () => {
  if (process.platform !== "win32") return;
  control("fail");
  const cwd = project(),
    j = task(cwd, { maxRevisions: 0 });
  const failed = await done(j);
  assert.equal(failed.status, "blocked_runtime");
  assert.equal(failed.modelStarted, false);
  assert.equal(failed.runtimeFailure.code, "sandbox_setup_failed");
  assert.equal(
    fs.existsSync(path.join(j.logDirectory, "captured.json")),
    false,
  );
  assert.equal(fs.existsSync(path.join(cwd, "answer.mjs")), false);
  assert.ok(fs.existsSync(path.join(j.logDirectory, "assignment.json")));
  assert.throws(
    () => verifyJob({ cwd, jobId: j.jobId }),
    /completed implementation/,
  );
  const count = calls();
  const saved = doctor({ cwd });
  assert.equal(saved.sandbox.cached, true);
  assert.equal(saved.sandbox.probeExecuted, false);
  const retry = task(cwd, { readOnly: true });
  assert.equal((await done(retry)).preflight.cached, true);
  assert.equal(calls(), count);
  const resumed = startJob({
    cwd,
    resumeJobId: j.jobId,
    requestId: randomUUID(),
  });
  jobs.push(resumed);
  const blocked = await done(resumed);
  assert.equal(blocked.status, "blocked_runtime");
  assert.equal(blocked.revision, 0);
  assert.equal(calls(), count);
  const failedRead = doctor({
    cwd,
    jobId: resumed.jobId,
    probe: true,
    readOnly: true,
  });
  assert.equal(failedRead.readiness, "blocked");
  assert.equal(failedRead.sandbox.readOnly, false);
  control("readonly");
  const limited = doctor({
    cwd,
    jobId: resumed.jobId,
    probe: true,
    readOnly: true,
  });
  assert.equal(limited.readiness, "blocked");
  assert.equal(limited.sandbox.latestProbe.status, "passed");
  control("pass");
  assert.equal(
    doctor({ cwd, jobId: resumed.jobId, probe: true }).readiness,
    "passed",
  );
  const next = startJob({
    cwd,
    resumeJobId: resumed.jobId,
    requestId: randomUUID(),
  });
  jobs.push(next);
  const finished = await done(next);
  assert.equal(finished.status, "implementation_finished");
  assert.equal(finished.revision, 0);
  assert.equal(finished.assignment.objective, failed.assignment.objective);
  assert.equal(
    fs.readFileSync(path.join(cwd, "user.txt"), "utf8"),
    "user content",
  );
  assert.throws(
    () => startJob({ cwd, resumeJobId: j.jobId, requestId: randomUUID() }),
    /superseded/,
  );
});
test("stale shared setup logs cannot falsely fail a fresh successful probe", () => {
  if (process.platform !== "win32") return;
  control("pass");
  const dir = path.join(process.env.CODEX_HOME, ".sandbox");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "setup_error.json"),
    JSON.stringify({
      code: "helper_unknown_error",
      message: "setup refresh had errors",
    }),
  );
  const report = doctor({ cwd: project(), probe: true });
  assert.equal(report.readiness, "passed");
  assert.equal(report.diagnostics.lastSetupError.code, "helper_unknown_error");
  assert.equal(report.diagnostics.historical, true);
});
test("a changed runtime configuration permits one new preflight; identical state stays blocked", async () => {
  if (process.platform !== "win32") return;
  control("fail");
  const cwd = project(),
    first = await done(task(cwd));
  const count = calls();
  control("pass");
  const cached = await done(task(cwd));
  assert.equal(cached.status, "blocked_runtime");
  assert.equal(calls(), count);
  fs.mkdirSync(path.join(cwd, ".codex"));
  fs.writeFileSync(
    path.join(cwd, ".codex", "config.toml"),
    "# changed runtime configuration\n",
  );
  const next = await done(task(cwd));
  assert.equal(next.status, "implementation_finished");
  assert.notEqual(next.runtime.fingerprint, first.runtime.fingerprint);
  assert.equal(calls(), count + 1);
});
test("a setup failure during execution stops the worker and prevents another model call", async () => {
  control("pass");
  const cwd = project(),
    j = task(cwd, { prompt: "SANDBOX_FAIL_RUNNING" });
  const result = await done(j);
  assert.equal(result.status, "blocked_runtime");
  assert.equal(result.modelStarted, true);
  assert.ok(result.runtimeFailure);
  assert.equal(S.alive(S.read(j.jobId).codexPid), false);
  const next = await done(task(cwd));
  assert.equal(next.status, "blocked_runtime");
  assert.equal(next.modelStarted, false);
});
test("a zero exit without the sandbox nonce is not readiness; timeout remains blocked", () => {
  if (process.platform !== "win32") return;
  control("nomarker");
  const cwd = project();
  assert.equal(doctor({ cwd, probe: true }).readiness, "blocked");
  control("timeout");
  const binary = resolveCodex(),
    runtime = inspectRuntime(binary, cwd);
  const result = probeRuntime(binary, runtime, cwd, {
    force: true,
    timeoutMs: 1000,
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.failure.code, "sandbox_probe_timeout");
  control("pass");
});
test("legacy false success is diagnosed without rewriting original history files", async () => {
  control("pass");
  const cwd = project(),
    jobId = randomUUID(),
    dir = S.jobDir(jobId);
  fs.mkdirSync(dir, { recursive: true });
  const original = JSON.stringify({
    jobId,
    cwd,
    status: "succeeded",
    readOnly: false,
    startedAt: "2026-09-27T16:00:00Z",
    threadId: "11111111-2222-3333-4444-555555555555",
    progress: "Blocked: helper_unknown_error: setup refresh had errors",
  });
  fs.writeFileSync(path.join(dir, "job.json"), original);
  const savedPrompt = "saved exact assignment " + "任务".repeat(70000);
  fs.writeFileSync(path.join(dir, "prompt.txt"), savedPrompt);
  const diagnosed = await statusJob({ cwd, jobId });
  assert.equal(diagnosed.status, "blocked_runtime");
  assert.equal(diagnosed.previousStatus, "succeeded");
  assert.equal(diagnosed.runtimeFailure.historical, true);
  assert.equal(fs.readFileSync(path.join(dir, "job.json"), "utf8"), original);
  const resumed = startJob({
    cwd,
    resumeJobId: jobId,
    requestId: randomUUID(),
  });
  jobs.push(resumed);
  assert.equal(S.read(resumed.jobId).prompt, savedPrompt);
  assert.equal((await done(resumed)).threadId, diagnosed.threadId);
});

test("different worktree paths with identical config share the original project's runtime block", () => {
  const cwd = project(),
    worktree1 = project(),
    worktree2 = project(),
    binary = resolveCodex();
  for (const dir of [cwd, worktree1, worktree2]) {
    fs.mkdirSync(path.join(dir, ".codex"));
    fs.writeFileSync(
      path.join(dir, ".codex", "config.toml"),
      "# identical project config\n",
    );
  }
  const original = inspectRuntime(binary, cwd),
    first = inspectRuntime(binary, worktree1),
    second = inspectRuntime(binary, worktree2);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.fingerprint, original.fingerprint);
  recordFailure(cwd, first, { code: "sandbox_setup_failed" }, false);
  const before = calls(),
    blocked = probeRuntime(binary, second, cwd, { executionCwd: worktree2 });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.cached, true);
  assert.equal(calls(), before);
});
