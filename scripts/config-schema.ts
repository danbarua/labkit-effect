/**
 * Writes the JSON Schema of a policies file (`src/agent-config/schema.ts`), made from the built-in
 * plug-ins, to the path given (`policies.schema.json` when none is). A policies file names it in a
 * comment at its top, so an editor with the YAML language server checks the file as it is typed:
 *
 *     # yaml-language-server: $schema=./policies.schema.json
 *
 * Run: `bun scripts/config-schema.ts [path]`.
 */

import { writeFileSync } from "node:fs";
import { policiesJsonSchema } from "../src/agent-config/schema.ts";

const path = process.argv[2] ?? "policies.schema.json";
writeFileSync(path, `${JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", ...(policiesJsonSchema() as object) }, null, 2)}\n`);
console.log(`Written to ${path}`);
