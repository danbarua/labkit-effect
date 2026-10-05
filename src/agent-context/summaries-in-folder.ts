/**
 * Summaries kept as files in a folder: one folder for each session, one inside it for each kind
 * (the provider whose requests carry them), and one file for each summary, named for its number in
 * that kind, the time it was written, its summarizer and its window:
 *
 *   <folder>/<session>/<kind>/0001_2026-09-30T18-15-59.548Z_PlainTextFizzBuzzSummarizer_window-1.txt
 *
 * The file holds the summary as written: `.txt` for text, `.json` for JSON. Listing a kind's folder
 * in name order lists its summaries in the order written. A file that cannot be written or read is
 * a defect: the record of summaries cannot be kept.
 */

import { Array as Arr, DateTime, Effect, FileSystem, Layer, Order, Path } from "effect";
import { ProviderName, SessionId, WindowId } from "../agent-machine/names.ts";
import { asText, receivedJsonText, receivedText } from "../agent-session/received.ts";
import { Summaries } from "./compaction.ts";
import { SummarizerName, type WindowSummary } from "./forks.ts";

const extensions = new Map([
  ["text/plain", "txt"],
  ["application/json", "json"],
]);

/** A time as it goes in a file name: ISO 8601 with the colons as hyphens. */
const fileStamp = (time: DateTime.Utc): string => DateTime.formatIso(time).replaceAll(":", "-");
const isoFromFileStamp = (stamp: string): string => stamp.replace(/T(\d\d)-(\d\d)-(\d\d)/, "T$1:$2:$3");

/** Summaries by the time they were written, then by their number within their kind. */
const writtenOrder: Order.Order<readonly [number, WindowSummary]> = Order.combine(
  Order.mapInput(DateTime.Order, ([, summary]) => summary.writtenAt),
  Order.mapInput(Order.Number, ([number]) => number),
);

export const SummariesInFolder = (folder: string) =>
  Layer.effect(
    Summaries,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const read = (session: string, kind: string, name: string): Effect.Effect<readonly [number, WindowSummary]> =>
        Effect.gen(function* () {
          const match = /^(\d+)_([^_]+)_([^_]+)_(.+)\.(txt|json)$/.exec(name);
          if (match === null) return yield* Effect.die(new Error(`${name} is not the name of a summary`));
          const [, number, stamp, writtenBy, window, extension] = match;
          const text = yield* fs.readFileString(path.join(folder, session, kind, name));
          const writtenAt = DateTime.makeUnsafe(isoFromFileStamp(stamp ?? ""));
          return [
            Number(number),
            {
              session: SessionId.make(session),
              window: WindowId.make(window ?? ""),
              kind: ProviderName.make(kind),
              writtenBy: SummarizerName.make(writtenBy ?? ""),
              writtenAt,
              summary: extension === "json" ? receivedJsonText(text) : receivedText(text),
            },
          ] as const;
        }).pipe(Effect.orDie);

      const recorded = Effect.gen(function* () {
        if (!(yield* fs.exists(folder))) return [];
        const sessions = yield* fs.readDirectory(folder);
        const all = yield* Effect.forEach(sessions, (session) =>
          Effect.gen(function* () {
            const kinds = yield* fs.readDirectory(path.join(folder, session));
            return (yield* Effect.forEach(kinds, (kind) =>
              fs.readDirectory(path.join(folder, session, kind)).pipe(
                Effect.flatMap((names) => Effect.forEach(Arr.sort(names, Order.String), (name) => read(session, kind, name))),
              ),
            )).flat();
          }),
        );
        // In the order written: by time, then by number within a kind.
        return Arr.sort(all.flat(), writtenOrder).map(([, summary]) => summary);
      }).pipe(Effect.orDie);

      const record = (summary: WindowSummary) =>
        Effect.gen(function* () {
          const extension = extensions.get(summary.summary.mediaType);
          if (extension === undefined) return yield* Effect.die(new Error(`A summary of ${summary.summary.mediaType} cannot be kept as a file`));
          const directory = path.join(folder, summary.session, summary.kind);
          yield* fs.makeDirectory(directory, { recursive: true });
          const number = (yield* fs.readDirectory(directory)).length + 1;
          const name = `${String(number).padStart(4, "0")}_${fileStamp(summary.writtenAt)}_${summary.writtenBy}_${summary.window}.${extension}`;
          yield* fs.writeFileString(path.join(directory, name), asText(summary.summary));
        }).pipe(Effect.orDie);

      return { record, recorded };
    }),
  );
