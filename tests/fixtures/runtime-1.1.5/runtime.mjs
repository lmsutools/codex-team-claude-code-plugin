import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as S from "./store.mjs";
import * as C from "./contracts.mjs";
import * as D from "./diagnostics.mjs";
import { git, snapshot, changes, hash, integrateFiles } from "./git.mjs";
import * as P from "./profile.mjs";
import * as PC from "./policy-core.mjs";
import * as Q from "./policy-checks.mjs";
import * as G from "./gates.mjs";
import * as E from "./evidence-budget.mjs";
import { prepareBranch, commitJob } from "./delivery.mjs";
import { contextKey } from "./continuity.mjs";
export { workspace, stateRoot } from "./store.mjs";
const self = fileURLToPath(import.meta.url);
const VERSION = "1.1.5";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const artifact = (id, name) => path.join(S.jobDir(id), name);
export function recordWorkerFault(jobId, error, stage) {
  // Detached workers have no terminal. Retain a bounded, redacted diagnostic
  // even when an asynchronous state write or the worker's catch handler fails.
  try {
    let profile;
    try {
      profile = S.read(jobId).profile;
    } catch {}
    let message =
      "Internal worker failure; diagnostic redaction was unavailable.";
    try {
      message = PC.scan(
        String(error?.message || error).slice(0, 2000),
        profile || P.templates.strict,
      ).text;
    } catch {}
    const code = error?.cause?.code || error?.code;
    const category = [
      "ERR_SCRIPT_EXECUTION_TIMEOUT",
      "ERR_SQLITE_ERROR",
      "SQLITE_BUSY",
      "ENOSPC",
      "EACCES",
      "EPERM",
    ].includes(code)
      ? code
      : "unclassified";
    const fault = { at: S.now(), stage, message, category };
    fs.writeFileSync(
      artifact(jobId, "worker-fault.json"),
      JSON.stringify(fault),
      { mode: 0o600 },
    );
    return fault;
  } catch {
    return null;
  }
}
const writeJson = (file, value) =>
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
const idFor = (value) => {
  const h = hash(value).slice(0, 32);
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    h.slice(12, 16),
    h.slice(16, 20),
    h.slice(20),
  ].join("-");
};

export function resolveCodex() {
  const configured = process.env.CODEX_TEAM_CODEX;
  if (configured && !path.isAbsolute(configured))
    throw new Error("CODEX_TEAM_CODEX must be an absolute executable path.");
  const candidates = configured
    ? [configured]
    : [
        ...(process.env.PATH || "")
          .split(path.delimiter)
          .filter(Boolean)
          .map((p) =>
            path.join(p, process.platform === "win32" ? "codex.exe" : "codex"),
          ),
        path.join(
          os.homedir(),
          ".local",
          "bin",
          process.platform === "win32" ? "codex.exe" : "codex",
        ),
        ...(process.platform === "win32"
          ? [
              path.join(
                process.env.APPDATA ||
                  path.join(os.homedir(), "AppData", "Roaming"),
                "npm",
                "node_modules",
                "@openai",
                "codex",
                "bin",
                "codex.js",
              ),
            ]
          : []),
      ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
    if (/\.(cmd|bat|ps1)$/i.test(candidate))
      throw new Error("Use codex.exe or codex.js, not a shell shim.");
    return /\.m?js$/i.test(candidate)
      ? { command: process.execPath, prefix: [candidate] }
      : { command: candidate, prefix: [] };
  }
  throw new Error(
    "Codex CLI not found. Install/login or set CODEX_TEAM_CODEX to its absolute executable path.",
  );
}
export function doctor(input = {}) {
  C.object(input, "doctor", ["cwd", "jobId", "probe", "readOnly"]);
  for (const key of ["probe", "readOnly"])
    if (input[key] !== undefined && typeof input[key] !== "boolean")
      throw new Error(key + " must be a boolean.");
  if ((input.probe || input.jobId) && !input.cwd)
    throw new Error("cwd is required for a sandbox probe or job diagnosis.");
  const cwd = input.cwd ? S.workspace(input.cwd) : null;
  const job = input.jobId
    ? S.transaction(() =>
        withHistoricalDiagnosis(S.recover(S.scoped(input.jobId, cwd))),
      )
    : null;
  if (input.probe) S.transaction(() => S.assertIdle(cwd));
  let binary;
  try {
    binary = resolveCodex();
  } catch (e) {
    return {
      available: false,
      authenticated: false,
      readiness: "unavailable",
      error: e.message,
      recovery: D.recovery(cwd, input.jobId),
    };
  }
  const runtime = D.inspectRuntime(
    binary,
    job?.executionCwd || cwd || undefined,
  );
  const check = cwd
    ? input.probe
      ? D.probeRuntime(binary, runtime, cwd, {
          force: true,
          readOnly: input.readOnly ?? job?.readOnly ?? false,
          executionCwd: job?.executionCwd || cwd,
          jobId: input.jobId,
        })
      : D.health(cwd, runtime)
    : null;
  if (check && !input.probe) {
    check.cached = true;
    check.probeExecuted = false;
  }
  const diagnostics = D.sandboxLogs(cwd);
  // Ownership is inspected now, not taken from the record: a repair shows at once.
  const ownership = D.ownershipFor(job?.executionCwd || cwd, [
    ...diagnostics.findings,
    ...(check?.failure?.diagnostics?.probe?.findings || []),
  ]);
  if (ownership) diagnostics.ownership = ownership;
  return {
    ...runtime,
    readiness: !runtime.available
      ? "unavailable"
      : !runtime.authenticated
        ? "authentication_required"
        : check?.status || "untested",
    sandbox: check || { status: "untested", probeExecuted: false },
    diagnostics,
    ...(job ? { job: summary(job) } : {}),
    recovery: D.recovery(cwd, input.jobId, diagnostics),
  };
}
function localOverrides(cwd) {
  const configs = [
    path.join(
      process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
      "config.toml",
    ),
  ];
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    configs.push(path.join(dir, ".codex", "config.toml"));
    if (path.dirname(dir) === dir) break;
  }
  const overrides = new Set(['web_search="disabled"']);
  for (const file of configs)
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
        const mcp = line.match(
          /^\s*\[mcp_servers\.([A-Za-z0-9_-]+|"[^"]+")\]\s*$/,
        );
        const plugin = line.match(/^\s*\[plugins\.("[^"]+")\]\s*$/);
        if (mcp) overrides.add("mcp_servers." + mcp[1] + ".enabled=false");
        if (plugin) overrides.add("plugins." + plugin[1] + ".enabled=false");
      }
    }
  return [...overrides];
}
export function buildArgs(state, report) {
  const args = [
    "exec",
    "--cd",
    state.executionCwd || state.cwd,
    "--sandbox",
    state.readOnly ? "read-only" : "workspace-write",
    "-c",
    'approval_policy="never"',
  ];
  if (state.model) args.push("--model", state.model);
  if (state.effort)
    args.push("-c", "model_reasoning_effort=" + JSON.stringify(state.effort));
  for (const override of state.configOverrides || []) args.push("-c", override);
  if (state.threadId) args.push("resume", state.threadId);
  if (state.assignment)
    args.push("--output-schema", artifact(state.jobId, "report-schema.json"));
  args.push("--json", "--output-last-message", report, "-");
  return args;
}
function normalize(input, previous) {
  C.object(input, "start", [
    "cwd",
    "prompt",
    "assignment",
    "readOnly",
    "resumeJobId",
    "requestId",
    "isolation",
    "timeoutSeconds",
    "maxRevisions",
    "model",
    "effort",
    "workerProfile",
    "branch",
    "topic",
    "lane",
    "contextPacks",
    "criteriaTemplates",
    "criteriaOmissions",
    "batchId",
  ]);
  if (input.readOnly !== undefined && typeof input.readOnly !== "boolean")
    throw new Error("readOnly must be a boolean.");
  const readOnly = input.readOnly ?? previous?.readOnly ?? false;
  if (previous && readOnly !== previous.readOnly)
    throw new Error("A revision must preserve readOnly.");
  const task = input.assignment
    ? C.assignment(input.assignment)
    : previous?.assignment || null;
  const prompt =
    input.prompt === undefined
      ? previous?.status === "blocked_runtime"
        ? (previous.prompt ??
          C.text(
            fs.readFileSync(artifact(previous.jobId, "prompt.txt"), "utf8"),
            "saved prompt",
            200000,
          ))
        : ""
      : C.text(input.prompt, "prompt", 200000);
  if (!task && !prompt) throw new Error("Provide an assignment or prompt.");
  if (task && !input.requestId)
    throw new Error(
      "Structured assignments require a stable requestId for safe retries.",
    );
  const requestId =
    input.requestId === undefined
      ? null
      : C.text(input.requestId, "requestId", 160);
  const isolation = input.isolation ?? previous?.isolation ?? "direct";
  if (!["direct", "worktree"].includes(isolation))
    throw new Error("isolation must be direct or worktree.");
  if (previous && isolation !== (previous.isolation || "direct"))
    throw new Error("A revision must preserve isolation.");
  const workerProfile =
    input.workerProfile ?? previous?.workerProfile ?? "inherit";
  if (!["inherit", "local-code"].includes(workerProfile))
    throw new Error("workerProfile must be inherit or local-code.");
  const model = input.model ?? previous?.model ?? null;
  if (model !== null && !/^[a-zA-Z0-9_.:/-]{1,120}$/.test(model))
    throw new Error("Invalid model identifier.");
  const effort = input.effort ?? previous?.effort ?? null;
  if (
    effort !== null &&
    !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
      effort,
    )
  )
    throw new Error("Invalid reasoning effort.");
  return {
    assignment: task,
    prompt,
    readOnly,
    requestId,
    isolation,
    workerProfile,
    model,
    effort,
    timeoutSeconds: C.integer(
      input.timeoutSeconds ?? previous?.timeoutSeconds ?? 1800,
      "timeoutSeconds",
      1,
      14400,
    ),
    maxRevisions: C.integer(
      input.maxRevisions ?? previous?.maxRevisions ?? 5,
      "maxRevisions",
      0,
      50,
    ),
  };
}
function launch(state, mode) {
  const worker = spawn(process.execPath, [self, mode, state.jobId], {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env: process.env,
    cwd: state.executionCwd || state.cwd,
  });
  worker.on("error", (error) => {
    try {
      S.patch(state.jobId, {
        status: "failed",
        error: error.message,
        finishedAt: S.now(),
      });
    } catch {} // Recovery marks the job interrupted once its heartbeat is stale.
  });
  worker.unref();
  // Waits up to CODEX_TEAM_DB_BUSY_MS for the lock; the worker waits for the
  // launch file below before it trusts the record.
  S.patch(state.jobId, { workerPid: worker.pid, heartbeatAt: S.now() });
  fs.writeFileSync(artifact(state.jobId, "launch"), String(worker.pid));
}
/**
 * Starts (or replays) a job. The database-wide write lock is held for
 * milliseconds only, however large the project:
 *   1. read and validate, without the lock;
 *   2. reserve the project: a short transaction re-checks the request ID,
 *      idleness and capacity, then records a reservation, so two sessions can
 *      never both start in one project;
 *   3. snapshots, worktree and policy capture, without the lock;
 *   4. a short transaction replaces the reservation with the full job.
 * A start that fails after step 2 removes its reservation and leaves no record,
 * as before.
 */
