process.env.NoDefaultCurrentDirectoryInExePath = "1";
/** Job lifecycle, worker execution, independent verification and lead acceptance. */
import { timeoutChoice, queueRun, recordFinishedExecs } from "./run-stats.mjs";
import { observationWriter as createObservationWriter } from "./observation-writer.mjs";
import { commandTracker, runObservation, bootstrapReads, otherActiveJobs, contextJobs } from "./run-observation.mjs";
import { trimEvent } from "./event-log.mjs";
import { salvageRun, canSalvage } from "./salvage.mjs";
import { sandboxProbe } from "./sandbox-probe.mjs";
import { inspectVerificationRequest,orderedChecks } from "./verification-request.mjs";
import {backgroundFacts} from "./background-facts.mjs";
import { reviewOptions, findingDispositions, findingPacketBinding } from './review-findings.mjs';
import { instructionSnapshot, assertReviewInstructions } from './review-instructions.mjs';
import { scoutEvidenceFloor, scoutThreadEvents } from './review-evidence.mjs';
import {storedReview} from "./review-state.mjs";
import { trustedExecutable } from "./host-security.mjs";
import { hiddenState, verificationFingerprint } from "./hidden-inventory.mjs";
import { draftHash } from "./report-preview.mjs";
import { autoVerifyGate } from "./auto-verify.mjs";
import { hostEnvironment, resolveCheckExecutable } from "./check-executable.mjs";
import { checkInvocation, requireHostAck, reviewInputDetails, reviewFingerprint, sandboxLimitation, verificationCommands } from "./sandbox-checks.mjs";
import { shellEnvironmentPolicy, inlineCommand, redactDefault } from "./host-security.mjs";
import { captureVisibility, finishVisibility, inheritVisibility } from "./visibility.mjs";
import { captureBytes, inheritCapture, pruneBytes, authoredLineStats, captureAttemptBytes } from "./baseline-bytes.mjs";
import { resolvePacketEvidence } from "./decision-packet.mjs";
import { runReviewer } from "./reviewer.mjs";
import * as H from "./handbook.mjs";
import { resolveScout } from "./scout.mjs";
import { scoutMode, SCOUT_MARKER } from "./scout-controls.mjs";
import { reportPreview, SCOUT_NEXT } from "./report-preview.mjs";
import { buildWorkerPrompt } from "./worker-prompt.mjs";
const isScout = state => scoutMode(state, id => S.read(id, { blobs: false }));
import { waitCommand } from "./tool-output.mjs";
import { classifyTransientFailure, failureTracker } from "./recovery.mjs";
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
import { queueStateCard, leadContext } from "./lead-state.mjs";
export { workspace, stateRoot } from "./store.mjs";
const self = fileURLToPath(import.meta.url);
const VERSION = "1.2.1";
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
  C.object(input, "doctor", ["cwd", "jobId", "probe", "probeNetwork", "readOnly"]);
  for (const key of ["probe", "readOnly"])
    if (input[key] !== undefined && typeof input[key] !== "boolean")
      throw new Error(key + " must be a boolean.");
  if ((input.probe || input.probeNetwork || input.jobId) && !input.cwd)
    throw new Error("cwd is required for a sandbox probe or job diagnosis.");
  const cwd = input.cwd ? S.workspace(input.cwd) : null;
  const job = input.jobId
    ? S.transaction(() =>
        withHistoricalDiagnosis(S.recover(S.scoped(input.jobId, cwd))),
      )
    : null;
  if (input.probe || input.probeNetwork) S.assertIdle(cwd);
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
    verificationSandbox: cwd && (input.probe || input.probeNetwork)
      ? check?.status === "blocked" || input.readOnly === true
        ? { status: "skipped", probeExecuted: false, networkIsolation: "unconfirmed", reason: "Blocked or read-only runtime probe; containment probe was not attempted." }
        : sandboxProbe(binary, job?.executionCwd || cwd, { probeNetwork: input.probeNetwork })
      : { status: "untested", probeExecuted: false, networkIsolation: "unconfirmed" },
    diagnostics,
    hint: D.versionHint(runtime.version, {check, failure:job?.runtimeFailure}),
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
    isScout(state) || state.readOnly ? "read-only" : "workspace-write",
    "-c",
    'approval_policy="never"',
  ];
  if (state.model) args.push("--model", state.model);
  if (state.effort)
    args.push("-c", "model_reasoning_effort=" + JSON.stringify(state.effort));
  for (const override of state.configOverrides || []) args.push("-c", override);
  args.push(...shellEnvironmentPolicy(state.profile?.passEnv || []));
  if (state.threadId) args.push("resume", state.threadId);
  if (state.assignment || isScout(state))
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
    "salvageSeconds",
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
    "mode",
    "fromScout",
    "confirmDraftHash",
    "autoVerify",
    "review",
  ]);
  if (input.readOnly !== undefined && typeof input.readOnly !== "boolean")
    throw new Error("readOnly must be a boolean.");
  if (input.autoVerify !== undefined && typeof input.autoVerify !== "boolean") throw Error("autoVerify must be a boolean.");
  const previousMode = previous && isScout(previous) ? "scout" : "implementation";
  const mode = input.mode ?? previousMode;
  if (!["scout", "implementation"].includes(mode)) throw new Error("mode must be scout or implementation.");
  if (previous && mode !== previousMode) throw new Error("A revision must preserve mode.");
  if (mode === "scout" && input.readOnly === false) throw new Error("Scouts must be read-only.");
  const readOnly = mode === "scout" || (input.readOnly ?? previous?.readOnly ?? false);
  if (previous && readOnly !== previous.readOnly)
    throw new Error("A revision must preserve readOnly.");
  const task = input.assignment
    ? C.assignment(input.assignment, { scout: mode === "scout" })
    : previous?.assignment || null;
  if (mode === "scout" && task && !task.constraints.includes(SCOUT_MARKER))
    task.constraints = [...task.constraints, SCOUT_MARKER];
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
  if (mode === "scout" && input.isolation && input.isolation !== "direct")
    throw new Error("Scouts use direct read-only exploration without a worktree.");
  const isolation = mode === "scout" ? "direct" : input.isolation ?? previous?.isolation ?? "direct";
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
  const timing = timeoutChoice(mode === "scout" ? "scout" : previous ? "revision" : "implementation", input.timeoutSeconds ?? (previous ? previous.timeoutSeconds ?? 1800 : undefined));
  return {
    assignment: task,
    review: reviewOptions(input.review, previous?.review),
    autoVerifyExplicit: input.autoVerify !== undefined || !!previous?.autoVerifyExplicit,
    autoVerifyVersion: 12,
    autoVerify: !!task && !readOnly && mode !== "scout" && !task.verification.some(c => c.host) && (input.autoVerify ?? (previous ? previous.autoVerifyVersion === 12 && previous.autoVerify === true : true)),
    ...(mode === "scout" ? { mode, readOnlyDraft: true } : {}),
    prompt,
    readOnly,
    requestId,
    isolation,
    workerProfile,
    model,
    effort,
    ...timing,
    salvageSeconds: input.salvageSeconds === undefined ? previous?.salvageSeconds : C.integer(input.salvageSeconds, "salvageSeconds", 0, 300),
    timeoutSeconds: C.integer(
      timing.timeoutSeconds,
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
export function launch(state, mode, { patch = S.patch } = {}) {
  const supervised = mode === "--worker";
  const entry = supervised
    ? fileURLToPath(new URL("./supervisor.mjs", import.meta.url))
    : self;
  const args = supervised ? [entry, state.jobId] : [entry, mode, state.jobId];
  const worker = spawn(process.execPath, args, {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env: hostEnvironment(),
    cwd: state.executionCwd || state.cwd,
  });
  worker.on("error", (error) => {
    try {
      S.patch(state.jobId, {
        status: mode === "--verify" ? "verification_failed" : "failed", livePhase: null, reservation: null,
        error: error.message,
        finishedAt: S.now(),
      });
      if (supervised) pruneJobBytes(state.jobId);
    } catch {} // Recovery marks the job interrupted once its heartbeat is stale.
  });
  worker.unref();
  // Waits up to CODEX_TEAM_DB_BUSY_MS for the lock; the worker waits for the
  // launch file below before it trusts the record.
  try {
    patch(state.jobId, {
      ...(supervised
        ? {
            supervisorPid: worker.pid,
            deadlineAt: new Date(Date.now() + state.timeoutSeconds * 1000).toISOString(),
          }
        : { workerPid: worker.pid }),
      heartbeatAt: S.now(),
    });
    fs.writeFileSync(artifact(state.jobId, supervised ? "supervisor-launch" : "launch"), String(worker.pid));
  } catch (error) {
    // This ChildProcess is the recorded launch identity; it has not received its launch token.
    try { worker.kill("SIGKILL"); } catch {}
    fs.writeFileSync(artifact(state.jobId, "launch-failed.json"), JSON.stringify({ pid: worker.pid, at: S.now(), error: error.message }));
    try { S.withBusyTimeout(0, () => S.patch(state.jobId, { status: mode === "--verify" ? "verification_failed" : "failed", livePhase: null, reservation: null, supervisorPid: null, workerPid: null, finishedAt: S.now(), error: "Launch persistence failed: " + error.message })); } catch {}
    throw error;
  }
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
  if (plan.replay) return startSummary(plan.replay);
  const replay = S.transaction(() => reserveStart(plan, cwd), "start:reserve");
  if (replay) return startSummary(replay);
  let state;
  try {
    state = S.stageBlobs(prepareStart(plan, cwd));
    S.transaction(() => commitStart(plan, state), "start:commit");
    if (plan.previous) pruneJobBytes(plan.previous.jobId);
  } catch (e) {
    releaseStart(plan.jobId);
    throw e;
  }
  try { launch(state, "--worker"); }
  catch (error) { pruneJobBytes(state.jobId); throw error; }
  return startSummary(state);
}
function planStart(input, cwd) {
  const resolved = resolveScout(input, cwd);
  input = resolved.input;
  const previous = input.resumeJobId
    ? withHistoricalDiagnosis(S.recover(S.scoped(input.resumeJobId, cwd)))
    : null;
  const options = normalize(input, previous);
  if (resolved.provenance || previous?.provenance) options.provenance = resolved.provenance || previous.provenance;
  if (options.provenance?.draftSourced || options.provenance?.draftCheckOverlap) options.autoVerify = false;
  const profile = P.loadProfile(cwd, {
    branch: input.branch || previous?.profile?.branch,
    topic: input.topic,
    lane: input.lane || previous?.profile?.lane,
  });
  if (profile) {
    if (PC.enabled(profile,"gates") && Object.values(profile.components.gates.checks || {}).some(c=>c.host && c.level!=="off")) options.autoVerify=false;
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
    if (PC.enabled(profile, "branchMode") && options.mode !== "scout") options.isolation = "worktree";
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
  options.autoVerifyReason = options.autoVerify ? "Lead-authored sandboxed checks." :
    options.provenance?.scoutJobId ? "Scout-seeded job: auto-verify requires an explicit lead choice" :
    options.assignment?.verification.some(c=>c.host) || (profile && PC.enabled(profile,"gates") && Object.values(profile.components.gates.checks || {}).some(c=>c.host && c.level!=="off")) ? "Host checks require manual verification and hostAck." :
    input.autoVerify === false ? "Explicit autoVerify:false." : previous && previous.autoVerifyVersion !== 12 ? "Legacy revision keeps auto-verify off." : previous && input.autoVerify === undefined ? "Inherited autoVerify:false." : "Auto-verification disabled or ineligible.";
  const identityOptions = { ...options };
  delete identityOptions.autoVerifyReason;
  delete identityOptions.autoVerifyVersion;
  delete identityOptions.autoVerifyExplicit;
  delete identityOptions.timeoutBasis;
  delete identityOptions.typicalDurationSeconds;
  if (input.timeoutSeconds === undefined) delete identityOptions.timeoutSeconds;
  const defaultAutoVerify = !previous && !!options.assignment && !options.readOnly && !options.provenance?.draftSourced && !options.provenance?.draftCheckOverlap && !options.assignment.verification.some(c=>c.host);
  if (options.autoVerify === defaultAutoVerify) delete identityOptions.autoVerify;
  const requestHash = hash(
    JSON.stringify({
      cwd: S.key(cwd),
      ...identityOptions,
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
  // A same-request reservation may appear after findReplay. Let the short
  // reservation transaction resolve it and re-check its request hash.
  S.assertIdle(cwd, jobId);
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
function checkCapacity({ input, previous, profile, jobId }, cwd) {
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
          j.jobId !== jobId && j.profile?.repoId === profile.repoId &&
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
    containmentVersion: 1,
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
  } else if (PC.enabled(profile, "branchMode") && !previous && options.mode !== "scout") {
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
  const attemptBaseline = !previous && executionCwd === cwd && !PC.enabled(profile, "branchMode")
    ? originBaseline : snapshot(executionCwd);
  const baseline =
    previous?.integration || previous?.delivery?.implementationCommit
      ? attemptBaseline
      : previous?.baseline || attemptBaseline;
  if (!attemptBaseline.available && (baseline.available === true || previous?.attemptBaseline?.available === true))
    throw new Error("Recorded Git repository is unavailable for this revision.");
  if (options.assignment && !baseline.available)
    throw new Error(
      "Structured verification requires a Git repository root.",
    );
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
  const handbook = PC.sanitize(H.readHandbook(cwd), profile);
  writeJson(artifact(jobId, "handbook.json"), handbook);
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
    reviewInstructionBaseline: previous && baseline === previous.baseline ? previous.reviewInstructionBaseline : instructionSnapshot(executionCwd, { requireGit: baseline.available === true || attemptBaseline.available === true }),
    ...(options.assignment && !options.readOnly ? { baselineBytes: previous && baseline === previous.baseline ? inheritCapture(previous.baselineBytes, artifact(jobId, "baseline-bytes")) : captureBytes(executionCwd, baseline, options.assignment.scope, artifact(jobId, "baseline-bytes"), profile) } : {}),
    originBaseline,
    contextAtStart: contextRow ? leadContext(JSON.parse(contextRow.data)) : null,
    handbookAtStart: H.metadata(handbook),
    configOverrides:
      options.workerProfile === "local-code" ? localOverrides(cwd) : [],
    reviews: previous?.reviews || [],
  };
  if (options.assignment && !options.readOnly) state.attemptBytes = captureAttemptBytes(state, artifact(jobId, "baseline-bytes"));
  if (previous?.baselineBytesUnavailableReason && baseline === previous.baseline) state.baselineBytesUnavailableReason = previous.baselineBytesUnavailableReason;
  state.checkLauncher = previous?.checkLauncher || resolveCodex();
  state.containmentVersion = 1;
  state.visibilityUnavailable = !!previous && !previous.visibilityRecorded;
  if(previous) state.visibilityUnavailable=!inheritVisibility(previous,S.jobDir(previous.jobId),dir);
  if(previous?.hiddenChanges) state.hiddenChanges=previous.hiddenChanges;
  writeJson(artifact(jobId, "assignment.json"), options.assignment);
  writeJson(artifact(jobId, "report-schema.json"), options.mode === "scout" ? C.scoutReportSchema : C.reportSchema);
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
/** Source cleanup is deliberately outside the DB lock. */
function pruneJobBytes(jobId, names = ["baseline-bytes", "review-copies"]) {
  for (const name of names) try { pruneBytes(artifact(jobId, name)); }
  catch (error) {
    try {
      const state = S.readRaw(jobId);
      S.patch(jobId, { result: { ...state.result, sandboxLimits: [...(state.result?.sandboxLimits || []), "Baseline cleanup: " + error.code] } });
    } catch {}
  }
}
/** Drops this process's reservation after a failed start, so the project is free again. */
function releaseStart(jobId) {
  pruneJobBytes(jobId);
  try {
    S.transaction(() => {
      if (S.readRaw(jobId).reservation?.pid === process.pid) S.remove(jobId);
    }, "start:release");
  } catch {}
}
function startSummary(state) { return {...summary(state), otherActiveJobs: otherActiveJobs(state.jobId)}; }
function summary(state) {
  const {
    baseline,
    baselineBytes,
    attemptBytes,
    verificationInputs,
    hiddenBaseline,
    verificationHidden,
    attemptBaseline,
    originBaseline,
    verificationBaseline,
    reviewBaseline,
    requestHash,
    configOverrides,
    prompt,
    policyBaseline,
    storage,
    reservation,
    handbookAtStart,
    ...rest
  } = state;
  const command = waitCommand(state.jobId);
  return {
    ...rest,
    ...runObservation(state),
    ...(handbookAtStart ? { handbookAtStart: H.metadata(handbookAtStart) } : {}),
    ...(state.result?.draftAssignment ? { draftHash: draftHash(state.result.draftAssignment) } : {}),
    logDirectory: S.jobDir(state.jobId),
    ...(S.active.has(state.status) && command ? { waitCommand: command } : {}),
    next: S.active.has(state.status)
      ? command ? "Run waitCommand with run_in_background."
        : "Wait command unavailable for this path; poll codex_status with waitSeconds=20."
      : state.status === "implementation_finished"
        ? state.mode === "scout" ? SCOUT_NEXT : "Inspect changes, then codex_verify and codex_review."
        : state.runtimeFailure?.kind === "auth_expired"
          ? "Run codex login, then explicitly resume the saved thread."
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
  C.object(input, "status", ["cwd", "jobId", "waitSeconds", "refresh", "includeProfileChecks"]);
  const cwd = S.workspace(input.cwd),
    wait = C.integer(input.waitSeconds ?? 0, "waitSeconds", 0, 30);
  for (const key of ["refresh", "includeProfileChecks"]) if(input[key] !== undefined && typeof input[key] !== "boolean") throw Error(key+" must be a boolean.");
  if (!input.jobId) {
    if(input.refresh) throw Error("refresh:true requires a jobId.");
    return { cwd, jobs: listJobs(cwd) };
  }
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
  if(input.refresh) {
    if(S.active.has(state.status)) throw Error("Wait for a completed job before refreshing review inputs.");
    const full=S.scoped(state.jobId,cwd), seen=full.updatedAt;
    const current=snapshot(full.executionCwd), visibility=finishVisibility(full,S.jobDir(full.jobId));
    const observation=S.stageBlobs({storage:full.storage,...visibility,...storedReview({...full,...visibility},current)});
    S.transaction(()=>{
      const fresh=S.scoped(full.jobId,cwd,{blobs:false});
      if(fresh.updatedAt!==seen || S.active.has(fresh.status)) throw Error("Job changed during refresh; retry status refresh.");
      S.assertIdle(cwd,full.jobId);
      S.save({...fresh,...observation,updatedAt:S.now()});
    },"status:refresh");
    state=load();
  }
  const result = summary(state);
  if (!S.active.has(state.status) && state.assignment) {
    result.reviewFingerprint = state.reviewFingerprint || null;
    result.reviewFingerprintReason = state.reviewFingerprintReason || (state.reviewFingerprint ? null : "No stored review observation; verification must observe the current inputs.");
    result.verificationCommands = state.reviewVerificationCommands || state.checkPlan?.checks || state.assignment.verification;
    if(input.includeProfileChecks === false) {
      result.reviewFingerprint=state.reviewFingerprintWithoutProfile || null;
      result.reviewFingerprintReason=state.reviewWithoutProfileReason || (result.reviewFingerprint ? null : "Use refresh:true to observe this check plan.");
      result.verificationCommands=state.reviewCommandsWithoutProfile || state.assignment.verification;
    }
    result.hostCheckAdvisories=result.verificationCommands.filter(c=>c.host && inlineCommand([c.command,...(c.args||[])])).map(c=>({id:c.id,note:"Inline code in host check: inspect before supplying hostAck."}));
  }
  if (!S.active.has(state.status) && state.assignment && !state.readOnly) {
    const observed = hiddenState(state); result.hiddenChanges = observed.changes;
    if (result.changes) result.changes = { ...result.changes, hiddenChanges: observed.changes };
  }
  if (state.handbookPublication === "pending") {
    try { result.handbookPublication = H.publicationPending(cwd) ? "pending" : "published"; } catch {}
  }
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
    result.acceptanceCurrent = null;
    result.acceptanceCurrentReason = "Status does not rehash files; verify, review and delivery enforce current content.";
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
    "confirmImported",
    "text",
    "expectedHandbookVersion",
    "expectedHandbookHash",
  ]);
  const cwd = S.workspace(input.cwd);
  const profile = P.loadProfile(cwd, {
    branch: input.key && input.key !== "cwd" ? input.key : undefined,
  });
  if (input.action === "handbook_get") return { cwd, handbook: H.readHandbook(cwd) };
  if (input.action === "handbook_replace") return { cwd, handbook: H.replaceHandbook(cwd, input, profile) };
  const contextScope = contextKey(cwd, profile, input.key);
  const readContext = () => {
    const row = S.db()
      .prepare("SELECT data FROM contexts WHERE cwd=?")
      .get(contextScope);
    return row
      ? leadContext(JSON.parse(row.data))
      : { version: 0, decisions: [], openQuestions: [], dependencies: [] };
  };
  if ((input.action || "get") === "get")
    return {
      cwd,
      context: readContext(),
      handbook: H.readHandbook(cwd),
      ...contextJobs(S.projectJobs(cwd)),
    };
  if (input.action !== "update")
    throw new Error("action must be get, update, handbook_get or handbook_replace.");
  return S.transaction(() => {
    const context = readContext();
    if (input.expectedVersion !== context.version)
      throw new Error(
        "Context changed; read version " +
          context.version +
          " before updating.",
      );
    const confirmed = new Set(input.confirmImported || []);
    if (!Array.isArray(input.confirmImported || []) || [...confirmed].some(i => !Number.isInteger(i) || !context.importedNotes?.[i])) throw Error("confirmImported requires valid imported note indexes.");
    for (const i of confirmed) { const note = context.importedNotes[i]; context[note.field] = [...new Set([...(context[note.field] || []), note.text])]; }
    const next = {
      importedNotes: (context.importedNotes || []).filter((_, i) => !confirmed.has(i)),
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
      nextSteps: C.strings(input.nextSteps ?? context.nextSteps ?? [], "nextSteps"),
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
    queueStateCard(S.db(), S.key(cwd), contextScope);
    return { cwd, context: next };
  }, "context:update");
}
/**
 * Hashing the project, policy inspection and check planning happen before the
 * transaction. The transaction only confirms the job is unchanged and idle,
 * then records the verification.
 */
function prepareVerification(state, input = {}) {
  S.assertIdle(state.cwd, state.jobId);
  P.currentProfile(state);
  state = { ...state, hostAck: input.hostAck, automaticVerification: !!input.automatic, checkLauncher: state.checkLauncher || resolveCodex() };
  const current = snapshot(state.executionCwd),
    delta = changes(state.baseline, current, state.assignment.scope);
  if (delta.outOfScope.length || delta.gitMetadataChanged)
    throw new Error(
      "Out-of-scope or Git metadata changes must be resolved before verification.",
    );
  for (const check of state.assignment.verification) G.allowCommand(state.profile, [check.command, ...check.args], check);
  if (state.profile) {
    const findings = Q.inspectPolicy(state, current);
    Q.enforceFindings(state.profile, findings);
    state = {
      ...state,
      policyFindings: findings,
      checkPlan: G.planChecks(state, current, delta.files, input),
    };
  }
  if (verificationCommands(state).some(c => c.host)) {
    if (input.automatic) throw Error("Host checks never run automatically.");
    if(state.visibilityRecorded) state={...state,...finishVisibility(state,S.jobDir(state.jobId))};
    requireHostAck(state, input.hostAck, current);
  }
  return S.stageBlobs({ ...state, containmentVersion: 1, status: "verifying", livePhase: "verification", progress: "Running independent checks.",
    decisionPacket: null, decisionPacketPath: null, cancelled: false, autoVerifySkipped: null,
    verification: { status: "running", startedAt: S.now(), checks: [] },
    verificationBaseline: current, heartbeatAt: S.now(), reviewStatus: "pending" });
}
/** Keep the implementation recoverable even when saving its verification plan fails. */
export async function prepareAutomaticVerification(jobId, { prepare = prepareVerification, save = persist } = {}) {
  try {
    const prepared = await retryBusy(() => prepare(S.read(jobId), { automatic: true }));
    const skipped = autoVerifyGate(prepared, changes(prepared.baseline, prepared.verificationBaseline, prepared.assignment.scope).files, prepared.checkPlan?.checks || prepared.assignment.verification);
    if (skipped) {
      await save(jobId, fs.existsSync(artifact(jobId, "cancel")) ? { status: "verification_failed", cancelled: true } : { status: "implementation_finished", autoVerifySkipped: skipped });
      return false;
    }
    await save(jobId, prepared);
    return true;
  } catch (error) {
    await save(jobId, fs.existsSync(artifact(jobId, "cancel")) ? { status: "verification_failed", cancelled: true } : { status: "implementation_finished", autoVerifySkipped: { reason: error.message } });
    return false;
  }
}
export function verifyJob(input) {
  const cwd = S.workspace(input.cwd);
  let state = S.recover(S.scoped(input.jobId, cwd));
  if (isScout(state)) throw new Error("Scouts cannot be verified as code.");
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
  const prepared = prepareVerification(state, input);
  if (state.verifiedFingerprint === verificationFingerprint(prepared.verificationBaseline) && ["verified", "accepted"].includes(state.status) && state.decisionPacket?.status === "ready" && state.decisionPacket.assignmentHash === PC.digest(state.assignment)) return summary(state);
  const next = { ...prepared, workerPid: null, supervisorPid: null };
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
/** Persist publication success separately from acceptance; failed writes remain retryable. */
function finishHandbookPublication(state, held = false) {
  const status = H.finishPublication(state.cwd, held);
  if (status === "published") {
    try { S.patch(state.jobId, { handbookPublication: "published" }); }
    catch { return "pending"; }
  }
  return status;
}
export function reviewJob(input) {
  if (input.handbookNotes === "all") throw Error("handbookNotes all is removed; select explicit note indexes.");
  C.object(input, "review", ["cwd", "jobId", "action", "summary", "evidence", "handbookNotes", "packetEvidenceOverrides", "packetFileObservations", "findingDispositions"]);
  const cwd = S.workspace(input.cwd);
  const planned = S.scoped(input.jobId, cwd);
  const dispositions = findingDispositions(planned, input.findingDispositions, input.action === "accept");
  if (input.action === "accept" && isScout(planned)) throw new Error("Scouts cannot be accepted as code.");
  if (input.action === "accept" && planned.status === "accepted") {
    if (input.evidence === "packet") resolvePacketEvidence(planned, input.packetEvidenceOverrides, snapshot(planned.executionCwd).fingerprint, input.packetFileObservations);
    pruneJobBytes(planned.jobId);
    const result = summary(planned);
    if (planned.handbookPublication === "pending") result.handbookPublication = finishHandbookPublication(planned);
    return result;
  }
  const selectedNotes = input.action === "accept" ? H.selectNotes(planned, input.handbookNotes) : [];
  const plannedIdentity = JSON.stringify(planned);
  if (input.action === "accept" && !["verified", "pending_lead_evidence", "accepted"].includes(planned.status))
    throw new Error("Acceptance requires independent verification to pass.");
  // Acceptance compares the project with the verified fingerprint. Hash it
  // before taking the lock; the transaction re-reads the job itself.
  const current =
    input.action === "accept"
      ? snapshot(S.scoped(input.jobId, cwd, { blobs: false }).executionCwd)
      : null;
  const currentFingerprint = current ? current.fingerprint : null;
  if (input.evidence === "packet" && input.action === "accept")
    input = { ...input, evidence: resolvePacketEvidence(planned, input.packetEvidenceOverrides, currentFingerprint, input.packetFileObservations) };
  else if (input.packetEvidenceOverrides !== undefined) throw Error("packetEvidenceOverrides requires evidence: packet and accept.");
  const findings = input.action === "accept" && planned.profile ? (() => {
    P.currentProfile(planned);
    const result = Q.inspectPolicy(planned, current);
    Q.enforceFindings(planned.profile, result);
    Q.expandCriteria(planned.profile, { ...planned.assignment, scope: changes(planned.baseline, current).files },
      planned.criteriaTemplates, planned.criteriaOmissions);
    return result;
  })() : null;
  const reviewed = input.action === "accept" && planned.profile ? E.leadEvidence(planned, input.evidence) : null;
  const staleContext = input.action === "accept" ? (planned.contextPacks?.docs || [])
    .filter(d => PC.digest(PC.readProject(planned.profile, planned.cwd, d.file)) !== d.hash).map(d => d.file) : [];
  const record = () => {
    const prepared = input.action === "accept" ? H.prepareAcceptedNotes(cwd, planned, selectedNotes) : null;
    const result = S.transaction(() => {
      let state = S.recover(S.scoped(input.jobId, cwd));
      S.assertIdle(cwd, state.jobId);
      if (JSON.stringify(state) !== plannedIdentity)
        throw new Error("Job changed while review was prepared; retry review.");
      if (S.active.has(state.status))
        throw new Error("Wait for the job before recording a review.");
      if (!["accept", "request_changes", "note"].includes(input.action))
        throw new Error("Unknown review action.");
      const review = {
        action: input.action,
        summary: C.text(input.summary, "review summary"),
        at: S.now(),
        reviewer: "Claude tech lead",
        findingDispositions: dispositions, findingPacketHash: findingPacketBinding(state.findingPacketHash),
        evidence: input.evidence || [],
        ...(input.packetFileObservations !== undefined ? { packetFileObservations: input.packetFileObservations } : {}),
        ...(input.handbookNotes !== undefined ? { handbookNotes: input.handbookNotes } : {}),
      };
      if (input.action === "accept") {
        if (!["verified", "pending_lead_evidence", "accepted"].includes(state.status))
          throw new Error(
            "Acceptance requires independent verification to pass.",
          );
        if (!state.result || state.result.blockers.length)
          throw new Error("Resolve reported blockers before acceptance.");
        if (
          currentFingerprint !== state.verifiedFingerprint
        )
          throw new Error(
            "Files changed after verification; verify again before acceptance.",
          );
        if (state.profile) {
          if (
            state.secretFindings?.length &&
            PC.enforced(state.profile, "secrets")
          )
            throw new Error(
              "Resolve recorded secret findings before acceptance.",
            );
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
            "source",
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
          ...(prepared ? { handbookPublication: "pending" } : {}),
          ...(state.delivery && !PC.enforced(state.profile, "report")
            ? { delivery: { ...state.delivery, ready: true } }
            : {}),
        };
      } else if (input.action === "request_changes") {
        state = { ...state, reviewStatus: "changes_requested" };
        if (state.status === "accepted") state.status = "verified";
      }
      if (input.action === "accept") H.mergeAcceptedNotes(prepared);
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
    if (result.status === "accepted") pruneJobBytes(result.jobId);
    if (prepared && result.status === "accepted") result.handbookPublication = finishHandbookPublication(result, true);
    return result;
  };
  if (!selectedNotes.length) return record();
  let accepted;
  try { return H.withHandbook(cwd, () => { accepted = record(); return accepted; }); }
  catch (error) {
    if (accepted?.status === "accepted") return { ...accepted, handbookPublication: "pending" };
    throw error;
  }
}
export function integrateJob(input) {
  const cwd = S.workspace(input.cwd);
  if (isScout(S.scoped(input.jobId, cwd))) throw new Error("Scouts cannot be integrated as code.");
  if (PC.enabled(S.scoped(input.jobId, cwd).profile, "branchMode"))
    return summary(commitJob(input));
  // A project lease serializes delivery; hashing and filesystem operations stay outside DB transactions.
  let planned = S.scoped(input.jobId, cwd);
  if(planned.visibilityRecorded) planned={...planned,...finishVisibility(planned,S.jobDir(planned.jobId))};
  const current = snapshot(planned.executionCwd),
    origin = snapshot(cwd);
  const integratedFingerprint = current.fingerprint;
  if (planned.gitConfigChanged?.changed) requireHostAck(planned, input.hostAck, current);
  return S.withProjectOperation(cwd, () => {
    const state = S.scoped(input.jobId, cwd);
    S.assertIdle(cwd, state.jobId);
    if (state.isolation !== "worktree" || state.status !== "accepted")
      throw new Error("Integration requires an accepted worktree job.");
    if (integratedFingerprint !== state.acceptedFingerprint)
      throw new Error("Worktree changed after acceptance. "+reviewInputDetails(planned,current).text);
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
    const r = spawnSync(trustedExecutable("taskkill.exe"), ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 10000,
    });
    if (r.status !== 0 && S.alive(pid))
      throw new Error(
        "Could not terminate process tree: " +
        String(r.error?.message || r.stderr || r.stdout || r.status).trim().slice(0, 500),
      );
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
export async function retryBusy(operation, { timeoutMs = 60000, delayMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { return operation(); }
    catch (error) {
      if (!S.isBusy(error)) throw error;
      if (Date.now() >= deadline) throw new Error("Database remained busy for " + timeoutMs + " ms; retry the operation after contention clears.", { cause: error });
      await sleep(Math.min(delayMs, Math.max(1, deadline - Date.now())));
    }
  }
}
export async function persist(jobId, changes, attempts = 5) {
  if (changes.status && !S.active.has(changes.status)) changes = { livePhase: null, ...changes };
  for (let attempt = 1; ; attempt++) {
    try {
      if (changes.status && !S.active.has(changes.status)) {
        const current = S.readRaw(jobId);
        if (current.reservation) changes = { ...changes, reservation: null };
        if (current.autoResumes?.length && !changes.autoResumes)
          changes = {
            ...changes,
            autoResumes: current.autoResumes.map(r => r.finishedAt ? r : {
              ...r, finishedAt: S.now(), outcome: changes.status,
            }),
          };
      }
      let previousExecs;
      if (changes.execs) try { previousExecs = S.readRaw(jobId).execs; } catch {}
      const saved = S.patch(jobId, changes);
      if (changes.execs) recordFinishedExecs(saved, previousExecs);
      if (saved.status === "cancelled") pruneJobBytes(jobId);
      else if (saved.cancelled) pruneJobBytes(jobId, ["review-copies"]);
      return saved;
    } catch (error) {
      if (!S.isBusy(error) || attempt >= attempts) throw error;
      await sleep(1000 * attempt);
    }
  }
}
export async function runProcess(
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
    checkCleanup,
    timer,
    exited = false,
    stopReason = null,
    pending = "",
    parseError = null,
    authFailure = null,
    authFailureSource = "stderr";
  const stderr = fs.openSync(errorFile, "a", 0o600),
    stdout = fs.openSync(eventsFile, "a", 0o600),
    started = Date.now();
  const observationWriter = onEvent ? createObservationWriter(state.jobId, {lastWriteAt: started, onError: error => recordWorkerFault(state.jobId, error, "observation")}) : null;
  const trackCommands = commandTracker();
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
    if (fs.existsSync(artifact(state.jobId, "cancel"))) {
      stopReason = "cancelled";
      return { code: null, stopReason };
    }
    const childStartedAt = S.now();
    if (onEvent) {
      state.execAttempt ??= 0;
      state.execRole ??= "implementation";
      await persist(state.jobId, {
        ...(state.execRole === "reviewer" ? {} : { execAttempt: state.execAttempt }),
        modelChildStartedAt: childStartedAt,
        lastEventAt: childStartedAt,
        runningCommandStartedAt: null,
        runningCommandCount: 0,
        execs: [...(S.readRaw(state.jobId).execs || []), {
          role: state.execRole,
          ...(state.reviewRunId ? { reviewRunId: state.reviewRunId } : {}),
          attempt: state.execAttempt,
          threadId: state.threadId || null,
          startedAt: childStartedAt,
          finishedAt: null,
          usage: null,
          model: state.model || null,
          freshThread: !state.threadId,
          outcome: "running",
        }],
      });
    }
    let environment = G.workerEnvironment(state, !onEvent, state.activeCheck?.passEnv);
    if (!onEvent) {
      command = resolveCheckExecutable(command, state.executionCwd, environment); G.allowCommand(state.profile, [command, ...args], state.activeCheck);
      const invocation = checkInvocation(state, { ...state.activeCheck, command, args }, state.checkLauncher || resolveCodex());
      checkCleanup = invocation.cleanup;
      command = invocation.command; args = invocation.args; environment = { ...invocation.env, PATH: environment.PATH || environment.Path };
    }
    if (state.execRole === "reviewer" || (onEvent && (state.salvage || state.autoResumes?.length))) assertReviewInstructions(state);
    child = spawn(command, args, {
      cwd: state.executionCwd,
      env: environment,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      S.patch(state.jobId, {
        codexPid: child.pid,
        childStartedAt, // 1.1.5 servers use this timestamp to identify the live child.
        ...(!onEvent ? { verificationChildStartedAt: childStartedAt } : {}),
        childRole: onEvent ? (state.execRole === "reviewer" ? "reviewer" : "codex") : "verification",
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
          child.stderr?.destroy();
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
        if (!secureLogs) fs.writeSync(stdout, line + "\n");
        parseError = "Malformed JSON event in Codex output.";
        return;
      }
      if (!secureLogs) fs.writeSync(stdout, JSON.stringify(trimEvent(event)) + "\n");
      try {
        const observedAt = S.now();
        const observation = { lastEventAt: observedAt, ...trackCommands(event, observedAt) };
        if (["agent_message", "reasoning", "reasoning_summary"].includes(event.item?.type)) observation.readableTail = PC.scan(redactDefault(String(event.item.text || (Array.isArray(event.item.summary) ? event.item.summary.map(part => part.text || "").join(" ") : event.item.summary) || "")), state.profile).text.slice(-1000);
        const boot = bootstrapReads(event, state.bootstrapReads);
        if (boot.count) { state.bootstrapReads = boot; observation.bootstrapReads = boot; }
        observationWriter.note(observation);
        if (["error","turn.failed"].includes(event.type)) noteAuth(event.message || event.error?.message || "", "event");
        onEvent(event);
      } catch (e) {
        parseError = e.message;
      }
    };
    child.stdout.setEncoding("utf8");
    const noteAuth = (text, source = "stderr") => {
      if (!onEvent || authFailure) return; // Verification stderr belongs to the checked application.
      const failure = D.classifyFailure(text, {source});
      if (failure?.kind !== "auth_expired") return;
      authFailure = text;
      authFailureSource = source;
      if (state.execRole !== "reviewer") try { S.withBusyTimeout(0, () => S.patch(state.jobId, {runtimeFailure:failure})); } catch {}
    };
    let diagnosticLine = "", oversizedDiagnostic = false, diagnosticReceivedAt = 0;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", data => {
      diagnosticReceivedAt = Date.now();
      for (const part of data.match(/[^\n]*\n|[^\n]+$/g) || []) {
        if (!oversizedDiagnostic) diagnosticLine += part;
        if (diagnosticLine.length > 65536) { diagnosticLine = ""; oversizedDiagnostic = true; }
        if (part.endsWith("\n")) {
          if (!oversizedDiagnostic) noteAuth(diagnosticLine);
          diagnosticLine = ""; oversizedDiagnostic = false;
        }
      }
      if (secureLogs) buffer("err", data); else fs.writeSync(stderr, data);
    });
    child.stdout.on("data", (data) => {
      if (secureLogs) buffer("out", data);
      else if (!onEvent) fs.writeSync(stdout, data);
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
    child.stdin.end((typeof input === "function" ? input() : input) || "");
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
      observationWriter?.flush();
      // Some CLI errors omit a trailing newline; retain the whole attributed line.
      if (!oversizedDiagnostic && diagnosticLine && Date.now() - diagnosticReceivedAt >= 500) noteAuth(diagnosticLine);
      if (exited || stopReason) return;
      const reason = fs.existsSync(artifact(state.jobId, "cancel"))
        ? "cancelled"
        : authFailure ? "blocked_runtime"
        : Date.now() - started > timeoutSeconds * 1000 || (onEvent && state.execRole !== "reviewer" && !state.salvage && Date.now() >= Date.parse(state.deadlineAt))
          ? "timed_out"
          : parseError
            ? "failed"
            : authFailure ? "blocked_runtime" : stopRequested?.() || null;
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
    if (!oversizedDiagnostic && diagnosticLine) noteAuth(diagnosticLine);
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
            return JSON.stringify(trimEvent(result.value));
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
      ...(authFailure ? { authFailure, authFailureSource } : {}),
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
    observationWriter?.finish({runningCommandStartedAt: null, runningCommandCount: 0});
    if (!onEvent) queueRun({id: `${state.jobId}:verification:${started}`,kind:"verification",cwd:state.cwd,at:S.now(),durationSeconds:(Date.now()-started)/1000,inputTokens:null,cachedTokens:null,outputTokens:null,outcome:stopReason || (exited && child?.exitCode === 0 ? "finished" : "failed"),cliVersion:state.runtime?.version || null,model:state.model || null,effort:state.effort || null});
    try { checkCleanup?.(); } catch(error) { recordWorkerFault(state.jobId,error,"check-temp-cleanup"); }
    fs.closeSync(stderr);
    fs.closeSync(stdout);
  }
}
/** Thread durability must survive a transient read failure in the event callback. */
export function noteThreadStarted(jobId, threadId, progress, readRaw = S.readRaw) {
  let execs;
  try {
    execs = (readRaw(jobId).execs || []).map(exec => exec.finishedAt
      ? exec : { ...exec, threadId });
  } catch {} // The progress writer retains/retries the thread ID itself.
  progress.note({ threadId, ...(execs ? { execs } : {}) }, true);
}
function finishModelExec(state, outcome) {
  return (state.execs || []).map(exec => exec.finishedAt || exec.role !== "implementation" ? exec : {
    ...exec, threadId: state.threadId || exec.threadId, finishedAt: S.now(), usage: state.usage || null, outcome,
  });
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
  if (isScout(state)) {
    Object.assign(state, { mode: "scout", readOnly: true, readOnlyDraft: true });
    await persist(jobId, { mode: "scout", readOnly: true, readOnlyDraft: true });
    writeJson(artifact(jobId, "report-schema.json"), C.scoutReportSchema);
  }
  const workerHeartbeat=setInterval(()=>{try{S.withBusyTimeout(0,()=>S.heartbeat(jobId));}catch{}},1000);
  let privateReportDirectory = null,
    verificationLease = false;
  const releaseChecks = async () => {
    if (!verificationLease) return;
    await retryBusy(() => S.transaction(() => {
      const key = state.profile.repoId;
      S.setExtension("check-leases", key, { jobs: (S.extension("check-leases", key)?.jobs || []).filter(id => id !== jobId) });
    }, "lease:release"));
    verificationLease = false;
  };
  const hasBudget = async () => {
    try { E.assertBudget(state); return true; }
    catch (error) {
      await persist(jobId, {
        status: "budget_exhausted", error: error.message, finishedAt: S.now(),
        ...(state.autoResumes?.length ? { autoResumes: state.autoResumes.map(resume => resume.finishedAt ? resume : {
          ...resume, finishedAt: S.now(), outcome: "budget_exhausted",
        }) } : {}),
      });
      return false;
    }
  };
  try {
    P.currentProfile(state);
    if (fs.existsSync(artifact(jobId, "cancel"))) {
      await persist(jobId, { status: verification ? "verification_failed" : "cancelled", ...(verification ? { cancelled: true } : {}), finishedAt: S.now() });
      return;
    }
    if (!verification && state.autoResumes?.length && !await hasBudget()) return;
    if (verification && isScout(state)) throw new Error("Scouts cannot be verified as code.");
    if (verification) {
      if (PC.enabled(state.profile, "gates")) {
        const deadline = Date.now() + state.timeoutSeconds * 1000;
        while (!verificationLease) {
          verificationLease = await retryBusy(() => S.transaction(() => {
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
          }));
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
      const checks = [], { before } = inspectVerificationRequest(state);
      const specifications = orderedChecks(state);
      for (const spec of specifications) {
        await persist(jobId, { activeCheck: { id: spec.id, host: spec.host === true }, progress: "Running check " + spec.id });
        const attempts = [];
        let result, stdoutPath, stderrPath;
        G.allowCommand(state.profile, [spec.command, ...spec.args], spec);
        for (
          let attempt = 0;
          attempt <= (spec.retryOnTimeout || 0);
          attempt++
        ) {
          if(spec.host) Object.assign(state,await backgroundFacts("host",state));
          stdoutPath = artifact(
            jobId,
            "verify-" + spec.id + (attempt ? "-retry" : "") + ".stdout.log",
          );
          stderrPath = artifact(
            jobId,
            "verify-" + spec.id + (attempt ? "-retry" : "") + ".stderr.log",
          );
          fs.writeFileSync(stdoutPath, "");
          fs.writeFileSync(stderrPath, "");
          if (spec.coveragePath && fs.existsSync(spec.coveragePath))
            fs.unlinkSync(spec.coveragePath);
          result = await runProcess({ ...state, activeCheck: spec }, spec.command, spec.args, {
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
        const sandboxLimited = !spec.host && result.code !== 0 && sandboxLimitation(tail(stdoutPath) + "\n" + tail(stderrPath), state.executionCwd);
        checks.push({
          ...spec,
          executedIn: spec.host ? "host" : "sandbox",
          ...(spec.host && inlineCommand([spec.command,...spec.args]) ? {advisory:"Inline code: host execution was acknowledged by the lead."} : {}),
          ...(sandboxLimited ? { sandboxLimited: true, hint: "Review the diff and re-run an explicit host check with hostAck." } : {}),
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
          attempts, coverageError, tests: G.countLogs(stdoutPath, stderrPath),
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
      await persist(jobId,{progress:"Finalizing checks: observing content and hidden changes.",heartbeatAt:S.now()});
      const {after,...visibility}=await backgroundFacts("verification",state);
      Object.assign(state,visibility);
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
      await releaseChecks();
      await persist(jobId, {
        ...visibility,...storedReview(state,after,{planned:true}),
        status: "verifying", livePhase: "reviewer", progress: "Reviewing acceptance criteria.", reviewerStartedAt: S.now(),
        verifiedFingerprint: passed ? after.fingerprint : null,
        verification: {
          status: passed ? "passed" : "failed",
          checks,
          filesChangedDuringChecks: before.fingerprint !== after.fingerprint,
          finishedAt: S.now(),
        },
        finishedAt: S.now(),
      });
      if (fs.existsSync(artifact(jobId, "cancel"))) {
        await persist(jobId, { status: "verification_failed", cancelled: true, finishedAt: S.now() });
        return;
      }
      await runReviewer(S.read(jobId), after, passed, { runProcess, buildArgs, resolveCodex, persist, progressWriter, retryBusy });
      return;
    }
    await persist(jobId, { status: "running", livePhase: "implementation" });
    const binary = resolveCodex();
    const runtime = D.inspectRuntime(binary, state.executionCwd);
    await persist(jobId, { runtime });
    const preflight = D.probeRuntime(binary, runtime, state.cwd, {
      readOnly: state.readOnly,
      executionCwd: state.executionCwd,
      timeoutMs: state.deadlineAt ? Math.max(1, Date.parse(state.deadlineAt) - Date.now()) : state.timeoutSeconds * 1000,
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
    if (state.deadlineAt && Date.now() >= Date.parse(state.deadlineAt)) {
      await persist(jobId, { status: "timed_out", finishedAt: S.now() });
      return;
    }
    if (!await hasBudget()) return;
    captureVisibility(state, S.jobDir(jobId));
    const reportedPaths = [];
    const failure = failureTracker();
    let runtimeFailure = null,
      budgetExceeded = false,
      turnIndex = 0;
    const secretFindings = [];
    let turnCompleted = false,
      turnFailed = false,
      commandDenied = false;
    const progress = progressWriter(jobId);
    let handbook = { text: "" };
    if (!(state.execAttempt > 0)) {
      const saved = artifact(jobId, "handbook.json");
      handbook = PC.sanitize(fs.existsSync(saved) ? json(saved) : H.readHandbook(state.cwd), state.profile);
      if (!fs.existsSync(saved) || !state.handbookAtStart || state.handbookAtStart.text !== undefined) {
        state.handbookAtStart = H.metadata(handbook);
        await persist(jobId, { handbookAtStart: state.handbookAtStart });
      }
    }
    let finalReportPath = artifact(jobId, "report.txt");
    if (PC.enabled(state.profile, "secrets")) {
      privateReportDirectory = fs.mkdtempSync(
        path.join(os.tmpdir(), "codex-team-report-" + jobId + "-"),
      );
      finalReportPath = path.join(privateReportDirectory, "report.txt");
    }
    let execOptions;
    let result = await runProcess(
      state,
      binary.command,
      [...binary.prefix, ...buildArgs(state, finalReportPath)],
      execOptions = {
        input: () => buildWorkerPrompt(state, handbook.text) + (isScout(state) ? '\nEvidence floor: use tools to read or search project files and cite at least one existing file with a valid current line range in the brief. No-evidence scouts cannot seed implementation.' : ''),
        eventsFile: artifact(jobId, "events.jsonl"),
        errorFile: artifact(jobId, "stderr.log"),
        timeoutSeconds: state.deadlineAt ? Math.max(0, (Date.parse(state.deadlineAt) - Date.now()) / 1000) : state.timeoutSeconds,
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
          if (reportedPaths.length < 2000) { if (event.item?.command) reportedPaths.push(event.item.command); for (const change of event.item?.changes || []) if (change.path) reportedPaths.push(change.path); }
          failure.note(event);
          if (event.type === "turn.started") {
            turnIndex++;
            turnCompleted = false;
            turnFailed = false;
          }
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
          if (/denied|not authorized|blocked by policy/i.test(diagnostic)) commandDenied = true;
          const diagnosticSource = ["error", "turn.failed"].includes(event.type) ? "event" : "command";
          const diagnosticFailure = D.classifyFailure(diagnostic, {source: diagnosticSource});
          if (diagnosticFailure && (diagnosticFailure.kind !== "auth_expired" || ["error", "turn.failed"].includes(event.type)))
            runtimeFailure = D.failureRecord(diagnostic, { cwd: state.cwd, source: diagnosticSource });
          if (event.type === "thread.started")
            noteThreadStarted(jobId, event.thread_id, progress);
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
    const pendingProgress = progress.take();
    const latest = { ...S.readRaw(jobId), ...pendingProgress };
    if (canSalvage(latest, result, fs.existsSync(artifact(jobId,"cancel")))) {
      await persist(jobId, { ...pendingProgress, execs: finishModelExec(latest, "timed_out") });
      state.execAttempt = (latest.execAttempt || 0) + 1;
      turnCompleted = false; turnFailed = false;
      result = await salvageRun(latest, {runProcess,buildArgs,binary,reportPath:finalReportPath,eventsFile:artifact(jobId,"events.jsonl"),errorFile:artifact(jobId,"stderr.log"),persist,onEvent:execOptions.onEvent});
      if (result.salvage.outcome === "salvaged") {
        const fresh = S.readRaw(jobId);
        await persist(jobId,{execs:fresh.execs.map(e=>e.attempt === (latest.execAttempt || 0) && e.role === "implementation" ? {...e,outcome:"salvaged"} : e)});
      }
    } else progress.note(pendingProgress, true);
    if (result.authFailure) runtimeFailure = D.failureRecord(result.authFailure, {cwd:state.cwd, source:result.authFailureSource});
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
    const delta = changes(isScout(state) ? state.attemptBaseline : state.baseline, after, state.assignment?.scope);
    Object.assign(state,finishVisibility(state,S.jobDir(jobId),reportedPaths));
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
    if ((state.assignment || isScout(state)) && !error)
      try {
        structured = state.mode === "scout" ? C.scoutReport(json(reportPath)) : C.report(json(reportPath));
      } catch (e) {
        error = "Invalid structured report: " + e.message;
      }
    if (isScout(state) && (delta.files.length || delta.gitMetadataChanged))
      error = "Read-only scout changed project files or Git metadata: " +
        [...delta.files, ...(delta.gitMetadataChanged ? ["Git metadata"] : [])].join(", ");
    const scoutFloor = isScout(state) && structured ? scoutEvidenceFloor(state, structured, scoutThreadEvents(state)) : null;
    if (scoutFloor?.status === 'failed') error = 'Invalid structured report: no-evidence';
    const successful =
      !result.stopReason && result.code === 0 && turnCompleted && !turnFailed && !error;
    const blockedText =
      structured?.blockers?.join("\n") ||
      (!state.assignment ? D.readTail(reportPath, 20000) : "");
    if (!runtimeFailure && D.classifyFailure(blockedText) && D.classifyFailure(blockedText).kind !== "auth_expired")
      runtimeFailure = D.failureRecord(blockedText, { cwd: state.cwd, source: "report" });
    if (
      (!runtimeFailure || ["command", "report"].includes(runtimeFailure.source)) &&
      result.code !== 0 &&
      D.classifyFailure(tail(artifact(jobId, "stderr.log")))
    )
      runtimeFailure = D.failureRecord(tail(artifact(jobId, "stderr.log")), {
        cwd: state.cwd,
      });
    if (runtimeFailure) {
      if (runtimeFailure.kind !== "auth_expired") runtimeFailure.recovery = D.recovery(
        state.cwd,
        jobId,
        runtimeFailure.diagnostics,
      );
      runtimeFailure.partialChanges = changes(
        state.attemptBaseline,
        after,
        state.assignment?.scope,
      );
      // Login failures belong to the job, not the persistent sandbox-health cache.
      if (runtimeFailure.kind !== "auth_expired" && ["stderr", "event"].includes(runtimeFailure.source)) D.recordFailure(
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
    const cliFailure = failure.text(result.code !== 0 ? tail(artifact(jobId, "stderr.log")) : "");
    const finalState = {
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
        (turnFailed ? cliFailure : null) || error ||
        (!turnCompleted ? cliFailure || "No turn.completed event was observed." : null),
      result: structured,
      ...(scoutFloor ? { evidenceFloor: scoutFloor } : {}),
      runtimeFailure,
      changes: delta,
      implementationFingerprint: after.fingerprint,
      visibilityRecorded:state.visibilityRecorded,hiddenChanges:state.hiddenChanges,gitConfigChanged:state.gitConfigChanged,
      durationMs: result.durationMs,
      finishedAt: S.now(),
      ...(state.profile ? { policyFindings, secretFindings } : {}),
    };
    finalState.cliFailure = cliFailure;
    if(state.assignment) Object.assign(finalState,storedReview({...state,...finalState},after));
    if (commandDenied) finalState.commandDenied = true;
    finalState.contractFailure = !!result.parseError || !!error?.startsWith("Invalid structured report:");
    if (successful) finalState.implementationFinishedAt = S.now();
    if (state.assignment && !state.readOnly && !isScout(state)) {
      finalState.lineStats=authoredLineStats(state,after);
      finalState.lineStatsAt=finalState.finishedAt;
    }
    const fresh = { ...S.readRaw(jobId), ...finalState };
    finalState.execs = finishModelExec(fresh, result.salvage?.outcome === "salvaged" ? "salvaged" : finalState.status);
    if (fresh.autoResumes?.length)
      finalState.autoResumes = fresh.autoResumes.map(r => r.finishedAt ? r : {
        ...r, finishedAt: S.now(), outcome: finalState.status,
      });
    if (S.alive(state.supervisorPid) && (fresh.autoResumes?.length || 0) < 2 && classifyTransientFailure(fresh)) {
      // Old in-memory servers also understand starting + a live reservation.
      finalState.status = "starting";
      finalState.recoveryPhase = "pending";
      finalState.reservation = { pid: state.supervisorPid, at: S.now() };
    }
    const automatic = finalState.status === "implementation_finished" && state.autoVerify && (state.autoVerifyVersion === 12 || state.autoVerifyExplicit === true) && !state.provenance?.draftSourced && !state.provenance?.draftCheckOverlap && state.assignment && !state.readOnly && !isScout(state);
    if (automatic) {
      // Remain active while planning/gating, so no other writer can claim the project.
      await persist(jobId, { ...finalState, status: "verifying", livePhase: "verification", reservation: null });
      if (!await prepareAutomaticVerification(jobId)) return;
      await worker(jobId, true);
    } else await persist(jobId, finalState);
  } catch (e) {
    try {
      let observation={};
      if(verification) try {const {after,...visibility}=await backgroundFacts("verification",state);observation={...visibility,...storedReview({...state,...visibility},after,{planned:true})};}
      catch(failure){observation={reviewFingerprint:null,reviewFingerprintReason:failure.message.slice(0,300)};}
      await persist(jobId, {
        ...observation,
        ...(verification && e.message.startsWith("Host check refused") ? {result:{...state.result,blockers:[...(state.result?.blockers || []),e.message]}} : {}),
        status: verification ? "verification_failed" : fs.existsSync(artifact(jobId, "cancel")) ? "cancelled" : "failed",
        ...(verification && fs.existsSync(artifact(jobId, "cancel")) ? { cancelled: true } : {}),
        ...(!verification ? { execs: finishModelExec(S.readRaw(jobId), "failed") } : {}),
        error: e.message,
        finishedAt: S.now(),
      });
    } catch (writeError) {
      recordWorkerFault(jobId, writeError, "final");
    }
  } finally {
    try { await releaseChecks(); } catch (error) { recordWorkerFault(jobId, error, "lease:release"); }
    clearInterval(workerHeartbeat);
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
