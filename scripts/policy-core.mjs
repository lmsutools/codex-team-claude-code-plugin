import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { git, hash, safeFile } from "./git.mjs";

export const levels = ["off", "advise", "enforce"];
export const enabled = (p, component) =>
  !!p?.components?.[component]?.level &&
  p.components[component].level !== "off";
export const enforced = (p, component) =>
  p?.components?.[component]?.level === "enforce";
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
export const digest = (value) => hash(JSON.stringify(canonical(value)));
export function glob(pattern, name) {
  const normalize = (s) => s.replaceAll("\\", "/");
  pattern = normalize(pattern);
  name = normalize(name);
  let expression = "^";
  for (let i = 0; i < pattern.length; i++) {
    if (pattern.slice(i, i + 3) === "**/") {
      expression += "(?:.*/)?";
      i += 2;
    } else if (pattern.slice(i, i + 2) === "**") {
      expression += ".*";
      i++;
    } else if (pattern[i] === "*") expression += "[^/]*";
    else if (pattern[i] === "?") expression += "[^/]";
    else expression += pattern[i].replace(/[.*+?^{}()|[\]\\$]/g, "\\$&");
  }
  return new RegExp(
    expression + "$",
    process.platform === "win32" ? "i" : "",
  ).test(name);
}
export const matches = (patterns, name) =>
  (patterns || []).some((p) => glob(p, name));
