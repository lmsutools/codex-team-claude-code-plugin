#!/usr/bin/env node
/**
 * Fast (<50ms) architectural guardrail for multi-crate Rust workspaces.
 *
 * Enforces five laws that keep large multi-agent Rust codebases fast to compile
 * and clean at scale:
 *   1. No feature-unification thrashing: member Cargo.toml files must not add
 *      per-crate `features = [...]` on `[workspace.dependencies]` items, so
 *      `cargo test -p <crate>` and `cargo test --workspace` share one cache hash.
 *   2. Single integration-test binary per crate: `tests/` may have at most one
 *      top-level `.rs` file (or `tests/it/main.rs`), avoiding N× link steps.
 *   3. OS conditional compilation (`#[cfg(target_os/unix/windows)]`) stays inside
 *      the `platform` crate.
 *   4. Pure domain & shallow DAG: `domain` never depends on I/O or runtime crates
 *      (`tokio`, `reqwest`, `axum`, `sqlx`, `hyper`, `tonic`, `sentry`), and
 *      internal workspace dependency depth is <= 4.
 *   5. Member crates inherit `[lints] workspace = true` when the root defines
 *      `[workspace.lints]`.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const FORBIDDEN_DOMAIN_DEPS = new Set([
  "tokio", "reqwest", "hyper", "axum", "actix-web", "sqlx", "diesel", "sea-orm", "tonic", "sentry", "sentry-tracing",
]);
const CFG_OS_RE = /#\s*\[\s*cfg\s*\([^)]*\b(?:target_os|target_family|unix|windows)\b/;

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

/** Audit a Rust workspace at `cwd` and return `{ ok, violations }`. */
export function checkRustArchitecture(cwd = process.cwd()) {
  const rootManifest = path.join(cwd, "Cargo.toml");
  if (!fs.existsSync(rootManifest)) return { ok: true, violations: [] };
  const rootRaw = fs.readFileSync(rootManifest, "utf8");
  if (!/\[workspace\]/.test(rootRaw)) return { ok: true, violations: [] };

  const rootHasWorkspaceLints = /\[workspace\.lints(?:\.|\])/.test(rootRaw);
  const manifests = walkFiles(cwd, f => path.basename(f) === "Cargo.toml" && path.resolve(f) !== path.resolve(rootManifest));
  const crates = manifests.map(parseCrateManifest).filter(c => c.name);
  const violations = [];
  const rel = p => path.relative(cwd, p).replaceAll("\\", "/");

  for (const crate of crates) {
    const isPlatform = crate.name === "platform" || crate.name.endsWith("-platform") || rel(crate.dir) === "crates/platform";
    const isDomain = crate.name === "domain" || crate.name.endsWith("-domain") || rel(crate.dir) === "crates/domain";
    const isTelemetry = crate.name === "telemetry" || crate.name.endsWith("-telemetry") || rel(crate.dir) === "crates/telemetry";

    // Law 1: No per-crate feature overrides on workspace dependencies (prevents cache thrashing between -p and --workspace)
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

  return { ok: violations.length === 0, violations };
}

function main(argv = process.argv.slice(2)) {
  const cwd = argv[0] ? path.resolve(argv[0]) : process.cwd();
  const result = checkRustArchitecture(cwd);
  if (!result.ok) {
    for (const v of result.violations) {
      process.stderr.write(`error[${v.rule}]: ${v.message}\n  --> ${v.file}:${v.line || 1}:${v.column || 1}\n`);
    }
    process.exit(1);
  }
  process.stdout.write("check-rust-arch: ok\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
