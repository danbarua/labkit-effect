/**
 * Checks that no file has more casts than `scripts/lint-exceptions.ts` records for it. The lint rules
 * against casts (`typescript/consistent-type-assertions`, `typescript/no-non-null-assertion`) are off
 * for the files listed there, so this check is what catches a new cast in one of them.
 *
 * - It runs oxlint with only those two rules, over `src`, `tests`, `scripts` and `bin`, and counts
 *   what each rule reports in each file.
 * - A file with more casts than its recorded count fails the check, naming the file and both counts.
 * - A file with fewer casts than its recorded count also fails, naming the count to record, so the
 *   list only ever goes down and stays exact. A file with none is removed from the list.
 * - A file that is not listed is left to the lint rules, which report every cast in it.
 *
 * Prints the totals it counted; exits 1 on a failure, and when oxlint reports nothing it can parse.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nonNullAssertions, typeAssertions } from "./lint-exceptions.ts";

const rules = {
  "consistent-type-assertions": { recorded: typeAssertions, listName: "typeAssertions" },
  "no-non-null-assertion": { recorded: nonNullAssertions, listName: "nonNullAssertions" },
} as const;

type Rule = keyof typeof rules;

const isRule = (name: string): name is Rule => Object.hasOwn(rules, name);

const folder = mkdtempSync(join(tmpdir(), "check-casts-"));
const config = join(folder, "oxlint.json");
writeFileSync(
  config,
  JSON.stringify({
    plugins: ["typescript"],
    ignorePatterns: ["repos/**"],
    rules: { "typescript/consistent-type-assertions": ["error", { assertionStyle: "never" }], "typescript/no-non-null-assertion": "error" },
  }),
);
const run = Bun.spawnSync(["node_modules/.bin/oxlint", "-c", config, "--format", "unix", "src", "tests", "scripts", "bin"], { stdout: "pipe", stderr: "pipe" });
rmSync(folder, { recursive: true, force: true });

/** `<file>:<line>:<column>: <message> [Error/typescript(<rule>)]`, as oxlint's unix format writes a report. */
const reportLine = /^(.+?):\d+:\d+: .*\[\w+\/typescript\(([a-z-]+)\)\]$/;

const counted = new Map<Rule, Map<string, number>>([
  ["consistent-type-assertions", new Map()],
  ["no-non-null-assertion", new Map()],
]);
for (const line of run.stdout.toString().split("\n")) {
  const found = reportLine.exec(line);
  const file = found?.[1];
  const rule = found?.[2];
  if (file === undefined || rule === undefined || !isRule(rule)) continue;
  const perFile = counted.get(rule);
  perFile?.set(file, (perFile.get(file) ?? 0) + 1);
}

const totals = Array.from(counted.entries()).map(([rule, perFile]) => ({ rule, total: Array.from(perFile.values()).reduce((sum, n) => sum + n, 0) }));
if (totals.every(({ total }) => total === 0)) {
  console.error(`ERROR: oxlint reported no casts at all, so the check examined nothing.\n${run.stderr.toString()}`);
  process.exit(1);
}

const failures: Array<string> = [];
for (const [rule, perFile] of counted) {
  const { recorded, listName } = rules[rule];
  for (const [file, count] of perFile) {
    const allowed = recorded[file];
    if (allowed !== undefined && count > allowed)
      failures.push(`${file}: ${count} ${rule} reports, but ${listName} records ${allowed}. Remove the new ones: narrow, annotate, or decode instead.`);
    if (allowed !== undefined && count < allowed) failures.push(`${file}: ${count} ${rule} reports, fewer than the ${allowed} that ${listName} records. Record ${count} in scripts/lint-exceptions.ts.`);
  }
  for (const file of Object.keys(recorded))
    if (!perFile.has(file)) failures.push(`${file}: no ${rule} reports, but ${listName} lists it. Remove it from scripts/lint-exceptions.ts.`);
}

console.log(totals.map(({ rule, total }) => `${rule}: ${total} in ${counted.get(rule)?.size ?? 0} files`).join("; "));
if (failures.length > 0) {
  console.error(failures.map((failure) => `ERROR: ${failure}`).join("\n"));
  process.exit(1);
}
