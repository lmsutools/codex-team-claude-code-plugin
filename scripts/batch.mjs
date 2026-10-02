/** Isolated batch orchestration with deterministic advisory visibility. */
import { verificationFingerprint } from "./hidden-inventory.mjs";
import fs from "node:fs";
import {storedReview} from "./review-state.mjs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as S from "./store.mjs";
import * as C from "./contracts.mjs";
import { git, snapshot, integrateFiles, changes } from "./git.mjs";
import { loadProfile, assertApproved, currentProfile } from "./profile.mjs";
import { enabled, matches, digest, branch } from "./policy-core.mjs";
import { capturePolicy } from "./policy-checks.mjs";
import { startJob, statusJob, verifyJob } from "./runtime.mjs";
import { commitJob } from "./delivery.mjs";

const overlap = (a, b) =>
  a.some((x) =>
    b.some(
      (y) =>
        x === "." ||
        y === "." ||
        x === y ||
        x.startsWith(y + "/") ||
        y.startsWith(x + "/"),
    ),
  );
function unionAssignment(assignments) {
  const scope = [],
    criteria = [],
    verification = [];
  for (const [index, state] of assignments.entries()) {
    const criterionOffset = criteria.length;
    scope.push(...state.assignment.scope);
    criteria.push(...state.assignment.acceptanceCriteria);
    verification.push(
      ...state.assignment.verification.map((c) => ({
        ...c,
        id: "part" + index + "-" + c.id,
        ...(c.criteria ? { criteria: c.criteria.map(n => n + criterionOffset) } : {}),
      })),
    );
  }
  if (verification.length > 20 || criteria.length > 200)
    throw new Error(
      "Union assignment exceeds bounded verification/criteria limits.",
    );
  return C.assignment({
    objective: "Verify the combined batch result.",
    scope: [...new Set(scope)],
    acceptanceCriteria: criteria,
    verification,
  });
}
export async function batchTool(input) {
  const cwd = S.workspace(input.cwd);
  if (input.action !== "start") {
    const batch = S.extension("batch", input.batchId);
    if (!batch || batch.cwd !== cwd)
      throw new Error("Unknown batch in this project.");
    const children = [];
    for (const child of batch.children)
      children.push(
        child.jobId
          ? await statusJob({ cwd: child.cwd, jobId: child.jobId })
          : child,
      );
    batch.reviewFingerprint=digest(children.map(c=>({jobId:c.jobId,reviewFingerprint:c.reviewFingerprint})));
    batch.gitConfigChanged={changed:children.some(c=>c.gitConfigChanged?.changed),heading:"Batch Git configuration observations",children:children.filter(c=>c.gitConfigChanged?.changed).map(c=>c.jobId)};
    if (input.action === "status") return { ...batch, children };
    if(batch.gitConfigChanged.changed && input.hostAck!==batch.reviewFingerprint) throw Error("Batch host integration requires hostAck equal to the batch reviewFingerprint.");
    if (input.action !== "integrate") throw new Error("Unknown batch action.");
    return integrateBatch(batch, children, input);
  }
  if (!input.requestId?.trim())
    throw new Error("Batch requires a stable requestId.");
  const profile = loadProfile(cwd, { branch: input.branch, lane: input.lane });
  if (!enabled(profile, "parallel"))
    throw new Error("Enable parallel before starting a batch.");
  assertApproved(profile);
  if (!input.authorization?.trim())
    throw new Error(
      "Record the existing user authorization for multiple workers.",
    );
  if (
    !Array.isArray(input.assignments) ||
    !input.assignments.length ||
    input.assignments.length > (profile.components.parallel.maxWorkers || 3)
  )
    throw new Error("Batch size exceeds the worker limit.");
  const assignments = input.assignments.map((item) => {
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(item.part || ""))
      throw new Error("Batch parts must be short lowercase identifiers.");
    return { part: item.part, assignment: C.assignment(item.assignment) };
  });
  if (new Set(assignments.map((a) => a.part)).size !== assignments.length)
    throw new Error("Duplicate batch part.");
  unionAssignment(assignments);
  for (let i = 0; i < assignments.length; i++)
    for (let j = i + 1; j < assignments.length; j++)
      if (
        overlap(
          assignments[i].assignment.scope,
          assignments[j].assignment.scope,
        )
      )
        throw new Error("Batch scopes overlap; no worker was launched.");
  const shared =
    profile.manifest?.appendOnly || profile.components.ownership?.shared || [];
  for (const a of assignments)
    if (a.assignment.scope.some((p) => matches(shared, p)))
      throw new Error(
        "Children cannot edit shared files; prewire them before the batch.",
      );
  if (profile.components.parallel.prewire?.required) {
    const prewire = input.prewireJobId ? S.read(input.prewireJobId) : null;
    if (
      !prewire ||
      prewire.profile?.repoId !== profile.repoId ||
      S.key(prewire.executionCwd) !== S.key(cwd) ||
      prewire.status !== "accepted" ||
      snapshot(prewire.executionCwd).fingerprint !== prewire.acceptedFingerprint
    )
      throw new Error(
        "Batch requires a current accepted prewire job in the parent worktree.",
      );
  }
  const requestKey = profile.repoId + ":" + cwd + ":" + input.requestId;
  const inputHash = digest({
    assignments,
    authorization: input.authorization,
    prewireJobId: input.prewireJobId || null,
    profileHash: profile.hash,
  });
  let batch;
  const before = snapshot(cwd), currentBranch = enabled(profile, "branchMode") ? branch(cwd) : null;
  S.transaction(() => {
    const saved = S.extension("batch-request", requestKey);
    if (saved) {
      batch = S.extension("batch", saved.batchId);
      if (batch.inputHash !== inputHash)
        throw new Error("Batch requestId was used with different inputs.");
      return;
    }
    S.assertIdle(cwd);
    if (
      S.extensions("batch").some(
        (b) =>
          b.cwd === cwd &&
          [
            "starting",
            "running",
            "conflict",
            "awaiting_union_verification",
          ].includes(b.status),
      )
    )
      throw new Error("This parent worktree already has an active batch.");
    if (before.dirty || !before.head)
      throw new Error("Batch parent must have a clean committed baseline.");
    if (enabled(profile, "branchMode") && currentBranch !== profile.branch)
      throw new Error("Start a branch batch from its own parent worktree.");
    if (
      enabled(profile, "branchMode") &&
      S.extension("branch", profile.repoId + ":" + profile.branch)?.cwd !== cwd
    )
      throw new Error(
        "Use a recorded parent worktree created by codex_start before starting a branch batch.",
      );
    const batchId = randomUUID();
    batch = {
      batchId,
      cwd,
      inputHash,
      profile,
      baseline: before,
      status: "starting",
      authorization: input.authorization,
      children: assignments.map((a) => ({
        ...a,
        cwd: path.join(S.stateRoot(), "batch-worktrees", batchId, a.part),
        branch:
          profile.components.parallel.childBranch
            ?.replaceAll("{branch}", profile.branch)
            .replaceAll("{part}", a.part) || profile.branch + "--" + a.part,
      })),
      at: S.now(),
      integrated: [],
    };
    S.setExtension("batch", batchId, batch);
    S.setExtension("batch-request", requestKey, { batchId });
  });
  if (batch.status !== "starting") return batch;
  for (let i = 0; i < batch.children.length; i++) {
    const child = batch.children[i];
    if (child.jobId) continue;
    if (!fs.existsSync(child.cwd)) {
      fs.mkdirSync(path.dirname(child.cwd), { recursive: true });
      git(
        cwd,
        enabled(profile, "branchMode")
          ? [
              "worktree",
              "add",
              "-b",
              child.branch,
              child.cwd,
              batch.baseline.head,
            ]
          : ["worktree", "add", "--detach", child.cwd, batch.baseline.head],
      );
    }
    if (enabled(profile, "branchMode"))
      S.transaction(() =>
        S.setExtension("branch", profile.repoId + ":" + child.branch, {
          cwd: fs.realpathSync(child.cwd),
          branch: child.branch,
          at: S.now(),
        }),
      );
    const job = startJob({
      cwd: child.cwd,
      assignment: child.assignment,
      requestId: input.requestId + ":" + child.part,
      batchId: batch.batchId,
      branch: enabled(profile, "branchMode") ? child.branch : profile.branch,
      lane: profile.lane || undefined,
    });
    child.jobId = job.jobId;
    S.transaction(() => S.setExtension("batch", batch.batchId, batch));
  }
  batch.status = "running";
  S.transaction(() => S.setExtension("batch", batch.batchId, batch));
  return batch;
}
function batchJournal(batch, data) {
  const dir = path.join(S.stateRoot(), "batch-intents");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, batch.batchId + ".json");
  if (data) {
    fs.writeFileSync(file + ".tmp", JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(file + ".tmp", file);
  }
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}
function integrateBatch(batch, children, input = {}) {
  if (batch.unionJobId)
    return {
      ...batch,
      next: "Verify, review and report the union job.",
      unionJobId: batch.unionJobId,
    };
  const profile = loadProfile(batch.cwd, {
    branch: batch.profile.branch,
    lane: batch.profile.lane,
  });
  if (profile.hash !== batch.profile.hash)
    throw new Error("Batch policy changed.");
  assertApproved(profile);
  return S.withProjectOperation(batch.cwd, () => {
    S.assertIdle(batch.cwd);
    // Status deliberately does not snapshot; establish every child's currency under the operation lease.
    children = children.map(child => {
      const state = S.read(child.jobId);
      if (state.status !== "accepted")
        throw new Error(`Child job ${child.jobId} must be accepted before integration.`);
      let current;
      try { current = snapshot(state.executionCwd); }
      catch (error) {
        throw new Error(`Cannot establish current acceptance for child job ${child.jobId}: ${error.message}`);
      }
      if (!current.available || current.fingerprint !== state.acceptedFingerprint)
        throw new Error(`Child job ${child.jobId} is stale: current content differs from its accepted fingerprint. Verify and accept it again before integration.`);
      return state;
    });
    const assignment = unionAssignment(children);
    const journal = batchJournal(batch);
    if (journal) {
      if (journal.completed) {
        if (journal.batch.integrated.length > batch.integrated.length)
          batch = journal.batch;
      } else if (!batch.integrated.includes(journal.childJobId)) {
        const actual = snapshot(batch.cwd),
          contentMatches =
            digest(actual.files) === digest(journal.expectedFiles);
        const named = enabled(profile, "branchMode");
        const applied =
          contentMatches &&
          (named
            ? git(batch.cwd, ["log", "-1", "--format=%B"]).stdout.includes(
                "Codex-Team-Operation: " + journal.childJobId + ":code",
              ) &&
              git(batch.cwd, ["rev-parse", "HEAD^"], true).stdout.trim() ===
                journal.before.head &&
              !actual.dirty
            : actual.head === journal.before.head &&
              actual.indexHash === journal.before.indexHash);
        let resolved = false;
        if (input.resolution && batch.status === "conflict") {
          const child = S.read(journal.childJobId),
            delta = changes(journal.before, actual, child.assignment.scope);
          const cherryPick = git(batch.cwd, [
            "rev-parse",
            "--git-path",
            "CHERRY_PICK_HEAD",
          ]).stdout.trim();
          resolved =
            input.resolution.commit === actual.head &&
            input.resolution.summary?.trim() &&
            !actual.dirty &&
            !delta.outOfScope.length &&
            !fs.existsSync(path.resolve(batch.cwd, cherryPick)) &&
            git(batch.cwd, ["rev-parse", "HEAD^"], true).stdout.trim() ===
              journal.before.head;
          if (!resolved)
            throw new Error(
              "Conflict resolution must be a clean committed change confined to the child's scope, directly after the saved parent commit.",
            );
        }
        if (applied || resolved) {
          batch = {
            ...journal.batch,
            status: "running",
            integrated: [...journal.batch.integrated, journal.childJobId],
            integrationFingerprint: actual.fingerprint,
            ...(resolved ? { resolution: input.resolution } : {}),
            conflict: null,
          };
          batchJournal(batch, { completed: true, batch });
          S.setExtension("batch", batch.batchId, batch);
        } else if (actual.fingerprint !== journal.before.fingerprint) {
          batch.status = "conflict";
          batch.conflict = {
            jobId: journal.childJobId,
            message:
              "Interrupted integration has partial changes. Resolve and commit within this child's scope, then supply resolution.commit and summary.",
          };
          S.setExtension("batch", batch.batchId, batch);
          return batch;
        }
      }
    }
    if (batch.status === "conflict")
      throw new Error(
        "Resolve the saved integration conflict before continuing; no automatic reset is performed.",
      );
    const current = snapshot(batch.cwd),
      expected = batch.integrationFingerprint || batch.baseline.fingerprint;
    if (current.fingerprint !== expected)
      throw new Error(
        "Parent changed after batch baseline; preserve and reconcile those edits.",
      );
    // Commit child work before this transaction: commitJob uses its own transaction.
    if (
      enabled(profile, "branchMode") &&
      children.some((c) => !c.delivery?.implementationCommit)
    )
      throw new Error(
        "Call codex_integrate for each accepted child before integrating the batch.",
      );
    for (const child of children) {
      if (batch.integrated.includes(child.jobId)) continue;
      const childState = S.read(child.jobId),
        childSnapshot = snapshot(childState.executionCwd),
        before = snapshot(batch.cwd),
        expectedFiles = { ...before.files };
      for (const file of changes(childState.baseline, childSnapshot).files) {
        if (childSnapshot.files[file])
          expectedFiles[file] = childSnapshot.files[file];
        else if (enabled(profile, "branchMode")) delete expectedFiles[file];
        else expectedFiles[file] = null;
      }
      batchJournal(batch, {
        completed: false,
        batch,
        childJobId: child.jobId,
        before,
        expectedFiles,
      });
      if (enabled(profile, "branchMode")) {
        const result = git(
          batch.cwd,
          ["cherry-pick", child.delivery.implementationCommit],
          true,
        );
        if (result.status !== 0) {
          batch.status = "conflict";
          batch.conflict = {
            jobId: child.jobId,
            message:
              "Cherry-pick conflict; inspect the parent's worktree. Later children were not integrated.",
          };
          S.setExtension("batch", batch.batchId, batch);
          return batch;
        }
      } else {
        const state = S.read(child.jobId);
        integrateFiles(
          batch.cwd,
          state.executionCwd,
          state.baseline,
          snapshot(state.executionCwd),
        );
      }
      batch.integrated.push(child.jobId);
      batch.integrationFingerprint = snapshot(batch.cwd).fingerprint;
      batchJournal(batch, { completed: true, batch });
      S.setExtension("batch", batch.batchId, batch);
    }
    const after = snapshot(batch.cwd),
      jobId = randomUUID();
    const baseline = {
      ...batch.baseline,
      head: after.head,
      indexHash: after.indexHash,
    };
    fs.mkdirSync(S.jobDir(jobId), { recursive: true, mode: 0o700 });
    const scratch = path.join(S.stateRoot(), "scratch", jobId);
    fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
    const state = {
      containmentVersion: 1,
      visibilityRecorded: true,
      hiddenChanges: { heading: "hidden changes", status: "unavailable", entries: [], total: 0, omitted: 0 },
      gitConfigChanged: { changed: children.some(c => c.gitConfigChanged?.changed), paths: [] },
      jobId,
      taskId: jobId,
      cwd: batch.cwd,
      executionCwd: batch.cwd,
      profile,
      baseline,
      attemptBaseline: baseline,
      originBaseline: baseline,
      baselineBytesUnavailableReason: "batch-union-baseline-bytes-not-captured-before-integration",
      policyBaseline: capturePolicy(
        profile,
        batch.cwd,
        baseline,
        assignment.scope,
      ),
      assignment,
      scratch,
      status: "implementation_finished",
      reviewStatus: "pending",
      result: {
        summary:
          "Children integrated; combined verification is still required.",
        changedFiles: changes(baseline, after).files,
        checks: [],
        blockers: [],
      },
      changes: changes(baseline, after),
      startedAt: S.now(),
      timeoutSeconds: 1800,
      maxRevisions: 5,
      readOnly: false,
      isolation: "direct",
      reviews: [],
      batchId: batch.batchId,
      ...(enabled(profile, "branchMode")
        ? {
            delivery: {
              implementationCommit: after.head,
              commits: children.map((c) => c.delivery.implementationCommit),
              ready: false,
            },
          }
        : {}),
    };
    Object.assign(state,storedReview(state,after));
    S.save(state);
    batch.unionJobId = jobId;
    batch.status = "awaiting_union_verification";
    S.setExtension("batch", batch.batchId, batch);
    return {
      ...batch,
      next: "Run codex_verify and codex_review on unionJobId; child evidence does not accept the union.",
    };
  });
}
