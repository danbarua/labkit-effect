/**
 * Projects every session file of one harness under a directory (by default where that harness
 * keeps them) into trajectories, and writes a summary: totals of every decision and unmapped record kind, the
 * sessions where the core found observations it did not expect or could not deliver, and the
 * sessions richest in the record kinds worth studying.
 *
 *   bun scripts/trajectories/sweep.ts <claude-code|codex> [sessions-dir] [out-dir]
 *
 * A session file that cannot be imported is listed with its error; the sweep goes on.
 */

import { readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { importClaudeCode } from "./claude-code.ts";
import { importCodex } from "./codex.ts";
import { type Imported, writeTrajectory } from "./project.ts";

const harnesses = {
  "claude-code": { importer: importClaudeCode, root: join(homedir(), ".claude", "projects") },
  codex: { importer: importCodex, root: join(homedir(), ".codex", "sessions") },
};
const [harness, rootArg, outArg] = process.argv.slice(2);
if (harness !== "claude-code" && harness !== "codex")
  throw new Error("usage: bun scripts/trajectories/sweep.ts <claude-code|codex> [sessions-dir] [out-dir]");
const { importer } = harnesses[harness];
const root = rootArg ?? harnesses[harness].root;
const outDir = outArg ?? join("trajectories", harness);

function sessionFiles(dir: string): Array<string> {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sessionFiles(path);
    return entry.endsWith(".jsonl") ? [path] : [];
  });
}

const add = (into: Map<string, number>, from: Record<string, number>): void => {
  for (const [kind, n] of Object.entries(from)) into.set(kind, (into.get(kind) ?? 0) + n);
};

const files = sessionFiles(root).sort();
const decisions = new Map<string, number>();
const unmapped = new Map<string, number>();
const reports: Array<Imported["report"] & { readonly subagent: boolean }> = [];
const failures: Array<{ readonly source: string; readonly error: string }> = [];
const started = performance.now();

for (const file of files) {
  const where = relative(root, dirname(file));
  try {
    const imported = await importer(file);
    writeTrajectory(join(outDir, where), basename(file, ".jsonl"), imported);
    add(decisions, imported.report.decisions);
    add(unmapped, imported.report.unmapped);
    reports.push({ ...imported.report, subagent: where.includes("subagents") });
  } catch (error) {
    failures.push({ source: file, error: error instanceof Error ? error.message : String(error) });
  }
}

const off = (report: Imported["report"]) =>
  (report.decisions["ObservationNotExpected"] ?? 0) + (report.decisions["ObservationUndelivered"] ?? 0);
const richest = (kind: string) =>
  reports
    .filter((report) => (report.unmapped[kind] ?? 0) > 0)
    .sort((a, b) => (b.unmapped[kind] ?? 0) - (a.unmapped[kind] ?? 0))
    .slice(0, 5)
    .map((report) => ({ source: report.source, [kind]: report.unmapped[kind], turns: report.turns }));

const summary = {
  root,
  files: files.length,
  imported: reports.length,
  subagentFiles: reports.filter((report) => report.subagent).length,
  seconds: Math.round((performance.now() - started) / 100) / 10,
  turns: reports.reduce((total, report) => total + report.turns, 0),
  facts: reports.reduce((total, report) => total + report.facts, 0),
  decisions: Object.fromEntries([...decisions].sort((a, b) => b[1] - a[1])),
  unmapped: Object.fromEntries([...unmapped].sort((a, b) => b[1] - a[1])),
  sessionsWithObservationsNotExpectedOrUndelivered: reports
    .filter((report) => off(report) > 0)
    .sort((a, b) => off(b) - off(a))
    .map((report) => ({ source: report.source, notExpectedOrUndelivered: off(report), turns: report.turns })),
  richestIn: Object.fromEntries(
    ["system/compact_boundary", "queue-operation", "user block: image", "user block: input_image"].map((kind) => [kind, richest(kind)]),
  ),
  failures,
};

writeFileSync(join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ ...summary, sessionsWithObservationsNotExpectedOrUndelivered: summary.sessionsWithObservationsNotExpectedOrUndelivered.length }, null, 2));
