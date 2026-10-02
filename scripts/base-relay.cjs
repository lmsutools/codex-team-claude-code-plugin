/** Detached Windows relay: keep cmd's inherited pipes and its process tree alive until cleanup. */
process.env.NoDefaultCurrentDirectoryInExePath = "1";
const { spawn } = require("node:child_process");
const [, , shell, command] = process.argv;
try {
  // The parent supplies an absolute, trusted cmd.exe path; never resolve it here.
  const child = spawn(shell, ["/d", "/s", "/c", '"' + command + '"'], {
    detached: false, stdio: "inherit", windowsVerbatimArguments: true, windowsHide: true,
  });
  child.once("error", () => process.exit(1));
  child.once("exit", code => process.exit(code ?? 1));
} catch {
  process.exit(1);
}
