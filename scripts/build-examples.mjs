import fs from "node:fs";
import { validate, profileSchema } from "./profile.mjs";
const minimal = {
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
};
validate(minimal, profileSchema);
fs.mkdirSync(new URL("../examples/node/", import.meta.url), {
  recursive: true,
});
fs.writeFileSync(
  new URL("../examples/node/profile.json", import.meta.url),
  JSON.stringify(minimal, null, 2) + "\n",
);
console.log("Wrote example profiles.");
