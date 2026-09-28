/**
 * Checks two rules over every file in src/agent-core:
 *
 * - it imports only `Schema` from "effect", or a file inside src/agent-core;
 * - every string it declares is branded: each `Schema.String` is followed by
 *   `.pipe(Schema.brand(` on the same line, and the `string` keyword does not appear.
 *
 * Prints the number of files examined, so a run over no files is visible.
 */

import { Glob } from "bun";

const files = [...new Glob("src/agent-core/**/*.ts").scanSync(".")].sort();
const problems: Array<string> = [];

for (const file of files) {
  const lines = (await Bun.file(file).text()).split("\n");
  lines.forEach((line, index) => {
    const at = `${file}:${index + 1}`;
    const from = /\bfrom\s+"([^"]+)"/.exec(line)?.[1];
    if (from !== undefined) {
      const local = from.startsWith("./") || from.startsWith("../");
      const schemaOnly = from === "effect" && /^import\s+\{\s*Schema\s*\}\s+from/.test(line.trim());
      if (!local && !schemaOnly) problems.push(`${at}: imports "${from}": ${line.trim()}`);
    }
    for (const match of line.matchAll(/Schema\.String\b/g)) {
      const rest = line.slice(match.index + "Schema.String".length);
      if (!rest.startsWith(".pipe(Schema.brand(")) problems.push(`${at}: unbranded Schema.String`);
    }
    if (/\bstring\b/.test(line.replace(/\/\/.*$|\/\*.*?\*\/|^\s*\*.*$/g, "")))
      problems.push(`${at}: the \`string\` type: ${line.trim()}`);
  });
}

console.log(`check:core examined ${files.length} files`);
if (files.length === 0) {
  console.error("check:core: no files under src/agent-core");
  process.exit(1);
}
if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
