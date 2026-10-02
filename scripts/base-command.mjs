/** Bounded status-line composition; timeout kills the entire command tree. */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hostEnvironment } from "./check-executable.mjs";
import { trustedExecutable } from "./host-security.mjs";
export function baseCommand(command, input, timeoutMs = 1000) {
  return new Promise(resolve => {
    const started = performance.now();
    const windows = process.platform === "win32";
    const terminatorPath = windows ? trustedExecutable("taskkill.exe") : null;
    // A detached Node relay preserves the tree for taskkill without detaching cmd from its pipes.
    const child = spawn(windows ? process.execPath : "/bin/sh", windows
      ? [fileURLToPath(new URL("./base-relay.cjs", import.meta.url)), trustedExecutable("cmd.exe"), command]
      : ["-c", command], {
      env: hostEnvironment(), windowsHide: true, detached: true, stdio: ["pipe", "pipe", "ignore"] });
    let text = "", done = false;
    const finish = value => { if (done) return; done = true; clearTimeout(timer); resolve(value); };
    const kill = () => {
      if (done) return;
      try {
        if (windows) { const terminator = spawn(terminatorPath, ["/PID", String(child.pid), "/T", "/F"], { env: hostEnvironment(), windowsHide: true, detached: true, stdio: "ignore" }); terminator.on("error", () => {}); terminator.unref(); }
        else process.kill(-child.pid, "SIGKILL");
      } catch { /* A denied or unavailable terminator must not hang the status line. */ }
      child.stdout.unref?.(); child.stdin.unref?.();
      child.stdout.destroy(); child.stdin.destroy(); child.unref(); finish("");
    };
    const timer = setTimeout(kill, Math.max(0, timeoutMs - (performance.now() - started)));
    child.on("error", () => finish("")); child.stdin.on("error", () => {});
    child.stdout.on("data", chunk => { text += chunk; if (text.length > 65536) kill(); });
    child.on("close", code => finish(code === 0 ? text.trimEnd() : ""));
    child.stdin.end(input);
  });
}
