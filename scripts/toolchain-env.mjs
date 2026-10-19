/**
 * Toolchain homes: directory paths, never credentials. Rust installs often live
 * outside the default %USERPROFILE%\.cargo (for example CARGO_HOME=D:\tools\cargo),
 * and the sandbox has no network, so a check that cannot see CARGO_HOME finds
 * neither the offline registry nor the toolchain.
 */
export const TOOLCHAIN_HOMES = ["CARGO_HOME", "RUSTUP_HOME"];
const RUST_TOOL = /^(?:cargo|rustc|rustup|rustdoc|rustfmt|clippy-driver|cargo-[a-z0-9_-]+)$/i;
const present = (name, environment) => Object.keys(environment).some(key => key.toUpperCase() === name);
const toolName = command => String(command || "").replaceAll("\\", "/").split("/").at(-1).replace(/\.exe$/i, "");
export const rustTool = command => RUST_TOOL.test(toolName(command));
/** Homes to pass automatically to a check that runs a Rust tool directly; recorded as autoPassEnv. */
export function toolchainPassEnv(command, passEnv = [], environment = process.env) {
  if (!rustTool(command)) return [];
  const have = new Set((passEnv || []).map(name => name.toUpperCase()));
  return TOOLCHAIN_HOMES.filter(name => !have.has(name) && present(name, environment));
}
/** Homes set on the host, for Codex's own shell (its commands run cargo too). */
export function workerToolchainEnv(environment = process.env) {
  return TOOLCHAIN_HOMES.filter(name => present(name, environment));
}
const CARGO_OFFLINE = /no matching package named|failed to get `[^`]+` as a dependency|failed to load source for dependency|attempting to make an HTTP request, but --offline was specified|Unable to update registry|failed to (?:download|query replaced source registry)|spurious network error|error: toolchain '[^']+' is not installed|rustup could not choose a version of (?:cargo|rustc)|no default toolchain configured|could not find `[^`]+` in (?:registry|the registry)/i;
/**
 * A diagnosis for a failed sandboxed check whose output shows cargo/rustup
 * missing its registry or toolchain; null when it does not apply.
 */
export function toolchainHint(check, output, environment = process.env) {
  if (check?.host || !CARGO_OFFLINE.test(String(output || ""))) return null;
  const passed = new Set([...(check.passEnv || []), ...(check.autoPassEnv || [])].map(name => name.toUpperCase()));
  const missing = TOOLCHAIN_HOMES.filter(name => present(name, environment) && !passed.has(name));
  if (missing.length)
    return `Cargo in the network-off sandbox could not reach its registry or toolchain, and the check did not receive ${missing.join(" and ")} (set on the host). Add passEnv: ${JSON.stringify(missing)} to the check; it is passed automatically only when the check runs cargo, rustc or rustup directly.`;
  if (!TOOLCHAIN_HOMES.some(name => present(name, environment)))
    return "Cargo in the network-off sandbox could not reach its registry or toolchain. CARGO_HOME and RUSTUP_HOME are not set on the host, so cargo uses %USERPROFILE%\\.cargo; pre-fetch dependencies on the host (cargo fetch) and run checks with --offline, or set and pass CARGO_HOME/RUSTUP_HOME.";
  return "Cargo in the network-off sandbox could not reach its registry or toolchain although CARGO_HOME/RUSTUP_HOME were passed. Pre-fetch dependencies on the host (cargo fetch) or vendor them, and run checks with --offline or --frozen.";
}
/** Doctor summary: which homes are set (names only, never values). */
export function toolchainSummary(environment = process.env) {
  const set = Object.fromEntries(TOOLCHAIN_HOMES.map(name => [name, present(name, environment) ? "set" : "unset"]));
  return { ...set, note: "Rust checks: CARGO_HOME/RUSTUP_HOME are passed automatically to checks that run cargo/rustc/rustup directly and to Codex's shell when set on the host; other checks need passEnv." };
}
