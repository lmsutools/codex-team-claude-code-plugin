/** Isolated projects and fake CLI lifecycle helpers for Job B contract tests. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { after } from "node:test";
import assert from "node:assert/strict";
import * as S from "../scripts/store.mjs";
import * as R from "../scripts/runtime.mjs";
import { git } from "../scripts/git.mjs";
import { profileTool } from "../scripts/profile.mjs";
export { S, R };
export function fixture(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `codex-team-${name}-`));
  process.env.CODEX_TEAM_STATE = path.join(root, "state");
  process.env.CODEX_TEAM_CODEX = fileURLToPath(new URL("./fake-codex.mjs", import.meta.url));
  process.env.CODEX_HOME = path.join(root, "codex");
  fs.mkdirSync(process.env.CODEX_HOME);
  let sequence = 0;
  function project(components) {
    const cwd = path.join(root, "project-" + ++sequence);
    fs.mkdirSync(cwd);
    git(cwd, ["init", "--quiet", "-b", "main"]);
    fs.writeFileSync(path.join(cwd, "existing.txt"), "Baseline input\n");
    if (components) {
      fs.mkdirSync(path.join(cwd, ".codex-team"));
      fs.writeFileSync(path.join(cwd, ".codex-team/profile.json"), JSON.stringify({ profileVersion: 1, name: "fixture", components }));
    }
    fs.writeFileSync(path.join(cwd, "answer.mjs"), "");
    git(cwd, ["add", "."]);
    git(cwd, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]);
    return fs.realpathSync(cwd);
  }
  function approve(cwd, extra = {}) {
    const { profile } = profileTool({ cwd, ...extra });
    return profileTool({ cwd, ...extra, action: "approve", expectedHash: profile.hash }).profile;
  }
  const assignment = extra => ({ objective: "Explore the answer module", scope: ["answer.mjs"], acceptanceCriteria: ["answer is 42"],
    verification: [{ id: "answer", allowInline: true, criteria: [0], command: process.execPath, args: ["-e", "process.exit(0)"], timeoutSeconds: 10 }], ...extra });
  const start = (cwd, extra = {}) => R.startJob({ autoVerify: false, cwd, requestId: randomUUID(), assignment: assignment(), ...extra });
  async function done(job) {
    const state = await R.statusJob({ cwd: job.cwd, jobId: job.jobId, waitSeconds: 30 });
    assert.ok(!S.active.has(state.status), JSON.stringify(state));
    const end = Date.now() + 10000;
    while (S.readRaw(job.jobId).supervisorPid && Date.now() < end) await new Promise(r => setTimeout(r, 25));
    return state;
  }
  const evidence = [{ criterionIndex: 0, checkId: "answer", observation: "Inspected and checked" }];
  const accept = (job, extra = {}) => R.reviewJob({ cwd: job.cwd, jobId: job.jobId, action: "accept", summary: "Reviewed", evidence, ...extra });
  after(() => {
    S.closeStores();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith(`codex-team-${name}-`));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { root, project, approve, assignment, start, done, evidence, accept };
}
