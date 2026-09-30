/**
 * What a model request passes on while its response streams: each event as the provider sent it,
 * and each part of the response once it is complete. Nothing passed on is recorded; the response
 * is recorded whole when the stream ends. The loop sets `ModelStream` around each model request;
 * outside one, what is passed on goes nowhere.
 */

import { Context, Effect } from "effect";
import { Millis } from "../agent-machine/names.ts";
import type { ModelPart } from "../agent-machine/observation.ts";
import type { Received } from "../agent-machine/received.ts";

export type Streamed =
  /** One event of the stream, as received. */
  | { readonly _tag: "Chunk"; readonly chunk: Received }
  /** A part of the response, complete. */
  | { readonly _tag: "Part"; readonly part: ModelPart };

export const ModelStream = Context.Reference<(streamed: Streamed) => Effect.Effect<void>>("agent-session/ModelStream", {
  defaultValue: () => () => Effect.void,
});

/**
 * How often, at most, stream events are passed on to those following the session: they are held and
 * released in batches. A completed part, and the end of the response, release what is held at once.
 */
export const ModelStreamInterval = Context.Reference<Millis>("agent-session/ModelStreamInterval", {
  defaultValue: () => Millis.make(100),
});
