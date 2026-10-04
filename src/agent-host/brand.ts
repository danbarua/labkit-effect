/**
 * The name the agent goes by. A package that ships it gives it its own (labkit's bin:
 * `runCli({ name: "labkit" })`), and everything named after it follows:
 *
 * - its configuration's folders: `~/.config/<name>/`, and `<project>/.<name>/`;
 * - where a launcher keeps sessions and logs: `~/.<name>/sessions`, `~/.<name>/logs`;
 * - where `/export` writes: `<folder>/.<name>/exports`;
 * - its environment variables' prefix: `<NAME>_` (`<NAME>_ACP_` for the ACP launcher's);
 * - what it calls itself to an ACP client (`agentInfo`) and to an MCP server (`clientInfo`).
 *
 * The brand is the one a program gives (`Brand`, set by its entry point); else the one the meta
 * variable names (`<DEFAULT>_BRAND`, with the default brand's prefix, so that an unbranded build runs
 * as another without code); else the default.
 */

import { Context } from "effect";

export interface Brand {
  /** As it appears in folder names, and, in capitals, in environment variables' names. */
  readonly name: string;
  readonly version: string;
}

/** The brand an unbranded build goes by. */
export const defaultBrand: Brand = { name: "labkit", version: "0.1.0" };

/** The prefix of a brand's environment variables: its name in capitals, every other character `_`, then `_`. */
export const envPrefixOf = (brand: Brand): string => `${brand.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_`;

/** The meta variable that names the brand when a program gives none: the default brand's prefix, then `BRAND`. */
export const brandVariable = `${envPrefixOf(defaultBrand)}BRAND`;

/** The brand `env` names (`brandVariable`), else the default. */
export const brandFrom = (env: Readonly<Record<string, string | undefined>>): Brand => {
  const named = env[brandVariable];
  return named === undefined || named.trim() === "" ? defaultBrand : { name: named.trim(), version: defaultBrand.version };
};

/** The brand a program runs as. */
export const Brand = Context.Reference<Brand>("agent-host/Brand", { defaultValue: () => brandFrom(process.env) });

/** The folder a brand keeps things in, in a home or a project: `.<name>`. */
export const folderOf = (brand: Brand): string => `.${brand.name}`;
