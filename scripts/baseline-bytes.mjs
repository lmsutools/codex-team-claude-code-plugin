/** Bounded source capture: clean Git blobs plus dirty/untracked content-addressed bytes. */
import fs from "node:fs";
import path from "node:path";
import { hash, safeFile, changes, git } from "./git.mjs";
import * as PC from "./policy-core.mjs";
import { lineDifference } from "./line-stats.mjs";
export const inScope = (file, scope) => scope.some(s => s === "." || file === s || file.startsWith(s + "/"));
const FILE_LIMIT = 256 * 1024, TOTAL_LIMIT = 8 * 1024 * 1024;
/** Never allocate or read past the approved bound, including a file that grows after stat. */
export function boundedBytes(file, limit = FILE_LIMIT) {
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw Error("oversized");
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!read) throw Error("source-changed-during-read");
      offset += read;
    }
    if (fs.fstatSync(fd).size !== stat.size) throw Error("source-changed-during-read");
    return bytes;
  } finally { fs.closeSync(fd); }
}
function inspect(bytes, profile) {
  if (PC.textMeta(bytes).encoding !== "utf-8") throw Error("binary-or-unknown-encoding");
  if (PC.scan(bytes.toString("utf8"), profile).count) throw Error("profile-secret");
  return bytes;
}
function source(cwd, file, profile, remaining = FILE_LIMIT) {
  if (PC.forbidden(profile, cwd, file)) throw Error("profile-forbidden");
  const target = safeFile(cwd, file);
  if (!fs.existsSync(target)) return Buffer.alloc(0);
  const size = fs.statSync(target).size;
  if (size > FILE_LIMIT) throw Error("oversized");
  if (size > remaining) throw Error("capture-budget");
  return inspect(boundedBytes(target, Math.min(FILE_LIMIT, remaining)), profile);
}
export function captureBytes(cwd, baseline, scope, directory, profile, { budget = TOTAL_LIMIT } = {}) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const index = new Map(git(cwd, ["ls-files", "--stage", "-z"]).stdout.split("\0").filter(Boolean).map(row => {
    const match = row.match(/^\d+ ([0-9a-f]+) 0\t(.+)$/s); return match ? [match[2], match[1]] : [row, null];
  }));
  const dirty = new Set([
    ...git(cwd, ["ls-files", "--modified", "--others", "--exclude-standard", "-z"]).stdout.split("\0"),
    ...git(cwd, ["diff", "--cached", "--name-only", "-z"]).stdout.split("\0"),
  ]);
  const files = {}; let total = 0;
  for (const file of Object.keys(baseline.files).filter(f => inScope(f, scope))) {
    // Once exhausted, do not stat, read, filter or secret-scan subsequent sources.
    if (total >= budget) { files[file] = { skipped: "capture-budget" }; continue; }
    try {
      if (PC.forbidden(profile, cwd, file)) throw Error("profile-forbidden");
      if (index.get(file) && !dirty.has(file) && baseline.files[file]) {
        const size = fs.statSync(safeFile(cwd, file)).size;
        if (size > FILE_LIMIT) throw Error("oversized");
        files[file] = { gitBlob: index.get(file), hash: baseline.files[file].hash };
        continue;
      }
      const bytes = source(cwd, file, profile, budget - total);
      if (baseline.files[file] && hash(bytes) !== baseline.files[file].hash) throw Error("baseline-changed");
      const digest = hash(bytes);
      fs.writeFileSync(path.join(directory, digest), bytes, { mode: 0o600 });
      files[file] = { hash: digest }; total += bytes.length;
    } catch (error) { files[file] = { skipped: error.message }; }
  }
  return { version: 2, directory, files, bytes: total };
}
function baselineSource(state, file, captured) {
  if (!captured) return Buffer.alloc(0);
  if (!/^[0-9a-f]{64}$/.test(captured.hash)) throw Error("invalid-baseline-hash");
  let bytes;
  if (captured.gitBlob) {
    if (!/^[0-9a-f]{40,64}$/.test(captured.gitBlob)) throw Error("invalid-git-blob");
    const result = git(state.executionCwd, ["cat-file", "--filters", "--path=" + file, captured.gitBlob], true,
      { encoding: null, maxBuffer: FILE_LIMIT });
    if (result.status !== 0 || result.error) throw Error("git-baseline-unavailable-or-oversized");
    bytes = result.stdout;
    if (hash(bytes) !== captured.hash) {
      // A clean LF worktree need not have been checked out with autocrlf's CRLF conversion.
      const raw = git(state.executionCwd, ["cat-file", "blob", captured.gitBlob], true,
        { encoding: null, maxBuffer: FILE_LIMIT });
      if (raw.status === 0 && !raw.error) bytes = raw.stdout;
    }
  } else {
    const location = path.join(state.baselineBytes.directory, captured.hash);
    if (!fs.existsSync(location)) throw Error("captured-bytes-pruned-or-missing");
    bytes = boundedBytes(location);
  }
  if (hash(bytes) !== captured.hash) throw Error("baseline-bytes-corrupt-or-filters-changed");
  return inspect(bytes, state.profile);
}
/** Authorship starts at this job, not its inherited review baseline. Copies share
 * the existing owned directory and aggregate budget; retries never recapture. */
