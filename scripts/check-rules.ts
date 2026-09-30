/**
 * Checks that every rule in a `MODEL.md` under `src/` has a test named for it. A rule is a list item
 * that starts with its id (`- R1. …`); a test is named for a rule when its name starts with ids
 * and a colon (`"R1 TC2: …"`). Prints each rule and how many tests name it, so a run over nothing
 * is visible.
 *
 * retire-when: the rules are generated from the tests' names, or the tests from the rules.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const files = (directory: string, ending: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(directory, entry.name), ending) : entry.name.endsWith(ending) ? [join(directory, entry.name)] : [],
  );

const rules = files("src", "MODEL.md").flatMap((file) =>
  [...readFileSync(file, "utf8").matchAll(/^- ([A-Z]{1,2}\d+)\. /gm)].map((match) => ({ id: match[1] ?? "", file })),
);

const named = new Map<string, number>();
for (const file of [...files("src", ".test.ts"), ...files("tests", ".test.ts")])
  for (const match of readFileSync(file, "utf8").matchAll(/\btest(?:\.each\([^)]*\))?\(\s*"((?:[A-Z]{1,2}\d+ ?)+):/g))
    for (const id of (match[1] ?? "").trim().split(" ")) named.set(id, (named.get(id) ?? 0) + 1);

for (const { id, file } of rules) console.log(`${id}\t${named.get(id) ?? 0} test(s)\t${file}`);
const untested = rules.filter(({ id }) => !named.has(id));
const unknown = [...named.keys()].filter((id) => !rules.some((rule) => rule.id === id));
if (rules.length === 0) throw new Error("no rule was found in any MODEL.md under src/");
if (untested.length > 0 || unknown.length > 0) {
  for (const { id, file } of untested) console.error(`no test is named for ${id} (${file})`);
  for (const id of unknown) console.error(`a test is named for ${id}, which no MODEL.md has`);
  process.exit(1);
}
console.log(`${rules.length} rules, each with a test named for it`);
