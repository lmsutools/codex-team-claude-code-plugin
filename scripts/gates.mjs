/** Verification planning and host execution policy. */
import { checkEnvironment, inlineCommand } from "./host-security.mjs";
import fs from "node:fs";
import { hostEnvironment } from "./check-executable.mjs";
import path from "node:path";
import { safeFile, hash } from "./git.mjs";
import {
  enabled,
  enforced,
  matches,
  glob,
  expand,
  readProject,
  digest,
  forbidden,
  boundedRead,
} from "./policy-core.mjs";
import { variables } from "./profile.mjs";

export const applies = (when, files) =>
  when === "always" || files.some((f) => matches(when?.changed, f));
export function workerEnvironment(state, verification = false, passEnv = []) {
  const environment = verification ? checkEnvironment(process.env, passEnv) : hostEnvironment();
  const cfg = state.profile?.components?.gates?.toolchain;
  if (
    !enabled(state.profile, "gates") ||
    !cfg ||
    (!verification && !cfg.applyToWorker)
  )
    return environment;
  const dirs = expand(
    cfg.prependPath || [],
    variables(state.profile, state.cwd, { worktree: state.executionCwd }),
  );
  for (const dir of dirs)
    if (!path.isAbsolute(dir) || !fs.statSync(dir).isDirectory())
      throw new Error(
        "Toolchain PATH must identify existing absolute directories.",
      );
  return {
    ...Object.fromEntries(Object.entries(environment).filter(([key]) => key.toLowerCase() !== "path")),
    PATH: [...dirs, process.env.PATH || ""].join(path.delimiter),
  };
}
export function allowCommand(profile, argv, check = {}) {
  if (/\.(cmd|bat|ps1)$/i.test(argv[0]))
    throw new Error(
      "Use a direct executable; shell shims require an explicitly authorized shell.",
    );
  if (!enabled(profile, "gates")) return;
  const normalize = (s) => s.replaceAll("\\", "/").toLowerCase();
  for (const rule of profile.components.gates.neverRun || []) {
    if (
      rule.command.every((token) =>
        argv.some((arg) => normalize(arg).includes(normalize(token))),
      )
    )
      throw new Error("Command forbidden by profile: " + rule.reason);
  }
}
function selectedTests(state, changed, selection, allFiles) {
  const cfg = state.profile.components.gates,
    found = new Set();
  const isTest = (name) =>
    /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name);
  if (selection.includes("changedTests"))
    changed
      .filter(isTest)
      .filter((n) => allFiles.includes(n))
      .forEach((n) => found.add(n));
  if (selection.includes("affectedTests")) {
    for (const map of cfg.affectedTests?.byName || []) {
      const [before, after] = map.source.split("{name}");
      for (const name of changed)
        if (
          after !== undefined &&
          name.startsWith(before) &&
          name.endsWith(after)
        ) {
          const stem = name.slice(before.length, name.length - after.length);
          for (const pattern of map.tests)
            allFiles
              .filter((n) => glob(pattern.replaceAll("{name}", stem), n))
              .forEach((n) => found.add(n));
        }
    }
    const scan = cfg.affectedTests?.byImportScan;
    if (scan && changed.length) {
      const candidates = allFiles.filter(
        (n) => scan.roots.some((r) => n.startsWith(r + "/")) && isTest(n),
      );
      if (candidates.length > scan.maxFiles)
        throw new Error(
          "Affected test scan exceeds maxFiles; provide an explicit narrower mapping.",
        );
      const known = new Set(allFiles),
        cache = new Map(),
        changedSet = new Set(changed);
      const imports = (name) => {
        if (cache.has(name)) return cache.get(name);
        if (cache.size >= scan.maxFiles)
          throw new Error(
            "Affected import graph exceeds maxFiles; narrow the roots or increase the approved bound.",
          );
        const text = readProject(
          state.profile,
          state.executionCwd,
          name,
          1024 * 1024,
        );
        const data = {
          paths: [],
          unknown:
            /\b(?:import|require)\s*\(\s*[^'"\s]|\b(?:readFile|readFileSync|readdirSync|fetch)\s*\(/.test(
              text,
            ),
        };
        cache.set(name, data);
        const specifiers = [
          ...text.matchAll(
            /\b(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)["']([^"']+)["']/g,
          ),
        ].map((m) => m[1]);
        for (const specifier of specifiers) {
          if (specifier.startsWith("node:")) continue;
          if (!specifier.startsWith(".")) {
            data.unknown = true;
            continue;
          }
          const base = path.posix.normalize(
            path.posix.join(path.posix.dirname(name), specifier),
          );
          const extensions = [
            "",
            ".ts",
            ".tsx",
            ".js",
            ".jsx",
            ".mjs",
            ".cjs",
            "/index.ts",
            "/index.js",
          ];
          const resolved = extensions
            .map((ext) => base + ext)
            .find((p) => known.has(p));
          if (resolved) data.paths.push(resolved);
          else data.unknown = true;
        }
        return data;
      };
      for (const test of candidates) {
        const queue = [test],
          visited = new Set();
        let affected = false;
        while (queue.length) {
          const name = queue.pop();
          if (visited.has(name)) continue;
          visited.add(name);
          if (changedSet.has(name)) {
            affected = true;
            break;
          }
          const data = imports(name);
          if (data.unknown) {
            affected = true;
            break;
          }
          queue.push(...data.paths);
        }
        if (affected) found.add(test);
      }
    }
  }
  return [...found].sort();
}
export function planChecks(state, current, changed, input = {}) {
  const profile = state.profile,
    configs = profile?.components?.gates?.checks || {};
  const checks = state.assignment.verification.map((v) => ({
      ...v,
      level: "enforce",
      source: "assignment",
    })),
    coverage = [];
  if (enabled(profile, "gates")) {
    for (const [id, cfg] of Object.entries(configs)) {
      const level = cfg.level || profile.components.gates.level;
      if (level === "off" || !applies(cfg.when, changed)) continue;
      if (input.includeProfileChecks === false) {
        if (level === "enforce")
          throw new Error("Cannot omit enforced profile checks.");
        continue;
      }
      if (cfg.source === "lcov") {
        coverage.push({ id: "profile-" + id, ...cfg, level });
        continue;
      }
      const files = cfg.perFile
        ? selectedTests(
            state,
            changed,
            cfg.perFile.select,
            Object.keys(current.files).filter((n) => current.files[n]),
          )
        : [null];
      if (!files.length && level === "enforce")
        throw new Error(
          "No tests selected for required check " +
            id +
            "; map the affected tests explicitly.",
        );
      for (const file of files) {
        const fileId = file
          ? path.basename(file).replace(/[^a-zA-Z0-9_.-]/g, "_") +
            "-" +
            hash(file).slice(0, 12)
          : id;
        const scratch = path.join(state.scratch, "checks", id);
        if (!input.preview) fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
        const argv = expand(
          cfg.perFile?.command || cfg.command || [],
          variables(profile, state.cwd, {
            worktree: state.executionCwd,
            scratch,
            file: file || "",
            files: files.filter(Boolean),
            fileId,
          }),
        );
        if (!argv.length)
          throw new Error(
            "Profile check requires command or coverage source: " + id,
          );
        checks.push({
          id: "profile-" + id + (file ? "-" + hash(file).slice(0, 12) : ""),
          command: argv[0],
          args: argv.slice(1),
          timeoutSeconds: cfg.timeoutSeconds || 120,
          level,
          source: "profile",
          host: cfg.host === true, passEnv: cfg.passEnv || [], allowInline: cfg.allowInline === true, criteria: cfg.criteria || [],
          file,
          retryOnTimeout: profile.components.gates.retryOnTimeout || 0,
          coveragePath: cfg.requireCoverageReport
            ? path.join(scratch, fileId, "lcov.info")
            : null,
        });
      }
    }
  }
  for (const check of input.preview ? [] : checks)
    allowCommand(profile, [check.command, ...check.args], check);
  if (new Set(checks.map((v) => v.id)).size !== checks.length)
    throw new Error("Assignment/profile check IDs collide.");
  return { checks, coverage, changed };
}
export function parseCounts(text) {
  const bunPass = (text.match(/^\(pass\)/gm) || []).length,
    bunFail = (text.match(/^\(fail\)/gm) || []).length;
  if (bunPass || bunFail)
    return { pass: bunPass, fail: bunFail, format: "bun" };
  const passed = text.match(/(?:^|\n)(?:#|ℹ)\s*pass\s+(\d+)/),
    failed = text.match(/(?:^|\n)(?:#|ℹ)\s*fail\s+(\d+)/);
  return passed && failed
    ? { pass: Number(passed[1]), fail: Number(failed[1]), format: "node" }
    : { pass: null, fail: null, format: "unknown" };
}
export function countLogs(...files) {
  try {
    const texts = files.map((file) => boundedRead(file, 8 * 1024 * 1024));
    return parseCounts(texts.join("\n"));
  } catch {
    return {
      pass: null,
      fail: null,
      format: "unknown",
      reason:
        "Complete check logs unavailable or exceed the 8 MiB parsing bound.",
    };
  }
}
export function parseLcov(text, cwd) {
  const records = [];
  let row;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      const raw = line.slice(3).replaceAll("\\", "/");
      const name = (
        path.isAbsolute(raw) ? path.relative(cwd, raw) : raw
      ).replaceAll("\\", "/");
      safeFile(cwd, name);
      row = { path: name, lines: {}, functions: {}, fnf: null, fnh: null };
      records.push(row);
    } else if (row && line.startsWith("DA:")) {
      const [n, h] = line.slice(3).split(",").map(Number);
      if (!Number.isInteger(n) || n < 1 || !Number.isFinite(h) || h < 0)
        throw new Error("Malformed LCOV line count.");
      row.lines[n] = Math.max(row.lines[n] || 0, h);
    } else if (row && line.startsWith("FNDA:")) {
      const comma = line.indexOf(",", 5),
        count = Number(line.slice(5, comma)),
        name = line.slice(comma + 1);
      if (comma < 0 || !Number.isFinite(count) || count < 0 || !name)
        throw new Error("Malformed LCOV function.");
      row.functions[name] = Math.max(row.functions[name] || 0, count);
    } else if (row && /^FN[FH]:/.test(line)) {
      const n = Number(line.slice(4));
      if (!Number.isInteger(n) || n < 0)
        throw new Error("Malformed LCOV function total.");
      const field = line.startsWith("FNF") ? "fnf" : "fnh";
      if (row[field] !== null)
        throw new Error("Duplicate LCOV function total.");
      row[field] = n;
    }
  }
  if (!records.length) throw new Error("Empty LCOV report.");
  for (const r of records)
    if (r.fnh !== null && r.fnf !== null && r.fnh > r.fnf)
      throw new Error("LCOV functions hit exceed found.");
  return records;
}
export function coverageChecks(state, plan, checks, current) {
  return plan.coverage.map((cfg) => {
    const policy = JSON.parse(
      readProject(state.profile, state.cwd, cfg.policy),
    );
    if (policy.policyVersion !== 1 || !Array.isArray(policy.groups))
      throw new Error("Unsupported coverage policy.");
    const minimum = {
      lines: Math.max(
        cfg.minimum?.lines || 0,
        policy.minimumPercent?.lines || 0,
      ),
      functions: Math.max(
        cfg.minimum?.functions || 0,
        policy.minimumPercent?.functions || 0,
      ),
    };
    const records = [];
    for (const check of checks)
      if (check.coveragePath && check.status === "passed")
        records.push(
          ...parseLcov(
            fs.readFileSync(check.coveragePath, "utf8"),
            state.executionCwd,
          ),
        );
    const rows = [];
    for (const name of plan.changed) {
      if (!current.files[name]) continue;
      const group = policy.groups.find((g) =>
        g.paths.some(
          (p) =>
            name === p ||
            name.startsWith(p.replace(/\/$/, "") + "/") ||
            glob(p, name),
        ),
      );
      if (!group) continue;
      const entries = records.filter((r) => r.path === name),
        lines = {},
        functions = {};
      for (const entry of entries) {
        for (const [n, hits] of Object.entries(entry.lines))
          lines[n] = Math.max(lines[n] || 0, hits);
        for (const [n, hits] of Object.entries(entry.functions))
          functions[n] = Math.max(functions[n] || 0, hits);
      }
      const identities =
        entries.length > 0 &&
        entries.every(
          (r) => Object.keys(r.functions).length > 0 || r.fnf === 0,
        );
      const found = identities
        ? Object.keys(functions).length
        : Math.max(0, ...entries.map((r) => r.fnf || 0));
      const hit = identities
        ? Object.values(functions).filter((v) => v > 0).length
        : Math.max(0, ...entries.map((r) => r.fnh || 0));
      const metric = (hit, found) => ({
        hit,
        found,
        percent: found ? (hit * 100) / found : null,
      });
      const row = {
        path: name,
        sourceHash: current.files[name].hash,
        group: group.id,
        lines: metric(
          Object.values(lines).filter((v) => v > 0).length,
          Object.keys(lines).length,
        ),
        functions: metric(hit, found),
        functionMethod: identities
          ? "identity-union"
          : "conservative-lower-bound",
      };
      const validFunctions =
        entries.length &&
        entries.every((e) => e.fnf !== null && e.fnh !== null);
      row.passed = !!(
        entries.length &&
        row.lines.found &&
        row.lines.percent >= minimum.lines &&
        (identities || validFunctions) &&
        (!found || row.functions.percent >= minimum.functions)
      );
      rows.push(row);
    }
    const passed = rows.every((r) => r.passed);
    return {
      id: cfg.id,
      source: "profile",
      level: cfg.level,
      status: passed ? "passed" : "failed",
      exitCode: passed ? 0 : 1,
      coverage: {
        minimum,
        files: rows,
        method:
          "Union of lines; functions use identities when available, otherwise a conservative lower bound.",
      },
    };
  });
}
