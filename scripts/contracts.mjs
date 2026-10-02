/** Structured assignment and worker report contracts. */
export function object(value, name, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${name} must be an object.`);
  for (const key of Object.keys(value))
    if (!keys.includes(key))
      throw new Error(`Unexpected ${name} field: ${key}`);
  return value;
}
export function text(value, name, max = 20000) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(
      `${name} must be nonempty text of at most ${max} characters.`,
    );
  return value;
}
export function integer(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer from ${min} through ${max}.`);
  return value;
}
export function strings(value, name) {
  if (!Array.isArray(value) || value.length > 200)
    throw new Error(`${name} must be an array (maximum 200 entries).`);
  return value.map((v) => text(v, name, 5000));
}
export function relative(value) {
  text(value, "scope path", 1000);
  if (value === ".") return value;
  if (
    value.includes("\\") ||
    value.startsWith("/") ||
    value.includes(":") ||
    value
      .split("/")
      .some(
        (p) => !p || p === ".." || p === "." || p.toLowerCase() === ".git",
      ) ||
    /[\x00-\x1f*?]/.test(value)
  )
    throw new Error(
      "Scope paths must be literal relative files/directories using forward slashes; use . for the whole project.",
    );
  return value;
}
export function assignment(value, { scout = false } = {}) {
  object(value, "assignment", [
    "objective",
    "scope",
    "constraints",
    "acceptanceCriteria",
    "verification",
    "decisions",
    "dependencies",
  ]);
  const scope = strings(value.scope, "scope").map(relative);
  if (!scope.length)
    throw new Error("scope must contain at least one file or directory.");
  if (
    !Array.isArray(value.acceptanceCriteria) ||
    value.acceptanceCriteria.length > 200
  )
    throw new Error(
      "acceptanceCriteria must be an array of at most 200 criteria.",
    );
  const acceptanceCriteria = value.acceptanceCriteria.map((v) => {
    if (typeof v === "string") return text(v, "acceptance criterion", 5000);
    object(v, "criterion", ["id", "text", "tags"]);
    return {
      text: text(v.text, "criterion text", 5000),
      ...(v.id ? { id: text(v.id, "criterion id", 100) } : {}),
      tags: strings(v.tags || [], "criterion tags"),
    };
  });
  if (!acceptanceCriteria.length)
    throw new Error("At least one acceptance criterion is required.");
  if (
    !Array.isArray(value.verification) ||
    value.verification.length < (scout ? 0 : 1) ||
    value.verification.length > 20
  )
    throw new Error(`verification requires ${scout ? "0" : "1"}-20 command specifications.`);
  const verification = value.verification.map((v) => {
    object(v, "verification", ["id", "command", "args", "timeoutSeconds", "passEnv", "criteria", "allowInline", "host"]);
    const id = text(v.id, "check id", 80);
    if (!/^[a-zA-Z0-9_-]+$/.test(id))
      throw new Error(
        "Check IDs must contain only letters, numbers, underscores and hyphens.",
      );
    const args = v.args ?? [];
    if (
      !Array.isArray(args) ||
      args.some((a) => typeof a !== "string" || a.length > 20000)
    )
      throw new Error("Verification args must be strings.");
    if (v.passEnv !== undefined && strings(v.passEnv, "passEnv").some(k => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k))) throw Error("Invalid passEnv name.");
    if (v.criteria !== undefined && (!Array.isArray(v.criteria) || v.criteria.some(i => !Number.isInteger(i) || i < 0 || i >= acceptanceCriteria.length))) throw Error("Invalid verification criteria.");
    if (v.host !== undefined && typeof v.host !== "boolean") throw Error("host must be boolean.");
    if (v.allowInline !== undefined && typeof v.allowInline !== "boolean") throw Error("allowInline must be boolean.");
    return {
      ...(v.host !== undefined ? { host: v.host } : {}),
      ...(v.passEnv !== undefined ? { passEnv: v.passEnv } : {}),
      ...(v.criteria !== undefined ? { criteria: v.criteria } : {}),
      ...(v.allowInline !== undefined ? { allowInline: v.allowInline } : {}),
      id,
      command: text(v.command, "command", 1000),
      args,
      timeoutSeconds: integer(
        v.timeoutSeconds ?? 120,
        "check timeoutSeconds",
        1,
        1800,
      ),
    };
  });
  if (new Set(verification.map((v) => v.id)).size !== verification.length)
    throw new Error("Verification check IDs must be unique.");
  return {
    objective: text(value.objective, "objective"),
    scope,
    acceptanceCriteria,
    verification,
    constraints: strings(value.constraints ?? [], "constraints"),
    decisions: strings(value.decisions ?? [], "decisions"),
    dependencies: strings(value.dependencies ?? [], "dependencies"),
  };
}
export const reportSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    changedFiles: { type: "array", items: { type: "string" } },
    checks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          command: { type: "string" },
          exitCode: { type: ["integer", "null"] },
          result: { type: "string" },
        },
        required: ["command", "exitCode", "result"],
      },
    },
    blockers: { type: "array", items: { type: "string" } },
    handbookNotes: { type: "array", items: { type: "string" } },
    sandboxLimits: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "changedFiles", "checks", "blockers", "handbookNotes", "sandboxLimits"],
};
export function report(value) {
  object(value, "report", ["summary", "changedFiles", "checks", "blockers", "handbookNotes", "sandboxLimits"]);
  text(value.summary, "report summary");
  strings(value.changedFiles, "changedFiles");
  strings(value.blockers, "blockers");
  for (const key of ["handbookNotes", "sandboxLimits"])
    if (value[key] !== undefined) strings(value[key], key);
  if (!Array.isArray(value.checks))
    throw new Error("Report checks must be an array.");
  for (const check of value.checks) {
    object(check, "report check", ["command", "exitCode", "result"]);
    text(check.command, "command");
    text(check.result, "result");
    if (check.exitCode !== null && !Number.isInteger(check.exitCode))
      throw new Error("Report check exitCode must be integer or null.");
  }
  return value;
}
const schemaText = () => ({ type: "string" });
const schemaStrings = { type: "array", items: schemaText() };
const strictObject = (properties) => ({
  type: "object", additionalProperties: false, properties, required: Object.keys(properties),
});
const draftSchema = strictObject({
  objective: schemaText(), scope: { ...schemaStrings },
  constraints: schemaStrings, decisions: schemaStrings, dependencies: schemaStrings,
  acceptanceCriteria: { type: "array", items: { anyOf: [
    schemaText(), strictObject({ id: { type: ["string", "null"] }, text: schemaText(), tags: schemaStrings }),
  ] } },
  verification: { type: "array", items: strictObject({
    id: { ...schemaText() }, command: schemaText(),
    args: { type: "array", items: { type: "string" } },
    timeoutSeconds: { type: "integer", minimum: 1, maximum: 1800 },
  }) },
});
export const scoutReportSchema = strictObject({
  summary: schemaText(),
  files: { type: "array", items: strictObject({
    path: schemaText(),
    lines: { type: "array", items: strictObject({
      startLine: { type: "integer", minimum: 1, maximum: 2147483647 },
      endLine: { type: "integer", minimum: 1, maximum: 2147483647 },
    }) }, why: schemaText(),
  }) },
  dataFlow: schemaStrings, draftAssignment: draftSchema,
  risks: schemaStrings, openQuestions: schemaStrings,
  handbookNotes: schemaStrings, sandboxLimits: schemaStrings,
});
/** Enforces semantic constraints JSON Schema cannot express, including ordered ranges. */
export function scoutReport(value) {
  object(value, "scout report", Object.keys(scoutReportSchema.properties));
  text(value.summary, "scout summary");
  if (!Array.isArray(value.files) || value.files.length > 200)
    throw new Error("Scout files must be an array of at most 200 entries.");
  for (const file of value.files) {
    object(file, "scout file", ["path", "lines", "why"]);
    relative(file.path);
    if (file.path === ".") throw new Error("Scout file path must be a literal relative file.");
    text(file.why, "scout file why", 5000);
    if (!Array.isArray(file.lines) || file.lines.length > 200)
      throw new Error("Scout lines must be an array of at most 200 ranges.");
    let last = 0;
    for (const range of file.lines) {
      object(range, "scout range", ["startLine", "endLine"]);
      integer(range.startLine, "startLine", 1, 2147483647);
      integer(range.endLine, "endLine", range.startLine, 2147483647);
      if (range.startLine <= last) throw new Error("Scout line ranges must be ordered and nonoverlapping.");
      last = range.endLine;
    }
  }
  for (const key of ["dataFlow", "risks", "openQuestions"]) strings(value[key], key);
  for (const key of ["handbookNotes", "sandboxLimits"])
    if (value[key] !== undefined) strings(value[key], key);
  const draftAssignment = assignment(value.draftAssignment);
  for (const check of draftAssignment.verification)
    if (check.args.length > 200) throw new Error("Scout draft verification args exceed 200 entries.");
  return { ...value, draftAssignment };
}

/** Strict fresh-thread reviewer output; semantic relationships are validated separately. */
export const findingSchema = strictObject({
  severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
  confidence: { type: 'number', minimum: 0, maximum: 1 },
  file: schemaText(), startLine: { type: 'integer' }, endLine: { type: 'integer' },
  title: schemaText(), body: schemaText(), evidence: schemaStrings,
});
export const reviewerReportSchema = strictObject({
  criteria: { type: "array", items: strictObject({
    criterionIndex: { type: "integer" }, verdict: { type: "string", enum: ["met", "unmet", "unclear"] },
    evidence: schemaText(), checkIds: schemaStrings, failingCheckIds: schemaStrings,
    hunks: { type: "array", items: strictObject({ file: schemaText(), startLine: { type: "integer" }, endLine: { type: "integer" } }) },
  }) }, risks: schemaStrings, findings: { type: 'array', items: findingSchema },
});