export function startJob(input) {
  const cwd = S.workspace(input.cwd);
  const plan = planStart(input, cwd);
  if (plan.replay) return summary(plan.replay);
  const replay = S.transaction(() => reserveStart(plan, cwd), "start:reserve");
  if (replay) return summary(replay);
  let state;
  try {
    state = S.stageBlobs(prepareStart(plan, cwd));
    S.transaction(() => commitStart(plan, state), "start:commit");
  } catch (e) {
    releaseStart(plan.jobId);
    throw e;
  }
  launch(state, "--worker");
  return summary(state);
}
function planStart(input, cwd) {
  const previous = input.resumeJobId
    ? withHistoricalDiagnosis(S.recover(S.scoped(input.resumeJobId, cwd)))
    : null;
  const options = normalize(input, previous);
  const profile = P.loadProfile(cwd, {
    branch: input.branch || previous?.profile?.branch,
    topic: input.topic,
    lane: input.lane || previous?.profile?.lane,
  });
  if (profile) {
    P.assertApproved(profile);
    if (previous?.status === "budget_exhausted")
      for (const exceeded of previous.budget?.exceeded || []) {
        const next =
          profile.components?.budget?.[exceeded.scope]?.[exceeded.metric];
        if (!Number.isFinite(next) || next <= exceeded.limit)
          throw new Error(
            "Resuming exhausted work requires an authorized increase of its recorded budget limit.",
          );
      }
    if (!options.assignment)
      throw new Error("Profile jobs require a structured assignment.");
    if (PC.enabled(profile, "branchMode")) options.isolation = "worktree";
    if (!previous || input.assignment)
      options.assignment = Q.expandCriteria(
        profile,
        options.assignment,
        input.criteriaTemplates,
        input.criteriaOmissions,
      ).assignment;
  } else if (
    options.assignment?.acceptanceCriteria.some((c) => typeof c !== "string")
  )
    throw new Error("Tagged criteria require a project profile.");
  const requestHash = hash(
    JSON.stringify({
      cwd: S.key(cwd),
      ...options,
      resumeJobId: input.resumeJobId || null,
      ...(profile
        ? {
            profileHash: profile.hash,
            branch: profile.branch,
            contextPacks: input.contextPacks || [],
            criteriaTemplates: input.criteriaTemplates || [],
            criteriaOmissions: input.criteriaOmissions || {},
            batchId: input.batchId || null,
          }
        : {}),
    }),
  );
  const jobId = options.requestId
    ? idFor(S.key(cwd) + "\0" + options.requestId)
    : randomUUID();
  const replay = findReplay(jobId, requestHash);
  if (replay) return { replay };
  // Early, friendly checks; step 2 repeats the ones other sessions can race.
  S.assertIdle(cwd);
  const plan = { input, options, profile, previous, requestHash, jobId };
  checkCapacity(plan, cwd);
  const previousBatch = previous?.batchId
    ? S.extension("batch", previous.batchId)
    : null;
  const unionRevision =
    previousBatch?.unionJobId === previous?.jobId && !!previous;
  if (
    previous &&
    !previous.threadId &&
    previous.status !== "blocked_runtime" &&
    !unionRevision
  )
    throw new Error(
      "Previous job has no Codex thread ID; start a fresh assignment.",
    );
  if (previous) {
    const taskId = previous.taskId || previous.jobId;
    const newest = S.projectJobs(cwd)
      .filter((job) => (job.taskId || job.jobId) === taskId)
      .sort(
        (a, b) =>
          (b.attempt ?? b.revision ?? 0) - (a.attempt ?? a.revision ?? 0) ||
          b.startedAt.localeCompare(a.startedAt),
      )[0];
    if (newest && newest.jobId !== previous.jobId)
      throw new Error(
        `This attempt is superseded. Resume the latest job ${newest.jobId} to preserve review history and revision limits.`,
      );
  }
  const revision = previous
    ? (previous.revision || 0) +
      (previous.status === "blocked_runtime" ? 0 : 1)
    : 0;
  if (revision > options.maxRevisions)
    throw new Error(
      "Revision limit reached. Review the blocker and explicitly increase maxRevisions if authorized.",
    );
  resolveCodex();
  return { ...plan, previousBatch, unionRevision, revision };
}
/** An existing job for this request ID (a transport retry), or null. */
function findReplay(jobId, requestHash) {
  const existing = S.db()
    .prepare("SELECT state FROM jobs WHERE id=?")
    .get(jobId);
  if (!existing) return null;
  const state = JSON.parse(existing.state);
  if (state.requestHash !== requestHash)
    throw new Error(
      "requestId already exists with different inputs. Use a new ID for a new assignment.",
    );
  return { ...S.recover(state), replayed: true };
}
function checkCapacity({ input, previous, profile }, cwd) {
  const occupyingBatch = S.extensions("batch").find(
    (b) =>
      S.key(b.cwd) === S.key(cwd) &&
      [
        "starting",
        "running",
        "conflict",
        "awaiting_union_verification",
      ].includes(b.status) &&
      (input.batchId || previous?.batchId) !== b.batchId,
  );
  if (occupyingBatch)
    throw new Error(
      "Parent worktree is reserved by batch " +
        occupyingBatch.batchId +
        ". Finish or reconcile that batch first.",
    );
  if (profile && PC.enabled(profile, "parallel")) {
    const running = S.db()
      .prepare("SELECT state FROM jobs")
      .all()
      .map((r) => JSON.parse(r.state))
      .filter(
        (j) =>
          j.profile?.repoId === profile.repoId &&
          ["starting", "running"].includes(S.recover(j).status),
      );
    if (running.length >= (profile.components.parallel.maxWorkers || 3))
      throw new Error(
        "Shared worker limit reached; poll existing jobs before starting another.",
      );
  }
}
/** Step 2, inside the transaction: database reads and one small write only. */
function reserveStart(plan, cwd) {
  const replay = findReplay(plan.jobId, plan.requestHash);
  if (replay) return replay;
  S.assertIdle(cwd);
  checkCapacity(plan, cwd);
  const { options, profile, previous, jobId } = plan;
  plan.startedAt = S.now();
  S.save({
    ...options,
    ...(profile ? { profile } : {}),
    jobId,
    requestHash: plan.requestHash,
    cwd,
    executionCwd: previous?.executionCwd || cwd,
    version: VERSION,
    storage: S.STORAGE_VERSION,
    status: "starting",
    modelStarted: false,
    reviewStatus: "pending",
    startedAt: plan.startedAt,
    heartbeatAt: plan.startedAt,
    reservation: { pid: process.pid, at: plan.startedAt },
    threadId: previous?.threadId || null,
    resumeJobId: previous?.jobId || null,
    taskId: previous?.taskId || previous?.jobId || jobId,
    revision: plan.revision,
    attempt: previous ? (previous.attempt ?? previous.revision ?? 0) + 1 : 0,
    reviews: previous?.reviews || [],
  });
  return null;
}
/** Step 3, without the lock: everything that reads the project or runs git. */
function prepareStart(plan, cwd) {
  const { input, options, profile, previous, jobId, revision } = plan;
  const dir = S.jobDir(jobId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let executionCwd = previous?.executionCwd || cwd;
  let originBaseline = previous?.originBaseline || snapshot(cwd);
  if (previous?.integration) {
    originBaseline = snapshot(cwd);
    if (
      originBaseline.fingerprint !== previous.integration.fingerprint ||
      snapshot(executionCwd).fingerprint !== previous.acceptedFingerprint
    )
      throw new Error(
        "Source or worktree changed after integration. Reconcile the edits before resuming this task.",
      );
  }
  if (input.batchId && !previous) {
    const batch = S.extension("batch", input.batchId);
    if (!batch || !batch.children.some((c) => S.key(c.cwd) === S.key(cwd)))
      throw new Error("batchId does not authorize this child worktree.");
    executionCwd = cwd;
  } else if (PC.enabled(profile, "branchMode") && !previous) {
    executionCwd = prepareBranch(cwd, profile);
  } else if (options.isolation === "worktree" && !previous) {
    if (
      !originBaseline.available ||
      !originBaseline.head ||
      originBaseline.dirty
    )
      throw new Error(
        "Worktree mode requires a clean Git root with a commit. Use direct mode to preserve current uncommitted work.",
      );
    executionCwd = path.join(S.stateRoot(), "worktrees", jobId);
    fs.mkdirSync(path.dirname(executionCwd), { recursive: true });
    git(cwd, [
      "worktree",
      "add",
      "--detach",
      executionCwd,
      originBaseline.head,
    ]);
    executionCwd = S.workspace(executionCwd);
  }
  const baseline =
    previous?.integration || previous?.delivery?.implementationCommit
      ? snapshot(executionCwd)
      : previous?.baseline || snapshot(executionCwd);
  if (options.assignment && !baseline.available)
    throw new Error(
      "Structured verification requires a Git repository root.",
    );
  const attemptBaseline = snapshot(executionCwd);
  let policyData = {};
  if (profile) {
    Q.scopePolicy(profile, executionCwd, options.assignment, baseline);
    E.assertBudget({
      profile,
      jobId,
      taskId: previous?.taskId || previous?.jobId || jobId,
      model: options.model,
    });
    const scratch = path.join(S.stateRoot(), "scratch", jobId);
    fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
    const packNames = input.contextPacks ?? previous?.contextPackNames ?? [];
    policyData = {
      profile,
      scratch,
      policyBaseline:
        previous &&
        !previous.delivery?.implementationCommit &&
        !previous.integration
          ? previous.policyBaseline
          : Q.capturePolicy(
              profile,
              executionCwd,
              baseline,
              options.assignment.scope,
            ),
      contextPacks: Q.contextPacks(profile, cwd, packNames),
      contextPackNames: packNames,
      criteriaTemplates:
        input.criteriaTemplates ?? previous?.criteriaTemplates ?? [],
      criteriaOmissions:
        input.criteriaOmissions ?? previous?.criteriaOmissions ?? {},
      batchId: input.batchId || previous?.batchId || null,
    };
    if (
      PC.inspectValue(
        { assignment: options.assignment, prompt: options.prompt },
        profile,
      ).count
    )
      throw new Error(
        "Assignment contains a secret pattern; remove it before starting.",
      );
  }
  const contextRow = S.db()
    .prepare("SELECT data FROM contexts WHERE cwd=?")
    .get(contextKey(cwd, profile));
  const state = {
    ...options,
    ...policyData,
    jobId,
    requestHash: plan.requestHash,
    cwd,
    executionCwd,
    version: VERSION,
    storage: S.STORAGE_VERSION,
    status: "starting",
    modelStarted: false,
    reviewStatus: "pending",
    startedAt: plan.startedAt,
    threadId: previous?.threadId || null,
    resumeJobId: previous?.jobId || null,
    taskId: previous?.taskId || previous?.jobId || jobId,
    revision,
    attempt: previous ? (previous.attempt ?? previous.revision ?? 0) + 1 : 0,
    baseline,
    attemptBaseline,
    originBaseline,
    contextAtStart: contextRow ? JSON.parse(contextRow.data) : null,
    configOverrides:
      options.workerProfile === "local-code" ? localOverrides(cwd) : [],
    reviews: previous?.reviews || [],
  };
  writeJson(artifact(jobId, "assignment.json"), options.assignment);
  writeJson(artifact(jobId, "report-schema.json"), C.reportSchema);
  fs.writeFileSync(artifact(jobId, "prompt.txt"), options.prompt, {
    mode: 0o600,
  });
  return state;
}
/** Step 4, inside the transaction: the reservation must still be ours. */
function commitStart(plan, state) {
  const current = S.readRaw(plan.jobId);
  if (current.status !== "starting" || current.reservation?.pid !== process.pid)
    throw new Error(
      "This start lost its project reservation. Start again with a new requestId.",
    );
  // A fresh heartbeat keeps a slow start from looking abandoned before launch
  // records the worker; the tool response stays as in earlier versions.
  S.save({ ...state, heartbeatAt: S.now() });
  // Re-read the batch under the lock: another session may have updated it.
  const { previous } = plan;
  const previousBatch = previous?.batchId
    ? S.extension("batch", previous.batchId)
    : null;
  if (previousBatch) {
    const unionRevision = previousBatch.unionJobId === previous.jobId;
    if (unionRevision) previousBatch.unionJobId = state.jobId;
    else
      previousBatch.children = previousBatch.children.map((c) =>
        c.jobId === previous.jobId ? { ...c, jobId: state.jobId } : c,
      );
    previousBatch.status = unionRevision
      ? "awaiting_union_verification"
      : "running";
    S.setExtension("batch", previousBatch.batchId, previousBatch);
  }
}
/** Drops this process's reservation after a failed start, so the project is free again. */
function releaseStart(jobId) {
  try {
    S.transaction(() => {
      if (S.readRaw(jobId).reservation?.pid === process.pid) S.remove(jobId);
    }, "start:release");
  } catch {}
}
function summary(state) {
  const {
    baseline,
    attemptBaseline,
    originBaseline,
    verificationBaseline,
    requestHash,
    configOverrides,
    prompt,
    policyBaseline,
    storage,
    reservation,
    ...rest
  } = state;
  return {
    ...rest,
    logDirectory: S.jobDir(state.jobId),
    next: S.active.has(state.status)
      ? "Poll codex_status with waitSeconds=20."
      : state.status === "implementation_finished"
        ? "Inspect changes, then codex_verify and codex_review."
        : state.status === "blocked_runtime"
          ? "Runtime failure; do not create another coding or read-only test job. Use codex_doctor with this cwd/jobId. After repair and a successful probe, resume with a new requestId; the saved assignment is retained."
          : undefined,
  };
}
function withHistoricalDiagnosis(state) {
  if (
    S.active.has(state.status) ||
    state.runtimeFailure ||
    state.status === "accepted"
  )
    return state;
  const text =
    state.result?.blockers?.join("\n") ||
    (!state.result
      ? [
          state.progress,
          state.error,
          D.readTail(artifact(state.jobId, "report.txt"), 20000),
        ]
          .filter(Boolean)
          .join("\n")
      : state.error || "");
  if (!D.classifyFailure(text)) return state;
  const runtimeFailure = D.failureRecord(text, {
    cwd: state.cwd,
    stage: "saved_worker_report",
    historical: true,
  });
  runtimeFailure.recovery = D.recovery(
    state.cwd,
    state.jobId,
    runtimeFailure.diagnostics,
  );
  return S.save({
    ...state,
    previousStatus: state.status,
    status: "blocked_runtime",
    runtimeFailure,
  });
}
// Listing and polling read without the write lock (WAL readers never block
// writers); the rare recovery write commits on its own.
export function listJobs(cwd) {
  return S.projectJobs(cwd)
    .slice(0, 50)
    .map(withHistoricalDiagnosis)
    .map(summary);
}
export async function statusJob(input) {
  C.object(input, "status", ["cwd", "jobId", "waitSeconds"]);
  const cwd = S.workspace(input.cwd),
    wait = C.integer(input.waitSeconds ?? 0, "waitSeconds", 0, 30);
  if (!input.jobId) return { cwd, jobs: listJobs(cwd) };
  const deadline = Date.now() + wait * 1000;
  const load = () =>
    withHistoricalDiagnosis(
      S.recover(S.scoped(input.jobId, cwd, { blobs: false })),
    );
  let state = load();
  while (S.active.has(state.status) && Date.now() < deadline) {
    await sleep(Math.min(500, deadline - Date.now()));
    state = load();
  }
  const result = summary(state);
  if (state.profile) result.budget = E.usageSummary(state);
  result.cancellationRequested = fs.existsSync(artifact(state.jobId, "cancel"));
  const reportPath = artifact(state.jobId, "report.txt");
  if (!S.active.has(state.status) && fs.existsSync(reportPath)) {
    result.report = fs.readFileSync(reportPath, "utf8").slice(0, 20000);
    result.reportPath = reportPath;
  }
  if (
    ["failed", "interrupted", "timed_out", "blocked_runtime"].includes(
      state.status,
    )
  )
    result.errorLogTail = tail(artifact(state.jobId, "stderr.log"));
  if (state.status === "accepted" && state.acceptedFingerprint) {
    try {
      if (state.profile) {
        P.currentProfile(state);
        E.verifyAttachments(state);
      }
      result.acceptanceCurrent =
        snapshot(state.executionCwd || cwd).fingerprint ===
        state.acceptedFingerprint;
    } catch {
      result.acceptanceCurrent = false;
    }
  }
  return result;
}
function tail(file) {
  if (!fs.existsSync(file)) return "";
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size,
      buffer = Buffer.alloc(Math.min(size, 6000));
    fs.readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}
export function cancelJob(input) {
  const cwd = S.workspace(input.cwd);
  return S.transaction(() => {
    const state = S.recover(S.scoped(input.jobId, cwd));
    if (!S.active.has(state.status))
      return {
        jobId: state.jobId,
        status: state.status,
        cancellationRequested: false,
      };
    fs.writeFileSync(artifact(state.jobId, "cancel"), S.now());
    return {
      jobId: state.jobId,
      status: state.status,
      cancellationRequested: true,
      next: "Poll to confirm process termination.",
    };
  });
}
export function contextJob(input) {
  C.object(input, "context", [
    "cwd",
    "action",
    "expectedVersion",
    "decisions",
    "openQuestions",
    "dependencies",
    "key",
    "crossLaneRequests",
    "nextSteps",
  ]);
  const cwd = S.workspace(input.cwd);
  const profile = P.loadProfile(cwd, {
    branch: input.key && input.key !== "cwd" ? input.key : undefined,
  });
  const contextScope = contextKey(cwd, profile, input.key);
  const readContext = () => {
    const row = S.db()
      .prepare("SELECT data FROM contexts WHERE cwd=?")
      .get(contextScope);
    return row
      ? JSON.parse(row.data)
      : { version: 0, decisions: [], openQuestions: [], dependencies: [] };
  };
  if ((input.action || "get") === "get")
    return {
      cwd,
      context: readContext(),
      jobs: S.projectJobs(cwd)
        .slice(0, 20)
        .map(withHistoricalDiagnosis)
        .map(summary),
    };
  if (input.action !== "update")
    throw new Error("action must be get or update.");
  return S.transaction(() => {
    const context = readContext();
    if (input.expectedVersion !== context.version)
      throw new Error(
        "Context changed; read version " +
          context.version +
          " before updating.",
      );
    const next = {
      version: context.version + 1,
      updatedAt: S.now(),
      decisions: C.strings(input.decisions ?? context.decisions, "decisions"),
      openQuestions: C.strings(
        input.openQuestions ?? context.openQuestions,
        "openQuestions",
      ),
      dependencies: C.strings(
        input.dependencies ?? context.dependencies,
        "dependencies",
      ),
      ...(PC.enabled(profile, "continuity")
        ? {
            crossLaneRequests: C.strings(
              input.crossLaneRequests ?? context.crossLaneRequests ?? [],
              "crossLaneRequests",
            ),
            nextSteps: C.strings(
              input.nextSteps ?? context.nextSteps ?? [],
              "nextSteps",
            ),
          }
        : {}),
    };
    S.db()
      .prepare(
        "INSERT INTO contexts(cwd,data) VALUES(?,?) ON CONFLICT(cwd) DO UPDATE SET data=excluded.data",
      )
      .run(contextScope, JSON.stringify(PC.sanitize(next, profile)));
    return { cwd, context: next };
  }, "context:update");
}
/**
 * Hashing the project, policy inspection and check planning happen before the
 * transaction. The transaction only confirms the job is unchanged and idle,
 * then records the verification.
 */
export function verifyJob(input) {
  const cwd = S.workspace(input.cwd);
  let state = S.recover(S.scoped(input.jobId, cwd));
  if (state.status === "verifying") return summary(state);
  const seen = { status: state.status, updatedAt: state.updatedAt };
  if (
    ![
      "implementation_finished",
      "verification_failed",
      "verified",
      "accepted",
      "pending_lead_evidence",
    ].includes(state.status)
  )
    throw new Error("Verification requires completed implementation.");
  if (!state.assignment)
    throw new Error(
      "Legacy prompt-only jobs need a structured revision before recorded verification.",
    );
  if (state.readOnly)
    throw new Error(
      "Read-only investigations do not permit host verification commands. Start a separately authorized coding assignment.",
    );
  S.assertIdle(cwd, state.jobId);
  P.currentProfile(state);
  const current = snapshot(state.executionCwd),
    delta = changes(state.baseline, current, state.assignment.scope);
  if (delta.outOfScope.length || delta.gitMetadataChanged)
    throw new Error(
      "Out-of-scope or Git metadata changes must be resolved before verification.",
    );
  if (state.profile) {
    const findings = Q.inspectPolicy(state, current);
    Q.enforceFindings(state.profile, findings);
    state = {
      ...state,
      policyFindings: findings,
      checkPlan: G.planChecks(state, current, delta.files, input),
    };
  }
  if (
    state.verifiedFingerprint === current.fingerprint &&
    ["verified", "accepted"].includes(state.status)
  )
    return summary(state);
  const next = S.stageBlobs({
    ...state,
    status: "verifying",
    verification: { status: "running", startedAt: S.now(), checks: [] },
    verificationBaseline: current,
    workerPid: null,
    heartbeatAt: S.now(),
    reviewStatus: "pending",
  });
  let launched = false;
  S.transaction(() => {
    const fresh = S.scoped(input.jobId, cwd, { blobs: false });
    if (fresh.status === "verifying") {
      state = fresh;
      return;
    }
    if (fresh.status !== seen.status || fresh.updatedAt !== seen.updatedAt)
      throw new Error(
        "The job changed while verification was being prepared; call codex_verify again.",
      );
    S.assertIdle(cwd, state.jobId);
    if (fs.existsSync(artifact(state.jobId, "cancel")))
      fs.unlinkSync(artifact(state.jobId, "cancel"));
    if (fs.existsSync(artifact(state.jobId, "launch")))
      fs.unlinkSync(artifact(state.jobId, "launch"));
    state = S.save(next);
    launched = true;
  }, "verify:commit");
  if (launched) launch(state, "--verify");
  return summary(state);
}
export function reviewJob(input) {
  C.object(input, "review", ["cwd", "jobId", "action", "summary", "evidence"]);
  const cwd = S.workspace(input.cwd);
  // Acceptance compares the project with the verified fingerprint. Hash it
  // before taking the lock; the transaction re-reads the job itself.
  const current =
    input.action === "accept"
      ? snapshot(S.scoped(input.jobId, cwd, { blobs: false }).executionCwd)
      : null;
  return S.transaction(() => {
    let state = S.recover(S.scoped(input.jobId, cwd));
    S.assertIdle(cwd, state.jobId);
    if (S.active.has(state.status))
      throw new Error("Wait for the job before recording a review.");
    if (!["accept", "request_changes", "note"].includes(input.action))
      throw new Error("Unknown review action.");
    const review = {
      action: input.action,
      summary: C.text(input.summary, "review summary"),
      at: S.now(),
      reviewer: "Claude tech lead",
      evidence: input.evidence || [],
    };
    if (input.action === "accept") {
      if (!["verified", "pending_lead_evidence"].includes(state.status))
        throw new Error(
          "Acceptance requires independent verification to pass.",
        );
      if (!state.result || state.result.blockers.length)
        throw new Error("Resolve reported blockers before acceptance.");
      if (
        current.fingerprint !== state.verifiedFingerprint
      )
        throw new Error(
          "Files changed after verification; verify again before acceptance.",
        );
      if (state.profile) {
        P.currentProfile(state);
        const findings = Q.inspectPolicy(state, current);
        Q.enforceFindings(state.profile, findings);
        Q.expandCriteria(
          state.profile,
          {
            ...state.assignment,
            scope: changes(state.baseline, current).files,
          },
          state.criteriaTemplates,
          state.criteriaOmissions,
        );
        if (
          state.secretFindings?.length &&
          PC.enforced(state.profile, "secrets")
        )
          throw new Error(
            "Resolve recorded secret findings before acceptance.",
          );
        const reviewed = E.leadEvidence(state, input.evidence);
        review.evidence = reviewed.evidence;
        if (reviewed.pending.length)
          return summary(
            S.save({
              ...state,
              status: "pending_lead_evidence",
              pendingEvidence: reviewed.pending,
              reviews: [
                ...(state.reviews || []),
                { ...review, action: "pending_lead_evidence" },
              ],
            }),
          );
        const staleContext = (state.contextPacks?.docs || [])
          .filter(
            (d) =>
              PC.digest(PC.readProject(state.profile, state.cwd, d.file)) !==
              d.hash,
          )
          .map((d) => d.file);
        state = {
          ...state,
          policyFindings: findings,
          contextWarnings: staleContext,
          pendingEvidence: [],
        };
      }
      if (
        !Array.isArray(input.evidence) ||
        input.evidence.length !== state.assignment.acceptanceCriteria.length
      )
        throw new Error("Provide one evidence entry per acceptance criterion.");
      const seen = new Set();
      for (const item of state.profile ? [] : input.evidence) {
        C.object(item, "evidence", [
          "criterionIndex",
          "checkId",
          "observation",
        ]);
        C.integer(
          item.criterionIndex,
          "criterionIndex",
          0,
          state.assignment.acceptanceCriteria.length - 1,
        );
        if (seen.has(item.criterionIndex))
          throw new Error("Duplicate criterion evidence.");
        seen.add(item.criterionIndex);
        C.text(item.observation, "observation");
        if (
          !state.verification.checks.some(
            (c) => c.id === item.checkId && c.exitCode === 0,
          )
        )
          throw new Error("Evidence must reference a passed recorded check.");
      }
      state = {
        ...state,
        status: "accepted",
        reviewStatus: "accepted",
        acceptedFingerprint: state.verifiedFingerprint,
        acceptedAt: S.now(),
        ...(state.delivery && !PC.enforced(state.profile, "report")
          ? { delivery: { ...state.delivery, ready: true } }
          : {}),
      };
    } else if (input.action === "request_changes") {
      state = { ...state, reviewStatus: "changes_requested" };
      if (state.status === "accepted") state.status = "verified";
    }
    const recorded = S.save({
      ...state,
      reviews: [...(state.reviews || []), review],
      updatedAt: S.now(),
    });
    if (recorded.batchId && recorded.status === "accepted") {
      const batch = S.extension("batch", recorded.batchId);
      if (batch?.unionJobId === recorded.jobId)
        S.setExtension("batch", batch.batchId, {
          ...batch,
          status: "union_accepted",
        });
    }
    return summary(recorded);
  }, "review");
}
export function integrateJob(input) {
  const cwd = S.workspace(input.cwd);
  if (PC.enabled(S.scoped(input.jobId, cwd).profile, "branchMode"))
    return summary(commitJob(input));
  // Hash both trees before taking the lock. Copying the files and the
  // resulting fingerprint stay inside it, so integration remains atomic.
  const planned = S.scoped(input.jobId, cwd, { blobs: false });
  const current = snapshot(planned.executionCwd),
    origin = snapshot(cwd);
  return S.transaction(() => {
    const state = S.scoped(input.jobId, cwd);
    S.assertIdle(cwd, state.jobId);
    if (state.isolation !== "worktree" || state.status !== "accepted")
      throw new Error("Integration requires an accepted worktree job.");
    if (current.fingerprint !== state.acceptedFingerprint)
      throw new Error("Worktree changed after acceptance.");
    if (state.integration?.fingerprint === origin.fingerprint)
      return summary(state);
    if (origin.fingerprint !== state.originBaseline.fingerprint)
      throw new Error(
        "Original project changed since the worktree started. Integration refused; preserve and reconcile those changes.",
      );
    const delta = changes(state.baseline, current, state.assignment.scope);
    if (delta.outOfScope.length || delta.gitMetadataChanged)
      throw new Error("Worktree scope or Git metadata changed.");
    const files = integrateFiles(
      cwd,
      state.executionCwd,
      state.baseline,
      current,
    );
    return summary(
      S.save({
        ...state,
        integration: {
          status: "applied",
          at: S.now(),
          files,
          fingerprint: snapshot(cwd).fingerprint,
        },
        updatedAt: S.now(),
      }),
    );
  }, "integrate");
}
function stopTree(pid) {
  if (!S.alive(pid)) return;
  if (process.platform === "win32") {
    const r = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 10000,
    });
    if (r.status !== 0 && S.alive(pid))
      throw new Error("Could not terminate process tree.");
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
}
/** A running worker beats this often; readers treat 15 s of silence plus a dead process as gone. */
const HEARTBEAT_MS = 5000;
/** How long a worker's progress write waits for the lock before trying again on a later tick. */
const SOFT_BUSY_MS = 250;
/**
 * Progress notes of a running worker. Another session can hold the database
 * lock for a while (for example a 1.1.4 server hashing a large project), so
 * notes are merged and written when the lock is free. A failed write is
 * recorded, never fatal: it must not stop the Codex run. Urgent notes (thread
 * ID, usage, errors) are tried at once, the rest at most once a second.
 */
