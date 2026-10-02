/** Resolve host checks without allowing project-local executable or PATH shadowing. */
import fs from "node:fs";
import path from "node:path";
export function hostEnvironment(environment = process.env) {
  return { ...Object.fromEntries(Object.entries(environment).filter(([key]) => key.toLowerCase() !== "nodefaultcurrentdirectoryinexepath")), NoDefaultCurrentDirectoryInExePath: "1" };
}
export function inside(directory, root) {
  const relative = path.relative(root, directory);
  return !relative || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}
export function resolveCheckExecutable(command, cwd, environment = process.env, platform = process.platform) {
  if (path.isAbsolute(command) || /[\\/]/.test(command)) return path.resolve(cwd, command);
  const get = key => Object.entries(environment).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1] || "";
  const extensions = platform === "win32" && !/\.(?:exe|com|cmd|bat)$/i.test(command) ? (get("PATHEXT") || ".COM;.EXE;.BAT;.CMD").split(";").filter(v => /^\.[a-z0-9]+$/i.test(v)) : [""];
  const root = fs.realpathSync.native(cwd);
  let projectMatch = false;
  for (const entry of [cwd, ...get("PATH").split(path.delimiter)]) {
    const directory = path.resolve(cwd, entry.replace(/^"|"$/g, "") || ".");
    let realDirectory;
    try { realDirectory = fs.realpathSync.native(directory); } catch { continue; }
    for (const extension of extensions) {
      const candidate = path.join(realDirectory, command + extension);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        const real = fs.realpathSync.native(candidate);
        if (inside(directory, path.resolve(cwd)) || inside(realDirectory, root) || inside(real, root)) { projectMatch = true; continue; }
        if (platform !== "win32") fs.accessSync(real, fs.constants.X_OK);
        return real;
      } catch {}
    }
  }
  throw Error(projectMatch ? `Check executable '${command}' resolves only inside the project; use a trusted executable outside executionCwd.` : `Check executable '${command}' was not found on PATH outside executionCwd.`);
}
