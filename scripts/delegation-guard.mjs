process.env.NoDefaultCurrentDirectoryInExePath = "1";
/** Fail-open delegation speed bump, with atomic per-session cumulative edit markers. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isMain } from "./hook-entry.mjs";
import { stateRoot } from "./state-reader.mjs";
import { gitRoot, fold } from "./observer.mjs";
import { classifySourcePath, estimateChangedLines, sessionHasCodex } from "./delegation-policy.mjs";
export function pruneMarkers(dir, now = Date.now()) {
  const deadline = Date.now() + 10;
  for (const name of fs.readdirSync(dir).slice(0, 256)) {
    if (Date.now() > deadline) break;
    if (!/^[a-f0-9]{64}$/.test(name)) continue;
    const file = path.join(dir, name);
    try { if (now - fs.statSync(file).mtimeMs > 7 * 86400000) fs.unlinkSync(file); } catch {}
  }
}
export function evaluateGuard(input, { root = stateRoot(), mode = process.env.CODEX_TEAM_GUARD || "remind", home, now = Date.now() } = {}) {
  if (mode === "off" || !["remind", "block"].includes(mode) || !input?.cwd || !input.session_id) return null;
  if (!["Edit", "Write", "NotebookEdit", "MultiEdit"].includes(input.tool_name)) return null;
  const cwd = gitRoot(input.cwd), data = input.tool_input;
  if (!cwd || !data) return null;
  const supplied = data.file_path || data.notebook_path || data.path;
  if (typeof supplied !== "string") return null;
  const scratchpad = input.scratchpad_dir || process.env.CLAUDE_CODE_SCRATCHPAD_DIR;
  const target = classifySourcePath(path.resolve(input.cwd, supplied), cwd, home, scratchpad);
  if (!target) return null;
  // Path and edit estimation precede any SQLite access. Small chunks accumulate
  // as attempted changes: PreToolUse cannot observe their later success/failure.
  const count = estimateChangedLines(input.tool_name, data, target);
  if (count === null || count === 0) return null;
  const key = createHash("sha256").update([input.session_id, fold(cwd), fold(target)].join("\0")).digest("hex");
  const dir = path.join(root, "guard"), marker = path.join(dir, key), lock = marker + ".lock";
  fs.mkdirSync(dir, { recursive: true });
  pruneMarkers(dir, now);
  try { if (now - fs.statSync(lock).mtimeMs > 10000) fs.rmSync(lock, { recursive: true, force: true }); } catch {}
  try { fs.mkdirSync(lock); } catch (e) { if (e.code === "EEXIST") return null; throw e; }
  let deny = false;
  try {
    let saved = { lines: 0, reminded: false };
    if (fs.existsSync(marker)) {
      const text = fs.readFileSync(marker, "utf8");
      saved = text ? JSON.parse(text) : { lines: 0, reminded: true };
    }
    if (mode === "remind" && saved.reminded) return null;
    saved.lines = Math.min(21, (Number(saved.lines) || 0) + count);
    if (saved.lines > 20 && sessionHasCodex(input, root, cwd, now)) {
      deny = true; saved.lines = 0; saved.reminded = true;
    }
    const temp = path.join(lock, "next");
    fs.writeFileSync(temp, JSON.stringify(saved), { mode: 0o600 });
    fs.renameSync(temp, marker);
  } finally { fs.rmdirSync(lock); }
  if (!deny) return null;
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
    permissionDecisionReason: `codex-team: delegate this large source edit to Codex; Claude leads and reviews.${mode === "remind" ? " This is a reminder: a retry of this same file is allowed in this session." : " Guard mode block denies qualifying source edits; use Codex for implementation."}` } };
}
if (isMain(import.meta.url)) {
  try { const result = evaluateGuard(JSON.parse(fs.readFileSync(0, "utf8"))); if (result) process.stdout.write(JSON.stringify(result)); } catch {}
}
