/**
 * The capture server: `bun run observability:captures`.
 *
 * Browsers refuse to open a `file://` link from an `http://` page such as Grafana's, so this server
 * serves the capture files (`src/instrumentation/http-captures.ts`) over HTTP, and Grafana links a
 * capture's log line to it (`datasources.ts`).
 *
 * - It listens on the loopback interface only, on `captureServerPort` (`config.ts`).
 * - It serves `GET /http-captures/<capture_id>.json`, read-only, from the capture folder of the
 *   brand's logs folder (`~/.local/share/labkit/logs/http-captures/`), as `application/json`.
 * - It serves nothing else: a name that is not a capture id is refused (404) before any file is
 *   opened, so no request can reach a file outside the folder; a missing file is 404, and a method
 *   other than GET is 405.
 *
 * While it runs, it reports the disk use of the logs folder and of its capture folder as OTLP gauges
 * (service `labkit-captures`, to `OTEL_EXPORTER_OTLP_ENDPOINT`), once at start and then every
 * `reportEvery`, since capture files are never deleted:
 * - `agent.logs.folder_bytes`: the size in bytes of the folder's files, its subfolders' included;
 * - `agent.logs.folder_files`: their number;
 * each with the attributes `folder` (`logs` or `http-captures`) and `path` (the folder).
 */

import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { BunRuntime } from "@effect/platform-bun";
import { Duration, Effect, Metric, Schedule } from "effect";
import { brandFrom } from "../../src/agent-host/brand.ts";
import { brandFoldersOf } from "../../src/agent-host/brand-folders.ts";
import { capturesFolderIn } from "../../src/instrumentation/http-captures.ts";
import { OtlpSpansAndMetrics } from "../../src/instrumentation/telemetry.ts";
import { captureIdPattern, captureServerPort, captureUrlOf } from "./config.ts";

const logsFolder = brandFoldersOf(brandFrom(process.env)).logs;
const capturesFolder = capturesFolderIn(logsFolder);

/** How often the disk use is reported. */
const reportEvery = Duration.seconds(60);

const captureRoute = new RegExp(`^/http-captures/(${captureIdPattern})\\.json$`);

/** The `code` of a Node error (`ENOENT`, `EADDRINUSE`, …); undefined for any other thrown value. */
const errorCode = (error: unknown): unknown => (typeof error === "object" && error !== null && "code" in error ? error.code : undefined);

const refused = (status: number, text: string, headers: Record<string, string> = {}) => new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...headers } });

const serveCapture = async (request: Request): Promise<Response> => {
  // The raw pathname: a request whose name is percent-encoded or holds a separator does not match.
  const captureId = captureRoute.exec(new URL(request.url).pathname)?.[1];
  if (captureId === undefined) return refused(404, "Not found.");
  if (request.method !== "GET") return refused(405, "Method not allowed.", { Allow: "GET" });
  const file = Bun.file(join(capturesFolder, `${captureId}.json`));
  if (!(await file.exists())) return refused(404, "Not found.");
  return new Response(file, { headers: { "Content-Type": "application/json" } });
};

const startServer = () => {
  try {
    return Bun.serve({ hostname: "127.0.0.1", port: captureServerPort, fetch: serveCapture });
  } catch (error) {
    if (errorCode(error) === "EADDRINUSE") {
      console.error(`ERROR: Port ${captureServerPort} is in use.`);
      console.error(`HINT: Stop the program that listens on it (lsof -iTCP:${captureServerPort} -sTCP:LISTEN), which may be another capture server.`);
    } else console.error(`ERROR: The capture server did not start: ${String(error)}.`);
    return process.exit(1);
  }
};

// Their OTLP units (`unit`, which Effect's exporter reads from the attributes): without one, the unit is
// "1", and Prometheus names a gauge of unit "1" `…_ratio`.
const folderBytes = Metric.gauge("agent.logs.folder_bytes", {
  description: "The size in bytes of a labkit logs folder's files, its subfolders' included, by folder (logs, http-captures) and path.",
  attributes: { unit: "By" },
});
const folderFiles = Metric.gauge("agent.logs.folder_files", {
  description: "The number of files in a labkit logs folder, its subfolders' included, by folder (logs, http-captures) and path.",
  attributes: { unit: "{file}" },
});

interface DiskUse {
  readonly bytes: number;
  readonly files: number;
}

/** The size and number of the files in `path` and its subfolders. A folder that does not exist holds none. */
const diskUseOf = async (path: string): Promise<DiskUse> => {
  const entries = await readdir(path, { recursive: true, withFileTypes: true }).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  });
  let bytes = 0;
  let files = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    // A file deleted between the listing and its stat is no longer there to count.
    const stats = await lstat(join(entry.parentPath, entry.name)).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    });
    if (stats === undefined) continue;
    bytes += stats.size;
    files += 1;
  }
  return { bytes, files };
};

const reportFolder = (folder: "logs" | "http-captures", path: string) =>
  Effect.tryPromise(() => diskUseOf(path)).pipe(
    Effect.flatMap((use) =>
      Effect.all([Metric.update(Metric.withAttributes(folderBytes, { folder, path }), use.bytes), Metric.update(Metric.withAttributes(folderFiles, { folder, path }), use.files)], { discard: true }),
    ),
    // The gauges keep their last reported values; the next report measures again.
    Effect.catch((error) => Effect.sync(() => console.error(`ERROR: The disk use of ${path} could not be measured: ${String(error.cause)}.`))),
  );

const reportDiskUse = Effect.all([reportFolder("logs", logsFolder), reportFolder("http-captures", capturesFolder)], { discard: true });

const server = startServer();
console.log(`Serving the captures in ${capturesFolder} at ${captureUrlOf("<capture_id>")}`);

Effect.gen(function* () {
  yield* Effect.addFinalizer(() => Effect.promise(() => server.stop(true)));
  yield* reportDiskUse.pipe(Effect.repeat(Schedule.spaced(reportEvery)));
}).pipe(Effect.scoped, Effect.provide(OtlpSpansAndMetrics("labkit-captures")), BunRuntime.runMain);
