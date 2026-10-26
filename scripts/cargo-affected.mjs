#!/usr/bin/env node
/**
 * cargo-affected: run a cargo command on only the workspace packages a change
 * affects (owners of changed files plus their workspace dependents).
 *
 *   node cargo-affected.mjs --changed-list <file> [--always] -- <cargo args...>
 *   node cargo-affected.mjs --changed <file> <file> ... -- <cargo args...>
 *
 * Examples (profile checks):
 *   ["node","${pluginRoot}/scripts/cargo-affected.mjs","--changed-list","${changedList}","--","test","--locked","--offline","--no-fail-fast"]
 *   ["node","${pluginRoot}/scripts/cargo-affected.mjs","--changed-list","${changedList}","--","clippy","--all-targets","--locked","--offline","--","-D","warnings"]
 *
 * Package flags (-p NAME... or --workspace) are inserted before the first "--".
 * With no affected package the command is skipped and exits 0, unless --always
 * is given, which then runs it for the whole workspace.
 * Exit code: cargo's exit code; 2 for usage or metadata errors.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { affectedPackages, withSelection } from "./rust.mjs";

const argv = process.argv.slice(2);
const split = argv.indexOf("--");
if (split < 0 || split === argv.length - 1) usage("missing cargo arguments after --");
const options = argv.slice(0, split), cargoArgs = argv.slice(split + 1);
let changed = [], always = false;
for (let i = 0; i < options.length; i++) {
  if (options[i] === "--changed-list") {
    const file = options[++i];
    if (!file) usage("--changed-list needs a file");
    changed.push(...fs.readFileSync(file, "utf8").split(/\r?\n/).map(s => s.trim()).filter(Boolean));
  } else if (options[i] === "--changed") {
    while (options[i + 1] && !options[i + 1].startsWith("--")) changed.push(options[++i]);
  } else if (options[i] === "--always") always = true;
  else usage("unknown option " + options[i]);
}

const cargo = process.env.CARGO || "cargo";
const meta = spawnSync(cargo, ["metadata", "--format-version", "1", "--no-deps", "--offline"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
if (meta.status !== 0) {
  process.stderr.write(meta.stderr || String(meta.error || "cargo metadata failed"));
  process.stderr.write("\ncargo-affected: cargo metadata failed; cannot select packages.\n");
  process.exit(2);
}
let selection = affectedPackages(JSON.parse(meta.stdout), changed);
if (selection.mode === "none") {
  if (!always) {
    process.stderr.write(`cargo-affected: skipped (${selection.reason}).\n`);
    process.exit(0);
  }
  selection = { mode: "workspace", packages: [], reason: selection.reason + "; --always runs the workspace" };
}
const args = withSelection(cargoArgs, selection);
process.stderr.write(`cargo-affected: ${selection.mode === "workspace" ? "--workspace" : selection.packages.join(", ")} (${selection.reason})\n`);
const run = spawnSync(cargo, args, { stdio: "inherit" });
if (run.error) { process.stderr.write(`cargo-affected: ${run.error.message}\n`); process.exit(2); }
process.exit(run.status ?? 1);

function usage(message) {
  process.stderr.write(`cargo-affected: ${message}\nusage: cargo-affected.mjs (--changed-list FILE | --changed FILE...) [--always] -- <cargo args>\n`);
  process.exit(2);
}
