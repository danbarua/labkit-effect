/**
 * Every folder named after the brand, resolved once at an entry point (the CLI, the ACP launcher,
 * zork) from the brand, the home folder and the launch's overrides (`brandFoldersFor`), and provided
 * as `BrandFolders`. Whatever reads or writes one of them reads it here, so an override moves it for
 * every reader. The service has no default: an entry point that does not provide it does not compile.
 *
 * | Folder | Default | Override |
 * | --- | --- | --- |
 * | `config` | `<home>/.config/<brand>` (`agent-config` `configFolders`) | `--config-dir` |
 * | `data` | `<home>/.local/share/<brand>` | `--data-dir` |
 * | `sessions` | `<data>/sessions/<version>` (`sessionsVersion`) | `--sessions-dir`, the ACP launcher's |
 * | `blobs` | `<data>/blobs` | |
 * | `logs` | `<data>/logs` | the ACP launcher's own log files: `<BRAND>_ACP_LOG_DIR` |
 * | `project` | `.<brand>`, the folder a project keeps the brand's files in: its settings, `/export`'s `exports/` | |
 *
 * `--data-dir` moves sessions, blobs and logs together; `--sessions-dir` moves the sessions alone.
 */

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Context, Effect, Layer } from "effect";
import { ConfigInvalid, configFolders } from "../agent-config/file.ts";
import { type Brand, folderOf, sessionsVersion } from "./brand.ts";

export interface BrandFolderPaths {
  /** The user's configuration folder. */
  readonly config: string;
  /** Where the agent keeps what it writes. */
  readonly data: string;
  /** Every host's sessions, each a folder named for its id. */
  readonly sessions: string;
  /** Every session's blobs (`agent-session/blobs.ts`). */
  readonly blobs: string;
  /** The log files. */
  readonly logs: string;
  /** The name of the folder a project keeps the brand's files in. */
  readonly project: string;
}

/** The brand's folders for this run. */
export class BrandFolders extends Context.Service<BrandFolders, BrandFolderPaths>()("agent-host/BrandFolders") {}

/** What moves the brand's folders: the home folder they are under, and the launch's overrides, each absolute. */
export interface FolderOverrides {
  /** The home folder; this process's (`HOME`) when left out. */
  readonly home?: string | undefined;
  /** `--config-dir`. */
  readonly configDir?: string | undefined;
  /** `--data-dir`. */
  readonly dataDir?: string | undefined;
  /** `--sessions-dir`. */
  readonly sessionsDir?: string | undefined;
}

/** Returns the brand's folders, as the module's table says. */
export const brandFoldersOf = (brand: Brand, overrides: FolderOverrides = {}): BrandFolderPaths => {
  const home = overrides.home ?? homedir();
  const data = overrides.dataDir ?? join(home, ".local", "share", brand.name);
  return {
    config: configFolders("", { name: brand.name, home, ...(overrides.configDir === undefined ? {} : { configDir: overrides.configDir }) }).user,
    data,
    sessions: overrides.sessionsDir ?? join(data, "sessions", sessionsVersion),
    blobs: join(data, "blobs"),
    logs: join(data, "logs"),
    project: folderOf(brand),
  };
};

/** Returns the brand's folders for a launch; a `--data-dir` that is not absolute is refused, as `--config-dir` is, since a launcher's working folder is whatever its parent chose. */
export const brandFoldersFor = (brand: Brand, overrides: FolderOverrides): Effect.Effect<BrandFolderPaths, ConfigInvalid> =>
  overrides.dataDir !== undefined && !isAbsolute(overrides.dataDir)
    ? Effect.fail(new ConfigInvalid({ file: "--data-dir", path: "", problem: `Not an absolute path: ${overrides.dataDir}` }))
    : Effect.succeed(brandFoldersOf(brand, overrides));

/** Provides the brand's folders. */
export const brandFoldersLayer = (folders: BrandFolderPaths): Layer.Layer<BrandFolders> => Layer.succeed(BrandFolders, folders);
