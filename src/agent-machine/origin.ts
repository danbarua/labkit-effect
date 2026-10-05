/**
 * Where an observation came from: who or what in the world outside the core reported it. Every
 * recorded observation has one.
 */

import { Schema } from "effect";
import { HarnessPart, ProviderName, SessionId, TestName, ToolName, Via } from "./names.ts";

export const Origin = Schema.Union([
  /** A person, through the surface named (an editor, a protocol, a terminal). */
  Schema.TaggedStruct("User", { via: Via }),
  /** Another session: the one this was forked from, its parent, or a sub-agent. */
  Schema.TaggedStruct("Session", { session: SessionId }),
  /** A model provider: what it returned, or how a request to it failed. */
  Schema.TaggedStruct("Provider", { provider: ProviderName }),
  /** A tool: how a call to it ended. */
  Schema.TaggedStruct("Tool", { tool: ToolName }),
  /** A part of the harness around the core: the loop, a fallback chain, a context assembler. */
  Schema.TaggedStruct("Harness", { part: HarnessPart }),
  /** A test, or another run of the code such as a probe, by its name. */
  Schema.TaggedStruct("Test", { name: TestName }),
]);
export type Origin = typeof Origin.Type;