export function boundedRead(file, max = 1024 * 1024) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.size > max)
    throw new Error("Expected a bounded regular file: " + path.basename(file));
  return fs.readFileSync(file, "utf8");
}
export function identity(cwd) {
  const common = git(cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]).stdout.trim();
  const real = fs.realpathSync(common);
  return digest(process.platform === "win32" ? real.toLowerCase() : real);
}
export function branch(cwd) {
  return git(cwd, ["branch", "--show-current"]).stdout.trim();
}
export function textMeta(bytes) {
  const bom = bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191]));
  if (bytes.includes(0)) return { binary: true };
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return { encoding: "unknown" };
  }
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/(?<!\r)\n/g) || []).length;
  const cr = (text.match(/\r(?!\n)/g) || []).length;
  return {
    encoding: "utf-8",
    bom,
    eol: cr || (crlf && lf) ? "mixed" : crlf ? "crlf" : lf ? "lf" : "none",
    finalNewline: /\r?\n$/.test(text),
  };
}
export function patternsFor(profile) {
  if (!enabled(profile, "secrets")) return [];
  return (profile.components.secrets.patterns || []).map((p) => {
    let pattern = typeof p === "string" ? p : p.pattern,
      flags = typeof p === "string" ? "" : p.flags || "";
    const prefix = pattern.match(/^\(\?([ims]+)\)/);
    if (prefix) {
      flags += prefix[1];
      pattern = pattern.slice(prefix[0].length);
    }
    flags = [...new Set((flags + "g").split(""))].join("");
    if (pattern.length > 1000 || /[^gimsu]/.test(flags))
      throw new Error("Invalid secret pattern flags or size.");
    try {
      new RegExp(pattern, flags);
    } catch {
      throw new Error("Invalid secret pattern.");
    }
    return { pattern, flags };
  });
}
export function scan(text, profile) {
  const patterns = patternsFor(profile);
  if (!patterns.length) return { text, count: 0 };
  if (typeof text !== "string" || text.length > 8 * 1024 * 1024)
    throw new Error(
      "Secret scan input exceeds 8 MiB; refusing unscanned content.",
    );
  try {
    return vm.runInNewContext(
      "let count=0; for(const p of patterns){text=text.replace(new RegExp(p.pattern,p.flags),()=>{count++;return '[REDACTED]';});} ({text,count})",
      { text, patterns },
      { timeout: 1000 },
    );
  } catch (cause) {
    throw new Error(
      "Secret scan failed or exceeded its time bound; content was not persisted.",
      { cause },
    );
  }
}
export function inspectValue(value, profile) {
  const patterns = patternsFor(profile);
  if (!patterns.length) return { value, count: 0 };
  const strings = [],
    keys = [];
  let size = 0;
  const collect = (v, isKey = false) => {
    if (typeof v === "string") {
      size += v.length;
      strings.push(v);
      keys.push(isKey);
    } else if (Array.isArray(v)) v.forEach((item) => collect(item));
    else if (v && typeof v === "object")
      for (const [key, item] of Object.entries(v)) {
        collect(key, true);
        collect(item);
      }
  };
  collect(value);
  if (size > 32 * 1024 * 1024)
    throw new Error("Secret-scanned structured content exceeds 32 MiB.");
  let result;
  try {
    result = vm.runInNewContext(
      "let count=0;const expressions=patterns.map(p=>new RegExp(p.pattern,p.flags));const output=strings.map((text,index)=>{for(const expression of expressions)text=text.replace(expression,()=>{if(keys[index])throw Error('structural');count++;return '[REDACTED]';});return text;});({output,count})",
      { strings, keys, patterns },
      { timeout: 1000 },
    );
  } catch (cause) {
    throw new Error(
      "Secret scan failed or exceeded its bound; structured content was not persisted.",
      { cause },
    );
  }
  if (!result.count) return { value, count: 0 };
  let index = 0;
  const rebuild = (v) => {
    if (typeof v === "string") return result.output[index++];
    if (Array.isArray(v)) return v.map(rebuild);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v).map(([key, item]) => {
          index++;
          return [key, rebuild(item)];
        }),
      );
    return v;
  };
  return { value: rebuild(value), count: result.count };
}
export function sanitize(value, profile) {
  if (
    !enabled(profile, "secrets") ||
    profile.components.secrets.redactInState === false
  )
    return value;
  return inspectValue(value, profile).value;
}
export function forbidden(profile, cwd, name) {
  if (!enabled(profile, "secrets")) return false;
  return (
    matches(profile.components.secrets.forbiddenPaths, name) ||
    matches(
      profile.components.secrets.forbiddenPaths,
      path.resolve(cwd, name).replaceAll("\\", "/"),
    )
  );
}
export function commandAccessSuspected(profile, cwd, value) {
  // A literal negative rg glob excludes files; it is not an access operand.
  // Only remove this recognized option inside an rg command segment. Other
  // commands, positive globs, explicit operands and dynamic expressions remain.
  const command = String(value || "")
    .replaceAll("\\", "/")
    .split(/([;|&\r\n])/)
    .map((segment) => {
      if (!/(?:^|[\s"'/])rg(?:\.exe)?(?=[\s"'])/i.test(segment)) return segment;
      return segment.replace(
        /(^|\s)(?:-g|--glob|--iglob)(?:=|\s+)["']*![A-Za-z0-9_./*?{}\[\],-]+["']*(?=\s|$)/g,
        "$1",
      );
    })
    .join("");
  const paths = [
    ...command.matchAll(/"([^"]+)"|'([^']+)'|([^\s;|&()]+)/g),
  ].flatMap((m) => [
    m[1] || m[2] || m[3],
    (m[1] || m[2] || m[3]).split("=").at(-1),
  ]);
  return (
    paths.some((candidate) => forbidden(profile, cwd, candidate)) ||
    (profile.components.secrets.forbiddenPaths || []).some(
      (p) =>
        glob(p, command) ||
        command
          .toLowerCase()
          .includes(p.replaceAll("**", "").replaceAll("\\", "/").toLowerCase()),
    )
  );
}
export function readProject(profile, cwd, name, max) {
  if (forbidden(profile, cwd, name))
    throw new Error("Profile prohibits reading this path: " + name);
  return boundedRead(safeFile(cwd, name), max);
}
export function expand(argv, variables) {
  return argv.flatMap((part) => {
    if (part === "$" + "{files}") return variables.files || [];
    return [
      part.replace(/\$\{([A-Za-z][A-Za-z0-9]*)\}/g, (_, key) => {
        if (!(key in variables) || Array.isArray(variables[key]))
          throw new Error("Unknown or non-scalar profile variable: " + key);
        return String(variables[key]);
      }),
    ];
  });
}
