/**
 * Rust support: cargo/nextest test counts, compact rustc/clippy/test-failure
 * summaries for decision packets, workspace crate selection for changed files,
 * and copy-on-write warm targets for job worktrees. Zero dependencies.
 *
 * Everything parsed here comes from compiling and running contributor code, so
 * summaries are untrusted text (see untrusted-output.mjs: "rust").
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const RUST_TOOL = /^(?:cargo|rustc|rustup|rustdoc|rustfmt|clippy-driver|cargo-[a-z0-9_-]+)$/i;
const toolName = command => String(command || "").replaceAll("\\", "/").split("/").at(-1).replace(/\.exe$/i, "");
/** cargo-affected.mjs and check-rust-arch.mjs count as Rust tools for diagnostics. */
export const AFFECTED_SCRIPT = "cargo-affected.mjs";
export const ARCH_SCRIPT = "check-rust-arch.mjs";
export const runsRust = check =>
  RUST_TOOL.test(toolName(check?.command)) ||
  (check?.args || []).some(arg => [AFFECTED_SCRIPT, ARCH_SCRIPT].includes(toolName(arg)));

// ---------------------------------------------------------------- test counts
const NEXTEST_SUMMARY = /^\s*Summary \[[^\]]*\]\s+(\d+) tests? run:([^\n]*)$/m;
const LIBTEST_RESULT = /^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed;/gm;
/**
 * Counts from `cargo nextest` (its Summary line) or libtest (`cargo test`
 * prints one "test result:" line per test binary and doc-test run; they are
 * summed). Returns null when neither format is present.
 */
export function parseCargoCounts(text) {
  const summary = String(text).match(NEXTEST_SUMMARY);
  if (summary) {
    const n = re => Number(summary[2].match(re)?.[1] || 0);
    const fail = n(/(\d+) failed/) + n(/(\d+) timed out/);
    return { pass: n(/(\d+) passed/), fail, format: "nextest" };
  }
  let pass = 0, fail = 0, seen = 0;
  for (const m of String(text).matchAll(LIBTEST_RESULT)) { pass += Number(m[1]); fail += Number(m[2]); seen++; }
  return seen ? { pass, fail, format: "cargo" } : null;
}

