/** Scripted Zork players: a model client that answers each request from a script, and keeps every request it was sent. */

import { Effect, Layer } from "effect";
import { CallId, FailureText, ModelName, ModelText, ProviderName, StopReason, ToolName } from "../../src/agent-machine/names.ts";
import type { ModelPart } from "../../src/agent-machine/observation.ts";
import { ModelClient, type ModelContext } from "../../src/agent-session/contracts.ts";
import { receivedJson } from "../../src/agent-session/received.ts";
import type { Player } from "../../src/examples/zork/scenario.ts";
import type { Action, view } from "../../src/examples/zork/world.ts";

export const say = (text: string): ReadonlyArray<ModelPart> => [{ _tag: "Text", text: ModelText.make(text) }];
export const call = (action: Action, id: string): ReadonlyArray<ModelPart> => [{
  _tag: "ToolCall", call: CallId.make(id), tool: ToolName.make(action.tool), input: receivedJson(action.input),
}];
/**
 * A player whose client answers each request with `reply`, given the request and its number from 1;
 * `undefined` fails the request. `before`, when given, runs before each answer, given the request's
 * number, so that a test can hold a game at a request.
 */
export const model = (name: string, reply: (context: ModelContext, request: number) => ReadonlyArray<ModelPart> | undefined, before?: (request: number) => Effect.Effect<void>) => {
  const seen: Array<ModelContext> = [];
  const player: Player = {
    target: { provider: ProviderName.make("scripted"), model: ModelName.make(name) },
    client: Layer.succeed(ModelClient, {
      respond: (target, context, turn) => (before?.(seen.length + 1) ?? Effect.void).pipe(Effect.andThen(Effect.sync(() => {
        seen.push(context);
        const parts = reply(context, seen.length);
        return parts === undefined ? {
          _tag: "ModelFailed" as const, turn, failure: FailureText.make("scripted outage"), error: receivedJson({}),
        } : {
          _tag: "ModelResponded" as const, turn, ...target, parts,
          stop: StopReason.make(parts.some((part) => part._tag === "ToolCall") ? "tool_use" : "end_turn"),
          ending: { _tag: "Complete" as const }, metadata: receivedJson({}),
        };
      }))),
    }),
  };
  return { player, seen };
};
export const userWorld = (context: ModelContext): ReturnType<typeof view> => {
  const text = context.messages.filter((message) => message.role === "user" && message.parts.some((part) => part._tag === "Text")).at(-1)?.parts
    .flatMap((part) => part._tag === "Text" ? [part.text] : []).join("\n") ?? "";
  return (JSON.parse(text) as { world: ReturnType<typeof view> }).world;
};
export const scriptedEngine = (select: (world: ReturnType<typeof view>) => ReadonlyArray<string> = (world) => world.availableTools, narrate?: (world: ReturnType<typeof view>) => string, fenced = false, before?: (request: number) => Effect.Effect<void>) =>
  model("engine", (context) => {
    const world = userWorld(context);
    const json = JSON.stringify({ narration: narrate?.(world) ?? world.event, tools: world.outcome === "Alive" ? select(world) : [] });
    return say(fenced ? `\`\`\`json\n${json}\n\`\`\`` : json);
  }, before);
export const scriptedAdventurer = (choose: (world: ReturnType<typeof view>, context: ModelContext) => Action) => model("adventurer", (context, n) => {
  if (context.messages.at(-1)?.parts.some((part) => part._tag === "ToolResult")) return say("Done.");
  return call(choose(userWorld(context), context), `action-${n}`);
});
