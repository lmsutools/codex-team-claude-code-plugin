/**
 * Test preload (node --import): resolve the temp directory's symlinks once, before
 * any fixture is created. On macOS os.tmpdir() is /var/folders/..., a symlink to
 * /private/var/folders/...; the plugin canonicalizes every project path with
 * realpath (S.workspace, gitRoot, canonical), so fixtures built from the
 * unresolved path missed their own jobs and hook markers. Windows is unchanged.
 */
import fs from "node:fs";
import os from "node:os";
if (process.platform !== "win32") {
  try { process.env.TMPDIR = fs.realpathSync(os.tmpdir()); } catch {}
}
