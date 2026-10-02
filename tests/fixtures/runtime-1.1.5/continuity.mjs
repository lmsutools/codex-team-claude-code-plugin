import fs from "node:fs";
import path from "node:path";
import * as S from "./store.mjs";
import { safeFile, git, hash } from "./git.mjs";
import {
  identity,
  branch,
  enabled,
  sanitize,
  digest,
  boundedRead,
  readProject,
  forbidden,
  textMeta,
} from "./policy-core.mjs";
import { loadProfile, assertApproved } from "./profile.mjs";
import { classify, enforceFindings } from "./policy-checks.mjs";

export function contextKey(cwd, profile, requested) {
  if (
    enabled(profile, "continuity") &&
    profile.components.continuity.contextKey === "branch"
  )
    return (
      "branch:" +
      identity(cwd) +
      ":" +
      (requested || profile.branch || branch(cwd))
    );
  if (requested && requested !== "cwd")
    throw new Error("Branch context key requires the continuity component.");
  return S.key(cwd);
}
export function handoffTool(input) {
  const cwd = S.workspace(input.cwd),
    profile = loadProfile(cwd, { branch: input.branch, lane: input.lane });
  if (!enabled(profile, "continuity"))
    throw new Error(
      "Enable continuity before exporting or importing a handoff.",
    );
  assertApproved(profile);
  const executionCwd = enabled(profile, "branchMode")
    ? S.extension("branch", profile.repoId + ":" + profile.branch)?.cwd
    : cwd;
  return S.transaction(() => {
    const key = contextKey(cwd, profile, input.branch),
      stored = S.db().prepare("SELECT data FROM contexts WHERE cwd=?").get(key);
    const context = stored
      ? JSON.parse(stored.data)
      : {
          version: 0,
          decisions: [],
          openQuestions: [],
          dependencies: [],
          crossLaneRequests: [],
          nextSteps: [],
        };
    if (input.action === "import") {
      if (input.file && !executionCwd)
        throw new Error(
          "Use a recorded own branch worktree for handoff files.",
        );
      const text =
        input.text ||
        (input.file
          ? readProject(profile, executionCwd, input.file, 200000)
          : "");
      if (text.length > 200000)
        throw new Error("Handoff exceeds 200000 characters.");
      const match = /<!-- codex-team-handoff\n([\s\S]*?)\n-->/.exec(text);
      if (!match) throw new Error("Missing handoff data block.");
      const data = JSON.parse(match[1]);
      if (
        data.repoId !== profile.repoId ||
        data.branch !== profile.branch ||
        data.format !== 1
      )
        throw new Error("Handoff repository/branch/format does not match.");
      if (input.expectedVersion !== context.version)
        throw new Error("Context version changed; read and reconcile.");
      const next = {
        ...context,
        version: context.version + 1,
        updatedAt: S.now(),
      };
      for (const name of [
        "decisions",
        "openQuestions",
        "dependencies",
        "crossLaneRequests",
        "nextSteps",
      ]) {
        const items = data.context?.[name] || [];
        if (
          !Array.isArray(items) ||
          items.length > 200 ||
          items.some((v) => typeof v !== "string" || v.length > 5000)
        )
          throw new Error("Invalid handoff notes.");
        next[name] = [
          ...new Set([...(context[name] || []), ...sanitize(items, profile)]),
        ];
      }
      S.db()
        .prepare(
          "INSERT INTO contexts(cwd,data) VALUES(?,?) ON CONFLICT(cwd) DO UPDATE SET data=excluded.data",
        )
        .run(key, JSON.stringify(next));
      return {
        context: next,
        notice:
          "Imported notes only. No approvals, acceptance states or commands were imported.",
      };
    }
    if (input.action !== "export") throw new Error("Unknown handoff action.");
    const jobs = S.db()
      .prepare("SELECT state FROM jobs")
      .all()
      .map((r) => JSON.parse(r.state))
      .filter(
        (j) =>
          j.profile?.repoId === profile.repoId &&
          j.profile?.branch === profile.branch &&
          !["accepted", "cancelled"].includes(j.status),
      )
      .map((j) => ({
        jobId: j.jobId,
        status: j.status,
        objective: j.assignment?.objective || null,
      }));
    const data = sanitize(
      {
        format: 1,
        repoId: profile.repoId,
        branch: profile.branch,
        context,
        jobs,
      },
      profile,
    );
    let text = "# Handoff · " + profile.branch + "\n\n";
    for (const [name, items] of Object.entries(context))
      if (Array.isArray(items))
        text +=
          "## " +
          name +
          "\n\n" +
          (items.map((v) => "- " + v).join("\n") || "None.") +
          "\n\n";
    text +=
      "<!-- codex-team-handoff\n" + JSON.stringify(data, null, 2) + "\n-->\n";
    let file = null;
    if (input.write) {
      const relative = profile.components.continuity.handoffFile?.replaceAll(
        "{lane}",
        profile.lane || "default",
      );
      if (!relative)
        throw new Error("Configure handoffFile or export text only.");
      if (!executionCwd)
        throw new Error(
          "Use a recorded own branch worktree for handoff files.",
        );
      file = safeFile(executionCwd, relative);
      if (forbidden(profile, executionCwd, relative))
        throw new Error("Handoff destination is forbidden.");
      if (
        !profile.components.continuity.tracked &&
        git(executionCwd, ["check-ignore", "--quiet", "--", relative], true)
          .status !== 0
      )
        throw new Error(
          "Handoff path must already be ignored; .gitignore was not modified.",
        );
      const previous = fs.existsSync(file)
        ? fs.readFileSync(file)
        : Buffer.alloc(0);
      if (input.expectedTargetHash !== hash(previous))
        throw new Error(
          "Handoff write requires expectedTargetHash (SHA-256 of current target bytes).",
        );
      if (
        profile.components.continuity.tracked &&
        enabled(profile, "ownership")
      )
        enforceFindings(profile, [
          {
            component: "ownership",
            ...classify(profile, {
              path: relative,
              status: fs.existsSync(file) ? "M" : "A",
              removed: previous.toString("utf8").split(/\r?\n/),
              added: text.split(/\r?\n/),
            }),
          },
        ]);
      const meta = textMeta(previous);
      if (meta.binary || meta.encoding === "unknown" || meta.eol === "mixed")
        throw new Error("Handoff destination has ambiguous text encoding.");
      if (meta.eol === "crlf") text = text.replace(/\n/g, "\r\n");
      if (previous.length && !meta.finalNewline)
        text = text.replace(/\r?\n$/, "");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text, { mode: 0o600 });
    }
    return {
      text,
      file,
      contextVersion: context.version,
      contentHash: hash(Buffer.from(text)),
    };
  });
}
