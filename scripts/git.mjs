/** Git snapshots and diffs using a trusted host executable. */
import { trustedExecutable } from "./host-security.mjs";
import { hostEnvironment } from "./check-executable.mjs";
import { gitSafetyArgs } from "./git-security.mjs";
import { guardFilteredWrite } from "./git-write-policy.mjs";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

export const hash = (value) => createHash("sha256").update(value).digest("hex");
export function git(cwd, args, allowFailure = false, options = {}) {
  let commandIndex=0;
  while(args[commandIndex]?.startsWith("-")) commandIndex += ["-c","-C","--git-dir","--work-tree"].includes(args[commandIndex]) ? 2 : 1;
  const globals=args.slice(0,commandIndex);args=args.slice(commandIndex);
  const safety = gitSafetyArgs();
  // Config listing cannot invoke filters. Disable filter programs before reading worktree content.
  const config = spawnSync(trustedExecutable("git", cwd), [...globals,...safety, "-C", cwd, "config", "--includes", "--name-only", "--get-regexp", "^(filter\\..*\\.(clean|smudge|process|required)|merge\\..*\\.driver)$"], { env: hostEnvironment(), encoding: "utf8", windowsHide: true, timeout: 5000 });
  if (config.error || ![0, 1].includes(config.status)) throw Error("Cannot inspect Git filters safely.");
  const keys=(config.stdout || "").split(/\r?\n/).filter(Boolean);
  const run=(argv,extra={},allow=false)=>{const r=spawnSync(trustedExecutable("git",cwd),[...safety,"-C",cwd,...argv],{env:hostEnvironment(),encoding:"utf8",windowsHide:true,timeout:5000,maxBuffer:32*1024*1024,...extra});if(!allow && (r.status!==0 || r.error))throw Error("Git write safety inspection failed: "+(r.error?.message || r.stderr));return r;};
  const writing=guardFilteredWrite(args,keys,run);
  for (const key of keys) if(key.startsWith("merge.") || !writing) safety.push("-c", key + (key.endsWith(".required") ? "=false" : "="));
  if(["diff","show","log"].includes(args[0])) args=[args[0],"--no-ext-diff","--no-textconv",...args.slice(1)];
  const r = spawnSync(trustedExecutable("git", cwd), [...globals,...safety, "-C", cwd, ...args], {
    env: { ...hostEnvironment(), GIT_OPTIONAL_LOCKS: "0" },
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (r.status !== 0 && !allowFailure)
    throw new Error(
      `Git ${args[0]} failed: ${[r.error?.message, r.stderr].filter(Boolean).join("\n").slice(0, 2000)}`,
    );
  return r;
}
export function safeFile(cwd, name) {
  if (
    !name ||
    name.includes("\\") ||
    name.includes(":") ||
    name.startsWith("/") ||
    name
      .split("/")
      .some((p) => ["..", ".git", "."].includes(p.toLowerCase()) || !p)
  )
    throw new Error(`Unsafe project path: ${name}`);
  const parts = name.split("/");
  let target = cwd;
  for (const part of parts) {
    target = path.join(target, part);
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink())
      throw new Error(
        `Symlink paths are not supported for tracked changes: ${name}`,
      );
  }
  return target;
}
export function snapshot(cwd) {
  const root = git(cwd, ["rev-parse", "--show-toplevel"], true);
  if (root.status !== 0)
    return { available: false, reason: "Not a Git repository." };
  if (fs.realpathSync(root.stdout.trim()).toLowerCase() !== cwd.toLowerCase())
    throw new Error("Use the Git repository root as cwd.");
  const index = git(cwd, ["ls-files", "--stage", "-z"]).stdout;
  if (
    index
      .split("\0")
      .some((row) => row.startsWith("160000 ") || row.startsWith("120000 "))
  )
    throw new Error(
      "Snapshot verification does not support Git submodules or tracked symlinks.",
    );
  const names = [
    ...new Set(
      git(cwd, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
        .stdout.split("\0")
        .filter(Boolean),
    ),
  ].sort();
  if (names.length > 30000)
    throw new Error("Snapshot exceeds 30000 files; use a smaller project.");
  const files = {};
  let bytes = 0;
  for (const name of names) {
    const file = safeFile(cwd, name);
    if (!fs.existsSync(file)) {
      files[name] = null;
      continue;
    }
    const info = fs.statSync(file);
    if (!info.isFile()) throw new Error(`Expected a regular file: ${name}`);
    bytes += info.size;
    if (info.size > 32 * 1024 * 1024 || bytes > 512 * 1024 * 1024)
      throw new Error(
        "Snapshot size limit exceeded (32 MiB/file, 512 MiB/project).",
      );
    files[name] = {
      hash: hash(fs.readFileSync(file)),
      mode: info.mode & 0o777,
    };
  }
  const head = git(cwd, ["rev-parse", "--verify", "HEAD"], true);
  const data = {
    available: true,
    head: head.status === 0 ? head.stdout.trim() : null,
    indexHash: hash(index),
    files,
  };
  return {
    ...data,
    fingerprint: hash(JSON.stringify(data)),
    dirty: Boolean(
      git(cwd, [
        "status",
        "--porcelain",
        "--untracked-files=all",
      ]).stdout.trim(),
    ),
  };
}
export function changes(before, after, scope = ["."]) {
  if (!before.available || !after.available)
    return { available: false, files: [], outOfScope: [] };
  const names = [
    ...new Set([...Object.keys(before.files), ...Object.keys(after.files)]),
  ].sort();
  const files = names.filter(
    (n) =>
      JSON.stringify(before.files[n] ?? null) !==
      JSON.stringify(after.files[n] ?? null),
  );
  return {
    available: true,
    files,
    outOfScope: files.filter(
      (n) => !scope.some((s) => s === "." || n === s || n.startsWith(s + "/")),
    ),
    gitMetadataChanged:
      before.head !== after.head || before.indexHash !== after.indexHash,
  };
}
export function integrateFiles(origin, worktree, before, after) {
  const delta = changes(before, after);
  const originals = new Map();
  // Complete preflight before the first write; use literal, contained regular files.
  for (const name of delta.files) {
    const dest = safeFile(origin, name);
    const source = safeFile(worktree, name);
    if (!before.files[name] && fs.existsSync(dest))
      throw new Error(
        `Integration would overwrite an existing untracked or ignored file: ${name}`,
      );
    if (
      before.files[name] &&
      (!fs.existsSync(dest) ||
        hash(fs.readFileSync(dest)) !== before.files[name].hash)
    )
      throw new Error(
        `Original file changed during integration preflight: ${name}`,
      );
    originals.set(
      name,
      fs.existsSync(dest)
        ? { bytes: fs.readFileSync(dest), mode: fs.statSync(dest).mode }
        : null,
    );
    if (
      after.files[name] &&
      hash(fs.readFileSync(source)) !== after.files[name].hash
    )
      throw new Error("Worktree changed during integration preflight.");
  }
  const written = [];
  try {
    for (const name of delta.files) {
      const dest = safeFile(origin, name);
      written.push(name);
      if (after.files[name]) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(safeFile(worktree, name), dest);
        fs.chmodSync(dest, after.files[name].mode);
      } else if (fs.existsSync(dest)) fs.unlinkSync(dest);
    }
  } catch (error) {
    const failures = [];
    for (const name of written.reverse()) {
      try {
        const dest = safeFile(origin, name);
        const original = originals.get(name);
        if (original) {
          fs.writeFileSync(dest, original.bytes);
          fs.chmodSync(dest, original.mode);
        } else if (fs.existsSync(dest)) fs.unlinkSync(dest);
      } catch (e) {
        failures.push(e.message);
      }
    }
    throw new Error(
      `Integration failed: ${error.message}. Rollback: ${failures.length ? failures.join("; ") : "file contents restored"}`,
    );
  }
  return delta.files;
}
