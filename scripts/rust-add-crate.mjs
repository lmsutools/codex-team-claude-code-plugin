#!/usr/bin/env node
/**
 * Golden Protocol Beat 1 helper: scaffolds a compliant sibling adapter crate
 * under `crates/<name>` and registers it in root `[workspace.dependencies]` in <50ms.
 *
 * Why this exists:
 *   In multi-agent Rust (`codex_batch`), parallel workers must NEVER edit root
 *   `Cargo.toml` concurrently (causes merge conflicts & feature-hash thrashing).
 *   Instead, the lead runs `node scripts/rust-add-crate.mjs <name>` serially in
 *   Beat 1 (Spine & Contracts), warms `target/`, and then fans out parallel
 *   workers scoped strictly to `crates/<name>/**` in Beat 2.
 *
 * Usage:
 *   node scripts/rust-add-crate.mjs <crate-short-name> [--cwd <workspace-root>]
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const VALID_CRATE_NAME_RE = /^[a-z][a-z0-9-]*$/;

function inferWorkspacePrefix(rootRaw, cwd) {
  const domainMatch = rootRaw.match(/^\s*([a-z0-9-]+)-domain\s*=\s*\{\s*path\s*=\s*"crates\/domain"/m);
  if (domainMatch) return domainMatch[1];
  const appMatch = rootRaw.match(/default-members\s*=\s*\[\s*"apps\/([a-z0-9-]+)"/);
  if (appMatch) return appMatch[1];
  return "";
}

/**
 * Create `crates/<name>` with a Golden-Protocol-compliant `Cargo.toml`, `src/lib.rs`,
 * and single integration-test binary `tests/it/main.rs`, and register it in root `Cargo.toml`.
 */
export function addSiblingCrate(name, { cwd = process.cwd() } = {}) {
  if (!name || !VALID_CRATE_NAME_RE.test(name)) {
    throw new Error(`Invalid crate name '${name}' (must match /^[a-z][a-z0-9-]*$/)`);
  }
  const rootManifest = path.join(cwd, "Cargo.toml");
  if (!fs.existsSync(rootManifest)) {
    throw new Error(`No root Cargo.toml found at ${rootManifest}`);
  }
  const rootRaw = fs.readFileSync(rootManifest, "utf8");
  if (!/\[workspace\]/.test(rootRaw)) {
    throw new Error(`Root Cargo.toml at ${rootManifest} is not a [workspace]`);
  }

  const crateRelDir = `crates/${name}`;
  const crateDir = path.join(cwd, "crates", name);
  const manifestPath = path.join(crateDir, "Cargo.toml");
  if (fs.existsSync(manifestPath)) {
    throw new Error(`Crate already exists at ${crateRelDir}/Cargo.toml`);
  }

  const prefix = inferWorkspacePrefix(rootRaw, cwd);
  const pkgName = prefix ? `${prefix}-${name}` : name;
  const domainDep = prefix ? `${prefix}-domain` : "domain";
  const appDep = prefix ? `${prefix}-app` : "app";

  const hasWsPackageField = key => new RegExp(`\\[workspace\\.package\\][\\s\\S]*?^\\s*${key}\\s*=`, "m").test(rootRaw);
  const hasWsLints = /\[workspace\.lints(?:\.|\])/.test(rootRaw);
  const hasDepInRoot = dep => new RegExp(`^\\s*${dep}\\s*=\\s*\\{`, "m").test(rootRaw);

  // 1. Register in root [workspace.dependencies] if section exists
  let updatedRoot = rootRaw;
  const depEntry = `${pkgName} = { path = "${crateRelDir}" }`;
  if (!hasDepInRoot(pkgName) && /\[workspace\.dependencies\]/.test(rootRaw)) {
    updatedRoot = rootRaw.replace(
      /(\[workspace\.dependencies\]\s*\r?\n(?:#[^\r\n]*\r?\n)*)/,
      `$1${depEntry}\n`,
    );
    fs.writeFileSync(rootManifest, updatedRoot);
  }

  // 2. Write crates/<name>/Cargo.toml
  const pkgLines = [
    "[package]",
    `name = "${pkgName}"`,
    "version.workspace = true",
    "edition.workspace = true",
  ];
  if (hasWsPackageField("rust-version")) pkgLines.push("rust-version.workspace = true");
  if (hasWsPackageField("publish")) pkgLines.push("publish.workspace = true");
  if (hasWsPackageField("license")) pkgLines.push("license.workspace = true");

  const depLines = [];
  if (hasDepInRoot(domainDep)) depLines.push(`${domainDep} = { workspace = true }`);
  if (hasDepInRoot(appDep)) depLines.push(`${appDep} = { workspace = true }`);

  const manifestContent = [
    ...pkgLines,
    "",
    ...(hasWsLints ? ["[lints]", "workspace = true", ""] : []),
    "[lib]",
    "doctest = false",
    "",
    "[dependencies]",
    ...depLines,
    "",
  ].join("\n");

  fs.mkdirSync(path.join(crateDir, "src"), { recursive: true });
  fs.mkdirSync(path.join(crateDir, "tests", "it"), { recursive: true });
  fs.writeFileSync(manifestPath, manifestContent);

  // 3. Write crates/<name>/src/lib.rs
  const structName = name
    .split("-")
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join("") + "Adapter";
  const libRs = [
    `//! Sibling adapter crate \`${pkgName}\` (Golden Protocol Beat 1 stub).`,
    "//! Depends only on pure `domain` and `app` port traits — never on sibling adapters.",
    "",
    "#[derive(Debug, Default, Clone)]",
    `pub struct ${structName};`,
    "",
    `impl ${structName} {`,
    "    #[must_use]",
    "    pub const fn new() -> Self {",
    "        Self",
    "    }",
    "}",
    "",
    "#[cfg(test)]",
    "mod tests {",
    "    use super::*;",
    "",
    "    #[test]",
    "    fn adapter_constructs() {",
    `        let _adapter = ${structName}::new();`,
    "    }",
    "}",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(crateDir, "src", "lib.rs"), libRs);

  // 4. Write single integration test binary crates/<name>/tests/it/main.rs
  const itMainRs = [
    `//! Single integration test binary for \`${pkgName}\` (Law 2: arch::single_integration_test_binary).`,
    "",
    "#[test]",
    "fn integration_smoke() {",
    `    let _ = ${pkgName.replaceAll("-", "_")}::${structName}::new();`,
    "}",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(crateDir, "tests", "it", "main.rs"), itMainRs);

  return {
    name,
    pkgName,
    crateDir,
    manifestPath,
    scope: [`${crateRelDir}/**`],
  };
}

function main(argv = process.argv.slice(2)) {
  let cwd = process.cwd();
  let name = "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--cwd" && argv[i + 1]) {
      cwd = path.resolve(argv[++i]);
    } else if (!arg.startsWith("-") && !name) {
      name = arg;
    }
  }
  if (!name) {
    process.stderr.write("Usage: node scripts/rust-add-crate.mjs <crate-short-name> [--cwd <dir>]\n");
    process.exit(1);
  }
  try {
    const res = addSiblingCrate(name, { cwd });
    process.stdout.write(
      `rust-add-crate: created ${res.pkgName} at crates/${res.name} (worker scope: ${JSON.stringify(res.scope)})\n`,
    );
  } catch (err) {
    process.stderr.write(`rust-add-crate error: ${err.message}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
