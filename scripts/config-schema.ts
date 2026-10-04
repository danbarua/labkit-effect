/**
 * The JSON Schema of a policies file (`src/agent-config/schema.ts`), made from the built-in plug-ins,
 * kept at `schemas/policies.schema.json`. A policies file names it in a comment at its top, so an
 * editor with the YAML language server checks the file as it is typed:
 *
 *     # yaml-language-server: $schema=<path or URL of schemas/policies.schema.json>
 *
 * A path relative to the file works from a checkout; once the repository is published, its raw URL
 * (`https://raw.githubusercontent.com/<owner>/<repository>/main/schemas/policies.schema.json`) works
 * from anywhere. It has the built-in plug-ins: an extension's are not in it.
 *
 * Run: `bun scripts/config-schema.ts [path]` writes it; `bun scripts/config-schema.ts --check` fails
 * when the file kept differs from what the plug-ins make (`bun run check` runs it).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { policiesJsonSchema } from "../src/agent-config/schema.ts";

const kept = resolve(import.meta.dir, "../schemas/policies.schema.json");
const made = `${JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", ...(policiesJsonSchema() as object) }, null, 2)}\n`;

if (process.argv[2] === "--check") {
  const current = (() => {
    try {
      return readFileSync(kept, "utf8");
    } catch {
      return "";
    }
  })();
  if (current !== made) {
    console.error(`${kept} differs from what the plug-ins make: run bun scripts/config-schema.ts`);
    process.exit(1);
  }
  console.log(`check:schemas ${kept} is current`);
} else {
  const path = process.argv[2] ?? kept;
  writeFileSync(path, made);
  console.log(`Written to ${path}`);
}
