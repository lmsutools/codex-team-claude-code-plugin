/** Real CLI output schemas use the strict subset; bounds belong to JS validators. */
import test from "node:test";
import assert from "node:assert/strict";
import * as contracts from "../scripts/contracts.mjs";
const forbidden = new Set(["minLength", "maxLength", "pattern", "format", "minItems", "maxItems"]);
function inspect(schema, location) {
  if (!schema || typeof schema !== "object") return;
  for (const [key, value] of Object.entries(schema)) {
    assert.ok(!forbidden.has(key), `${location}.${key} is unsupported`);
    if (key === "properties") {
      assert.equal(schema.additionalProperties, false, location);
      assert.deepEqual([...schema.required].sort(), Object.keys(value).sort(), location);
    }
    if (value && typeof value === "object") {
      if (Array.isArray(value)) value.forEach((item, index) => inspect(item, `${location}.${key}[${index}]`));
      else inspect(value, `${location}.${key}`);
    }
  }
}
for (const [name, schema] of Object.entries(contracts).filter(([name]) => name.endsWith("Schema")))
  test(`${name} uses the strict Codex output subset recursively`, () => inspect(schema, name));
test("old reports remain valid and optional strict criterion IDs may be null", () => {
  contracts.report({ summary: "legacy", changedFiles: [], checks: [], blockers: [] });
  const assignment = { objective: "task", scope: ["."], constraints: [], decisions: [], dependencies: [],
    acceptanceCriteria: [{ id: null, text: "criterion", tags: [] }],
    verification: [{ id: "check", command: "node", args: [], timeoutSeconds: 120 }] };
  assert.equal(contracts.assignment(assignment).acceptanceCriteria[0].id, undefined);
  assert.throws(() => contracts.report({ summary: "ok", changedFiles: [], checks: [], blockers: [], handbookNotes: Array(201).fill("note") }));
});
