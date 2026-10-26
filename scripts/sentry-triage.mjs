#!/usr/bin/env node
/**
 * Map a Sentry / BugSink / GlitchTip crash or error event JSON to affected Cargo
 * workspace packages and generate a ready-to-run `codex_start` worktree assignment.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { affectedPackages } from "./rust.mjs";

const slash = value => String(value || "").replaceAll("\\", "/");

function loadCargoMetadata(cwd) {
  if (!fs.existsSync(path.join(cwd, "Cargo.toml"))) return null;
  const cargo = process.env.CARGO || "cargo";
  const res = spawnSync(cargo, ["metadata", "--format-version", "1", "--no-deps", "--offline"], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0 || !res.stdout) return null;
  try { return JSON.parse(res.stdout); } catch { return null; }
}

/** Normalize a raw stacktrace filename into a workspace-relative POSIX path when possible. */
export function normalizeStackPath(rawFile, cwd = process.cwd()) {
  if (!rawFile || typeof rawFile !== "string") return null;
  let cleaned = slash(rawFile).trim();
  if (!cleaned || cleaned.startsWith("<") || cleaned.startsWith("/rustc/") || cleaned.includes("/.cargo/registry/") || cleaned.includes("/.cargo/git/") || cleaned.includes("/rustlib/src/rust/")) return null;
  const root = slash(path.resolve(cwd)).replace(/\/+$/, "");
  if (cleaned.startsWith(root + "/")) return cleaned.slice(root.length + 1);
  cleaned = cleaned.replace(/^(?:\.\/)+/, "");
  const markerMatch = cleaned.match(/(?:^|\/)((?:crates|bins|packages|services|libs|src)\/[A-Za-z0-9_./-]+\.rs)$/);
  if (markerMatch) return markerMatch[1];
  if (!path.isAbsolute(cleaned) && !cleaned.startsWith("..") && cleaned.endsWith(".rs")) return cleaned;
  return null;
}

