import { buildStateCard } from "../scripts/lead-state.mjs";
import { guardFixture } from "./fixture-lifetime.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import * as S from "../scripts/store.mjs";
import * as R from "../scripts/runtime.mjs";
import { git, snapshot, hash } from "../scripts/git.mjs";
import { profileTool, loadProfile, templates } from "../scripts/profile.mjs";
import {
  scan,
  glob,
  digest,
  identity,
  textMeta,
} from "../scripts/policy-core.mjs";
import {
  classify,
  grows,
  contextPacks,
  expandCriteria,
} from "../scripts/policy-checks.mjs";
import {
  parseLcov,
  coverageChecks,
  allowCommand,
  countLogs,
} from "../scripts/gates.mjs";
import { reportTool, pushTool, hygieneTool } from "../scripts/delivery.mjs";
import { recordUsage, usageSummary } from "../scripts/evidence-budget.mjs";
import { handoffTool } from "../scripts/continuity.mjs";
import { batchTool } from "../scripts/batch.mjs";
import { prepareBranch } from "../scripts/delivery.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-team-v112-"));
process.env.CODEX_TEAM_STATE = path.join(root, "state");
process.env.CODEX_TEAM_CODEX = fileURLToPath(
  new URL("./fake-codex.mjs", import.meta.url),
);
let seq = 0;
const jobs = [];
function project(components = {}, extra = {}) {
  const cwd = path.join(root, "project-" + ++seq);
  fs.mkdirSync(cwd);
  git(cwd, ["init", "--quiet", "-b", "main"]);
  git(cwd, ["config", "user.name", "Fixture"]);
  git(cwd, ["config", "user.email", "fixture@example.invalid"]);
  git(cwd, ["config", "commit.gpgsign", "false"]);
  fs.mkdirSync(path.join(cwd, ".codex-team"));
  fs.writeFileSync(
    path.join(cwd, ".gitignore"),
    ".artifacts/\n.codex-team/profile.local.json\n.codex-team/handoff/\n",
  );
  fs.writeFileSync(path.join(cwd, "existing.txt"), "existing\n");
  fs.writeFileSync(
    path.join(cwd, ".codex-team/profile.json"),
    JSON.stringify({
      profileVersion: 1,
      name: "fixture",
      components,
      ...extra,
    }),
  );
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-qm", "fixture"]);
  return fs.realpathSync(cwd);
}
function approve(cwd, args = {}) {
  const read = profileTool({ cwd, ...args });
  return profileTool({
    cwd,
    ...args,
    action: "approve",
    expectedHash: read.profile.hash,
  }).profile;
}
function assignment(extra = {}) {
  return {
    objective: "WRITE_CODE Create answer.mjs",
    scope: ["answer.mjs"],
    acceptanceCriteria: ["answer is 42"],
    verification: [
      {
        id: "answer",
        command: process.execPath, allowInline: true,
        args: [
          "--input-type=module",
          "-e",
          "import {answer} from './answer.mjs'; if(answer!==42)process.exit(1);",
        ],
        timeoutSeconds: 10,
      },
    ],
    ...extra,
  };
}
function start(cwd, extra = {}) {
  const j = R.startJob({ autoVerify: false,
    cwd,
    assignment: assignment(),
    requestId: randomUUID(),
    ...extra,
  });
  jobs.push(j);
  return j;
}
async function done(job) {
  const result = await R.statusJob({
    cwd: job.cwd,
    jobId: job.jobId,
    waitSeconds: 30,
  });
  assert.ok(!S.active.has(result.status), JSON.stringify(result));
  return result;
}
async function accept(
  job,
  evidence = [
    {
      criterionIndex: 0,
      checkId: "answer",
      observation: "Read and verified the exported value.",
    },
  ],
) {
  const finished = await done(job);
  assert.equal(finished.status, finished.autoVerify && !finished.autoVerifySkipped ? "verified" : "implementation_finished");
  R.verifyJob({ cwd: job.cwd, jobId: job.jobId });
  const verified = await done(job);
  assert.equal(verified.status, "verified", JSON.stringify(verified));
  return R.reviewJob({
    cwd: job.cwd,
    jobId: job.jobId,
    action: "accept",
    summary: "Implement the answer",
    evidence,
  });
}
after(async () => {
  for (const j of jobs)
    try {
      R.cancelJob({ cwd: j.cwd, jobId: j.jobId });
      await done(j);
    } catch {}
  S.closeStores();
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith("codex-team-v112-"));
  fs.rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
});

