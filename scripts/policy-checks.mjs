/** Project policy evaluation with trusted host helpers and explicit environment boundaries. */
import { trustedExecutable, checkEnvironment } from "./host-security.mjs";
import { gitSafetyArgs } from "./git-security.mjs";
import {delegateInputs,delegateUnavailable} from "./delegate-policy.mjs";
import { hostEnvironment } from "./check-executable.mjs";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as S from "./store.mjs";
import { git, safeFile, changes, hash } from "./git.mjs";
import {
  enabled,
  enforced,
  matches,
  textMeta,
  readProject,
  forbidden,
  scan,
  digest,
  expand,
} from "./policy-core.mjs";
import { variables, approvalKey } from "./profile.mjs";

const owns = (lane, name) =>
  matches(lane?.owns, name) && !matches(lane?.excludes, name);
const tokens = (line) => line.match(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) || [];
export function grows(before, after) {
  const old = tokens(before),
    next = tokens(after);
  let i = 0;
  for (const token of next) if (token === old[i]) i++;
  return i === old.length;
}
export function classify(profile, change, preflight = false) {
  const config = profile.components.ownership,
    manifest = profile.manifest;
  const name = change.path,
    shared = manifest?.appendOnly || config.shared;
  let rule = "unowned",
    ok = false,
    owner = null;
  if (matches(manifest?.ownerApproval || config.ownerApproval, name))
    rule = "ownerApproval";
  else if (
    manifest
      ? owns(manifest.lanes?.[profile.lane], name)
      : matches(config.ownLane, name)
  ) {
    rule = "ownLane";
    ok = true;
  } else if (matches(shared, name)) {
    rule = "appendOnly";
    ok =
      preflight ||
      (change.status !== "D" &&
        change.status !== "B" &&
        (change.removed || []).every(
          (line) =>
            !tokens(line).length ||
            (change.added || []).some((next) => grows(line, next)),
        ));
  } else {
    owner = Object.entries(manifest?.lanes || {}).find(
      ([id, lane]) => id !== profile.lane && owns(lane, name),
    )?.[0];
    if (owner || matches(config.otherLane, name)) rule = "otherLane";
    else if (
      change.status === "A" &&
      matches(manifest?.creatable || config.creatable, name)
    ) {
      rule = "creatable";
      ok = true;
    } else if (!manifest && !config.ownLane && !config.creatable) {
      rule = "default";
      ok = true;
    }
  }
  const approval =
    profile.hash && rule === "ownerApproval"
      ? S.extension(
          "owner-approval",
          approvalKey(profile) + ":" + profile.branch + ":" + name,
        )
      : null;
  if (approval) {
    ok = true;
    rule = "ownerApproval+recorded";
  }
  return {
    path: name,
    rule,
    ok,
    owner,
    ...(approval ? { approval } : {}),
    reason: ok
      ? "Allowed by " + rule
      : rule === "otherLane"
        ? "Request a wiring change from " + (owner || "the owning lane")
        : rule === "ownerApproval"
          ? "Requires the recorded owner authorization and integrator change."
          : "Resolve " + rule + " before proceeding.",
  };
}
export function capturePolicy(profile, cwd, baseline, scope) {
  if (!profile) return null;
  const metadata = {},
    sharedContents = {};
  const shared =
    profile.manifest?.appendOnly || profile.components?.ownership?.shared || [];
  let captured = 0;
  for (const [name, entry] of Object.entries(baseline.files || {})) {
    if (
      !entry ||
      !scope.some((s) => s === "." || name === s || name.startsWith(s + "/"))
    )
      continue;
    if (forbidden(profile, cwd, name)) continue;
    const bytes = fs.readFileSync(safeFile(cwd, name));
    metadata[name] = textMeta(bytes);
    if (
      matches(shared, name) ||
      (enabled(profile, "ownership") &&
        profile.components.ownership.delegateCommand)
    ) {
      captured += bytes.length;
      if (metadata[name].binary) {
        if (matches(shared, name))
          throw new Error("Shared binary baseline cannot be safely captured.");
        continue;
      }
      if (captured > 8 * 1024 * 1024 || metadata[name].encoding !== "utf-8")
        throw new Error(
          "Ownership baseline cannot be safely captured within 8 MiB.",
        );
      const text = bytes.toString("utf8");
      if (scan(text, profile).count)
        throw new Error(
          "Shared baseline contains a secret pattern; resolve before assignment.",
        );
      sharedContents[name] = text;
    }
  }
  return { metadata, sharedContents, delegate:delegateInputs(profile,cwd) };
}
function changedLines(state, name, before, after) {
  if (before === after) return { removed: [], added: [] };
  const dir = path.join(
    state.scratch,
    "ownership-diff",
    hash(name).slice(0, 16),
  );
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const a = path.join(dir, "before.txt"),
    b = path.join(dir, "after.txt");
  try {
    fs.writeFileSync(a, before, { mode: 0o600 });
    fs.writeFileSync(b, after, { mode: 0o600 });
    const result = spawnSync(
      trustedExecutable("git", state.executionCwd),
      [
        ...gitSafetyArgs(),
        "diff",
        "--no-index",
        "--no-renames",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "-U0",
        "--",
        a,
        b,
      ],
      {
        env: hostEnvironment(),
        encoding: "utf8",
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    if (![0, 1].includes(result.status))
      throw new Error("Cannot compute bounded ownership diff.");
    const removed = [],
      added = [];
    let inHunk = false;
    for (const line of result.stdout.split(/\r?\n/)) {
      if (line.startsWith("@@")) {
        inHunk = true;
        continue;
      }
      if (!inHunk) continue;
      if (line.startsWith("-")) removed.push(line.slice(1));
      if (line.startsWith("+")) added.push(line.slice(1));
    }
    return { removed, added };
  } finally {
    if (fs.existsSync(a)) fs.unlinkSync(a);
    if (fs.existsSync(b)) fs.unlinkSync(b);
  }
}
export function scopePolicy(profile, cwd, assignment, baseline) {
  if (!profile) return [];
  const names = new Set();
  for (const item of assignment.scope) {
    const descendants = Object.keys(baseline.files || {}).filter(
      (n) => item === "." || n === item || n.startsWith(item + "/"),
    );
    if (descendants.length) descendants.forEach((n) => names.add(n));
    else names.add(item);
  }
  const findings = [];
  for (const name of names) {
    if (forbidden(profile, cwd, name))
      findings.push({
        component: "secrets",
        path: name,
        ok: false,
        reason: "Forbidden path in assignment scope.",
      });
    if (enabled(profile, "ownership"))
      findings.push({
        component: "ownership",
        ...classify(
          profile,
          { path: name, status: baseline.files[name] ? "M" : "A" },
          true,
        ),
      });
  }
  enforceFindings(profile, findings);
  return findings;
}
export function enforceFindings(profile, findings) {
  const failed = findings.filter(
    (v) => v.ok === false && enforced(profile, v.component),
  );
  if (failed.length)
    throw new Error(
      "Profile policy rejected: " +
        failed
          .map(
            (v) =>
              v.component +
              ":" +
              (v.path || v.id || "") +
              " [" +
              (v.rule || v.component) +
              "] " +
              v.reason,
          )
          .join("; ")
          .slice(0, 4000),
    );
}
export function hygieneFindings(state, current) {
  const p = state.profile,
    config = p.components.textHygiene,
    results = [];
  for (const name of changes(state.baseline, current, state.assignment.scope)
    .files) {
    if (!current.files[name] || forbidden(p, state.executionCwd, name))
      continue;
    const old = state.policyBaseline?.metadata[name],
      next = textMeta(fs.readFileSync(safeFile(state.executionCwd, name)));
    if (next.binary) continue;
    let reason = null;
    if (next.encoding !== "utf-8" || (old && old.encoding !== "utf-8"))
      reason = "Unrecognized encoding; automatic normalization is unsafe.";
    else if (config.bom === "forbid" && next.bom) reason = "BOM is forbidden.";
    else if (old && config.bom !== "forbid" && old.bom !== next.bom)
      reason = "BOM changed.";
    else if (
      old &&
      config.lineEndings === "preserve" &&
      old.eol !== "none" &&
      old.eol !== next.eol
    )
      reason = "Line endings changed.";
    else if (
      ["lf", "crlf"].includes(config.lineEndings) &&
      next.eol !== "none" &&
      next.eol !== config.lineEndings
    )
      reason = "Unexpected line endings.";
    else if (config.finalNewline === "require" && !next.finalNewline)
      reason = "Final newline required.";
    else if (
      old &&
      config.finalNewline === "preserve" &&
      old.finalNewline !== next.finalNewline
    )
      reason = "Final newline changed.";
    results.push({
      component: "textHygiene",
      path: name,
      ok: !reason,
      reason,
      old,
      next,
    });
  }
  return results;
}
export function inspectPolicy(state, current, { committed = false } = {}) {
  const p = state.profile;
  if (!p) return [];
  const delta = changes(state.baseline, current, state.assignment.scope),
    findings = [],
    actual = [];
  for (const name of delta.files) {
    const old = state.baseline.files[name],
      next = current.files[name];
    const isForbidden = forbidden(p, state.executionCwd, name);
    if (isForbidden) {
      findings.push({
        component: "secrets",
        path: name,
        ok: false,
        reason: "Forbidden file changed.",
      });
      continue;
    }
    const bytes = next
      ? fs.readFileSync(safeFile(state.executionCwd, name))
      : null;
    const content =
      bytes && !textMeta(bytes).binary ? bytes.toString("utf8") : "";
    const secretCount = enabled(p, "secrets") ? scan(content, p).count : 0;
    const previous = state.policyBaseline?.sharedContents[name];
    const lines =
      previous !== undefined && !secretCount
        ? changedLines(state, name, previous, content)
        : { removed: [], added: secretCount ? [] : content.split(/\r?\n/) };
    const record = {
      path: name,
      status: !next
        ? "D"
        : secretCount
          ? "B"
          : !old
            ? "A"
            : bytes && textMeta(bytes).binary
              ? "B"
              : "M",
      ...lines,
    };
    actual.push(record);
    if (enabled(p, "ownership"))
      findings.push({ component: "ownership", ...classify(p, record) });
    if (secretCount)
      findings.push({
        component: "secrets",
        path: name,
        ok: false,
        reason: "Secret pattern in changed content.",
      });
  }
  if (enabled(p, "textHygiene"))
    findings.push(...hygieneFindings(state, current));
  const config = p.components?.ownership;
  if (enabled(p, "ownership") && config.delegateCommand) {
    const unavailable=delegateUnavailable(state,actual.map(change=>change.path));
    if(unavailable) {findings.push({component:"ownership",id:"delegate",ok:true,status:"unavailable",level:"advise",reason:unavailable});return findings;}
    if (config.delegateProtocol !== "changes-json" && !committed)
      throw new Error(
        "Ownership delegate must accept changes-json to verify uncommitted files.",
      );
    for (const [name, expected] of Object.entries(p.references))
      if (digest(readProject(p, state.executionCwd, name)) !== expected)
        throw new Error("Referenced policy changed.");
    const argv = expand(
      config.delegateCommand,
      variables(p, state.cwd, { worktree: state.executionCwd }),
    );
    if (/\.(cmd|bat)$/i.test(argv[0]))
      throw new Error("Ownership delegate requires a direct executable.");
    const allow = Object.fromEntries(
      findings
        .filter((f) => f.approval)
        .map((f) => [f.path, f.approval.quote + " (" + f.approval.date + ")"]),
    );
    const result = spawnSync(trustedExecutable(argv[0], state.executionCwd), argv.slice(1), {
      env: checkEnvironment(process.env, p.passEnv || []),
      cwd: state.executionCwd,
      input: JSON.stringify({
        manifest: p.manifest,
        lane: p.lane,
        changes: actual,
        allow,
      }),
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error("Ownership delegate did not return bounded JSON.");
    }
    findings.push({
      component: "ownership",
      id: "delegate",
      ok: result.status === 0 && parsed.ok === true,
      reason: "Project ownership evaluator",
      result: parsed,
    });
  }
  return findings;
}
export function contextPacks(profile, cwd, names = []) {
  if (!enabled(profile, "context")) return null;
  const cfg = profile.components.context,
    selected = [
      ...new Set([
        ...(cfg.alwaysInclude || []),
        ...(cfg.perLane?.[profile.lane] || []),
        ...names,
      ]),
    ],
    docs = [];
  for (const name of selected) {
    const pack = cfg.packs?.[name];
    if (!pack) throw new Error("Unknown context pack: " + name);
    let remaining = pack.maxChars;
    for (const reference of pack.docs) {
      const [file, section] = reference.split("#");
      const whole = readProject(profile, cwd, file);
      let excerpt = whole;
      if (section) {
        const lines = whole.split(/\r?\n/),
          headers = [];
        lines.forEach((line, index) => {
          const match = /^(#{1,6})\s+(.+)$/.exec(line);
          if (!match) return;
          const label = match[2].trim(),
            slug = label
              .toLowerCase()
              .replace(/[^\p{L}\p{N}\s-]/gu, "")
              .replace(/\s+/g, "-");
          if (
            slug === section.toLowerCase() ||
            new RegExp(
              "^\\(?" +
                section.replace(/[.*+?^{}()|[\]\\$]/g, "\\$&") +
                "\\)?(?:\\.(?!\\d)|[ ·\\s]|$)",
              "i",
            ).test(label)
          )
            headers.push({ index, depth: match[1].length });
        });
        if (headers.length !== 1)
          throw new Error("Missing or ambiguous context section: " + reference);
        const { index, depth } = headers[0];
        let end = index + 1;
        while (
          end < lines.length &&
          !new RegExp("^#{1," + depth + "}\\s").test(lines[end])
        )
          end++;
        excerpt = lines.slice(index, end).join("\n");
      }
      if (excerpt.length > remaining)
        throw new Error(
          "Context pack exceeds maxChars; select narrower sections: " + name,
        );
      remaining -= excerpt.length;
      if (scan(excerpt, profile).count)
        throw new Error(
          "Context contains a secret pattern; do not send it to the worker.",
        );
      docs.push({
        pack: name,
        file,
        section: section || null,
        hash: digest(whole),
        text: excerpt,
      });
    }
  }
  return {
    docs,
    conventions: cfg.conventions || [],
    blockedDecisions: cfg.blockedDecisions || [],
    hash: digest(docs),
  };
}
export function expandCriteria(
  profile,
  assignment,
  names = [],
  omissions = {},
) {
  if (!enabled(profile, "criteria")) return { assignment, suggestions: [] };
  const cfg = profile.components.criteria;
  const suggestions = Object.entries(cfg.templates || {})
    .filter(
      ([, v]) =>
        v.suggestWhen === "always" ||
        assignment.scope.some(
          (f) => f === "." || matches(v.suggestWhen?.changed, f),
        ),
    )
    .map(([k]) => k);
  if (enforced(profile, "criteria"))
    for (const name of suggestions)
      if (!names.includes(name) && !omissions[name]?.trim())
        throw new Error(
          "Template requires inclusion or a written reason: " + name,
        );
  const criteria = [...assignment.acceptanceCriteria];
  for (const name of names) {
    const template = cfg.templates?.[name];
    if (!template) throw new Error("Unknown criteria template: " + name);
    criteria.push(
      ...template.criteria.map((c) => (typeof c === "string" ? c : { ...c })),
    );
  }
  return {
    assignment: { ...assignment, acceptanceCriteria: criteria },
    suggestions,
    omissions,
  };
}
