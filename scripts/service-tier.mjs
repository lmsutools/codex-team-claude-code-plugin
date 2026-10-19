/**
 * Codex service tiers (speed lanes). An explicit tier is passed as
 * `-c service_tier="<tier>"`; omitted means the CLI's configuration decides.
 *
 * Observed on Codex CLI 0.153.2, 0.162.1 and 0.163.0 (2026-10-18):
 * - `service_tier` is free-form at config load; every value is accepted there.
 * - `default`, `fast` and `priority` run without notice.
 * - A tier the model catalog does not advertise is dropped by the CLI, which
 *   emits an `item.type: "error"` notice: "Configured service tier `ultrafast`
 *   is not advertised as supported for model `gpt-6-astra` and will be omitted
 *   from requests." The run then uses the default tier.
 * - `codex features list` shows `fast_mode` (all three) and `ultrafast_mode`
 *   (0.162.1 and 0.163.0 only), which is how support is validated per CLI.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
export const SERVICE_TIERS = ["default", "fast", "priority", "ultrafast"];
export const TIER_FEATURES = { fast: "fast_mode", priority: "fast_mode", ultrafast: "ultrafast_mode" };
export const TIER_OMITTED = /Configured service tier `([^`]{1,64})` is not advertised as supported for model `([^`]{1,120})`/;
export function validateTier(value) {
  if (value === null || value === undefined) return null;
  if (!SERVICE_TIERS.includes(value)) throw Error("serviceTier must be default, fast, priority or ultrafast.");
  return value;
}
const stamp = file => { try { const s = fs.statSync(file); return [file, s.size, s.mtimeMs]; } catch { return [file]; } };
const featureCache = new Map();
/** `codex features list` for the selected executable, cached per binary identity. */
export function cliFeatures(binary, { run = spawnSync } = {}) {
  const key = JSON.stringify([binary.command, ...(binary.prefix || [])].map(stamp));
  if (featureCache.has(key)) return featureCache.get(key);
  const options = { encoding: "utf8", windowsHide: true, timeout: 20000, maxBuffer: 1048576 };
  const version = run(binary.command, [...(binary.prefix || []), "--version"], options);
  const listing = run(binary.command, [...(binary.prefix || []), "features", "list"], options);
  let features = null;
  if (listing.status === 0 && !listing.error) {
    features = new Map();
    for (const line of String(listing.stdout || "").split(/\r?\n/)) {
      const match = line.match(/^([a-z0-9_]+)\s+(.+?)\s+(true|false)\s*$/);
      if (match) features.set(match[1], { stage: match[2].trim(), enabled: match[3] === "true" });
    }
  }
  const value = {
    version: String(version.stdout || version.stderr || "").trim().slice(0, 80) || null,
    available: !!features?.size,
    features: features || new Map(),
    error: features?.size ? null : String(listing.error?.message || listing.stderr || "no feature list").trim().slice(0, 300),
  };
  featureCache.set(key, value);
  return value;
}
/** Throws a clear error when the selected CLI cannot honor an explicit tier. */
export function assertTierSupported(tier, binary, { run } = {}) {
  if (!tier || tier === "default") return { checked: false };
  const need = TIER_FEATURES[tier], listing = cliFeatures(binary, { run });
  const label = (listing.version || "the selected Codex CLI") + " (" + [binary.command, ...(binary.prefix || [])].at(-1) + ")";
  if (!listing.available)
    throw Error(`serviceTier "${tier}" cannot be confirmed for ${label}: \`codex features list\` failed (${listing.error}). Omit serviceTier to inherit the CLI configuration, or select a CLI that lists ${need}.`);
  const feature = listing.features.get(need);
  if (!feature)
    throw Error(`serviceTier "${tier}" is not supported by ${label}: it has no ${need} feature${tier === "ultrafast" ? " (0.162.1 and later list it; 0.153.2 does not)" : ""}. Select a newer CLI through CODEX_TEAM_CODEX, or omit serviceTier.`);
  if (!feature.enabled)
    throw Error(`serviceTier "${tier}" is disabled in ${label}: feature ${need} is off. Enable it (features.${need}=true in config.toml), or omit serviceTier.`);
  return { checked: true, feature: need, version: listing.version };
}
const codexHome = () => path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
/** Top-level `key = "value"` of a TOML file (before the first table header). */
function topLevel(file, key) {
  let text;
  try { if (fs.statSync(file).size > 1048576) return null; text = fs.readFileSync(file, "utf8"); } catch { return null; }
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const match = line.match(new RegExp("^\\s*" + key + "\\s*=\\s*[\"']([^\"']{1,120})[\"']"));
    if (match) return match[1];
  }
  return null;
}
/** The tier a job inherits from configuration: the closest project .codex/config.toml, else the user config. */
export function configuredTier(cwd, home = codexHome()) {
  const files = [];
  if (cwd) for (let dir = cwd; ; dir = path.dirname(dir)) { files.push(path.join(dir, ".codex", "config.toml")); if (path.dirname(dir) === dir) break; }
  files.push(path.join(home, "config.toml"));
  for (const file of files) { const tier = topLevel(file, "service_tier"); if (tier) return { tier, file }; }
  return null;
}
/** The model a job inherits: explicit, else configuration. */
export function configuredModel(state, home = codexHome()) {
  if (state?.model) return state.model;
  const files = [];
  if (state?.cwd) for (let dir = state.cwd; ; dir = path.dirname(dir)) { files.push(path.join(dir, ".codex", "config.toml")); if (path.dirname(dir) === dir) break; }
  files.push(path.join(home, "config.toml"));
  for (const file of files) { const model = topLevel(file, "model"); if (model) return model; }
  return null;
}
/**
 * Start-time advice from Codex's cached model catalog: a tier the model does
 * not advertise will be dropped by the CLI. Advice only; the run confirms it.
 */