export function captureAttemptBytes(state, directory) {
  if (state.attemptBaseline === state.baseline) return state.baselineBytes;
  const remaining = Math.max(0, TOTAL_LIMIT - (state.baselineBytes?.bytes || 0));
  return captureBytes(state.executionCwd, state.attemptBaseline, state.assignment.scope,
    directory, state.profile, { budget: remaining });
}
/** Give a revision its own dirty-byte ownership before pruning the superseded job. */
export function inheritCapture(previous, directory) {
  if (!previous) return previous;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const result = { ...previous, directory, files: structuredClone(previous.files) };
  for (const [file, entry] of Object.entries(result.files)) {
    if (entry.skipped || entry.gitBlob) continue;
    try {
      if (!/^[0-9a-f]{64}$/.test(entry.hash)) throw Error("invalid-baseline-hash");
      const bytes = boundedBytes(path.join(previous.directory, entry.hash));
      if (hash(bytes) !== entry.hash) throw Error("baseline-bytes-corrupt");
      fs.writeFileSync(path.join(directory, entry.hash), bytes, { mode: 0o600 });
    } catch { result.files[file] = { skipped: "captured-bytes-pruned-or-missing" }; }
  }
  return result;
}
/** Only removes explicitly owned source-copy directories; callers run outside transactions. */
export function pruneBytes(directory) {
  const target = path.resolve(directory);
  if (!["baseline-bytes", "review-copies"].includes(path.basename(target))) throw Error("Invalid baseline cleanup target.");
  if (!fs.existsSync(target)) return;
  if (fs.lstatSync(target).isSymbolicLink()) throw Error("Refusing linked baseline cleanup target.");
  fs.rmSync(target, { recursive: true, force: true });
}
export function exactHunks(state, current, { maxCharacters = 24000, copiesDirectory = null } = {}) {
  if (copiesDirectory) {
    const relative = path.relative(state.executionCwd, copiesDirectory);
    if (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)) throw Error('Review copies must be outside the project.');
  }
  const files = changes(state.baseline, current, state.assignment.scope).files.filter(f => inScope(f, state.assignment.scope));
  const result = { available: !!state.baselineBytes, hunks: [], unavailable: [], omitted: 0, ...(copiesDirectory ? { files: [] } : {}) };
  let size = 0;
  for (const file of files) {
    try {
      if (!state.baselineBytes) throw Error(state.baselineBytesUnavailableReason || "legacy-baseline-bytes-unavailable");
      const captured = state.baselineBytes.files[file];
      if (captured?.skipped) throw Error(captured.skipped);
      if (state.baseline.files[file] && !captured) throw Error("baseline-bytes-unavailable");
      const before = baselineSource(state, file, captured);
      const after = source(state.executionCwd, file, state.profile);
      if (current.files[file] && hash(after) !== current.files[file].hash) throw Error("current-bytes-changed");
      if (copiesDirectory) {
        fs.mkdirSync(copiesDirectory, { recursive: true, mode: 0o700 });
        const beforePath = path.join(copiesDirectory, hash(file) + '.before');
        const afterPath = path.join(copiesDirectory, hash(file) + '.after');
        fs.writeFileSync(beforePath, before, { mode: 0o600 });
        fs.writeFileSync(afterPath, after, { mode: 0o600 });
        result.files.push({ file, beforePath, afterPath });
      }
      // One exact replacement range per file. Common unchanged edges are excluded;
      // interior unchanged lines are context, never attributed as separate edits.
      const a = before.toString("utf8").match(/[^\n]*\n|[^\n]+$/g) || [];
      const b = after.toString("utf8").match(/[^\n]*\n|[^\n]+$/g) || [];
      let start = 0, end = 0;
      while (start < a.length && start < b.length && a[start] === b[start]) start++;
      while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
      if (start === a.length && start === b.length) continue;
      const hunk = { file, startLine: start + 1, endLine: Math.max(start + 1, b.length - end),
        oldStartLine: start + 1, oldEndLine: Math.max(start + 1, a.length - end),
        before: a.slice(start, a.length - end).join(""), after: b.slice(start, b.length - end).join("") };
      const length = JSON.stringify(hunk).length;
      if (size + length > maxCharacters) { result.omitted++; continue; }
      result.hunks.push(hunk); size += length;
    } catch (error) { result.unavailable.push({ file, reason: error.message }); }
  }
  return result;
}

