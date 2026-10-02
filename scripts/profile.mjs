import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as S from "./store.mjs";
import { git, safeFile } from "./git.mjs";
import { classify } from "./policy-checks.mjs";
import {
  branch,
  identity,
  digest,
  levels,
  enabled,
  matches,
  boundedRead,
  patternsFor,
  readProject,
  expand,
  scan,
} from "./policy-core.mjs";

const string = { type: "string", maxLength: 20000 };
const boolean = { type: "boolean" };
const number = { type: "number", minimum: 0 };
const integer = { type: "integer", minimum: 0 };
const strings = { type: "array", items: string, maxItems: 400 };
const object = (properties, required = []) => ({
  type: "object",
  properties,
  additionalProperties: false,
  required,
});
const record = (schema) => ({ type: "object", additionalProperties: schema });
function partial(schema) {
  if (!schema || typeof schema !== "object") return schema;
  const copy = { ...schema };
  if (copy.type === "object") {
    copy.required = [];
    if (copy.properties)
      copy.properties = Object.fromEntries(
        Object.entries(copy.properties).map(([k, v]) => [k, partial(v)]),
      );
    if (
      copy.additionalProperties &&
      typeof copy.additionalProperties === "object"
    )
      copy.additionalProperties = partial(copy.additionalProperties);
  }
  return copy;
}
const enumeration = (values) => ({ type: "string", enum: values });
const when = {
  anyOf: [enumeration(["always"]), object({ changed: strings }, ["changed"])],
};
const level = enumeration(levels);
const command = { type: "array", items: string, minItems: 1, maxItems: 200 };
const limits = object({ inputTokens: integer, outputTokens: integer });
const check = object(
  {
    level,
    reason: string,
    when,
    command,
    timeoutSeconds: { ...integer, minimum: 1, maximum: 1800 },
    host: boolean, passEnv: strings, allowInline: boolean, criteria: { type: "array", items: integer },
    perFile: object({ select: strings, command }, ["select", "command"]),
    requireCoverageReport: boolean,
    source: enumeration(["lcov"]),
    policy: string,
    minimum: object(
      {
        lines: { ...number, maximum: 100 },
        functions: { ...number, maximum: 100 },
      },
      ["lines", "functions"],
    ),
    scope: enumeration(["changed-critical-files"]),
    merge: enumeration(["across-runs"]),
  },
  ["when"],
);
export const criterionSchema = {
  anyOf: [
    string,
    object({ id: string, text: string, tags: strings }, ["text"]),
  ],
};
export const componentsSchema = object({
  branchMode: object(
    {
      level,
      trunk: string,
      worktreeDir: string,
      branchTemplate: string,
      neverWrite: strings,
      commit: object({
        trailer: string,
        subjectMax: { ...integer, minimum: 1, maximum: 1000 },
        stage: enumeration(["accepted-paths-only"]),
      }),
      push: object({
        allowed: boolean,
        onlyOwnBranch: boolean,
        forceWithLease: boolean,
        requireLeadCall: boolean,
        deniedBranches: strings,
        remote: string,
      }),
    },
    ["level"],
  ),
  ownership: object(
    {
      level,
      manifest: { anyOf: [string, { type: "null" }] },
      rules: strings,
      appendOnly: object({ mode: enumeration(["tokens-grow"]) }),
      ownerApproval: strings,
      ownLane: strings,
      otherLane: strings,
      creatable: strings,
      shared: strings,
      delegateCommand: command,
      delegateProtocol: enumeration(["changes-json", "committed"]),
      delegateFiles: strings,
      approvalLane: string,
    },
    ["level"],
  ),
  gates: object(
    {
      level,
      toolchain: object({ prependPath: strings, applyToWorker: boolean }),
      maxParallelChecks: { ...integer, minimum: 1, maximum: 3 },
      retryOnTimeout: { ...integer, maximum: 1 },
      executionSensitivePaths: strings,
      checks: record(check),
      affectedTests: object({
        byName: {
          type: "array",
          items: object({ source: string, tests: strings }, [
            "source",
            "tests",
          ]),
        },
        byImportScan: object(
          {
            roots: strings,
            maxFiles: { ...integer, minimum: 1, maximum: 10000 },
          },
          ["roots", "maxFiles"],
        ),
      }),
      neverRun: {
        type: "array",
        items: object({ command, reason: string }, ["command", "reason"]),
      },
    },
    ["level"],
  ),
  context: object(
    {
      level,
      packs: record(
        object(
          {
            docs: strings,
            maxChars: { ...integer, minimum: 1, maximum: 200000 },
          },
          ["docs", "maxChars"],
        ),
      ),
      alwaysInclude: strings,
      perLane: record(strings),
      conventions: strings,
      blockedDecisions: {
        type: "array",
        items: object({ id: string, area: string, rule: string }, [
          "id",
          "area",
          "rule",
        ]),
      },
    },
    ["level"],
  ),
  criteria: object(
    {
      level,
      templates: record(
        object(
          {
            suggestWhen: when,
            criteria: { type: "array", items: criterionSchema },
          },
          ["criteria"],
        ),
      ),
    },
    ["level"],
  ),
  report: object(
    {
      level,
      target: object(
        {
          file: string,
          insert: enumeration(["newest-first-after-first-rule", "append"]),
        },
        ["file"],
      ),
      template: string,
      ownerSummary: object({
        required: boolean,
        language: string,
        heading: string,
      }),
      evidenceKinds: strings,
      queueMessage: string,
      sections: strings,
      requiredLeaderFields: strings,
      timezone: string,
    },
    ["level"],
  ),
  parallel: object(
    {
      level,
      maxWorkers: { ...integer, minimum: 1, maximum: 3 },
      childBranch: string,
      prewire: object({ required: boolean, sharedFiles: strings }),
      integrate: enumeration(["sequential-stop-on-conflict"]),
    },
    ["level"],
  ),
  leadEvidence: object(
    {
      level,
      kinds: record(
        object({
          requiredFields: strings,
          allowedTools: strings,
          viewports: strings,
        }),
      ),
      requireForCriteriaTagged: record(string),
    },
    ["level"],
  ),
  secrets: object(
    {
      level,
      forbiddenPaths: strings,
      patterns: {
        type: "array",
        items: {
          anyOf: [
            string,
            object({ pattern: string, flags: string }, ["pattern"]),
          ],
        },
        maxItems: 30,
      },
      scan: strings,
      redactInState: boolean,
    },
    ["level"],
  ),
  budget: object(
    {
      level,
      perJob: limits,
      perDay: limits,
      cachedInputCounts: enumeration(["separately"]),
      onExceed: enumeration(["cancel-cleanly"]),
      timezone: string,
      prices: record(
        object(
          {
            inputPerMillion: number,
            cachedInputPerMillion: number,
            outputPerMillion: number,
            date: string,
          },
          ["inputPerMillion", "outputPerMillion", "date"],
        ),
      ),
    },
    ["level"],
  ),
  textHygiene: object(
    {
      level,
      lineEndings: enumeration(["preserve", "lf", "crlf"]),
      encoding: enumeration(["utf-8"]),
      bom: enumeration(["preserve", "forbid"]),
      finalNewline: enumeration(["preserve", "require"]),
    },
    ["level"],
  ),
  continuity: object(
    {
      level,
      contextKey: enumeration(["branch", "cwd"]),
      handoffFile: string,
      includeOpen: strings,
      tracked: boolean,
    },
    ["level"],
  ),
});
export const profileSchema = object(
  {
    passEnv: strings,
    profileVersion: { type: "integer", enum: [1] },
    name: string,
    extends: enumeration(["standard", "strict"]),
    variables: record(string),
    lanes: object({ source: string }, ["source"]),
    components: componentsSchema,
    laneOverrides: record(partial(componentsSchema)),
  },
  ["profileVersion", "name"],
);
export function validate(value, spec, label = "profile") {
  if(spec.type === "array" && label.endsWith(".passEnv") && (!Array.isArray(value) || value.some(n=>typeof n!=="string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)))) throw Error("passEnv must contain exact environment variable names.");
  if (spec.anyOf) {
    if (
      spec.anyOf.some((s) => {
        try {
          validate(value, s, label);
          return true;
        } catch {
          return false;
        }
      })
    )
      return;
    throw new Error(label + " does not match any supported shape.");
  }
  if (spec.type === "null") {
    if (value !== null) throw new Error(label + " must be null.");
    return;
  }
  if (spec.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(label + " must be an object.");
    for (const k of Object.keys(value)) {
      if (["__proto__", "prototype", "constructor"].includes(k))
        throw new Error("Unsafe configuration key.");
      const child = spec.properties?.[k] || spec.additionalProperties;
      if (!child) throw new Error("Unexpected " + label + " field: " + k);
      validate(value[k], child, label + "." + k);
    }
    for (const k of spec.required || [])
      if (!(k in value)) throw new Error("Missing " + label + "." + k);
  } else if (spec.type === "array") {
    if (
      !Array.isArray(value) ||
      value.length > (spec.maxItems ?? 400) ||
      value.length < (spec.minItems ?? 0)
    )
      throw new Error("Invalid array: " + label);
    value.forEach((v) => validate(v, spec.items, label));
  } else {
    if (
      spec.type === "integer"
        ? !Number.isInteger(value)
        : typeof value !== spec.type
    )
      throw new Error("Invalid type: " + label);
    if (
      typeof value === "string" &&
      (!value.trim() || value.length > (spec.maxLength ?? 20000))
    )
      throw new Error("Invalid text: " + label);
    if (
      typeof value === "number" &&
      (!Number.isFinite(value) ||
        value < (spec.minimum ?? -Infinity) ||
        value > (spec.maximum ?? Infinity))
    )
      throw new Error("Invalid number: " + label);
  }
  if (spec.enum && !spec.enum.includes(value))
    throw new Error("Unsupported value: " + label);
}
export function merge(a, b) {
  const out = structuredClone(a || {});
  for (const [k, v] of Object.entries(b || {}))
    out[k] =
      v && typeof v === "object" && !Array.isArray(v)
        ? merge(out[k], v)
        : structuredClone(v);
  return out;
}
const standard = {
  profileVersion: 1,
  name: "standard",
  components: {
    textHygiene: {
      level: "advise",
      lineEndings: "preserve",
      encoding: "utf-8",
      bom: "preserve",
      finalNewline: "preserve",
    },
  },
};
const strict = merge(standard, {
  name: "strict",
  components: {
    textHygiene: { level: "enforce" },
    secrets: {
      level: "enforce",
      forbiddenPaths: ["**/*.env", "**/.env", "**/.env.*"],
      patterns: ["sk-[A-Za-z0-9]{20,}", "-----BEGIN [A-Z ]*PRIVATE KEY-----"],
      scan: ["diff", "workerLog", "report", "commitMessage"],
      redactInState: true,
    },
  },
});
export const templates = { standard, strict };
function tighten(base, local, prefix = "") {
  for (const [k, value] of Object.entries(local)) {
    const old = base?.[k],
      label = prefix + k;
    if (old === undefined) continue;
    if (k === "level" && levels.indexOf(value) < levels.indexOf(old))
      throw new Error("Local profile weakens " + label);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      tighten(old, value, label + ".");
      continue;
    }
    if (
      JSON.stringify(old) === JSON.stringify(value) ||
      k === "level" ||
      prefix.startsWith("variables.")
    )
      continue;
    if (
      [
        "inputTokens",
        "outputTokens",
        "maxWorkers",
        "maxParallelChecks",
        "retryOnTimeout",
      ].includes(k) &&
      value <= old
    )
      continue;
    if (["lines", "functions"].includes(k) && value >= old) continue;
    if (
      [
        "forbiddenPaths",
        "patterns",
        "neverRun",
        "executionSensitivePaths",
        "ownerApproval",
        "deniedBranches",
      ].includes(k) &&
      Array.isArray(value) &&
      old.every((x) => value.some((y) => digest(x) === digest(y)))
    )
      continue;
    if (
      ["allowedTools", "evidenceKinds", "ownLane", "creatable"].includes(k) &&
      Array.isArray(value) &&
      value.every((x) => old.includes(x))
    )
      continue;
    if (["allowed", "forceWithLease"].includes(k) && value === false) continue;
    if (
      [
        "required",
        "redactInState",
        "onlyOwnBranch",
        "requireLeadCall",
      ].includes(k) &&
      value === true
    )
      continue;
    throw new Error("Local profile may not replace policy field: " + label);
  }
}
function checkPaths(value, key = "") {
  if (
    typeof value === "string" &&
    /path|file|source|manifest|policy|target|root|glob|select|owns|excludes|creatable|neverWrite/i.test(
      key,
    )
  ) {
    if (
      value.replaceAll("\\", "/").split("/").includes("..") ||
      value.includes("\0")
    )
      throw new Error("Unsafe profile path in " + key);
  } else if (Array.isArray(value)) value.forEach((v) => checkPaths(v, key));
  else if (value && typeof value === "object")
    Object.entries(value).forEach(([k, v]) => checkPaths(v, k));
}
export function loadProfile(cwd, options = {}) {
  if (options.topic && !/^[a-z0-9][a-z0-9-]{0,79}$/.test(options.topic))
    throw new Error("Topic must be a short lowercase identifier.");
  const file = safeFile(cwd, ".codex-team/profile.json");
  if (!fs.existsSync(file) && !options.profile) return null;
  const raw = options.profile || JSON.parse(boundedRead(file));
  validate(raw, profileSchema);
  let profile = merge(raw.extends ? templates[raw.extends] : {}, raw);
  const manifestPath =
    profile.lanes?.source || profile.components?.ownership?.manifest;
  const references = {};
  let manifest = null;
  if (manifestPath) {
    const text = readProject(profile, cwd, manifestPath);
    references[manifestPath] = digest(text);
    manifest = JSON.parse(text);
  }
  const prefix = options.lane
    ? manifest?.lanes?.[options.lane]?.branches?.[0]?.split("/")[0]
    : "";
  const topicBranch =
    options.topic &&
    profile.components?.branchMode?.branchTemplate
      ?.replaceAll("{topic}", options.topic)
      .replaceAll("{lanePrefix}", prefix || "")
      .replaceAll("{lane}", options.lane || "");
  const activeBranch = options.branch || topicBranch || branch(cwd);
  const laneMatches = Object.entries(manifest?.lanes || {})
    .filter(([, v]) => matches(v.branches, activeBranch))
    .map(([k]) => k);
  const lane =
    options.lane || (laneMatches.length === 1 ? laneMatches[0] : null);
  if (
    options.lane &&
    manifest?.lanes &&
    (!manifest.lanes[options.lane] ||
      (activeBranch &&
        !matches(manifest.lanes[options.lane].branches, activeBranch)))
  )
    throw new Error("Explicit lane does not own the selected branch.");
  if (
    manifest?.lanes &&
    (profile.components?.ownership?.level === "enforce" ||
      profile.components?.branchMode?.level === "enforce") &&
    !lane
  )
    throw new Error("An unambiguous lane/branch is required.");
  profile = merge(profile, { components: profile.laneOverrides?.[lane] || {} });
  const localFile = safeFile(cwd, ".codex-team/profile.local.json");
  if (fs.existsSync(localFile)) {
    if (
      git(
        cwd,
        ["check-ignore", "--quiet", "--", ".codex-team/profile.local.json"],
        true,
      ).status !== 0
    )
      throw new Error("profile.local.json must be ignored by Git.");
    const local = JSON.parse(boundedRead(localFile));
    validate(local, partial(profileSchema));
    if (local.extends || local.laneOverrides || local.lanes)
      throw new Error(
        "Local profile cannot replace inheritance or lane routing.",
      );
    tighten(profile, local);
    profile = merge(profile, local);
  }
  validate(profile, profileSchema);
  checkPaths(profile);
  patternsFor(profile);
  for (const [name, value] of Object.entries(profile.variables || {})) {
    if (
      [
        "repoRoot",
        "worktree",
        "branch",
        "lane",
        "file",
        "files",
        "fileId",
        "scratch",
      ].includes(name)
    )
      throw new Error("Cannot override reserved variable: " + name);
    if (scan(value, profile).count)
      throw new Error("Profile variables must not contain secret values.");
  }
  const c = profile.components || {};
  if (
    enabled(profile, "branchMode") &&
    (!c.branchMode.trunk ||
      !c.branchMode.branchTemplate ||
      !c.branchMode.worktreeDir)
  )
    throw new Error(
      "branchMode requires trunk, branchTemplate and worktreeDir.",
    );
  if (
    c.branchMode?.push?.onlyOwnBranch === false ||
    c.branchMode?.push?.requireLeadCall === false
  )
    throw new Error("Push must require the lead call and own branch.");
  if (enabled(profile, "budget"))
    new Intl.DateTimeFormat("en", { timeZone: c.budget.timezone || "UTC" });
  if (c.report?.timezone)
    new Intl.DateTimeFormat("en", { timeZone: c.report.timezone });
  const refs = [
    ...Object.values(c.gates?.checks || {}).map((v) => v.policy),
    ...(c.ownership?.delegateFiles || []),
    ...(c.report?.template && !c.report.template.startsWith("builtin:")
      ? [c.report.template]
      : []),
  ].filter(Boolean);
  for (const name of refs)
    references[name] = digest(readProject(profile, cwd, name));
  const resolved = {
    ...profile,
    lane,
    branch: activeBranch,
    repoId: identity(cwd),
    references,
    manifest,
  };
  resolved.hash = digest({ profile, lane, references, manifest });
  return resolved;
}
export function approvalKey(profile) {
  return profile.repoId + ":" + (profile.lane || "-") + ":" + profile.hash;
}
export function assertApproved(profile) {
  if (profile && !S.extension("approval", approvalKey(profile)))
    throw new Error(
      "Profile is not approved. Read/explain it, then codex_profile approve with expectedHash=" +
        profile.hash,
    );
}
export function currentProfile(state) {
  if (!state.profile) return null;
  const current = loadProfile(state.cwd, {
    lane: state.profile.lane,
    branch: state.profile.branch,
  });
  if (!current || current.hash !== state.profile.hash)
    throw new Error(
      "Profile or referenced policy changed; approve and start a new reviewed assignment.",
    );
  assertApproved(current);
  return current;
}
export function variables(profile, cwd, extra = {}) {
  const vars = {
    repoRoot: cwd,
    worktree: extra.worktree || cwd,
    branch: profile?.branch || branch(cwd),
    lane: profile?.lane || "",
    scratch: extra.scratch || "",
    ...(profile?.variables || {}),
    ...extra,
  };
  for (let i = 0; i < 5; i++)
    for (const [k, v] of Object.entries(vars))
      if (typeof v === "string") vars[k] = expand([v], vars)[0];
  if (Object.values(vars).some((v) => typeof v === "string" && /\$\{/.test(v)))
    throw new Error("Cyclic variable expansion.");
  return vars;
}
export function profileTool(input) {
  const cwd = S.workspace(input.cwd),
    action = input.action || "read";
  if (!["read", "validate", "approve", "explain"].includes(action))
    throw new Error("Unknown profile action.");
  const profile = loadProfile(cwd, input);
  if (!profile) return { cwd, profile: null, compatibleWith: "1.1.1" };
  const files = input.files || [];
  for (const file of files) safeFile(cwd, file);
  const vars = variables(profile, cwd, {
    worktree: enabled(profile, "branchMode")
      ? S.extension("branch", profile.repoId + ":" + profile.branch)?.cwd ||
        "<owned-worktree>"
      : cwd,
    scratch: "<job-scratch>",
    file: "<selected-test>",
    fileId: "<selected-test-id>",
    files,
  });
  if (action === "approve") {
    if (input.expectedHash !== profile.hash)
      throw new Error("Approval requires the exact current expectedHash.");
    S.transaction(() => {
      S.setExtension("approval", approvalKey(profile), {
        hash: profile.hash,
        at: S.now(),
        approver: "Claude tech lead",
      });
      if (input.ownerApprovals?.length) {
        if (
          profile.components?.ownership?.approvalLane &&
          profile.lane !== profile.components.ownership.approvalLane
        )
          throw new Error(
            "Owner exceptions must be recorded by the configured approval lane.",
          );
        for (const record of input.ownerApprovals) {
          validate(
            record,
            object({ path: string, quote: string, date: string }, [
              "path",
              "quote",
              "date",
            ]),
            "ownerApproval",
          );
          safeFile(cwd, record.path);
          if (
            /[?*]/.test(record.path) ||
            !Number.isFinite(Date.parse(record.date))
          )
            throw new Error(
              "Owner approval requires an exact file and valid date.",
            );
          S.setExtension(
            "owner-approval",
            approvalKey(profile) + ":" + profile.branch + ":" + record.path,
            {
              ...record,
              at: S.now(),
              attestation:
                "Claude records an existing owner authorization; technical profile approval alone does not grant it.",
            },
          );
        }
      }
    });
  }
  return {
    cwd,
    profile,
    approved: !!S.extension("approval", approvalKey(profile)),
    commands: Object.entries(profile.components?.gates?.checks || {}).map(
      ([id, v]) => ({
        id,
        when: v.when,
        argv: v.command || v.perFile?.command || null,
        expandedPreview: expand(v.command || v.perFile?.command || [], vars),
      }),
    ),
    ...(action === "explain"
      ? {
          files,
          applicableChecks: Object.entries(
            profile.components?.gates?.checks || {},
          )
            .filter(
              ([, v]) =>
                v.when === "always" ||
                files.some((f) => matches(v.when?.changed, f)),
            )
            .map(([id]) => id),
          ownership: enabled(profile, "ownership")
            ? files.map((file) =>
                classify(profile, {
                  path: file,
                  status: fs.existsSync(safeFile(cwd, file)) ? "M" : "A",
                  removed: [],
                  added: [],
                }),
              )
            : [],
          previewNotice:
            "Job-specific placeholders are previews; actual changed lines and selected tests are evaluated at verification.",
        }
      : {}),
    limits: [
      "Profile approval does not authorize publishing, installation, new agents or owner-only decisions.",
      "Commands are expanded as argv, without an implicit shell.",
    ],
  };
}