// ---------------------------------------------------------------- diagnostics
const MAX_ITEMS = 8, MAX_TEXT = 240;
const clip = s => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT - 1) + "…" : s);
const stripAnsi = s => s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
const NOISE = /^(?:could not compile|aborting due to|test failed, to rerun|build failed|Recipe|\d+ (?:previous )?errors?|`[^`]+` \((?:lib|bin|test)[^)]*\) generated)/i;
function relative(file, cwd) {
  if (!file) return file;
  const clean = file.replaceAll("\\", "/");
  if (cwd && path.isAbsolute(file)) {
    const rel = path.relative(cwd, file).replaceAll("\\", "/");
    if (!rel.startsWith("..")) return rel;
  }
  return clean;
}
/**
 * Compact summary of rustc/clippy diagnostics and failing tests from cargo or
 * nextest output (human format). Returns null when nothing Rust-specific is
 * found. Bounded: at most 8 diagnostics and 8 failing tests, 240 chars each.
 */
export function rustDiagnostics(text, cwd) {
  const lines = stripAnsi(String(text)).split(/\r?\n/);
  const errorItems = [], warningItems = [], failedTests = [], unformatted = [];
  let errors = 0, warnings = 0, unformattedCount = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const head = line.match(/^(error|warning)(?:\[([A-Za-z]+\d+|[a-z_:]+)\])?: (.+)$/);
    if (head && !NOISE.test(head[3])) {
      let location = null;
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const at = lines[j].match(/^\s*-->\s+(.+?):(\d+):(\d+)\s*$/);
        if (at) { location = { file: relative(at[1], cwd), line: Number(at[2]), column: Number(at[3]) }; break; }
      }
      if (!location && head[1] === "warning") continue; // summary warnings without a span
      const item = { level: head[1], ...(head[2] ? { code: head[2] } : {}), message: clip(head[3]), ...(location || {}) };
      if (head[1] === "error") { errors++; if (errorItems.length < MAX_ITEMS) errorItems.push(item); }
      else { warnings++; if (warningItems.length < MAX_ITEMS) warningItems.push(item); }
      continue;
    }
    // rustfmt --check: "Diff in /abs/path/src/lib.rs:12:" (older: "Diff in /abs/path/src/lib.rs at line 12:")
    const diff = line.match(/^Diff in (.+?)(?::(\d+):| at line (\d+):)\s*$/);
    if (diff) {
      const file = relative(diff[1], cwd);
      if (!unformatted.includes(file)) { unformattedCount++; if (unformatted.length < MAX_ITEMS) unformatted.push(file); }
      continue;
    }
    // libtest: "thread 'name' panicked at file:line:col:" (newer: "thread 'name' (123) panicked at")
    const panic = line.match(/^thread '([^']+)'(?: \(\d+\))? panicked at (.+?):(\d+):(\d+):?\s*$/);
    if (panic) {
      const message = (lines[i + 1] || "").trim();
      if (!failedTests.some(t => t.name === panic[1]) && failedTests.length < MAX_ITEMS)
        failedTests.push({ name: clip(panic[1]), file: relative(panic[2], cwd), line: Number(panic[3]), message: clip(message) });
      continue;
    }
    // nextest: "        FAIL [   0.003s] crate::binary test::name"
    const fail = line.match(/^\s+(?:FAIL|TIMEOUT|SIGSEGV|SIGABRT|ABORT) \[[^\]]*\] (?:\(\s*\d+\/\d+\)\s+)?(.+)$/);
    if (fail) {
      const name = fail[1].trim();
      if (!failedTests.some(t => t.name === name || name.endsWith(" " + t.name)) && failedTests.length < MAX_ITEMS)
        failedTests.push({ name: clip(name) });
      continue;
    }
    // libtest list: "test tests::it ... FAILED"
    const listed = line.match(/^test (\S+) \.\.\. FAILED$/);
    if (listed && !failedTests.some(t => t.name === listed[1] || t.name.endsWith(listed[1])) && failedTests.length < MAX_ITEMS)
      failedTests.push({ name: clip(listed[1]) });
  }
  if (!errorItems.length && !warningItems.length && !failedTests.length && !unformatted.length) return null;
  // Errors first: they explain a failed check; warnings fill any remaining slots.
  const diagnostics = [...errorItems, ...warningItems].slice(0, MAX_ITEMS);
  return { errors, warnings, diagnostics, failedTests, ...(unformatted.length ? { unformattedFiles: unformattedCount, unformatted } : {}) };
}

// ------------------------------------------------------------ crate selection
const GLOBAL = [/^Cargo\.lock$/, /^Cargo\.toml$/, /^\.cargo\//, /^rust-toolchain(?:\.toml)?$/, /^clippy\.toml$/, /^\.clippy\.toml$/, /^rustfmt\.toml$/, /^\.rustfmt\.toml$/, /^deny\.toml$/];
const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
/**
 * Which workspace packages a change affects, from `cargo metadata --no-deps`
 * output: packages owning a changed file plus every workspace package that
 * depends on them (normal, dev or build), transitively. Workspace-wide inputs
 * (root manifest, lockfile, .cargo/, toolchain/lint config) select everything.
 * Files outside every package (docs/, .github/) select nothing.
 */
export function affectedPackages(metadata, changed, root = metadata.workspace_root) {
  const wsRoot = real(root);
  const members = new Set(metadata.workspace_members || []);
  const packages = (metadata.packages || []).filter(p => members.has(p.id)).map(p => ({ name: p.name, dir: real(path.dirname(p.manifest_path)), deps: p.dependencies || [] }));
  const files = [...new Set((changed || []).map(f => String(f).replaceAll("\\", "/").replace(/^\.\//, "")).filter(Boolean))];
  if (!files.length) return { mode: "none", packages: [], reason: "no changed files" };
  const rootPackage = packages.find(p => p.dir === wsRoot);
  const global = files.filter(f => GLOBAL.some(re => re.test(f)));
  if (global.length) return { mode: "workspace", packages: packages.map(p => p.name).sort(), reason: "workspace-wide input changed: " + global.slice(0, 3).join(", ") };
  void rootPackage; // a root package owns files outside other members via longest-prefix below
  const owner = file => {
    const abs = path.join(wsRoot, file);
    let best = null;
    for (const p of packages) if ((abs === p.dir || abs.startsWith(p.dir + path.sep)) && (!best || p.dir.length > best.dir.length)) best = p;
    return best;
  };
  const direct = new Set();
  for (const f of files) { const p = owner(f); if (p) direct.add(p.name); }
  if (!direct.size) return { mode: "none", packages: [], reason: "no changed file belongs to a workspace package" };
  const byDir = new Map(packages.map(p => [p.dir, p.name]));
  const dependents = new Map(packages.map(p => [p.name, new Set()]));
  for (const p of packages)
    for (const d of p.deps) {
      const target = d.path ? byDir.get(real(d.path)) : null;
      if (target && target !== p.name) dependents.get(target).add(p.name);
    }
  const selected = new Set(direct), queue = [...direct];
  while (queue.length) for (const next of dependents.get(queue.shift()) || []) if (!selected.has(next)) { selected.add(next); queue.push(next); }
  const all = selected.size === packages.length;
  return { mode: all ? "workspace" : "packages", packages: [...selected].sort(), direct: [...direct].sort(), reason: all ? "every workspace package is affected" : `${direct.size} changed, ${selected.size - direct.size} dependent` };
}
/** Insert package selection into cargo arguments, before a literal "--" separator. */
export function withSelection(args, selection) {
  const flags = selection.mode === "workspace" ? ["--workspace"] : selection.packages.flatMap(name => ["-p", name]);
  const split = args.indexOf("--");
  return split < 0 ? [...args, ...flags] : [...args.slice(0, split), ...flags, ...args.slice(split)];
}

// --------------------------------------------------------------- readiness
/**
 * Host-side Rust readiness for codex_doctor (no model call, no sandbox): which
 * toolchain the checks will use, whether every locked dependency is already
 * available offline (checks run with network off), whether target/ can be
 * warmed, and whether cargo-nextest is installed. Null when cwd is not Cargo.
 */
export function rustReadiness(cwd, spawn, environment = process.env) {
  if (!cwd || !fs.existsSync(path.join(cwd, "Cargo.toml"))) return null;
  const run = (args, timeout = 30000) => {
    try {
      const r = spawn(environment.CARGO || "cargo", args, { cwd, encoding: "utf8", timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
      return { ok: r.status === 0, out: String(r.stdout || "").trim(), err: String(r.stderr || "").trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 400), missing: r.error?.code === "ENOENT" };
    } catch (e) { return { ok: false, out: "", err: String(e.message || e).slice(0, 300) }; }
  };
  const cargo = run(["--version"], 15000);
  if (!cargo.ok) return { cargo: "unavailable", advice: [cargo.missing ? "cargo is not on PATH for the plugin; install rustup or add the toolchain's bin directory to PATH (or gates.toolchain.prependPath)." : "cargo --version failed: " + cargo.err] };
  const offline = run(["fetch", "--locked", "--offline"], 120000);
  const nextest = run(["nextest", "--version"], 15000);
  const advice = [];
  if (!offline.ok) advice.push("Dependencies are not all available offline. Checks run with network off: run `cargo fetch --locked` on the host (an owner-authorized download), then verify again. " + (offline.err ? "cargo said: " + offline.err : ""));
  if (environment.CARGO_TARGET_DIR) advice.push("CARGO_TARGET_DIR is set: job worktrees share that directory, so concurrent jobs serialize on its lock and warm targets are skipped.");
  return {
    cargo: cargo.out,
    offlineDependencies: offline.ok ? "ready" : "missing",
    nextest: nextest.ok ? nextest.out.split(/\r?\n/)[0] : "not installed (template uses cargo test; examples/rust swaps in nextest)",
    warmTarget: { mode: environment.CODEX_TEAM_WARM_TARGET || "clone", targetPresent: fs.existsSync(path.join(cwd, "target")) },
    profileTemplate: "Use \"extends\": \"rust\" in .codex-team/profile.json for fmt, clippy and tests on affected packages.",
    ...(advice.length ? { advice } : {}),
  };
}

// ------------------------------------------------------------- warm targets
/**
 * Warm a freshly created job worktree from the original checkout's target/.
 * Mode from CODEX_TEAM_WARM_TARGET: "clone" (default, copy-on-write only),
 * "copy" (full copy fallback) or "off". Only an ignored target/ is warmed, so
 * snapshots, scope checks and fingerprints never see build artifacts.
 * Never throws: a warm target is an optimization, not a requirement.
 */
export function warmJobTarget(origin, worktree, git, mode = process.env.CODEX_TEAM_WARM_TARGET || "clone") {
  try {
    if (!["clone", "copy", "off"].includes(mode)) return { status: "skipped", reason: "CODEX_TEAM_WARM_TARGET must be clone, copy or off" };
    if (mode === "off") return { status: "off" };
    if (!fs.existsSync(path.join(worktree, "Cargo.toml"))) return { status: "skipped", reason: "not a Cargo project" };
    const ignored = git(worktree, ["check-ignore", "-q", "target/"], true);
    if (ignored.status !== 0) {
      const tracked = git(worktree, ["ls-files", "--", "target"], true);
      return { status: "skipped", reason: tracked.status === 0 && String(tracked.stdout || "").trim()
        ? "target/ is tracked by Git; untrack it (git rm -r --cached target) and add /target to .gitignore"
        : "target/ is not ignored by Git; add /target to .gitignore" };
    }
    return warmTarget(origin, worktree, mode);
  } catch (e) {
    return { status: "failed", reason: String(e?.message || e).slice(0, 300) };
  }
}
/**
 * Copy-on-write clone of the repository's target/ into a job worktree, so the
 * worktree starts with every dependency already built. Cargo keys workspace
 * crates by their absolute path, so changed sources in the worktree still
 * rebuild (verified: a dependency change fails the dependent's tests).
 * Never falls back to a byte copy unless mode === "copy": an unsupported
 * filesystem would otherwise copy gigabytes.
 */
export function warmTarget(repoRoot, worktree, mode = "clone") {
  const source = path.join(repoRoot, "target"), dest = path.join(worktree, "target");
  if (mode === "off") return { status: "off" };
  if (!fs.existsSync(path.join(worktree, "Cargo.toml"))) return { status: "skipped", reason: "not a Cargo project" };
  if (process.env.CARGO_TARGET_DIR || process.env.CARGO_BUILD_TARGET_DIR) return { status: "skipped", reason: "CARGO_TARGET_DIR is set; cargo already shares one target directory" };
  let stat;
  try { stat = fs.lstatSync(source); } catch { return { status: "skipped", reason: "repository has no target/ yet" }; }
  if (!stat.isDirectory()) return { status: "skipped", reason: "target is not a directory" };
  if (fs.existsSync(dest)) return { status: "skipped", reason: "worktree already has target/" };
  const started = Date.now();
  if (mode === "clone" && process.platform === "darwin") {
    // Node's COPYFILE_FICLONE_FORCE is ENOSYS on macOS even on APFS; clonefile(2)
    // through /bin/cp -c is the supported path and fails instead of copying.
    const r = spawnSync("/bin/cp", ["-c", "-R", source, dest], { encoding: "utf8", timeout: 600000 });
    if (r.status !== 0) {
      fs.rmSync(dest, { recursive: true, force: true });
      return { status: "skipped", reason: "filesystem does not support copy-on-write clones (" + String(r.stderr || r.error?.message || "cp -c failed").trim().slice(0, 200) + "); CODEX_TEAM_WARM_TARGET=copy forces a full copy" };
    }
    return { status: "cloned", durationMs: Date.now() - started };
  }
  if (mode === "clone" && process.platform === "win32")
    return { status: "skipped", reason: "copy-on-write clones are not detectable on Windows; on a ReFS Dev Drive, CODEX_TEAM_WARM_TARGET=copy lets Windows block-clone the copy" };
  if (mode === "clone") {
    // Probe: one real file cloned with FICLONE_FORCE, which throws on filesystems without reflinks.
    const probe = findFile(source);
    if (!probe) return { status: "skipped", reason: "target/ is empty" };
    const probeDest = path.join(worktree, ".codex-team-reflink-probe");
    try { fs.copyFileSync(probe, probeDest, fs.constants.COPYFILE_FICLONE_FORCE); }
    catch { return { status: "skipped", reason: "filesystem does not support copy-on-write clones (use warmTarget: \"copy\" to force a full copy)" }; }
    finally { fs.rmSync(probeDest, { force: true }); }
  }
  try {
    fs.cpSync(source, dest, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, mode: mode === "clone" ? fs.constants.COPYFILE_FICLONE_FORCE : fs.constants.COPYFILE_FICLONE });
  } catch (e) {
    fs.rmSync(dest, { recursive: true, force: true });
    return { status: "failed", reason: String(e.message || e).slice(0, 300) };
  }
  return { status: mode === "clone" ? "cloned" : "copied", durationMs: Date.now() - started };
}
function findFile(dir, depth = 0) {
  if (depth > 6) return null;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) if (e.isFile()) return path.join(dir, e.name);
  for (const e of entries) if (e.isDirectory()) { const f = findFile(path.join(dir, e.name), depth + 1); if (f) return f; }
  return null;
}