test("profiles require exact approval, reject unknown fields, and local policy cannot weaken", () => {
  const cwd = project({
    budget: { level: "enforce", perJob: { inputTokens: 100 } },
  });
  assert.throws(() => start(cwd), /not approved/);
  const p = approve(cwd);
  assert.ok(p.hash);
  assert.throws(
    () => profileTool({ cwd, action: "approve", expectedHash: "stale" }),
    /exact/,
  );
  fs.writeFileSync(
    path.join(cwd, ".codex-team/profile.local.json"),
    JSON.stringify({ components: { budget: { level: "advise" } } }),
  );
  assert.throws(() => loadProfile(cwd), /weakens/);
  fs.writeFileSync(
    path.join(cwd, ".codex-team/profile.local.json"),
    JSON.stringify({
      components: { budget: { level: "enforce", perJob: { inputTokens: 50 } } },
    }),
  );
  assert.notEqual(loadProfile(cwd).hash, p.hash);
  assert.throws(
    () =>
      profileTool({
        cwd,
        action: "validate",
        profile: { profileVersion: 1, name: "bad", unknown: true },
      }),
    /Unexpected/,
  );
});
test("complete test logs are counted and oversized logs remain unknown", () => {
  const log = path.join(root, "large-test.log");
  fs.writeFileSync(log, "(pass) test\n".repeat(1500));
  assert.equal(countLogs(log).pass, 1500);
  fs.writeFileSync(log, "x".repeat(8 * 1024 * 1024 + 1));
  assert.equal(countLogs(log).pass, null);
});
test("oversized union assignments fail before any child worktree or job is created", async () => {
  const cwd = project({ parallel: { level: "enforce", maxWorkers: 2 } });
  approve(cwd);
  const before = S.projectJobs(cwd).length;
  const checks = Array.from({ length: 11 }, (_, i) => ({
    id: "check" + i,
    command: process.execPath, allowInline: true,
    args: ["-e", ""],
  }));
  await assert.rejects(
    () =>
      batchTool({
        cwd,
        action: "start",
        requestId: "oversized",
        authorization: "Fixture authorizes two workers",
        assignments: [
          {
            part: "a",
            assignment: assignment({ scope: ["a.mjs"], verification: checks }),
          },
          {
            part: "b",
            assignment: assignment({ scope: ["b.mjs"], verification: checks }),
          },
        ],
      }),
    /Union assignment exceeds/,
  );
  assert.equal(S.projectJobs(cwd).length, before);
  assert.equal(S.extensions("batch").filter((b) => b.cwd === cwd).length, 0);
});
test("clean existing worktrees cannot be silently adopted as plugin-owned", () => {
  const cwd = project({
      branchMode: {
        level: "enforce",
        trunk: "main",
        branchTemplate: "codex/{topic}",
        worktreeDir: ".artifacts/{topic}",
      },
    }),
    target = path.join(cwd, ".artifacts", "external");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  git(cwd, ["worktree", "add", "-b", "codex/external", target, "main"]);
  const profile = approve(cwd, { branch: "codex/external" });
  assert.throws(() => prepareBranch(cwd, profile), /not recorded as owned/);
});
test("ownership precedence, exclusions, new files and token growth are enforced", () => {
  const p = {
    lane: "a",
    components: { ownership: { level: "enforce" } },
    manifest: {
      ownerApproval: ["package.json"],
      appendOnly: ["shared.js"],
      creatable: ["tests/**"],
      lanes: {
        a: { owns: ["src/**"], excludes: ["src/other.js"] },
        b: { owns: ["tests/industry-*", "src/other.js"] },
      },
    },
  };
  assert.equal(
    classify(p, { path: "package.json", status: "M" }).rule,
    "ownerApproval",
  );
  assert.equal(classify(p, { path: "src/a.js", status: "M" }).ok, true);
  assert.equal(
    classify(p, { path: "src/other.js", status: "M" }).rule,
    "otherLane",
  );
  assert.equal(
    classify(p, { path: "tests/new.test.js", status: "A" }).ok,
    true,
  );
  assert.equal(
    classify(p, { path: "tests/industry-a.js", status: "A" }).ok,
    false,
  );
  assert.equal(grows("limit: 70", "limit: 170"), false);
  assert.equal(grows('["old"]', '["old", "new"]'), true);
  assert.equal(
    classify(p, { path: "shared.js", status: "D", removed: [], added: [] }).ok,
    false,
  );
  assert.equal(glob("src/**/*.js", "src/a.js"), true);
});
test("secret scanner supports flags, multiline text and bounded pathological expressions", () => {
  const p = {
    components: {
      secrets: {
        level: "enforce",
        patterns: ["(?i)api_key\\s*=\\s*\\S{16,}", "BEGIN[\\s\\S]*?END"],
        redactInState: true,
      },
    },
  };
  assert.equal(scan("API_KEY=synthetic0000000000000", p).text, "[REDACTED]");
  assert.equal(scan("BEGIN\nsynthetic\nEND", p).count, 1);
  assert.throws(
    () =>
      scan("a".repeat(10000) + "!", {
        components: { secrets: { level: "enforce", patterns: ["(a+)+$"] } },
      }),
    /time bound/,
  );
});
test("profile checks run independently, prevent bypass, and report measured evidence", async () => {
  const cwd = project({
    gates: {
      level: "enforce",
      checks: {
        extra: {
          when: "always",
          allowInline: true, command: [process.execPath, "-e", "console.log('extra checked')"],
        },
      },
    },
    report: {
      level: "enforce",
      template: "builtin:short",
      ownerSummary: { required: true, language: "es-CO" },
      evidenceKinds: ["local"],
      sections: ["files", "tests", "coverage", "deviations"],
    },
  });
  approve(cwd);
  const job = start(cwd);
  await done(job);
  assert.throws(
    () => R.verifyJob({ cwd, jobId: job.jobId, includeProfileChecks: false }),
    /Cannot omit/,
  );
  const result = await accept(job);
  assert.equal(result.status, "accepted");
  const report = reportTool({
    cwd,
    jobId: job.jobId,
    action: "write",
    ownerSummary: "Ahora se obtiene el valor esperado.",
    crossLaneRequests: [],
    openDecisions: [],
    deviations: [],
  });
  assert.match(report.markdown, /extra/);
  assert.equal(report.evidenceKind, "local");
  assert.throws(
    () =>
      reportTool({
        cwd,
        jobId: job.jobId,
        evidenceKind: "production",
        ownerSummary: "Resumen",
        crossLaneRequests: [],
        openDecisions: [],
        deviations: [],
      }),
    /Unsupported/,
  );
});
test("actual out-of-owner uncommitted output fails policy before verification", async () => {
  const cwd = project({
    ownership: { level: "enforce", ownerApproval: ["answer.mjs"] },
  });
  approve(cwd);
  assert.throws(() => start(cwd), /ownerApproval/);
  assert.equal(fs.existsSync(path.join(cwd, "answer.mjs")), false);
});
test("branch commit, report commit and explicit own-branch push preserve parent", async () => {
  const cwd = project({
    branchMode: {
      level: "enforce",
      trunk: "main",
      branchTemplate: "codex/{topic}",
      worktreeDir: ".artifacts/{topic}",
      commit: {
        trailer: "Co-Authored-By: Test <test@example.invalid>",
        stage: "accepted-paths-only",
      },
      push: { allowed: true, onlyOwnBranch: true, requireLeadCall: true },
    },
    report: {
      level: "enforce",
      target: { file: "docs/delivery.md", insert: "append" },
      ownerSummary: { required: true },
      evidenceKinds: ["local"],
    },
  });
  approve(cwd, { branch: "codex/answer" });
  const before = snapshot(cwd);
  const job = start(cwd, { branch: "codex/answer" });
  await accept(job);
  const beforeCommit = S.read(job.jobId);
  git(beforeCommit.executionCwd, ["switch", "-c", "codex/unrelated"]);
  assert.throws(
    () => R.integrateJob({ cwd, jobId: job.jobId }),
    /recorded own branch/,
  );
  git(beforeCommit.executionCwd, ["switch", "codex/answer"]);
  const committed = R.integrateJob({
    cwd,
    jobId: job.jobId,
    commitMessage: "feat: add answer",
  });
  assert.ok(committed.delivery.implementationCommit);
  S.transaction(() => S.save(beforeCommit)); // Simulate a crash after Git commit but before the state transaction commits.
  assert.equal(
    R.integrateJob({ cwd, jobId: job.jobId, commitMessage: "feat: add answer" })
      .delivery.implementationCommit,
    committed.delivery.implementationCommit,
  );
  assert.throws(
    () =>
      pushTool({
        cwd,
        jobId: job.jobId,
        expectedCommit: committed.delivery.implementationCommit,
      }),
    /Complete/,
  );
  const args = {
    cwd,
    jobId: job.jobId,
    action: "write",
    ownerSummary: "El resultado esperado está disponible.",
    crossLaneRequests: [],
    openDecisions: [],
    deviations: [],
    expectedTargetHash: hash(Buffer.alloc(0)),
  };
  const beforeReport = S.read(job.jobId);
  const report = reportTool(args);
  assert.notEqual(report.commit, committed.delivery.implementationCommit);
  assert.deepEqual(reportTool(args), report);
  S.transaction(() => S.save(beforeReport)); // Simulate completed report commit with a rolled-back SQLite transaction.
  assert.equal(reportTool(args).commit, report.commit);
  assert.equal(
    git(committed.executionCwd, ["rev-list", "--count", "HEAD"]).stdout.trim(),
    "3",
  );
  assert.equal(snapshot(cwd).fingerprint, before.fingerprint);
  const remote = path.join(root, "remote.git");
  fs.mkdirSync(remote);
  git(remote, ["init", "--bare", "--quiet"]);
  git(cwd, ["remote", "add", "origin", remote]);
  assert.equal(git(cwd, ["remote", "get-url", "origin"]).stdout.trim(), remote);
  assert.throws(() => pushTool({ cwd, jobId: job.jobId, expectedCommit: report.commit }), /hostAck/);
  const refreshed = await R.statusJob({ cwd, jobId: job.jobId, refresh: true });
  assert.equal(refreshed.gitConfigChanged.changed, true);
  assert.deepEqual(refreshed.gitConfigChanged.paths.sort(), ["config", "effectiveConfig"]);
  assert.equal(
    pushTool({ cwd, jobId: job.jobId, expectedCommit: report.commit, hostAck: refreshed.reviewFingerprint }).commit,
    report.commit,
  );
  assert.notEqual(
    git(remote, ["show-ref", "--verify", "refs/heads/main"], true).status,
    0,
  );
});
test("usage is deduplicated and cached input is not double counted", () => {
  const cwd = project({
    budget: {
      level: "enforce",
      perJob: { inputTokens: 20 },
      timezone: "America/Bogota",
    },
  });
  const profile = approve(cwd),
    state = { profile, jobId: randomUUID(), taskId: randomUUID() };
  const event = {
    id: "usage-1",
    usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 2 },
  };
  recordUsage(state, event, 0);
  recordUsage(state, event, 0);
  const result = usageSummary(state);
  assert.equal(result.task.inputTokens, 20);
  assert.equal(result.task.cachedInputTokens, 5);
  assert.equal(result.exceeded.length, 0);
  assert.equal(result.atLimit.length, 1);
  assert.equal(result.estimatedTaskCost, undefined);
});
test("observed usage exhausts an enforced worker budget and does not accept the job", async () => {
  const cwd = project({
    budget: { level: "enforce", perJob: { inputTokens: 5 } },
  });
  approve(cwd);
  const result = await done(start(cwd));
  assert.equal(result.status, "budget_exhausted");
  assert.equal(result.budget.task.inputTokens, 10);
});
test("secret output is redacted from persistent logs and blocks acceptance", async () => {
  const cwd = project({
    secrets: {
      level: "enforce",
      patterns: ["SYNTHETIC_SECRET_[A-Z0-9]+"],
      redactInState: true,
      scan: ["workerLog", "report", "diff", "commitMessage"],
    },
  });
  approve(cwd);
  const job = start(cwd, {
      assignment: assignment({ objective: "WRITE_CODE EMIT_SECRET" }),
    }),
    result = await done(job);
  assert.equal(
    result.status,
    "secret_access_suspected",
    JSON.stringify(result),
  );
  for (const name of fs.readdirSync(S.jobDir(job.jobId))) {
    const file = path.join(S.jobDir(job.jobId), name);
    if (fs.statSync(file).isFile())
      assert.ok(
        !fs
          .readFileSync(file)
          .includes(Buffer.from("SYNTHETIC_SECRET_123456789")),
        name,
      );
  }
});
test("tagged UI criterion remains pending until required leader evidence arrives", async () => {
  const cwd = project({
    leadEvidence: {
      level: "enforce",
      kinds: {
        browser: {
          requiredFields: [
            "tool",
            "url",
            "viewports",
            "consoleErrors",
            "failedRequests",
            "attachments",
          ],
          allowedTools: ["chrome-devtools-mcp"],
          viewports: ["390x844"],
        },
      },
      requireForCriteriaTagged: { ui: "browser" },
    },
  });
  approve(cwd);
  const job = start(cwd, {
    assignment: assignment({
      acceptanceCriteria: [{ text: "Screen works", tags: ["ui"] }],
    }),
  });
  const result = await accept(job);
  assert.equal(result.status, "pending_lead_evidence");
  fs.mkdirSync(path.join(cwd, ".artifacts"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".artifacts/browser.json"),
    JSON.stringify({ fixture: true, viewport: "390x844" }),
  );
  R.verifyJob({ cwd, jobId: job.jobId });
  assert.equal((await done(job)).status, "verified");
  const accepted = R.reviewJob({
    cwd,
    jobId: job.jobId,
    action: "accept",
    summary: "Fixture UI evidence recorded.",
    evidence: [
      {
        criterionIndex: 0,
        observation: "Recorded fixture observation.",
        leadObservation: {
          kind: "browser",
          tool: "chrome-devtools-mcp",
          url: "http://localhost/fixture",
          viewports: ["390x844"],
          consoleErrors: [],
          failedRequests: [],
          attachments: [".artifacts/browser.json"],
        },
      },
    ],
  });
  assert.equal(accepted.status, "accepted");
  const attachment =
    accepted.reviews.at(-1).evidence[0].leadObservation.attachments[0];
  fs.writeFileSync(attachment.path, "tampered fixture evidence");
  assert.equal(
    (await R.statusJob({ cwd, jobId: job.jobId })).acceptanceCurrent,
    null,
  );
});
test("context packs, tagged templates and branch handoff preserve notes without approvals", () => {
  const cwd = project({
    context: {
      level: "enforce",
      packs: { rules: { docs: ["existing.txt"], maxChars: 100 } },
      alwaysInclude: ["rules"],
    },
    criteria: {
      level: "enforce",
      templates: {
        screen: {
          suggestWhen: "always",
          criteria: [{ text: "UI checked", tags: ["ui"] }],
        },
      },
    },
    continuity: { level: "advise", contextKey: "branch", handoffFile: "handoff.md", tracked: true },
  });
  const p = approve(cwd);
  assert.match(contextPacks(p, cwd).docs[0].text, /existing/);
  assert.throws(() => expandCriteria(p, assignment()), /requires inclusion/);
  assert.equal(
    expandCriteria(p, assignment(), ["screen"]).assignment.acceptanceCriteria
      .length,
    2,
  );
  R.contextJob({
    cwd,
    action: "update",
    expectedVersion: 0,
    decisions: ["Use synthetic fixtures."],
    nextSteps: ["Verify."],
  });
  // Legacy context rows may contain an old derived card: neither export nor
  // handoff files may forward it to another model/session.
  const contextRow = S.db().prepare("SELECT cwd,data FROM contexts ORDER BY rowid DESC LIMIT 1").get();
  S.db().prepare("UPDATE contexts SET data=? WHERE cwd=?").run(JSON.stringify({ ...JSON.parse(contextRow.data), stateCard: "C:/private/wait.mjs", stateCardContextKey: "legacy" }), contextRow.cwd);
  const exported = handoffTool({ cwd, action: "export" });
  assert.doesNotMatch(exported.text, /stateCard|private\/wait/);
  const written = handoffTool({ cwd, action: "export", write: true, expectedTargetHash: hash(Buffer.alloc(0)) });
  assert.doesNotMatch(fs.readFileSync(written.file, "utf8"), /stateCard|private\/wait/);
  const imported = handoffTool({
    cwd,
    action: "import",
    text: exported.text.replaceAll("Use synthetic fixtures.", "Imported decision needs confirmation."),
    expectedVersion: 1,
  });
  assert.equal(imported.context.version, 2);
  assert.ok(imported.context.importedNotes.every(note => note.imported === true));
  assert.doesNotMatch(buildStateCard(imported.context), /Imported decision needs confirmation/);
  const confirmed = R.contextJob({ cwd, action: "update", expectedVersion: 2, confirmImported: imported.context.importedNotes.map((_, i) => i) });
  assert.deepEqual(confirmed.context.importedNotes, []);
  assert.match(buildStateCard(confirmed.context), /Imported decision needs confirmation/);
  assert.match(imported.notice, /No approvals/);
});
test("text format check and explicit fix preserve CRLF baseline and invalidate verification", async () => {
  const cwd = project({
    textHygiene: {
      level: "enforce",
      lineEndings: "preserve",
      encoding: "utf-8",
      bom: "preserve",
      finalNewline: "preserve",
    },
  });
  fs.writeFileSync(
    path.join(cwd, "answer.mjs"),
    "export const answer = 1;\r\n",
  );
  git(cwd, ["add", "answer.mjs"]);
  git(cwd, ["commit", "-qm", "baseline text"]);
  approve(cwd);
  const job = start(cwd);
  await done(job);
  assert.throws(() => R.verifyJob({ cwd, jobId: job.jobId }), /Line endings/);
  const check = hygieneTool({ cwd, jobId: job.jobId, action: "check" });
  hygieneTool({
    cwd,
    jobId: job.jobId,
    action: "fix",
    expectedFingerprint: check.fingerprint,
  });
  assert.equal(
    textMeta(fs.readFileSync(path.join(cwd, "answer.mjs"))).eol,
    "crlf",
  );
  R.verifyJob({ cwd, jobId: job.jobId });
  assert.equal((await done(job)).status, "verified");
});
test("LCOV missing totals are not invented and forbidden commands are rejected", () => {
  const records = parseLcov(
    "SF:answer.mjs\nDA:1,1\nFNF:2\nFNH:1\nend_of_record\n",
    root,
  );
  assert.equal(records[0].fnf, 2);
  assert.equal(records[0].fnh, 1);
  assert.throws(
    () => parseLcov("SF:answer.mjs\nFNF:1\nFNH:2\n", root),
    /exceed/,
  );
  assert.throws(
    () =>
      allowCommand(
        {
          components: {
            gates: {
              level: "enforce",
              neverRun: [
                {
                  command: ["scripts/check.js"],
                  reason: "Reserved for integration.",
                },
              ],
            },
          },
        },
        [process.execPath, "scripts/check.js"],
      ),
    /forbidden/,
  );
});
test("batch overlap is rejected before any worker launch", async () => {
  const cwd = project({ parallel: { level: "advise", maxWorkers: 3 } });
  approve(cwd);
  await assert.rejects(
    batchTool({
      cwd,
      action: "start",
      requestId: "overlap",
      authorization: "Fixture explicitly requests two fake workers.",
      assignments: [
        { part: "one", assignment: assignment() },
        { part: "two", assignment: assignment() },
      ],
    }),
    /overlap/,
  );
});
test("two isolated children integrate into a union that must be verified again", async () => {
  const cwd = project({
    parallel: { level: "advise", maxWorkers: 2 },
    gates: { level: "enforce", maxParallelChecks: 1, checks: {} },
  });
  approve(cwd);
  const second = assignment({
    objective: "WRITE_SECOND",
    scope: ["second.mjs"],
    acceptanceCriteria: ["second is 7"],
    verification: [
      {
        id: "second",
        command: process.execPath, allowInline: true,
        args: [
          "--input-type=module",
          "-e",
          "import {second} from './second.mjs';if(second!==7)process.exit(1);",
        ],
        timeoutSeconds: 10,
      },
    ],
  });
  const batch = await batchTool({
    cwd,
    action: "start",
    requestId: "two-children",
    authorization: "The fixture requests two isolated fake workers.",
    assignments: [
      { part: "one", assignment: assignment() },
      { part: "two", assignment: second },
    ],
  });
  for (const [index, child] of batch.children.entries()) {
    const job = { cwd: child.cwd, jobId: child.jobId };
    jobs.push(job);
    await accept(job, [
      {
        criterionIndex: 0,
        checkId: index ? "second" : "answer",
        observation: "Executed the isolated assertion.",
      },
    ]);
  }
  assert.equal(fs.existsSync(path.join(cwd, "answer.mjs")), false);
  for (const child of batch.children)
    assert.equal((await R.statusJob({ cwd: child.cwd, jobId: child.jobId })).acceptanceCurrent, null);
  // Integration must check all children itself, before applying even the first current child.
  const staleChild = batch.children[1];
  const staleFile = path.join(S.read(staleChild.jobId).executionCwd, "second.mjs");
  const acceptedBytes = fs.readFileSync(staleFile);
  fs.appendFileSync(staleFile, "\n// changed after acceptance\n");
  try {
    await assert.rejects(batchTool({ cwd, action: "integrate", batchId: batch.batchId }), error => {
      assert.match(error.message, /is stale/);
      assert.ok(error.message.includes(staleChild.jobId), "stale error identifies the child job");
      return true;
    });
    assert.equal(fs.existsSync(path.join(cwd, "answer.mjs")), false, "no child is integrated before all currency checks pass");
    assert.equal(S.extension("batch", batch.batchId).integrated.length, 0);
  } finally { fs.writeFileSync(staleFile, acceptedBytes); }
  const merged = await batchTool({
    cwd,
    action: "integrate",
    batchId: batch.batchId,
  });
  assert.equal(merged.status, "awaiting_union_verification");
  const job = { cwd, jobId: merged.unionJobId };
  assert.equal(S.read(job.jobId).hiddenChanges.status, "unavailable");
  assert.equal(S.readRaw(job.jobId).hiddenBaseline, undefined);
  assert.equal(S.read(job.jobId).baselineBytesUnavailableReason, "batch-union-baseline-bytes-not-captured-before-integration");
  jobs.push(job);
  assert.equal(S.read(job.jobId).status, "implementation_finished");
  const accepted = await accept(job, [
    {
      criterionIndex: 0,
      checkId: "part0-answer",
      observation: "Verified combined result.",
    },
    {
      criterionIndex: 1,
      checkId: "part1-second",
      observation: "Verified combined result.",
    },
  ]);
  assert.equal(accepted.status, "accepted");
  assert.equal(
    (await batchTool({ cwd, action: "integrate", batchId: batch.batchId }))
      .unionJobId,
    job.jobId,
  );
});
test("coverage combines lines but never adds anonymous function hits across runs", () => {
  const cwd = project({});
  fs.writeFileSync(
    path.join(cwd, "policy.json"),
    JSON.stringify({
      policyVersion: 1,
      minimumPercent: { lines: 70, functions: 70 },
      groups: [{ id: "core", paths: ["answer.mjs"] }],
    }),
  );
  fs.writeFileSync(path.join(cwd, "answer.mjs"), "export const answer = 42;\n");
  const one = path.join(root, "one.lcov"),
    two = path.join(root, "two.lcov");
  fs.writeFileSync(
    one,
    "SF:answer.mjs\nDA:1,1\nDA:2,0\nFNF:2\nFNH:1\nend_of_record\n",
  );
  fs.writeFileSync(
    two,
    "SF:answer.mjs\nDA:1,0\nDA:2,1\nFNF:2\nFNH:1\nend_of_record\n",
  );
  const state = { cwd, executionCwd: cwd, profile: { components: {} } };
  const plan = {
    changed: ["answer.mjs"],
    coverage: [{ id: "coverage", level: "enforce", policy: "policy.json" }],
  };
  const result = coverageChecks(
    state,
    plan,
    [
      { coveragePath: one, status: "passed" },
      { coveragePath: two, status: "passed" },
    ],
    snapshot(cwd),
  )[0];
  assert.equal(result.coverage.files[0].lines.percent, 100);
  assert.equal(result.coverage.files[0].functions.percent, 50);
  assert.equal(result.status, "failed");
  assert.equal(
    coverageChecks(state, plan, [], snapshot(cwd))[0].status,
    "failed",
  );
});
test("a required check retries one timeout in isolation and preserves both attempts", async () => {
  const marker = path.join(root, "retry-marker").replaceAll("\\", "/");
  const code =
    `(${guardFixture.toString()})();` +
    "const fs=require('fs');if(!fs.existsSync(" +
    JSON.stringify(marker) +
    ")){fs.writeFileSync(" +
    JSON.stringify(marker) +
    ",'first');setInterval(()=>{},1000)}";
  const cwd = project({
    gates: {
      level: "enforce",
      retryOnTimeout: 1,
      maxParallelChecks: 1,
      checks: {
        retry: {
          allowInline: true,
          when: "always",
          command: [process.execPath, "-e", code],
          timeoutSeconds: 5,
        },
      },
    },
  });
  approve(cwd);
  const job = start(cwd);
  await done(job);
  R.verifyJob({ cwd, jobId: job.jobId });
  const result = await done(job);
  assert.equal(result.status, "verified", JSON.stringify(result));
  const check = result.verification.checks.find(
    (c) => c.id === "profile-retry",
  );
  assert.equal(check.attempts.length, 2);
  assert.equal(check.attempts[0].stopReason, "timed_out");
  assert.equal(check.attempts[1].code, 0);
});
test("append-only checks use actual removed lines, not unchanged duplicate lines", async () => {
  const cwd = project({
    ownership: { level: "enforce", shared: ["shared.mjs"] },
  });
  fs.writeFileSync(
    path.join(cwd, "shared.mjs"),
    "// retain\n// retain\nexport const answer = 42;\n",
  );
  git(cwd, ["add", "shared.mjs"]);
  git(cwd, ["commit", "-qm", "shared baseline"]);
  const head = snapshot(cwd).head;
  approve(cwd);
  const job = start(cwd, {
    assignment: assignment({
      objective: "WRITE_TARGET=shared.mjs",
      scope: ["shared.mjs"],
    }),
  });
  await done(job);
  assert.equal(snapshot(cwd).head, head);
  assert.throws(() => R.verifyJob({ cwd, jobId: job.jobId }), /appendOnly/);
});
test("owner authorization is distinct from technical profile approval", async () => {
  const cwd = project({
      ownership: { level: "enforce", ownerApproval: ["answer.mjs"] },
    }),
    profile = approve(cwd);
  assert.throws(() => start(cwd), /ownerApproval/);
  profileTool({
    cwd,
    action: "approve",
    expectedHash: profile.hash,
    ownerApprovals: [
      {
        path: "answer.mjs",
        quote: "The fixture owner authorizes this exact file on this branch.",
        date: "2026-09-27",
      },
    ],
  });
  const job = start(cwd);
  assert.equal((await accept(job)).status, "accepted");
});
test("escaped multiline JSON events are decoded before persistent redaction", async () => {
  const cwd = project({
    secrets: {
      level: "enforce",
      patterns: ["BEGIN\\n[^\\n]+\\nEND"],
      redactInState: true,
    },
  });
  approve(cwd);
  const job = start(cwd, {
    assignment: assignment({ objective: "WRITE_CODE EMIT_MULTILINE" }),
  });
  assert.equal((await done(job)).status, "secret_access_suspected");
  assert.ok(
    !fs
      .readFileSync(path.join(S.jobDir(job.jobId), "events.jsonl"), "utf8")
      .includes("SYNTHETIC_MULTILINE_PAYLOAD"),
  );
  assert.ok(
    !JSON.stringify(S.read(job.jobId)).includes("SYNTHETIC_MULTILINE_PAYLOAD"),
  );
});
test("named branch batches preserve the main checkout and verify their combined commits", async () => {
  const cwd = project({
    branchMode: {
      level: "enforce",
      trunk: "main",
      branchTemplate: "codex/{topic}",
      worktreeDir: ".artifacts/{topic}",
      push: { allowed: false, onlyOwnBranch: true, requireLeadCall: true },
    },
    parallel: {
      level: "advise",
      maxWorkers: 2,
      prewire: { required: true, sharedFiles: [] },
    },
  });
  approve(cwd, { branch: "codex/parent" });
  const original = snapshot(cwd);
  const prewire = start(cwd, { branch: "codex/parent" });
  await accept(prewire);
  const parent = R.integrateJob({ cwd, jobId: prewire.jobId });
  const assignmentFor = (file, id) =>
    assignment({
      objective: "WRITE_TARGET=" + file,
      scope: [file],
      verification: [
        {
          id,
          command: process.execPath, allowInline: true,
          args: [
            "--input-type=module",
            "-e",
            "import {answer} from './" +
              file +
              "';if(answer!==42)process.exit(1);",
          ],
          timeoutSeconds: 10,
        },
      ],
    });
  const batch = await batchTool({
    cwd: parent.executionCwd,
    action: "start",
    requestId: "named-children",
    prewireJobId: prewire.jobId,
    authorization: "The fixture requests two branch workers.",
    assignments: [
      { part: "second", assignment: assignmentFor("second.mjs", "second") },
      { part: "third", assignment: assignmentFor("third.mjs", "third") },
    ],
  });
  for (const [i, child] of batch.children.entries()) {
    const job = { cwd: child.cwd, jobId: child.jobId };
    jobs.push(job);
    await accept(job, [
      {
        criterionIndex: 0,
        checkId: i ? "third" : "second",
        observation: "Verified the child result.",
      },
    ]);
    R.integrateJob(job);
    assert.equal((await R.statusJob(job)).acceptanceCurrent, null);
  }
  const beforeMerge = S.extension("batch", batch.batchId);
  let merged = await batchTool({
    cwd: parent.executionCwd,
    action: "integrate",
    batchId: batch.batchId,
  });
  const afterMerge = snapshot(parent.executionCwd);
  S.transaction(() => {
    S.db().prepare("DELETE FROM jobs WHERE id=?").run(merged.unionJobId);
    S.setExtension("batch", batch.batchId, beforeMerge);
  });
  merged = await batchTool({
    cwd: parent.executionCwd,
    action: "integrate",
    batchId: batch.batchId,
  });
  assert.equal(
    snapshot(parent.executionCwd).fingerprint,
    afterMerge.fingerprint,
  );
  const union = { cwd: parent.executionCwd, jobId: merged.unionJobId };
  jobs.push(union);
  assert.ok(union.jobId, JSON.stringify(merged));
  const accepted = await accept(union, [
    {
      criterionIndex: 0,
      checkId: "part0-second",
      observation: "Verified union.",
    },
    {
      criterionIndex: 1,
      checkId: "part1-third",
      observation: "Verified union.",
    },
  ]);
  assert.equal(accepted.status, "accepted");
  assert.equal(snapshot(cwd).fingerprint, original.fingerprint);
});
