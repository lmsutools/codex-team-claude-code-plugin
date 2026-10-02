import fs from "node:fs";
import path from "node:path";
import * as S from "./store.mjs";
import {
  enabled,
  enforced,
  scan,
  sanitize,
  forbidden,
} from "./policy-core.mjs";
import { hash, safeFile } from "./git.mjs";
export function verifyAttachments(state) {
  const review = (state.reviews || [])
    .filter((r) => r.action === "accept")
    .at(-1);
  for (const item of review?.evidence || [])
    for (const attachment of item.leadObservation?.attachments || []) {
      if (
        path.resolve(path.dirname(attachment.path)) !==
        path.join(S.jobDir(state.jobId), "evidence")
      )
        throw new Error(
          "Evidence attachment is outside the job evidence directory.",
        );
      const stat = fs.lstatSync(attachment.path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 5 * 1024 * 1024 ||
        hash(fs.readFileSync(attachment.path)) !== attachment.hash
      )
        throw new Error(
          "Recorded evidence attachment changed; renewed lead evidence is required.",
        );
    }
}

export function leadEvidence(state, evidence) {
  const criteria = state.assignment.acceptanceCriteria,
    config = state.profile?.components?.leadEvidence;
  if (!Array.isArray(evidence) || evidence.length !== criteria.length)
    return {
      pending: ["Provide one evidence entry per criterion."],
      evidence: [],
    };
  const seen = new Set(),
    pending = [],
    accepted = [];
  for (const item of evidence) {
    if (
      !Number.isInteger(item.criterionIndex) ||
      item.criterionIndex < 0 ||
      item.criterionIndex >= criteria.length ||
      seen.has(item.criterionIndex)
    )
      throw new Error("Invalid or duplicate criterion evidence.");
    seen.add(item.criterionIndex);
    const criterion = criteria[item.criterionIndex],
      required = (typeof criterion === "object" ? criterion.tags || [] : [])
        .map((tag) => config?.requireForCriteriaTagged?.[tag])
        .filter(Boolean);
    if (!item.observation?.trim())
      throw new Error("Criterion observation is required.");
    const observation = item.leadObservation;
    if (!observation) {
      if (required.length && enforced(state.profile, "leadEvidence"))
        pending.push(
          "Criterion " +
            item.criterionIndex +
            " requires " +
            required.join(",") +
            " evidence.",
        );
      if (
        !state.verification.checks.some(
          (c) =>
            c.id === item.checkId && c.status === "passed" && c.exitCode === 0,
        )
      )
        throw new Error("Evidence must reference a passed independent check.");
      accepted.push(item);
      continue;
    }
    if (!enabled(state.profile, "leadEvidence"))
      throw new Error("Lead observations require the leadEvidence component.");
    const kind = config.kinds?.[observation.kind];
    if (!kind) throw new Error("Unsupported lead evidence kind.");
    if (
      required.some((k) => k !== observation.kind) &&
      enforced(state.profile, "leadEvidence")
    )
      pending.push("Criterion requires the configured evidence kind.");
    for (const field of kind.requiredFields || [])
      if (
        observation[field] === undefined ||
        observation[field] === null ||
        observation[field] === ""
      )
        pending.push("Missing lead evidence field: " + field);
    if (kind.allowedTools && !kind.allowedTools.includes(observation.tool))
      pending.push("Required browser controller is unavailable or mismatched.");
    for (const viewport of kind.viewports || [])
      if (!observation.viewports?.includes(viewport))
        pending.push("Missing viewport: " + viewport);
    if (observation.kind === "browser") {
      if (
        !Array.isArray(observation.attachments) ||
        !observation.attachments.length
      )
        pending.push("Browser evidence requires attachments.");
      if (
        observation.consoleErrors?.length ||
        observation.failedRequests?.length
      )
        pending.push(
          "Resolve browser console errors and failed requests before acceptance.",
        );
    }
    if (
      observation.kind === "ownerDecision" &&
      (!observation.quote?.trim() ||
        !Number.isFinite(Date.parse(observation.date)))
    )
      pending.push("Owner decision requires a quote and valid date.");
    const attachments = [];
    for (const reference of observation.attachments || []) {
      if (typeof reference !== "string")
        throw new Error("Attachment must be a relative project path.");
      if (forbidden(state.profile, state.executionCwd, reference))
        throw new Error("Forbidden evidence attachment.");
      const file = safeFile(state.executionCwd, reference),
        info = fs.lstatSync(file);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size > 5 * 1024 * 1024
      )
        throw new Error("Attachment must be a regular file of at most 5 MiB.");
      const ext = path.extname(file).toLowerCase();
      if (
        ![".png", ".jpg", ".jpeg", ".webp", ".json", ".txt", ".md"].includes(
          ext,
        )
      )
        throw new Error("Unsupported evidence attachment type.");
      let bytes = fs.readFileSync(file);
      if ([".json", ".txt", ".md"].includes(ext))
        bytes = Buffer.from(scan(bytes.toString("utf8"), state.profile).text);
      const target = path.join(
        S.jobDir(state.jobId),
        "evidence",
        hash(bytes) + ext,
      );
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, bytes, { mode: 0o600 });
      attachments.push({
        path: target,
        hash: hash(bytes),
        bytes: bytes.length,
      });
    }
    accepted.push({
      ...item,
      leadObservation: {
        ...sanitize(observation, state.profile),
        attachments,
        attestation:
          "Declared by Claude; controller use is not independently proven by the plugin.",
        fingerprint: state.verifiedFingerprint,
        at: S.now(),
      },
    });
  }
  return { pending, evidence: accepted };
}
function day(profile) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: profile.components.budget.timezone || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
export function usageSummary(state) {
  if (!enabled(state.profile, "budget")) return null;
  const ledger = S.extensions("usage").filter(
      (r) => r.repoId === state.profile.repoId,
    ),
    today = day(state.profile);
  const total = (rows) =>
    rows.reduce(
      (a, r) => ({
        inputTokens: a.inputTokens + r.inputTokens,
        cachedInputTokens: a.cachedInputTokens + r.cachedInputTokens,
        outputTokens: a.outputTokens + r.outputTokens,
      }),
      { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    );
  const taskId = state.taskId || state.jobId;
  const task = total(ledger.filter((r) => r.taskId === taskId)),
    daily = total(ledger.filter((r) => r.day === today));
  const config = state.profile.components.budget,
    exceeded = [],
    atLimit = [];
  for (const [scope, usage, limits] of [
    ["perJob", task, config.perJob],
    ["perDay", daily, config.perDay],
  ])
    for (const [metric, limit] of Object.entries(limits || {})) {
      const item = { scope, metric, limit, observed: usage[metric] };
      if (usage[metric] > limit) exceeded.push(item);
      if (usage[metric] >= limit) atLimit.push(item);
    }
  const price = config.prices?.[state.model];
  const measurementAvailable = ledger.some((r) => r.taskId === taskId);
  const completePrice =
    price &&
    measurementAvailable &&
    (!task.cachedInputTokens || price.cachedInputPerMillion !== undefined);
  return {
    task,
    day: today,
    daily,
    exceeded,
    atLimit,
    measurementAvailable,
    observationMode:
      "turn-completed; a running turn may exceed the limit before usage arrives",
    ...(completePrice
      ? {
          estimatedTaskCost:
            ((task.inputTokens - task.cachedInputTokens) *
              price.inputPerMillion +
              task.cachedInputTokens * (price.cachedInputPerMillion || 0) +
              task.outputTokens * price.outputPerMillion) /
            1000000,
          priceDate: price.date,
        }
      : {}),
    costScope:
      "Codex-reported tokens only; excludes Claude and unreported external charges.",
  };
}
export function assertBudget(state) {
  const summary = usageSummary(state);
  if (summary?.atLimit.length && enforced(state.profile, "budget"))
    throw new Error(
      "Observed budget exhausted; an authorized increase is required before another worker can start.",
    );
  return summary;
}
export function recordUsage(state, event, turnKey) {
  if (!enabled(state.profile, "budget")) return null;
  return S.transaction(() => {
    const usage = event.usage || {},
      inputTokens = usage.input_tokens,
      cachedInputTokens = usage.cached_input_tokens || 0,
      outputTokens = usage.output_tokens;
    if (
      [inputTokens, cachedInputTokens, outputTokens].some(
        (v) => !Number.isSafeInteger(v) || v < 0,
      ) ||
      cachedInputTokens > inputTokens
    )
      throw new Error("Malformed usage; budget cannot be certified.");
    const key = [
      state.jobId,
      state.execRole || "implementation",
      state.execAttempt || 0,
      event.id || turnKey,
    ].join(":");
    const row = {
      repoId: state.profile.repoId,
      taskId: state.taskId || state.jobId,
      jobId: state.jobId,
      day: day(state.profile),
      inputTokens,
      cachedInputTokens,
      outputTokens,
      at: S.now(),
    };
    const old = S.extension("usage", key);
    if (
      old &&
      (old.inputTokens !== inputTokens ||
        old.outputTokens !== outputTokens ||
        old.cachedInputTokens !== cachedInputTokens)
    )
      throw new Error("Conflicting usage event.");
    if (!old) S.setExtension("usage", key, row);
    return usageSummary(state);
  });
}