/** Extract structured crash/error context and a `codex_start` worktree assignment from a Sentry event/issue JSON. */
export function buildSentryTriage(payload, { cwd = process.cwd(), metadata = null } = {}) {
  if (!payload || typeof payload !== "object") throw Error("Sentry triage payload must be a JSON object.");
  const event = payload.latestEvent && typeof payload.latestEvent === "object" ? payload.latestEvent : payload;
  const issueId = String(payload.shortId || payload.id || event.eventID || event.event_id || "unknown-issue");
  const title = String(payload.title || event.title || event.message || "Unhandled Rust error");

  const exceptions = event.exception?.values || (Array.isArray(event.exception) ? event.exception : []);
  const primaryExc = exceptions.at(-1) || exceptions[0] || {};
  const excType = String(primaryExc.type || "Error");
  const excValue = String(primaryExc.value || event.message || title);

  const rawFrames = [];
  for (const exc of exceptions) {
    const list = exc?.stacktrace?.frames;
    if (Array.isArray(list)) rawFrames.push(...list);
  }
  if (!rawFrames.length && Array.isArray(event.stacktrace?.frames)) rawFrames.push(...event.stacktrace.frames);

  const frames = [];
  const relativeFiles = [];
  for (const frame of [...rawFrames].reverse()) {
    const rawFile = frame.abs_path || frame.filename || frame.file || "";
    const rel = normalizeStackPath(rawFile, cwd);
    if (!rel) continue;
    if (!relativeFiles.includes(rel)) relativeFiles.push(rel);
    if (frames.length < 10) {
      frames.push({
        file: rel,
        line: Number.isInteger(frame.lineno) ? frame.lineno : null,
        column: Number.isInteger(frame.colno) ? frame.colno : null,
        function: frame.function ? String(frame.function) : null,
      });
    }
  }

  const crumbValues = event.breadcrumbs?.values || (Array.isArray(event.breadcrumbs) ? event.breadcrumbs : []);
  const breadcrumbs = crumbValues.slice(-8).map(b => ({
    level: b.level || "info",
    category: b.category || b.type || "log",
    message: String(b.message || b.data?.message || "").slice(0, 200),
  })).filter(b => b.message);

  const tagEntries = Array.isArray(event.tags)
    ? event.tags.map(t => Array.isArray(t) ? t : [t?.key, t?.value])
    : Object.entries(event.tags || {});
  const tags = Object.fromEntries(tagEntries.filter(([k, v]) => k && v !== undefined).map(([k, v]) => [String(k), String(v)]));

  const resolvedMeta = metadata || loadCargoMetadata(cwd);
  const affected = relativeFiles.length && resolvedMeta
    ? affectedPackages(resolvedMeta, relativeFiles, cwd)
    : { mode: "none", packages: [], direct: [] };
  const directPackages = affected.direct?.length ? affected.direct : affected.packages || [];

  const scopeDirs = [...new Set(relativeFiles.map(file => {
    const parts = file.split("/");
    return parts.length >= 2 && ["crates", "bins", "packages", "services", "libs"].includes(parts[0])
      ? `${parts[0]}/${parts[1]}/**`
      : file;
  }))];
  const scope = scopeDirs.length ? scopeDirs : ["crates/**", "src/**"];

  const topFrame = frames[0];
  const locationLabel = topFrame ? `${topFrame.file}${topFrame.line ? ":" + topFrame.line : ""}` : "workspace";
  const verification = directPackages.length
    ? directPackages.map(pkg => ({
        id: `test-${pkg}`,
        command: "cargo",
        args: ["test", "--locked", "--offline", "-p", pkg, "--", "--nocapture"],
        timeoutSeconds: 300,
      }))
    : [{ id: "workspace-tests", command: "cargo", args: ["test", "--locked", "--offline"], timeoutSeconds: 300 }];

  const criteria = [
    `Add a regression test in ${directPackages.join(", ") || "the owning crate"} that reproduces ${issueId} (${excType}: ${excValue.slice(0, 120)}) at ${locationLabel}.`,
    "Fix the root cause using idiomatic Result/error propagation (no .unwrap() or .expect() in production paths).",
    "Pass all package unit/integration tests and clippy -D warnings offline.",
  ];

  const promptLines = [
    `Triage and fix Sentry issue ${issueId}: ${title}`,
    `Exception: ${excType}: ${excValue}`,
    frames.length ? `Top in-app stack frames:\n${frames.map(f => `  - ${f.file}${f.line ? ":" + f.line : ""}${f.function ? " (" + f.function + ")" : ""}`).join("\n")}` : null,
    breadcrumbs.length ? `Recent tracing breadcrumbs:\n${breadcrumbs.map(b => `  - [${b.level}] ${b.category}: ${b.message}`).join("\n")}` : null,
    Object.keys(tags).length ? `Platform/Release tags: ${JSON.stringify(tags)}` : null,
    "",
    "Workflow:",
    "1. First write a unit test that reproduces the failure mode shown in the stacktrace/breadcrumbs.",
    "2. Fix the bug cleanly without introducing unwrap()/expect() in library code.",
    `3. Run cargo test --offline ${directPackages.map(p => `-p ${p}`).join(" ") || "--workspace"} to confirm the fix.`,
  ].filter(line => line !== null);

  return {
    issueId,
    title,
    exception: { type: excType, value: excValue },
    frames,
    breadcrumbs,
    tags,
    affected: { mode: affected.mode, direct: directPackages, transitive: affected.packages || [] },
    codexStart: {
      isolation: "worktree",
      autoVerify: true,
      assignment: {
        goal: `Fix ${issueId} (${excType} at ${locationLabel}) with regression test`,
        scope,
        criteria,
        verification,
      },
      prompt: promptLines.join("\n"),
    },
  };
}

function main(argv = process.argv.slice(2)) {
  let issueFile = null;
  let cwd = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--issue" && argv[i + 1]) issueFile = argv[++i];
    else if (argv[i] === "--cwd" && argv[i + 1]) cwd = path.resolve(argv[++i]);
    else if (!argv[i].startsWith("-") && !issueFile) issueFile = argv[i];
  }
  const raw = issueFile && issueFile !== "-"
    ? fs.readFileSync(path.resolve(cwd, issueFile), "utf8")
    : fs.readFileSync(0, "utf8");
  const payload = JSON.parse(raw);
  const result = buildSentryTriage(payload, { cwd });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch (error) {
    process.stderr.write(`sentry-triage: ${error.message || error}\n`);
    process.exit(2);
  }
}
