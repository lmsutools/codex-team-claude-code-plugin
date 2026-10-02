process.env.NoDefaultCurrentDirectoryInExePath = "1";
/** Entry detection follows junctions/symlinks just as Node's module loader does. */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
export function isMain(url) {
  try { return fs.realpathSync.native(fileURLToPath(url)) === fs.realpathSync.native(process.argv[1]); }
  catch { return false; }
}
