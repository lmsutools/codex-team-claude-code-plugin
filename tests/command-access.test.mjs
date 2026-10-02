import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { commandAccessSuspected } from "../scripts/policy-core.mjs";
const profile = {
  components: {
    secrets: {
      level: "enforce",
      forbiddenPaths: ["**/*.env", "**/.env", "**/.env.*"],
    },
  },
};
test("literal negative ripgrep globs do not imply forbidden file access", () => {
  const examples = JSON.parse(
    fs.readFileSync(
      new URL("./fixtures/rg-negative-glob.json", import.meta.url),
      "utf8",
    ),
  );
  examples.push(
    'rg --files -g "!**/.env*"',
    "rg --files --glob=!**/.env*",
    'rg --files --iglob "!**/.env*"',
  );
  for (const command of examples)
    assert.equal(
      commandAccessSuspected(profile, process.cwd(), command),
      false,
      command,
    );
});
test("negative rg globs cannot hide positive globs or real access operands", () => {
  for (const command of [
    "cat .env",
    "Get-Content .env.production",
    "rg password .env",
    'rg --files -g "!**/.env*"; cat .env',
    'rg --files -g "!**/.env*" .env',
    'rg token --glob "**/.env*" .',
    'rg token --glob "!**/.env*" --glob "**/.env*" .',
    'Get-Content -g "!**/.env*"',
  ])
    assert.equal(
      commandAccessSuspected(profile, process.cwd(), command),
      true,
      command,
    );
});
