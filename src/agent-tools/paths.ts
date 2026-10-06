/**
 * Tool inputs that are paths. A path input's schema carries the annotation `pathOf` (a file or a
 * folder), so that a wrapper finds a tool's path inputs from its schema (`inWorkspace`). A primitive
 * tool takes a path as it is given: an absolute path, or a path relative to the process's working
 * folder.
 */

import { Schema } from "effect";

/** What a path input names. */
export type PathOf = "file" | "folder";

declare module "effect/Schema" {
  namespace Annotations {
    interface Annotations {
      /** The input is a path to a file or a folder. */
      readonly pathOf?: PathOf | undefined;
    }
  }
}

/** A path to a file. */
export const FilePath = Schema.NonEmptyString.annotate({ description: "The file's path.", pathOf: "file" });

/** A path to a folder. */
export const FolderPath = Schema.NonEmptyString.annotate({ description: "The folder's path.", pathOf: "folder" });

/** Returns what the input `schema` is a path to, or undefined when the input is not a path. */
export const pathOf = (schema: Schema.Top): PathOf | undefined => Schema.resolveAnnotations(schema)?.pathOf;
