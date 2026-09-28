/**
 * Checks three rules over every file in the abstract layers, src/agent-core and src/agent-policy:
 *
 * - a file imports only `Schema` from "effect", or files in the layers it may depend on:
 *   agent-core depends on nothing else; agent-policy depends on agent-core;
 * - every string it declares is branded: each `Schema.String` is followed by
 *   `.pipe(Schema.brand(` on the same line, and the `string` keyword does not appear;
 * - it is written as pure functions: no `let` or `var`, no loop statements, no `++` or `--`, and no
 *   call that changes a value in place (`push`, `set`, `delete`, `splice`, `sort`, `reverse`,
 *   `fill`, `Object.assign`).
 *
 * Prints the number of files examined per layer, so a run over no files is visible.
 */

import { Glob } from "bun";
import { dirname, join, normalize } from "node:path";

const layers: ReadonlyArray<{ dir: string; mayImport: ReadonlyArray<string> }> = [
  { dir: "src/agent-core", mayImport: ["src/agent-core"] },
  { dir: "src/agent-policy", mayImport: ["src/agent-policy", "src/agent-core"] },
];

const problems: Array<string> = [];

for (const layer of layers) {
  const files = [...new Glob(`${layer.dir}/**/*.ts`).scanSync(".")].sort();
  console.log(`check:core examined ${files.length} files in ${layer.dir}`);
  if (files.length === 0) problems.push(`${layer.dir}: no files`);
  for (const file of files) {
    const lines = (await Bun.file(file).text()).split("\n");
    lines.forEach((line, index) => {
      const at = `${file}:${index + 1}`;
      const from = /\bfrom\s+"([^"]+)"/.exec(line)?.[1];
      if (from !== undefined) {
        if (from.startsWith(".")) {
          const target = normalize(join(dirname(file), from));
          if (!layer.mayImport.some((dir) => target.startsWith(`${dir}/`)))
            problems.push(`${at}: imports ${target}, outside ${layer.mayImport.join(", ")}`);
        } else if (!(from === "effect" && /^import\s+\{\s*Schema\s*\}\s+from/.test(line.trim()))) {
          problems.push(`${at}: imports "${from}": ${line.trim()}`);
        }
      }
      for (const match of line.matchAll(/Schema\.String\b/g)) {
        const rest = line.slice(match.index + "Schema.String".length);
        if (!rest.startsWith(".pipe(Schema.brand(")) problems.push(`${at}: unbranded Schema.String`);
      }
      const code = line.replace(/\/\/.*$|\/\*.*?\*\/|^\s*\*.*$/g, "");
      if (/\bstring\b/.test(code)) problems.push(`${at}: the \`string\` type: ${line.trim()}`);
      const mutation =
        /\b(let|var)\s|\b(for|while|do)\s*[({]|\+\+|--|\.(push|set|delete|splice|sort|reverse|fill)\(|Object\.assign\(/.exec(
          code,
        );
      if (mutation !== null) problems.push(`${at}: not pure (\`${mutation[0]}\`): ${line.trim()}`);
    });
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
