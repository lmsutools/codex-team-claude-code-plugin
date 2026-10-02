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
export function assignment(value) {
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
    value.verification.length < 1 ||
    value.verification.length > 20
  )
    throw new Error("verification requires 1-20 command specifications.");
  const verification = value.verification.map((v) => {
    object(v, "verification", ["id", "command", "args", "timeoutSeconds"]);
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
    return {
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
  },
  required: ["summary", "changedFiles", "checks", "blockers"],
};
export function report(value) {
  object(value, "report", ["summary", "changedFiles", "checks", "blockers"]);
  text(value.summary, "report summary");
  strings(value.changedFiles, "changedFiles");
  strings(value.blockers, "blockers");
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
