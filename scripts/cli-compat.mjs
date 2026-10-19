process.env.NoDefaultCurrentDirectoryInExePath = "1";
/**
 * Model-free compatibility check of a Codex CLI against every flag and
 * subcommand this plugin passes. Run before pinning a new CLI:
 *   node scripts/cli-compat.mjs [absolute codex.exe or codex.js] [--json]
 * Without a path it checks the executable the plugin would select.
 */
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cliFeatures } from "./service-tier.mjs";
/** Flags per help surface. exec flags precede `resume <thread>` in buildArgs. */
export const REQUIRED = {
  exec: ["--cd", "--sandbox", "--config", "--model", "--output-schema", "--json", "--output-last-message"],
  "exec resume": ["--config", "--model", "--output-schema", "--json", "--output-last-message"],
  "exec review": ["--uncommitted"],
  sandbox: ["--permission-profile", "--include-managed-config", "--cd", "--config"],
};
export function cliCompatibility(binary, { run = spawnSync } = {}) {
  const options = { encoding: "utf8", windowsHide: true, timeout: 20000, maxBuffer: 4 * 1048576 };
  const call = args => run(binary.command, [...(binary.prefix || []), ...args], options);
  const version = call(["--version"]);
  const surfaces = {};
  for (const [surface, flags] of Object.entries(REQUIRED)) {
    const help = call([...surface.split(" "), "--help"]);
    const text = String(help.stdout || "") + String(help.stderr || "");
    surfaces[surface] = { ok: help.status === 0, missing: help.status === 0 ? flags.filter(flag => !text.includes(flag)) : flags };
  }
  const features = cliFeatures(binary, { run });
  const tiers = {
    default: true,
    fast: !!features.features.get("fast_mode")?.enabled,
    priority: !!features.features.get("fast_mode")?.enabled,
    ultrafast: !!features.features.get("ultrafast_mode")?.enabled,
  };
  const compatible = version.status === 0 && Object.values(surfaces).every(s => s.ok && !s.missing.length);
  return {
    version: String(version.stdout || version.stderr || "").trim().slice(0, 80) || null,
    executable: [binary.command, ...(binary.prefix || [])].join(" "),
    compatible, surfaces,
    featureList: features.available ? "available" : "unavailable: " + features.error,
    serviceTiers: tiers,
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), json = args.includes("--json"), target = args.find(a => a !== "--json");
  let binary;
  if (target) {
    if (!path.isAbsolute(target)) { console.error("Give an absolute codex.exe or codex.js path."); process.exit(2); }
    binary = /\.m?js$/i.test(target) ? { command: process.execPath, prefix: [target] } : { command: target, prefix: [] };
  } else binary = (await import("./runtime.mjs")).resolveCodex();
  const report = cliCompatibility(binary);
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`${report.version || "unknown version"} · ${report.compatible ? "compatible" : "INCOMPATIBLE"} · ${report.executable}`);
    for (const [surface, s] of Object.entries(report.surfaces)) console.log(`  codex ${surface}: ${s.ok ? (s.missing.length ? "missing " + s.missing.join(", ") : "ok") : "help failed"}`);
    console.log(`  features list: ${report.featureList}`);
    console.log(`  service tiers: ${Object.entries(report.serviceTiers).map(([t, ok]) => `${t} ${ok ? "yes" : "no"}`).join(", ")}`);
  }
  process.exitCode = report.compatible ? 0 : 1;
}
