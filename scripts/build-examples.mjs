import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { validate, profileSchema } from "./profile.mjs";
const examples = {
  node: {
    profileVersion: 1,
    name: "node-small",
    extends: "standard",
    components: {
      gates: {
        level: "enforce",
        checks: { tests: { when: "always", command: ["node", "--test"] } },
      },
      report: { level: "advise", template: "builtin:short" },
    },
  },
  // Rust workspace on top of the built-in "rust" template (fmt, clippy and
  // tests on affected packages). Adds a cross-target clippy for a "Ready"
  // platform and swaps libtest for cargo-nextest when it is installed.
  rust: {
    profileVersion: 1,
    name: "rust-workspace",
    extends: "rust",
    components: {
      gates: {
        level: "enforce",
        checks: {
          tests: {
            when: { changed: ["**/*.rs", "**/Cargo.toml", "Cargo.lock", ".cargo/**"] },
            command: ["node", "${pluginRoot}/scripts/cargo-affected.mjs", "--changed-list", "${changedList}", "--", "nextest", "run", "--locked", "--offline", "--no-fail-fast"],
            timeoutSeconds: 1800,
          },
          "windows-ready": {
            level: "advise",
            reason: "Keeps the Ready Windows target compiling (cargo check needs no MSVC linker).",
            when: { changed: ["**/*.rs", "**/Cargo.toml", "Cargo.lock"] },
            command: ["cargo", "clippy", "--workspace", "--all-targets", "--locked", "--offline", "--target", "x86_64-pc-windows-msvc", "--", "-D", "warnings"],
            timeoutSeconds: 1800,
          },
        },
      },
      report: { level: "advise", template: "builtin:short" },
    },
  },
};
export function writeExamples() {
  for (const [name, profile] of Object.entries(examples)) {
    validate(profile, profileSchema);
    fs.mkdirSync(new URL(`../examples/${name}/`, import.meta.url), { recursive: true });
    fs.writeFileSync(new URL(`../examples/${name}/profile.json`, import.meta.url), JSON.stringify(profile, null, 2) + "\n");
  }
  console.log("Wrote example profiles: " + Object.keys(examples).join(", ") + ".");
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) writeExamples();
export { examples };
