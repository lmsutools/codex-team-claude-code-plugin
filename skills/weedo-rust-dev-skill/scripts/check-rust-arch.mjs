#!/usr/bin/env node
/**
 * Fast (<50ms) architectural guardrail & brownfield migration ratchet for Rust workspaces.
 *
 * Modes:
 *   node check-rust-arch.mjs [cwd]
 *     Audits the workspace. If `.codex-team/arch-baseline.json` exists, runs in
 *     RATCHET mode: baselined legacy violations are tolerated, and only NEW
 *     violations fail the check.
 *
 *   node check-rust-arch.mjs [cwd] --write-baseline
 *     Snapshots current violations into `.codex-team/arch-baseline.json` so an
 *     existing brownfield codebase can adopt the guardrail immediately ("stop
 *     the bleeding") and burn down debt incrementally.
 *
 *   node check-rust-arch.mjs [cwd] --plan
 *     Outputs a prioritized 5-phase Strangler-Fig migration plan based on the
 *     exact architectural debt detected in the workspace.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const FORBIDDEN_DOMAIN_DEPS = new Set([
  "tokio", "reqwest", "hyper", "axum", "actix-web", "sqlx", "diesel", "sea-orm", "tonic", "sentry", "sentry-tracing",
]);
const CFG_OS_RE = /#\s*\[\s*cfg\s*\([^)]*\b(?:target_os|target_family|unix|windows)\b/;
const BASELINE_REL = ".codex-team/arch-baseline.json";

function walkFiles(dir, predicate, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "target" || entry.name.startsWith("target-") || entry.name === ".git" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, predicate, out);
    else if (entry.isFile() && predicate(full)) out.push(full);
  }
  return out;
}

function parseCrateManifest(manifestPath) {
  const raw = fs.readFileSync(manifestPath, "utf8");
  const lines = raw.split(/\r?\n/);
  let section = "";
  let name = null;
  let hasWorkspaceLints = false;
  const deps = [];
  const featureOverrides = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) {
      section = sec[1].trim();
      continue;
    }
    if (section === "package") {
      const m = line.match(/^name\s*=\s*"([^"]+)"/);
      if (m) name = m[1];
    } else if (section === "lints") {
      if (/^workspace\s*=\s*true\b/.test(line)) hasWorkspaceLints = true;
    } else if (/^(?:dependencies|(?:dev|build)-dependencies|target\..+\.dependencies)$/.test(section)) {
      const depMatch = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
      if (!depMatch) continue;
      const [, depName, rhs] = depMatch;
      if (section === "dependencies") deps.push(depName);
      if (/workspace\s*=\s*true/.test(rhs) && /features\s*=\s*\[/.test(rhs)) {
        featureOverrides.push(depName);
      }
    }
  }
  return { name, manifestPath, dir: path.dirname(manifestPath), raw, deps, featureOverrides, hasWorkspaceLints };
}

const violationKey = v => `${v.rule}::${v.file}`;

/** Audit a Rust workspace at `cwd` and return `{ ok, violations, newViolations, baselinedCount, fixedCount }`. */
export function checkRustArchitecture(cwd = process.cwd(), { ignoreBaseline = false } = {}) {
  const rootManifest = path.join(cwd, "Cargo.toml");
  if (!fs.existsSync(rootManifest)) return { ok: true, violations: [], newViolations: [], baselinedCount: 0, fixedCount: 0 };
  const rootRaw = fs.readFileSync(rootManifest, "utf8");
  const rel = p => path.relative(cwd, p).replaceAll("\\", "/");
  const violations = [];

  // Single-crate monolith detection (not a [workspace] yet)
  if (!/\[workspace\]/.test(rootRaw)) {
    const rootCrate = parseCrateManifest(rootManifest);
    const testsDir = path.join(cwd, "tests");
    if (fs.existsSync(testsDir)) {
      const topRs = fs.readdirSync(testsDir, { withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith(".rs")).map(e => e.name);
      const hasItMain = fs.existsSync(path.join(testsDir, "it", "main.rs"));
      if (topRs.length > 1 || (topRs.length >= 1 && hasItMain)) {
        violations.push({
          rule: "arch::single_integration_test_binary",
          file: rel(path.join(testsDir, topRs[0] || "it/main.rs")),
          line: 1,
          column: 1,
          message: `${rootCrate.name || "root"} has multiple integration test binaries (${[...topRs, ...(hasItMain ? ["it/main.rs"] : [])].join(", ")}); consolidate into tests/it/main.rs`,
        });
      }
    }
    return applyBaseline(cwd, violations, ignoreBaseline);
  }

  const rootHasWorkspaceLints = /\[workspace\.lints(?:\.|\])/.test(rootRaw);
  const manifests = walkFiles(cwd, f => path.basename(f) === "Cargo.toml" && path.resolve(f) !== path.resolve(rootManifest));
  const crates = manifests.map(parseCrateManifest).filter(c => c.name);

  for (const crate of crates) {
    const isPlatform = crate.name === "platform" || crate.name.endsWith("-platform") || rel(crate.dir) === "crates/platform";
    const isDomain = crate.name === "domain" || crate.name.endsWith("-domain") || rel(crate.dir) === "crates/domain";
    const isTelemetry = crate.name === "telemetry" || crate.name.endsWith("-telemetry") || rel(crate.dir) === "crates/telemetry";

    // Law 1: No per-crate feature overrides on workspace dependencies
    if (!isTelemetry && crate.featureOverrides.length) {
      violations.push({
        rule: "arch::no_workspace_feature_thrash",
        file: rel(crate.manifestPath),
        line: 1,
        column: 1,
        message: `${crate.name} overrides features on workspace dependencies (${crate.featureOverrides.join(", ")}); unify features in root [workspace.dependencies] so 'cargo test -p' and '--workspace' share one artifact cache`,
      });
    }

    // Law 2: Single integration-test binary per crate
    const testsDir = path.join(crate.dir, "tests");
    if (fs.existsSync(testsDir)) {
      const topRs = fs.readdirSync(testsDir, { withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith(".rs")).map(e => e.name);
      const hasItMain = fs.existsSync(path.join(testsDir, "it", "main.rs"));
      if (topRs.length > 1 || (topRs.length >= 1 && hasItMain)) {
        violations.push({
          rule: "arch::single_integration_test_binary",
          file: rel(path.join(testsDir, topRs[0] || "it/main.rs")),
          line: 1,
          column: 1,
          message: `${crate.name} has multiple integration test binaries (${[...topRs, ...(hasItMain ? ["it/main.rs"] : [])].join(", ")}); consolidate into tests/it/main.rs so cargo links only one test binary`,
        });
      }
    }

    // Law 3: OS conditional compilation stays in crates/platform
    if (!isPlatform) {
      const srcFiles = walkFiles(path.join(crate.dir, "src"), f => f.endsWith(".rs"));
      for (const file of srcFiles) {
        const text = fs.readFileSync(file, "utf8");
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (CFG_OS_RE.test(lines[i])) {
            violations.push({
              rule: "arch::platform_cfg_isolation",
              file: rel(file),
              line: i + 1,
              column: 1,
              message: `OS conditional compilation (${lines[i].trim()}) outside crates/platform; move OS-specific code behind a port trait implemented in crates/platform`,
            });
            break;
          }
        }
      }
    }

    // Law 4a: Pure domain crate
    if (isDomain) {
      const bad = crate.deps.filter(d => FORBIDDEN_DOMAIN_DEPS.has(d));
      if (bad.length) {
        violations.push({
          rule: "arch::pure_domain",
          file: rel(crate.manifestPath),
          line: 1,
          column: 1,
          message: `domain crate (${crate.name}) depends on runtime/IO crates (${bad.join(", ")}); keep domain pure and put IO in sibling adapter crates`,
        });
      }
    }

    // Law 5: Inherit [lints] workspace = true
    if (rootHasWorkspaceLints && !crate.hasWorkspaceLints) {
      violations.push({
        rule: "arch::workspace_lints",
        file: rel(crate.manifestPath),
        line: 1,
        column: 1,
        message: `${crate.name} is missing '[lints] workspace = true'`,
      });
    }
  }

  // Law 4b: Sibling adapter isolation & Workspace dependency depth <= 4
  const byName = new Map(crates.map(c => [c.name, c]));
  const isFoundation = c => {
    const r = rel(c.dir);
    return (
      c.name === "domain" || c.name.endsWith("-domain") || r === "crates/domain" ||
      c.name === "app" || c.name.endsWith("-app") || r === "crates/app" ||
      c.name === "types" || c.name.endsWith("-types") || r === "crates/types" ||
      c.name === "test-support" || c.name.endsWith("-test-support") || r === "crates/test-support"
    );
  };
  const isAdapter = c => rel(c.dir).startsWith("crates/") && !isFoundation(c);
  for (const crate of crates) {
    if (!isAdapter(crate)) continue;
    const siblingDeps = crate.deps.filter(d => byName.has(d) && isAdapter(byName.get(d)));
    if (siblingDeps.length) {
      violations.push({
        rule: "arch::sibling_adapter_isolation",
        file: rel(crate.manifestPath),
        line: 1,
        column: 1,
        message: `adapter crate '${crate.name}' depends directly on sibling adapter (${siblingDeps.join(", ")}); depend only on domain/app port traits and wire siblings in the binary crate`,
      });
    }
  }

  const memo = new Map();
  const depthOf = (name, visiting = new Set()) => {
    if (memo.has(name)) return memo.get(name);
    if (visiting.has(name)) return 0;
    visiting.add(name);
    const crate = byName.get(name);
    let maxChild = 0;
    for (const dep of crate?.deps || []) {
      if (byName.has(dep)) maxChild = Math.max(maxChild, 1 + depthOf(dep, new Set(visiting)));
    }
    memo.set(name, maxChild);
    return maxChild;
  };
  for (const crate of crates) {
    const d = depthOf(crate.name);
    if (d > 4) {
      violations.push({
        rule: "arch::max_workspace_depth",
        file: rel(crate.manifestPath),
        line: 1,
        column: 1,
        message: `${crate.name} has internal workspace dependency depth ${d} (max 4); flatten adapter crates into siblings so Cargo compiles in parallel`,
      });
    }
  }

  return applyBaseline(cwd, violations, ignoreBaseline);
}

function applyBaseline(cwd, violations, ignoreBaseline) {
  const baselinePath = path.join(cwd, BASELINE_REL);
  if (ignoreBaseline || !fs.existsSync(baselinePath)) {
    return { ok: violations.length === 0, violations, newViolations: violations, baselinedCount: 0, fixedCount: 0 };
  }
  let baseline = { entries: [] };
  try { baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8")); } catch {}
  const knownKeys = new Set((baseline.entries || []).map(violationKey));
  const currentKeys = new Set(violations.map(violationKey));
  const newViolations = violations.filter(v => !knownKeys.has(violationKey(v)));
  const baselinedCount = violations.length - newViolations.length;
  const fixedCount = [...knownKeys].filter(k => !currentKeys.has(k)).length;
  return {
    ok: newViolations.length === 0,
    violations,
    newViolations,
    baselinedCount,
    fixedCount,
  };
}

/** Snapshot current architectural violations into `.codex-team/arch-baseline.json`. */
export function writeArchBaseline(cwd = process.cwd()) {
  const audit = checkRustArchitecture(cwd, { ignoreBaseline: true });
  const baselinePath = path.join(cwd, BASELINE_REL);
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  const payload = {
    version: "1.0",
    entries: audit.violations.map(v => ({ rule: v.rule, file: v.file, message: v.message })),
  };
  fs.writeFileSync(baselinePath, JSON.stringify(payload, null, 2) + "\n");
  return { path: baselinePath, count: payload.entries.length, entries: payload.entries };
}

/** Generate a prioritized 5-phase Strangler-Fig migration plan for an existing brownfield Rust repo. */
export function buildBrownfieldPlan(cwd = process.cwd()) {
  const rootManifest = path.join(cwd, "Cargo.toml");
  const rootRaw = fs.existsSync(rootManifest) ? fs.readFileSync(rootManifest, "utf8") : "";
  const isWorkspace = /\[workspace\]/.test(rootRaw);
  const audit = checkRustArchitecture(cwd, { ignoreBaseline: true });
  const byRule = rule => audit.violations.filter(v => v.rule === rule);

  const phases = [
    {
      phase: 0,
      title: "Freeze Debt & Drop In Zero-Code Build Accelerators (15 mins, 0 code risk)",
      why: "Speeds up every subsequent refactoring compile and stops new architectural regressions immediately.",
      steps: [
        "Copy .cargo/config.toml (fast linker + split-debuginfo = 'unpacked') and [profile.dev] line-tables-only into root Cargo.toml.",
        "Run 'node scripts/check-rust-arch.mjs --write-baseline' to record existing violations in .codex-team/arch-baseline.json (Ratchet Mode).",
        "Add .codex-team/profile.json with '\"extends\": \"rust\"' and the 'arch' gate.",
      ],
    },
    {
      phase: 1,
      title: "Eliminate Cache Thrashing & Multi-Binary Test Link Storms (30-60 mins, 2-5x faster TDD)",
      why: "Unifies dependency hashes between 'cargo test -p' and '--workspace' and cuts test linking to 1 binary per crate.",
      findings: [
        ...byRule("arch::no_workspace_feature_thrash").map(v => v.file),
        ...byRule("arch::single_integration_test_binary").map(v => v.file),
      ],
      steps: [
        isWorkspace
          ? "Hoist shared dependency feature lists into root [workspace.dependencies] and remove per-crate features=[...] overrides."
          : "Convert root Cargo.toml into a [workspace] (resolver = '3') keeping the existing package in place while preparing crates/*.",
        "Consolidate multiple tests/*.rs files per crate into a single tests/it/main.rs with 'mod <name>;' declarations.",
      ],
    },
    {
      phase: 2,
      title: "Extract Leaf Infrastructure Crates: crates/platform & crates/telemetry",
      why: "Isolates OS #[cfg] seams and Sentry/tracing-subscriber compilation out of core logic with zero domain risk.",
      findings: byRule("arch::platform_cfg_isolation").map(v => `${v.file}:${v.line}`),
      steps: [
        "Create crates/platform and move scattered #[cfg(target_os/unix/windows)] functions behind a Platform trait; leave 'pub use' shims at old call sites.",
        "Create crates/telemetry from resources/templates/telemetry.rs so only the composition root compiles sentry/tracing-subscriber.",
      ],
    },
    {
      phase: 3,
      title: "Carve Out Pure crates/domain via Re-Export Shims (Strangler Seam)",
      why: "Creates a sub-second-compile foundation crate without breaking existing imports.",
      findings: byRule("arch::pure_domain").map(v => v.file),
      steps: [
        "Move pure value types, ID newtypes, and error enums (no tokio/sqlx/reqwest) into crates/domain.",
        "In the legacy crate, add 'pub use <name>_domain::*;' so existing modules keep compiling unchanged while new crates depend on domain.",
      ],
    },
    {
      phase: 4,
      title: "Decouple Sibling Adapters Behind Port Traits (Parallelizable with codex_batch)",
      why: "Flattens dependency depth <= 4 so Cargo compiles all adapters concurrently across all CPU cores.",
      findings: [
        ...byRule("arch::sibling_adapter_isolation").map(v => v.file),
        ...byRule("arch::max_workspace_depth").map(v => v.file),
      ],
      steps: [
        "Define object-safe port traits (Arc<dyn Port>) in crates/app.",
        "Dispatch parallel worktree jobs (codex_batch) to extract heavy adapters (db, http, storage, codegen) into sibling crates/* that depend only on domain + app.",
        "Re-run 'node scripts/check-rust-arch.mjs --write-baseline' after each phase until baselined violations reach 0.",
      ],
    },
  ];

  return {
    isWorkspace,
    totalViolations: audit.violations.length,
    countsByRule: Object.fromEntries(
      [...new Set(audit.violations.map(v => v.rule))].sort().map(r => [r, byRule(r).length]),
    ),
    phases,
  };
}

function main(argv = process.argv.slice(2)) {
  let cwd = process.cwd();
  let mode = "check";
  for (const arg of argv) {
    if (arg === "--write-baseline") mode = "write-baseline";
    else if (arg === "--plan") mode = "plan";
    else if (!arg.startsWith("-")) cwd = path.resolve(arg);
  }

  if (mode === "write-baseline") {
    const written = writeArchBaseline(cwd);
    process.stdout.write(`check-rust-arch: wrote ${written.count} baselined violation(s) to ${BASELINE_REL}\n`);
    return;
  }
  if (mode === "plan") {
    process.stdout.write(JSON.stringify(buildBrownfieldPlan(cwd), null, 2) + "\n");
    return;
  }

  const result = checkRustArchitecture(cwd);
  if (!result.ok) {
    for (const v of result.newViolations) {
      process.stderr.write(`error[${v.rule}]: ${v.message}\n  --> ${v.file}:${v.line || 1}:${v.column || 1}\n`);
    }
    process.exit(1);
  }
  const suffix = result.baselinedCount || result.fixedCount
    ? ` (${result.baselinedCount} baselined legacy, ${result.fixedCount} fixed since baseline)`
    : "";
  process.stdout.write(`check-rust-arch: ok${suffix}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