export function catalogAdvice(tier, model, home = codexHome()) {
  if (!tier || tier === "default" || !model) return null;
  let catalog;
  try { const file = path.join(home, "models_cache.json"); if (fs.statSync(file).size > 8 * 1048576) return null; catalog = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  const entry = (catalog.models || []).find(m => m?.slug === model);
  if (!entry) return null;
  const advertised = new Set([...(entry.service_tiers || []).map(t => t?.id), ...(entry.additional_speed_tiers || [])].filter(Boolean));
  if (advertised.has(tier)) return null;
  return `Codex's model catalog (fetched ${String(catalog.fetched_at || "at an unknown time").slice(0, 32)} by ${String(catalog.client_version || "an unknown CLI").slice(0, 24)}) does not advertise "${tier}" for ${model} (advertised: ${[...advertised].join(", ") || "none"}). The CLI will omit it and run at the default tier unless the catalog changes.`;
}
/** A CLI notice that the configured tier was dropped for this model, or null. */
export function omittedTier(event) {
  if (event?.item?.type !== "error" && event?.type !== "error") return null;
  const match = String(event.item?.message || event.message || "").match(TIER_OMITTED);
  return match ? { tier: match[1], model: match[2] } : null;
}
/** Effective tier as recorded on a job: what was asked, where it came from, and what ran. */
export function effectiveTier(state) {
  const requested = state?.serviceTier || state?.serviceTierInherited?.tier || null;
  const source = state?.serviceTier ? "explicit" : state?.serviceTierInherited?.tier ? "config" : "none";
  const omitted = state?.serviceTierOmitted && (!requested || state.serviceTierOmitted.tier === requested) ? state.serviceTierOmitted : null;
  return { requested, source, effective: omitted ? "default" : requested || "default", ...(omitted ? { omitted: true, model: omitted.model } : {}) };
}
/** One short label for status, waiter and footer lines. */
export function tierLabel(state) {
  const tier = effectiveTier(state);
  if (tier.source === "none") return null;
  const origin = tier.source === "config" ? " (config)" : "";
  return tier.omitted
    ? `default (${tier.requested}${origin} omitted by the CLI: not advertised for ${tier.model})`
    : `${tier.effective}${origin}`;
}
/** Compact form for the 110-character footer line. */
export function tierShort(state) {
  const tier = effectiveTier(state);
  if (tier.source === "none") return null;
  return tier.omitted ? `${tier.requested}→default (omitted)` : tier.effective + (tier.source === "config" ? " (config)" : "");
}
/** Tests swap CLI fixtures without changing the binary; production keeps the per-process cache. */
export function resetFeatureCache() { featureCache.clear(); }