function progressWriter(jobId) {
  let pending = null,
    lastWrite = 0,
    faulted = false;
  const flush = (busyMs = SOFT_BUSY_MS) => {
    if (!pending) return true;
    try {
      S.withBusyTimeout(busyMs, () => S.patch(jobId, pending));
      pending = null;
      lastWrite = Date.now();
      return true;
    } catch (error) {
      if (!S.isBusy(error) && !faulted) {
        faulted = true;
        recordWorkerFault(jobId, error, "progress");
      }
      return false;
    }
  };
  return {
    note(changes, urgent = false) {
      pending = { ...pending, ...changes };
      if (urgent || Date.now() - lastWrite >= 1000) flush();
    },
    flush,
    /** Notes not yet written; the final state write carries them. */
    take() {
      const rest = pending || {};
      pending = null;
      return rest;
    },
  };
}
/**
 * A write the job's outcome depends on (status changes, the final result).
 * Each attempt waits up to CODEX_TEAM_DB_BUSY_MS for the lock; a busy
 * database is retried, any other error is thrown.
 */
async function persist(jobId, changes, attempts = 5) {
  for (let attempt = 1; ; attempt++) {
    try {
      return S.patch(jobId, changes);
    } catch (error) {
      if (!S.isBusy(error) || attempt >= attempts) throw error;
      await sleep(1000 * attempt);
    }
  }
}
async function runProcess(
  state,
  command,
  args,
  {
    input,
    eventsFile,
    errorFile,
    timeoutSeconds,
    onEvent,
    stopRequested,
    onTick,
  } = {},
) {
  let child,
    timer,
    exited = false,
    stopReason = null,
    pending = "",
    parseError = null;
  const stderr = fs.openSync(errorFile, "a", 0o600),
    stdout = fs.openSync(eventsFile, "a", 0o600),
    started = Date.now();
  const secureLogs = PC.enabled(state.profile, "secrets");
  let stdoutBuffer = "",
    stderrBuffer = "";
  const buffer = (which, data) => {
    if (
      stdoutBuffer.length + stderrBuffer.length + data.length >
      8 * 1024 * 1024
    ) {
      parseError =
        "Secret-scanned log exceeds 8 MiB; process output is not persisted raw.";
      return;
    }
    if (which === "out") stdoutBuffer += data;
    else stderrBuffer += data;
  };
  try {
    if (fs.existsSync(artifact(state.jobId, "cancel")))
      return { code: null, stopReason: "cancelled" };
    const childStartedAt = S.now();
    child = spawn(command, args, {
      cwd: state.executionCwd,
      env: G.workerEnvironment(state, !onEvent),
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", secureLogs ? "pipe" : stderr],
    });
    try {
      S.patch(state.jobId, {
        codexPid: child.pid,
        childStartedAt,
        childRole: onEvent ? "codex" : "verification",
        ...(onEvent && child.pid ? { modelStarted: true } : {}),
        heartbeatAt: S.now(),
      });
    } catch (error) {
      // The run continues; readers still see the worker process itself.
      recordWorkerFault(state.jobId, error, "child-start");
    }
    const completed = new Promise((resolve, reject) => {
      let drain;
      child.once("error", (e) => {
        clearTimeout(drain);
        reject(e);
      });
      child.once("exit", (code, signal) => {
        exited = true;
        drain = setTimeout(() => {
          child.stdout.destroy();
          resolve({ code, signal });
        }, 1000);
      });
      child.once("close", (code, signal) => {
        clearTimeout(drain);
        resolve({ code, signal });
      });
    });
    const consume = (line) => {
      if (!onEvent || !line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        parseError = "Malformed JSON event in Codex output.";
        return;
      }
      try {
        onEvent(event);
      } catch (e) {
        parseError = e.message;
      }
    };
    child.stdout.setEncoding("utf8");
    if (secureLogs) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (data) => buffer("err", data));
    }
    child.stdout.on("data", (data) => {
      if (secureLogs) buffer("out", data);
      else fs.writeSync(stdout, data);
      if (onEvent) {
        pending += data;
        if (pending.length > 16 * 1024 * 1024) {
          parseError = "Codex event buffer exceeded 16 MiB.";
          pending = "";
        }
        let n;
        while ((n = pending.indexOf("\n")) >= 0) {
          consume(pending.slice(0, n));
          pending = pending.slice(n + 1);
        }
      }
    });
    child.stdin.on("error", (e) => {
      if (e.code !== "EPIPE") parseError = e.message;
    });
    child.stdin.end(input || "");
    let heartbeat = 0,
      heartbeatFaulted = false;
    timer = setInterval(() => {
      if (!parseError && Date.now() - heartbeat > HEARTBEAT_MS) {
        heartbeat = Date.now();
        // A missed beat is harmless: readers also check the worker process.
        // Never stop the run over it.
        try {
          S.withBusyTimeout(SOFT_BUSY_MS, () => S.heartbeat(state.jobId));
        } catch (error) {
          if (!S.isBusy(error) && !heartbeatFaulted) {
            heartbeatFaulted = true;
            recordWorkerFault(state.jobId, error, "heartbeat");
          }
        }
        onTick?.();
      }
      if (exited || stopReason) return;
      const reason = fs.existsSync(artifact(state.jobId, "cancel"))
        ? "cancelled"
        : Date.now() - started > timeoutSeconds * 1000
          ? "timed_out"
          : parseError
            ? "failed"
            : stopRequested?.() || null;
      if (reason) {
        try {
          stopTree(child.pid);
          stopReason = reason;
        } catch (e) {
          try {
            S.patch(state.jobId, { cancellationError: e.message });
          } catch (error) {
            recordWorkerFault(state.jobId, error, "cancel");
          }
        }
      }
    }, 250);
    const result = await completed;
    if (pending.trim()) consume(pending);
    let secretCount = 0;
    if (secureLogs) {
      if (onEvent)
        stdoutBuffer = stdoutBuffer
          .split("\n")
          .map((line) => {
            let event;
            try {
              event = JSON.parse(line);
            } catch {
              return PC.scan(line, state.profile).text;
            }
            const result = PC.inspectValue(event, state.profile);
            secretCount += result.count;
            return JSON.stringify(result.value);
          })
          .join("\n");
      const out = PC.scan(stdoutBuffer, state.profile),
        err = PC.scan(stderrBuffer, state.profile);
      secretCount += out.count + err.count;
      fs.writeSync(stdout, out.text);
      fs.writeSync(stderr, err.text);
    }
    return {
      ...result,
      stopReason,
      parseError,
      durationMs: Date.now() - started,
      ...(secureLogs ? { secretCount } : {}),
    };
  } catch (e) {
    if (child?.pid && !exited) {
      try {
        stopTree(child.pid);
      } catch {}
    }
    throw e;
  } finally {
    clearInterval(timer);
    fs.closeSync(stderr);
    fs.closeSync(stdout);
  }
}
async function worker(jobId, verification = false) {
  // The launching session records this worker, then writes the launch file.
  // Under contention that write can wait, so allow up to two minutes.
  for (let i = 0; i < 4800; i++) {
    if (
      fs.existsSync(artifact(jobId, "launch")) &&
      fs.readFileSync(artifact(jobId, "launch"), "utf8") === String(process.pid)
    )
      break;
    await sleep(25);
  }
  const state = S.read(jobId);
  if (state.workerPid !== process.pid) return;
  let privateReportDirectory = null,
    verificationLease = false;
  try {
    P.currentProfile(state);
    if (fs.existsSync(artifact(jobId, "cancel"))) {
      await persist(jobId, { status: "cancelled", finishedAt: S.now() });
      return;
    }
    if (verification) {
      if (PC.enabled(state.profile, "gates")) {
        const deadline = Date.now() + state.timeoutSeconds * 1000;
        while (!verificationLease) {
          verificationLease = S.transaction(() => {
            const key = state.profile.repoId;
            const active = (
              S.extension("check-leases", key)?.jobs || []
            ).filter((id) => {
              const job = S.read(id, { blobs: false });
              return job.status === "verifying" && S.alive(job.workerPid);
            });
            if (
              active.length >=
              (state.profile.components.gates.maxParallelChecks || 1)
            )
              return false;
            S.setExtension("check-leases", key, {
              jobs: [...new Set([...active, jobId])],
            });
            return true;
          });
          if (!verificationLease) {
            if (
              Date.now() > deadline ||
              fs.existsSync(artifact(jobId, "cancel"))
            )
              throw new Error(
                "Verification slot wait ended; no check was launched.",
              );
            try {
              S.withBusyTimeout(SOFT_BUSY_MS, () =>
                S.patch(jobId, { heartbeatAt: S.now() }),
              );
            } catch (error) {
              if (!S.isBusy(error)) throw error;
            }
            await sleep(250);
          }
        }
      }
      const checks = [],
        before = snapshot(state.executionCwd);
      if (before.fingerprint !== state.verificationBaseline.fingerprint)
        throw new Error(
          "Files changed between verification request and worker startup. Inspect the changes and verify again.",
        );
      const specifications =
        state.checkPlan?.checks || state.assignment.verification;
      for (const spec of specifications) {
        const attempts = [];
        let result, stdoutPath, stderrPath;
        G.allowCommand(state.profile, [spec.command, ...spec.args]);
        for (
          let attempt = 0;
          attempt <= (spec.retryOnTimeout || 0);
          attempt++
        ) {
          stdoutPath = artifact(
            jobId,
            "verify-" + spec.id + (attempt ? "-retry" : "") + ".stdout.log",
          );
          stderrPath = artifact(
            jobId,
            "verify-" + spec.id + (attempt ? "-retry" : "") + ".stderr.log",
          );
          if (spec.coveragePath && fs.existsSync(spec.coveragePath))
            fs.unlinkSync(spec.coveragePath);
          result = await runProcess(state, spec.command, spec.args, {
            eventsFile: stdoutPath,
            errorFile: stderrPath,
            timeoutSeconds: spec.timeoutSeconds,
          });
          attempts.push({ ...result, stdoutPath, stderrPath });
          if (result.stopReason !== "timed_out") break;
        }
        let coverageError = null;
        if (spec.coveragePath)
          try {
            G.parseLcov(
              PC.boundedRead(spec.coveragePath, 8 * 1024 * 1024),
              state.executionCwd,
            );
          } catch (e) {
            coverageError = e.message;
          }
        checks.push({
          ...spec,
          exitCode: result.code,
          status:
            result.stopReason ||
            (result.code === 0 && !coverageError && !result.secretCount
              ? "passed"
              : "failed"),
          durationMs: result.durationMs,
          stdoutPath,
          stderrPath,
          outputTail: tail(stdoutPath),
          ...(state.profile
            ? {
                attempts,
                coverageError,
                tests: G.countLogs(stdoutPath, stderrPath),
              }
            : {}),
        });
        // Interim progress; the final verification write carries every check.
        try {
          S.withBusyTimeout(SOFT_BUSY_MS, () =>
            S.patch(jobId, { verification: { status: "running", checks } }),
          );
        } catch (error) {
          if (!S.isBusy(error)) throw error;
        }
        if (
          result.stopReason ||
          (checks.at(-1).status !== "passed" && spec.level !== "advise")
        )
          break;
      }
      const after = snapshot(state.executionCwd);
      const commandChecksComplete = checks.length === specifications.length;
      if (state.checkPlan && commandChecksComplete)
        checks.push(...G.coverageChecks(state, state.checkPlan, checks, after));
      const verifiedChanges = changes(
        state.baseline,
        after,
        state.assignment.scope,
      );
      const passed =
        commandChecksComplete &&
        checks.every((c) => c.status === "passed" || c.level === "advise") &&
        before.fingerprint === after.fingerprint &&
        verifiedChanges.outOfScope.length === 0 &&
        !verifiedChanges.gitMetadataChanged;
      await persist(jobId, {
        status: passed ? "verified" : "verification_failed",
        verifiedFingerprint: passed ? after.fingerprint : null,
        verification: {
          status: passed ? "passed" : "failed",
          checks,
          filesChangedDuringChecks: before.fingerprint !== after.fingerprint,
          finishedAt: S.now(),
        },
        finishedAt: S.now(),
      });
      return;
    }
    await persist(jobId, { status: "running" });
    const binary = resolveCodex();
    const runtime = D.inspectRuntime(binary, state.executionCwd);
    await persist(jobId, { runtime });
    const preflight = D.probeRuntime(binary, runtime, state.cwd, {
      readOnly: state.readOnly,
      executionCwd: state.executionCwd,
      timeoutMs: state.timeoutSeconds * 1000,
      jobId,
    });
    if (preflight.status === "blocked") {
      const runtimeFailure = {
        ...preflight.failure,
        recovery: D.recovery(state.cwd, jobId, preflight.failure?.diagnostics),
      };
      writeJson(artifact(jobId, "diagnostics.json"), {
        runtime,
        preflight,
        runtimeFailure,
      });
      await persist(jobId, {
        status: fs.existsSync(artifact(jobId, "cancel"))
          ? "cancelled"
          : "blocked_runtime",
        runtimeFailure,
        preflight,
        modelStarted: false,
        finishedAt: S.now(),
      });
      return;
    }
    await persist(jobId, { preflight });
    let runtimeFailure = null,
      budgetExceeded = false,
      turnIndex = 0;
    const secretFindings = [];
    let turnCompleted = false,
      turnFailed = false;
    const progress = progressWriter(jobId);
    const role =
      "You are the code contributor under Claude Code, the tech lead. Implement only this authorized assignment; preserve existing user changes and follow repository instructions. Do not re-delegate, commit, publish, push, use unrelated external services, or bypass permission, sandbox or hook-trust checks. Report blockers honestly. If sandbox setup fails (for example helper_unknown_error: setup refresh had errors), stop tool retries and report the exact error; changing the shell, read-only mode, or editing tool cannot establish that setup is repaired. Claude independently verifies and accepts your work.\n";
    const context = state.assignment
      ? "\nStructured assignment:\n" +
        JSON.stringify(state.assignment, null, 2) +
        "\nSaved lead context:\n" +
        JSON.stringify(state.contextAtStart) +
        (state.profile
          ? "\nProject policy and context:\n" +
            JSON.stringify({
              profile: state.profile,
              contextPacks: state.contextPacks,
            })
          : "") +
        "\nReturn the requested JSON report. Checks you report are claims, not independent verification.\n"
      : "";
    let finalReportPath = artifact(jobId, "report.txt");
    if (PC.enabled(state.profile, "secrets")) {
      privateReportDirectory = fs.mkdtempSync(
        path.join(os.tmpdir(), "codex-team-report-" + jobId + "-"),
      );
      finalReportPath = path.join(privateReportDirectory, "report.txt");
    }
    const result = await runProcess(
      state,
      binary.command,
      [...binary.prefix, ...buildArgs(state, finalReportPath)],
      {
        input: role + context + "\n" + state.prompt,
        eventsFile: artifact(jobId, "events.jsonl"),
        errorFile: artifact(jobId, "stderr.log"),
        timeoutSeconds: state.timeoutSeconds,
        onTick: () => progress.flush(),
        stopRequested: () =>
          runtimeFailure
            ? "blocked_runtime"
            : secretFindings.length && PC.enforced(state.profile, "secrets")
              ? "secret_access_suspected"
              : budgetExceeded
                ? "budget_exhausted"
                : null,
        onEvent: (event) => {
          if (event.type === "turn.started") turnIndex++;
          if (PC.enabled(state.profile, "secrets")) {
            if (PC.inspectValue(event, state.profile).count)
              secretFindings.push({ kind: "pattern", eventType: event.type });
            if (event.item?.type === "command_execution") {
              if (
                PC.commandAccessSuspected(
                  state.profile,
                  state.executionCwd,
                  event.item.command,
                )
              )
                secretFindings.push({
                  kind: "forbidden_path",
                  eventType: event.type,
                });
            }
          }
          const diagnostic =
            event.type === "error" || event.type === "turn.failed"
              ? event.message || event.error?.message || ""
              : event.item?.type === "command_execution" &&
                  (event.item.status === "failed" || event.item.exit_code > 0)
                ? event.item.aggregated_output || ""
                : "";
          if (D.classifyFailure(diagnostic))
            runtimeFailure = D.failureRecord(diagnostic, { cwd: state.cwd });
          if (event.type === "thread.started")
            progress.note({ threadId: event.thread_id }, true);
          if (event.type === "turn.completed") {
            turnCompleted = true;
            progress.note({ usage: event.usage }, true);
            const budget = E.recordUsage(state, event, turnIndex);
            budgetExceeded = !!(
              budget?.exceeded.length && PC.enforced(state.profile, "budget")
            );
            if (budget) progress.note({ budget }, true);
          }
          if (event.type === "turn.failed") {
            turnFailed = true;
            progress.note(
              { error: event.error?.message || "Codex turn failed." },
              true,
            );
          }
          if (event.type === "error")
            progress.note(
              { lastDiagnostic: event.message || event.error?.message },
              true,
            );
          if (event.item?.type === "agent_message")
            progress.note({
              progress: String(event.item.text || "").slice(-3000),
            });
          if (event.item?.type === "command_execution")
            progress.note({
              lastCommand: event.item.command,
              lastCommandStatus: event.item.status,
              lastCommandExitCode: event.item.exit_code,
            });
        },
      },
    );
    if (privateReportDirectory && fs.existsSync(finalReportPath)) {
      const raw = PC.boundedRead(finalReportPath, 8 * 1024 * 1024);
      let output = PC.scan(raw, state.profile);
      try {
        const parsed = JSON.parse(raw),
          inspected = PC.inspectValue(parsed, state.profile);
        output = {
          text: JSON.stringify(inspected.value),
          count: output.count + inspected.count,
        };
      } catch (error) {
        if (error.message.includes("Secret")) throw error;
      }
      if (output.count)
        secretFindings.push({ kind: "pattern", source: "final_report" });
      fs.writeFileSync(artifact(jobId, "report.txt"), output.text, {
        mode: 0o600,
      });
    }
    if (result.secretCount)
      secretFindings.push({ kind: "pattern", source: "process_log" });
    const after = snapshot(state.executionCwd);
    writeJson(artifact(jobId, "snapshot-after.json"), after);
    const delta = changes(state.baseline, after, state.assignment?.scope);
    let policyFindings = [];
    if (state.profile) {
      policyFindings = Q.inspectPolicy(state, after);
      for (const finding of policyFindings.filter(
        (v) => v.component === "secrets" && !v.ok,
      ))
        secretFindings.push({ kind: "changed_file", path: finding.path });
    }
    let error = result.parseError,
      structured = null;
    const reportPath = artifact(jobId, "report.txt");
    if (
      !fs.existsSync(reportPath) ||
      !fs.readFileSync(reportPath, "utf8").trim()
    )
      error = error || "Codex exited without a final report.";
    if (state.assignment && !error)
      try {
        structured = C.report(json(reportPath));
      } catch (e) {
        error = "Invalid structured report: " + e.message;
      }
    const successful =
      result.code === 0 && turnCompleted && !turnFailed && !error;
    const blockedText =
      structured?.blockers?.join("\n") ||
      (!state.assignment ? D.readTail(reportPath, 20000) : "");
    if (!runtimeFailure && D.classifyFailure(blockedText))
      runtimeFailure = D.failureRecord(blockedText, { cwd: state.cwd });
    if (
      !runtimeFailure &&
      result.code !== 0 &&
      D.classifyFailure(tail(artifact(jobId, "stderr.log")))
    )
      runtimeFailure = D.failureRecord(tail(artifact(jobId, "stderr.log")), {
        cwd: state.cwd,
      });
    if (runtimeFailure) {
      runtimeFailure.recovery = D.recovery(
        state.cwd,
        jobId,
        runtimeFailure.diagnostics,
      );
      runtimeFailure.partialChanges = changes(
        state.attemptBaseline,
        after,
        state.assignment?.scope,
      );
      D.recordFailure(
        state.cwd,
        runtime,
        runtimeFailure,
        state.readOnly,
        jobId,
      );
      writeJson(artifact(jobId, "diagnostics.json"), {
        runtime,
        preflight,
        runtimeFailure,
      });
    }
    const noted = progress.take();
    await persist(jobId, {
      ...noted,
      status:
        (["cancelled", "timed_out"].includes(result.stopReason)
          ? result.stopReason
          : null) ||
        (runtimeFailure
          ? "blocked_runtime"
          : secretFindings.length && PC.enforced(state.profile, "secrets")
            ? "secret_access_suspected"
            : budgetExceeded
              ? "budget_exhausted"
              : result.stopReason) ||
        (successful ? "implementation_finished" : "failed"),
      exitCode: result.code,
      signal: result.signal || null,
      error:
        noted.error ||
        S.readRaw(jobId).error ||
        error ||
        (!turnCompleted ? "No turn.completed event was observed." : null),
      result: structured,
      runtimeFailure,
      changes: delta,
      implementationFingerprint: after.fingerprint,
      durationMs: result.durationMs,
      finishedAt: S.now(),
      ...(state.profile ? { policyFindings, secretFindings } : {}),
    });
  } catch (e) {
    try {
      await persist(jobId, {
        status: verification ? "verification_failed" : "failed",
        error: e.message,
        finishedAt: S.now(),
      });
    } catch (writeError) {
      recordWorkerFault(jobId, writeError, "final");
    }
  } finally {
    // A lease left behind expires by itself: holders must be verifying and alive.
    if (verificationLease)
      try {
        S.transaction(() => {
          const key = state.profile.repoId,
            jobs = S.extension("check-leases", key)?.jobs || [];
          S.setExtension("check-leases", key, {
            jobs: jobs.filter((id) => id !== jobId),
          });
        }, "lease:release");
      } catch {}
    if (
      privateReportDirectory &&
      path.dirname(privateReportDirectory) === os.tmpdir() &&
      path
        .basename(privateReportDirectory)
        .startsWith("codex-team-report-" + jobId + "-")
    )
      fs.rmSync(privateReportDirectory, { recursive: true, force: true });
    try {
      S.patch(jobId, { heartbeatAt: S.now() });
    } catch {}
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === self &&
  ["--worker", "--verify"].includes(process.argv[2])
) {
  process.on("uncaughtExceptionMonitor", (error) =>
    recordWorkerFault(process.argv[3], error, "uncaught"),
  );
  await worker(process.argv[3], process.argv[2] === "--verify");
}
