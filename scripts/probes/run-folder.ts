/**
 * Where a probe's run writes what it saw: `logs/probes/<probe>/<run>/`, made when asked for. The
 * run's name has no `/` in it (a local model's name may), so it is one folder.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const runFolder = (probe: string, run: string): string => {
  const folder = join("logs/probes", probe, run.replaceAll("/", "_"));
  mkdirSync(folder, { recursive: true });
  return folder;
};
