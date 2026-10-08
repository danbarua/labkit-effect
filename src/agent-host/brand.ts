/**
 * The name the agent goes by. A package that ships the agent passes its own brand (labkit's bin:
 * `runCli({ name: "labkit" })`), and everything named after the brand follows:
 *
 * - the configuration folders: `~/.config/<name>/` and `<project>/.<name>/`;
 * - where the agent keeps what it writes (`dataFolderOf`): `~/.local/share/<name>/`, with the
 *   sessions of every host in `sessions/<version>/`, the bytes their facts refer to (images, files,
 *   stored outputs) in `blobs/`, and the log files in `logs/`;
 * - where `/export` writes: `<folder>/.<name>/exports`;
 * - the environment variable prefix: `<NAME>_` (`<NAME>_ACP_` for the ACP launcher's);
 * - the name it gives an ACP client (`agentInfo`) and an MCP server (`clientInfo`).
 *
 * The brand is the one a program passes (`Brand`, set by its entry point); otherwise the one that the
 * meta variable names (`<DEFAULT>_BRAND`, with the default brand's prefix, so that an unbranded
 * build can run as another brand without code changes); otherwise the default.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { Context } from "effect";

export interface Brand {
  /** The name as it appears in folder names, and, in capitals, in environment variable names. */
  readonly name: string;
  readonly version: string;
}

/** The brand an unbranded build goes by. */
export const defaultBrand: Brand = { name: "labkit", version: "0.1.0" };

/** Returns the prefix of a brand's environment variables: its name in capitals, with every other character replaced by `_`, then `_`. */
export const envPrefixOf = (brand: Brand): string => `${brand.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_`;

/** The meta variable that names the brand when a program gives none: the default brand's prefix, then `BRAND`. */
export const brandVariable = `${envPrefixOf(defaultBrand)}BRAND`;

/** Returns the brand that `env` names (`brandVariable`), or the default brand. */
export const brandFrom = (env: Readonly<Record<string, string | undefined>>): Brand => {
  const named = env[brandVariable];
  return named === undefined || named.trim() === "" ? defaultBrand : { name: named.trim(), version: defaultBrand.version };
};

/** The brand a program runs as. */
export const Brand = Context.Reference<Brand>("agent-host/Brand", { defaultValue: () => brandFrom(process.env) });

/** Returns the folder that a brand uses in a home or a project: `.<name>`. */
export const folderOf = (brand: Brand): string => `.${brand.name}`;

/**
 * The version of the sessions' shape: their facts and their folders. A change to the shape moves
 * sessions to the next version's folder, so that no session store has to read an older shape. The
 * sessions in an older version's folder are left where they are.
 */
export const sessionsVersion = "v0.1.0";

/** The folder where the agent keeps what it writes: `<home>/.local/share/<name>/`, the home folder read from `HOME` when this is called. */
export const dataFolderOf = (brand: Brand, home: string = homedir()): string => join(home, ".local", "share", brand.name);

/** The folder of every host's sessions, for the current `sessionsVersion`. */
export const sessionsFolderOf = (brand: Brand, home: string = homedir()): string => join(dataFolderOf(brand, home), "sessions", sessionsVersion);

/**
 * The folder of every host's blobs (`agent-session/blobs.ts`), each a file named for its id. An id is
 * the SHA-256 of the bytes, so one folder serves every session, and a session that another host
 * continues finds its blobs.
 */
export const blobsFolderOf = (brand: Brand, home: string = homedir()): string => join(dataFolderOf(brand, home), "blobs");

/** The folder of the agent's log files. */
export const logsFolderOf = (brand: Brand, home: string = homedir()): string => join(dataFolderOf(brand, home), "logs");
