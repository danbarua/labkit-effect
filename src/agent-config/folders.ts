/**
 * The folders that configuration files are read from, and the error that refuses a configuration.
 * This module imports nothing else from the agent but the brand (`agent-host/brand.ts`), because
 * `agent-host/brand-folders.ts` imports it, and so does every program that imports the brand's
 * folders without the rest of the agent (labkit-web's bridge).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { Data } from "effect";
import { defaultBrand } from "../agent-host/brand.ts";

/** The name of the configuration's folders unless a caller gives another: the default brand's (`agent-host/brand.ts`). */
export const configName = defaultBrand.name;

/** Where configuration files are read from: the user's folder (`configDir`, else `~/.config/<name>`), and the project's (`<project>/.<name>`). */
export interface FolderOptions {
  readonly name?: string;
  /** The home whose `.config/<name>` is the user's folder; this process's when left out. */
  readonly home?: string;
  /** The user's folder, in place of `<home>/.config/<name>`. */
  readonly configDir?: string;
}

/** Returns the folders that configuration files are read from: the user's, and the project's. */
export const configFolders = (project: string, options: FolderOptions = {}): { readonly user: string; readonly project: string } => {
  const name = options.name ?? configName;
  return { user: options.configDir ?? join(options.home ?? homedir(), ".config", name), project: join(project, `.${name}`) };
};

/** A configuration that cannot be used: the layer, the path in it, and the problem. */
export class ConfigInvalid extends Data.TaggedError("ConfigInvalid")<{
  readonly file: string;
  readonly path: string;
  readonly problem: string;
}> {
  override get message(): string {
    return `${this.file}: ${this.path === "" ? "" : `${this.path}: `}${this.problem}`;
  }
}
