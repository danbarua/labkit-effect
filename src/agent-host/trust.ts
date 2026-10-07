/**
 * Trusted folders: the folders whose own files the agent reads.
 *
 * A folder is trusted when it, or a folder that contains it, is named in `trusted-folders.json` in the
 * user's configuration folder (`~/.config/<name>/`, or `--config-dir`). The file is JSON, so that the
 * configuration's layers, which are that folder's YAML files, do not include it. Folders are compared
 * by their real paths, so a link to a trusted folder is trusted too.
 *
 * A trusted folder's files are read as the user's own:
 * - its `.env` files, which Bun loads when the agent's command starts there (`bin/labkit.ts`);
 * - its project configuration (`.<name>/*.yml`), when `--setting-sources` names it. Those layers may
 *   name extensions and MCP servers.
 *
 * An untrusted folder's files are not read. A folder becomes trusted only when the user says so; the
 * agent writes the file when it adds a folder (`trustFolder`), and the user may edit it.
 *
 * The file holds `{ "folders": [...] }`, a list of absolute paths. When there is no file, no folder is
 * trusted. A file that cannot be read or decoded fails, naming the file, so that a mistake in
 * it is seen rather than taken to trust no folder.
 */

import { isAbsolute, join, relative, sep } from "node:path";
import { Data, Effect, FileSystem, Schema } from "effect";

/** The name of the file, in the user's configuration folder, that names the trusted folders. */
export const trustFileName = "trusted-folders.json";

/** Returns the trust file of the user whose configuration folder is `userFolder`. */
export const trustFileOf = (userFolder: string): string => join(userFolder, trustFileName);

/** A trust file that cannot be used: the file, and the problem. */
export class TrustFileInvalid extends Data.TaggedError("TrustFileInvalid")<{
  readonly file: string;
  readonly problem: string;
}> {
  override get message(): string {
    return `${this.file}: ${this.problem}`;
  }
}

/** A project's files were named (`--setting-sources project` or `local`) in a folder that is not trusted. */
export class FolderNotTrusted extends Data.TaggedError("FolderNotTrusted")<{
  readonly folder: string;
}> {
  override get message(): string {
    return `${this.folder} is not trusted, so its settings are not read.`;
  }
}

const TrustFile = Schema.Struct({ folders: Schema.Array(Schema.String) });

/** Returns the folders that the trust file in `userFolder` names, as written there. */
export const trustedFoldersIn = (userFolder: string): Effect.Effect<ReadonlyArray<string>, TrustFileInvalid, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = trustFileOf(userFolder);
    const failed = (problem: string) => new TrustFileInvalid({ file, problem });
    if (!(yield* fs.exists(file).pipe(Effect.mapError((error) => failed(`Could not be read: ${error.message}`))))) return [];
    const text = yield* fs.readFileString(file).pipe(Effect.mapError((error) => failed(`Could not be read: ${error.message}`)));
    const parsed = yield* Effect.try({ try: (): unknown => JSON.parse(text), catch: (cause) => failed(`Not JSON: ${String(cause)}`) });
    const decoded = yield* Schema.decodeUnknownEffect(TrustFile)(parsed).pipe(Effect.mapError(() => failed('Expected { "folders": [...] }, a list of folders.')));
    const relativeOne = decoded.folders.find((folder) => !isAbsolute(folder));
    if (relativeOne !== undefined) return yield* failed(`Not an absolute path: ${relativeOne}`);
    return decoded.folders;
  });

/** Whether `folder` is `container` or inside it. Both are absolute paths. */
export const isWithin = (folder: string, container: string): boolean => {
  const path = relative(container, folder);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

/** Returns the real path of `path`, or `path` itself when it does not exist, since a folder that does not exist contains no other. */
const realOrGiven = (fs: FileSystem.FileSystem, path: string): Effect.Effect<string> =>
  fs.realPath(path).pipe(Effect.orElseSucceed(() => path));

/** Whether `folder` is trusted: it, or a folder that contains it, is named in the trust file in `userFolder`. */
export const isTrusted = (folder: string, userFolder: string): Effect.Effect<boolean, TrustFileInvalid, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const trusted = yield* Effect.forEach(yield* trustedFoldersIn(userFolder), (each) => realOrGiven(fs, each));
    const real = yield* realOrGiven(fs, folder);
    return trusted.some((each) => isWithin(real, each));
  });

/** Returns the trust file's text for `folders`: JSON, a folder to a line. */
const trustFileText = (folders: ReadonlyArray<string>): string => `${JSON.stringify({ folders }, null, 2)}\n`;

/**
 * Adds `folder`, by its real path, to the trust file in `userFolder`, creating the folder and the file
 * when there are none. The folders already named stay, in their order; a folder already named is not
 * added twice.
 */
export const trustFolder = (folder: string, userFolder: string): Effect.Effect<void, TrustFileInvalid, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = trustFileOf(userFolder);
    const named = yield* trustedFoldersIn(userFolder);
    const real = yield* fs.realPath(folder).pipe(Effect.mapError((error) => new TrustFileInvalid({ file, problem: `Could not find ${folder}: ${error.message}` })));
    if (named.includes(real)) return;
    yield* fs.makeDirectory(userFolder, { recursive: true }).pipe(
      Effect.andThen(fs.writeFileString(file, trustFileText([...named, real]))),
      Effect.mapError((error) => new TrustFileInvalid({ file, problem: `Could not be written: ${error.message}` })),
    );
  });
