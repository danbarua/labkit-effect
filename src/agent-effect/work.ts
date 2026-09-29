/**
 * What the loop is working on while it carries out a request: the session, the turn, and for a tool
 * run the call and the tool. The loop sets it around each request; any service the request calls
 * reads it with `yield* CurrentWork`, so none of them is passed these as arguments. Outside a
 * request it is empty.
 */

import { Context } from "effect";
import type { CallId, SessionId, ToolName, TurnId } from "../agent-core/names.ts";

export interface Work {
  readonly session?: SessionId;
  readonly turn?: TurnId;
  readonly call?: CallId;
  readonly tool?: ToolName;
}

export const CurrentWork = Context.Reference<Work>("agent-effect/CurrentWork", { defaultValue: () => ({}) });
