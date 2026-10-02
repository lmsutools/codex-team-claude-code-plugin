/** Shared source classification and changed-line policy for the guard and successful-edit alarm. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { within, sessionStart, projectJobs, readBounded } from "./observer.mjs";
const extensions = new Set(".js .jsx .mjs .cjs .ts .tsx .mts .cts .py .pyi .rb .go .rs .java .kt .kts .c .h .cc .cpp .hpp .cs .fs .swift .m .mm .php .vue .svelte .astro .html .css .scss .sass .less .sql .sh .bash .zsh .ps1 .psm1 .bat .cmd .r .R .lua .ex .exs .erl .hrl .clj .cljs .dart .scala .sol .ipynb".toLowerCase().split(" "));
export function canonical(file) {
  let current = path.resolve(file), suffix = [];
  while (!fs.existsSync(current)) {
    suffix.unshift(path.basename(current));
    const parent = path.dirname(current);
    if (parent === current) throw Error("No existing parent");
    current = parent;
  }
  return path.join(fs.realpathSync.native(current), ...suffix);
}
export function classifySourcePath(file, cwd, home = os.homedir(), scratchpad = null) {
  if (typeof file !== "string" || !file || !cwd) return null;
  const target = canonical(path.resolve(cwd, file)), project = canonical(cwd);
  if (!within(project, target) || within(canonical(path.join(home, ".claude")), target)) return null;
  if (within(path.join(project, ".git"), target)) return null;
  if (scratchpad && within(canonical(scratchpad), target)) return null;
  if (!extensions.has(path.extname(target).toLowerCase()) && !["makefile", "dockerfile", "cmakelists.txt"].includes(path.basename(target).toLowerCase())) return null;
  return target;
}
const lines = text => text ? String(text).replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").length : 0;
function changed(before, after) {
  const old = String(before).replace(/\r\n/g, "\n").split("\n"), next = String(after).replace(/\r\n/g, "\n").split("\n");
  let start = 0, aEnd = old.length, bEnd = next.length;
  while (start < aEnd && start < bEnd && old[start] === next[start]) start++;
  while (aEnd > start && bEnd > start && old[aEnd - 1] === next[bEnd - 1]) { aEnd--; bEnd--; }
  // Bounded Myers edit distance: only the >20 decision needs an exact answer.
  const a = old.slice(start, aEnd), b = next.slice(start, bEnd), frontier = new Map([[1, 0]]);
  for (let d = 0; d <= 20; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (frontier.get(k - 1) ?? -1) < (frontier.get(k + 1) ?? -1))
        ? frontier.get(k + 1) || 0 : (frontier.get(k - 1) || 0) + 1;
      let y = x - k;
      while (x < a.length && y < b.length && a[x] === b[y]) { x++; y++; }
      frontier.set(k, x);
      if (x >= a.length && y >= b.length) return d;
    }
  }
  return 21;
}
export function estimateChangedLines(tool, input, target) {
  if (tool === "Write" && typeof input.content !== "string") return null;
  const exists = fs.existsSync(target);
  if (!exists) return tool === "Write" ? Infinity : null;
  const read = readBounded(target);
  if (read.truncated) return null;
  let text = read.text;
  if (tool === "Write") return input.content.length <= 1024 * 1024 ? changed(text, input.content) : null;
  if (tool === "NotebookEdit") {
    if (input.edit_mode && !["replace", "insert", "delete"].includes(input.edit_mode)) return null;
    if (input.edit_mode !== "delete" && typeof input.new_source !== "string") return null;
    const notebook = JSON.parse(text), cells = notebook.cells;
    if (!Array.isArray(cells)) return null;
    const cell = cells.find(c => c.id === input.cell_id);
    if (input.edit_mode === "insert") return input.cell_type === "markdown" ? 0 : lines(input.new_source);
    if (!cell) return null;
    if (cell.cell_type === "markdown") return 0;
    const old = Array.isArray(cell.source) ? cell.source.join("") : cell.source || "";
    return changed(old, input.edit_mode === "delete" ? "" : input.new_source || "");
  }
  const edits = tool === "MultiEdit" ? input.edits : [input];
  if (!Array.isArray(edits) || edits.length > 1000) return null;
  let total = 0;
  for (const edit of edits.slice(0, 1000)) {
    const a = edit.old_string, b = edit.new_string;
    if (typeof a !== "string" || typeof b !== "string" || a.length + b.length > 1024 * 1024 || !a || !text.includes(a)) return null;
    const occurrences = edit.replace_all ? text.split(a).length - 1 : 1;
    total += changed(a, b) * occurrences;
    text = edit.replace_all ? text.replaceAll(a, b) : text.replace(a, b);
  }
  return total;
}
export function recentCodex(job, now = Date.now()) {
  if (["starting", "running", "verifying"].includes(job.status)) return true;
  const finished = Date.parse(job.finishedAt);
  return Number.isFinite(finished) && now >= finished && now - finished < 7200000;
}
export function sessionHasCodex(input, root, cwd, now = Date.now()) {
  const jobs = projectJobs(root, cwd, "guard");
  if (jobs.some(job => recentCodex(job, now))) return true;
  let since = null;
  try { since = sessionStart(input.transcript_path); } catch {}
  return since !== null && jobs.some(job =>
    [job.startedAt, job.modelChildStartedAt].some(at => Date.parse(at) >= since));
}