/** Compute once in the worker, never in a Stop hook or against a later worktree. */
export function authoredLineStats(state, current) {
  const result={version:2,files:0,added:0,removed:0,unknownFiles:0,fileIds:[]};
  // Legacy review snapshots cannot establish the start of this attempt.
  if(!state.attemptBaseline?.available || !current?.available)return {...result,unavailable:true};
  const files=changes(state.attemptBaseline,current,state.assignment.scope).files.filter(file=>inScope(file,state.assignment.scope));
  result.files=files.length;
  const authored={...state,baseline:state.attemptBaseline,baselineBytes:state.attemptBytes};
  let remaining=TOTAL_LIMIT,root;
  try {root=fs.realpathSync.native(state.executionCwd);} catch {}
  for(const [index,file] of files.entries()) {
    if(index<256 && root) {
      // Canonical absolute-path identity distinguishes projects, survives deletion
      // and atomic replacement, and does not expose paths in the compact metadata.
      try {const target=safeFile(root,file);result.fileIds.push(hash(process.platform==="win32"?target.toLowerCase():target));} catch {}
    }
    try {
      if(index>=256 || remaining<=0)throw Error("line-stat-budget");
      const captured=authored.baselineBytes?.files[file];
      if(!authored.baselineBytes || captured?.skipped || (authored.baseline.files[file] && !captured))throw Error("baseline-unavailable");
      const before=baselineSource(authored,file,captured);
      remaining-=before.length;
      if(remaining<0)throw Error("line-stat-budget");
      const after=source(state.executionCwd,file,state.profile,remaining);
      remaining-=after.length;
      if(current.files[file] && hash(after)!==current.files[file].hash)throw Error("current-bytes-changed");
      const diff=lineDifference(before.toString("utf8"),after.toString("utf8"));
      if(!diff)throw Error("line-diff-budget");
      result.added+=diff.added;result.removed+=diff.removed;
    } catch {result.unknownFiles++;}
  }
  return result;
}
