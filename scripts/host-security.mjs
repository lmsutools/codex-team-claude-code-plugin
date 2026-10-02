/** Host execution boundaries shared by checks, hooks and the server. */
import { resolveCheckExecutable, hostEnvironment } from "./check-executable.mjs";
const cache = new Map();
export function trustedExecutable(command, cwd = process.cwd()) {
  const key = command + "\0" + cwd;
  if (!cache.has(key)) cache.set(key, resolveCheckExecutable(command, cwd, hostEnvironment()));
  return cache.get(key);
}
export const secretName = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY|AUTH|COOKIE|SESSION|^(?:OPENAI|ANTHROPIC|AZURE|AWS|GH|GITHUB)_|^npm_config__auth/i;
export function checkEnvironment(environment, passEnv = []) {
  validatePassEnv(passEnv);
  const fold = key => process.platform === "win32" ? key.toUpperCase() : key;
  const allowed = new Set([...CORE_ENV, ...passEnv].filter(name => name.toUpperCase() !== "CODEX_HOME").map(fold));
  return { ...hostEnvironment(Object.fromEntries(Object.entries(environment).filter(([key]) => allowed.has(fold(key))))), PYTHONSAFEPATH: "1" };
}
export const CORE_ENV = ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "USERPROFILE", "HOME", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "USERNAME", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "LANG", "LC_ALL", "LC_CTYPE", "SHELL", "TERM", "USER", "LOGNAME", "SYSTEMDRIVE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "NoDefaultCurrentDirectoryInExePath", "PYTHONSAFEPATH"];
export function validatePassEnv(names) { if(!Array.isArray(names) || names.some(n=>typeof n!=="string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(n))) throw Error("passEnv must contain exact environment variable names."); }
export function shellEnvironmentPolicy(passEnv = []) {
  validatePassEnv(passEnv);
  const names = [...CORE_ENV, ...passEnv].filter(name => name.toUpperCase() !== "CODEX_HOME");
  // Preserve actual Windows casing even if the CLI matches include_only globs case-sensitively.
  if (process.platform === "win32") { const allowed = new Set(names.map(name => name.toUpperCase())); names.push(...Object.keys(process.env).filter(name => allowed.has(name.toUpperCase()))); }
  return ['shell_environment_policy.inherit="all"', 'shell_environment_policy.ignore_default_excludes=true', 'shell_environment_policy.exclude=[]', 'shell_environment_policy.set={}', 'shell_environment_policy.include_only=' + JSON.stringify([...new Set(names)])].flatMap(value => ["-c", value]);
}
export function inlineCommand(argv, cwd = process.cwd()) {
  const name = argv[0].replaceAll("\\", "/").split("/").at(-1).replace(/\.exe$/i, "").toLowerCase();
  const args = argv.slice(1).map(a => a.toLowerCase());
  if (name === "node") return args.some(a => /^(?:-[ep].*|--(?:eval|print)(?:=|$))/.test(a));
  if (/^python[\d.]*$/.test(name) || name === "py") return args.some(a => a === "-c" || a.startsWith("-c"));
  if (["powershell", "pwsh"].includes(name)) return args.some(a => /^-(?:command|c|encodedcommand|enc|file)$/.test(a));
  if (name === "cmd") return args.some(a => /^\/[ck]/.test(a));
  if (["bash", "sh", "zsh"].includes(name)) return args.some(a => /^-[a-z]*c/.test(a));
  return ["deno", "bun"].includes(name) && args.includes("eval");
}

export function redactDefault(text) {
  return text.replace(/(?:Authorization|Cookie|Set-Cookie)\s*:\s*[^\r\n]+|\bBearer\s+\S+/gi, "[REDACTED]").replace(/(?:sk-[a-zA-Z0-9_-]{12,}|gh[pousr]_[a-zA-Z0-9_]{12,}|Bearer\s+\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:[a-zA-Z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY|AUTH|COOKIE|SESSION)[a-zA-Z_]*|OPENAI_\w+|ANTHROPIC_\w+|AZURE_\w+|AWS_\w+|GH_\w+|GITHUB_\w+)\s*[=:]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+))/gi, "[REDACTED]");
}
