import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { profileSchema, templates } from "./profile.mjs";
const root = new URL("../", import.meta.url);
fs.mkdirSync(new URL("schemas/", root), { recursive: true });
fs.mkdirSync(new URL("templates/", root), { recursive: true });
fs.writeFileSync(
  new URL("schemas/profile.schema.json", root),
  JSON.stringify(
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "codex-team project profile",
      ...profileSchema,
    },
    null,
    2,
  ) + "\n",
);
for (const [name, template] of Object.entries(templates))
  fs.writeFileSync(
    new URL("templates/" + name + ".json", root),
    JSON.stringify(template, null, 2) + "\n",
  );
console.log("Exported profile schema and standard/strict templates.");
