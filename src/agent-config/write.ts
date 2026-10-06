/**
 * Writes one setting into a configuration folder (the user's, `file.ts`), keeping each file's
 * comments and layout. The folder's files are read in the order of their names, the last write
 * winning, so the setting is written where it decides the folder's value:
 *
 * - into the last of the folder's files that sets it;
 * - when no file sets it, into `fallback`, a file of the folder that is created when it does not exist.
 *
 * A file that does not parse is not written; the error names it.
 */

import { join } from "node:path";
import { Array as Arr, Data, Effect, FileSystem, Option } from "effect";
import { Document, parseDocument } from "yaml";
import { filesIn } from "./file.ts";

/** A setting that could not be written: the file, and why. */
export class SettingNotWritten extends Data.TaggedError("SettingNotWritten")<{
  readonly file: string;
  readonly problem: string;
}> {
  override get message(): string {
    return `${this.file}: ${this.problem}`;
  }
}

/** Returns the file in `folder` that `path` was written to with `value`. */
export const writeSetting = (folder: string, path: ReadonlyArray<string>, value: string, fallback: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const failed = (file: string) => (cause: unknown) => new SettingNotWritten({ file, problem: String(cause) });
    const parsed = (file: string) =>
      Effect.gen(function* () {
        const document = parseDocument(yield* fs.readFileString(file).pipe(Effect.mapError(failed(file))));
        const problem = document.errors[0];
        if (problem !== undefined) return yield* new SettingNotWritten({ file, problem: `Not YAML: ${problem.message}` });
        return document;
      });
    const files = yield* filesIn(folder).pipe(Effect.mapError((error) => new SettingNotWritten({ file: folder, problem: error.problem })));
    const documents = yield* Effect.forEach(files, (file) => Effect.map(parsed(file), (document) => ({ file, document })));
    const setting = Arr.findLast(documents, ({ document }) => document.hasIn(path)).pipe(Option.getOrUndefined);
    const file = setting?.file ?? join(folder, fallback);
    const document = setting?.document ?? ((yield* fs.exists(file).pipe(Effect.mapError(failed(file)))) ? yield* parsed(file) : new Document({}));
    document.setIn(path, value);
    yield* fs.makeDirectory(folder, { recursive: true }).pipe(Effect.mapError(failed(folder)));
    // A flow list stays as the folder's files write it: `[low, high]`, not `[ low, high ]`.
    yield* fs.writeFileString(file, document.toString({ flowCollectionPadding: false })).pipe(Effect.mapError(failed(file)));
    return file;
  });
