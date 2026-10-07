/**
 * Scripted Zork players, which ask no model: each has a client that answers each request from a
 * script. The tests play games with them, and the scripted spectator (`zork-spectator/scripted.ts`)
 * shows one without a provider's key.
 */

import { Effect, Layer, Ref } from "effect";
import { CallId, FailureText, ModelName, ModelText, ProviderName, StopReason, ToolName } from "../../agent-machine/names.ts";
import type { ModelPart } from "../../agent-machine/observation.ts";
import { ModelClient, type ModelContext } from "../../agent-session/contracts.ts";
import { receivedJson } from "../../agent-session/received.ts";
import type { Player } from "./scenario.ts";
import type { Action, view } from "./world.ts";

/** Answers a request, given the request and its number in the session from 1; `undefined` fails the request. */
export type Reply = (context: ModelContext, request: number) => ReadonlyArray<ModelPart> | undefined;

export const say = (text: string): ReadonlyArray<ModelPart> => [{ _tag: "Text", text: ModelText.make(text) }];
export const call = (action: Action, id: string): ReadonlyArray<ModelPart> => [{
  _tag: "ToolCall", call: CallId.make(id), tool: ToolName.make(action.tool), input: receivedJson(action.input),
}];

/**
 * A player named `name` whose client answers each request with `reply`. `before`, when given, runs
 * before each answer, given the request's number, so that the answer can wait.
 */
export const scriptedPlayer = (name: string, reply: Reply, before?: (request: number) => Effect.Effect<void>): Player => ({
  target: { provider: ProviderName.make("scripted"), model: ModelName.make(name) },
  client: Layer.effect(ModelClient, Effect.gen(function* () {
    const requests = yield* Ref.make(0);
    return {
      respond: (target, context, turn) => Effect.gen(function* () {
        const request = yield* Ref.updateAndGet(requests, (count) => count + 1);
        if (before !== undefined) yield* before(request);
        const parts = reply(context, request);
        return parts === undefined ? {
          _tag: "ModelFailed" as const, turn, failure: FailureText.make("scripted outage"), error: receivedJson({}),
        } : {
          _tag: "ModelResponded" as const, turn, ...target, parts,
          stop: StopReason.make(parts.some((part) => part._tag === "ToolCall") ? "tool_use" : "end_turn"),
          ending: { _tag: "Complete" as const }, metadata: receivedJson({}),
        };
      }),
    };
  })),
});

/** The world view that the latest user message of `context` holds: the game's message for the request's turn. */
export const userWorld = (context: ModelContext): ReturnType<typeof view> => {
  const text = context.messages.filter((message) => message.role === "user" && message.parts.some((part) => part._tag === "Text")).at(-1)?.parts
    .flatMap((part) => part._tag === "Text" ? [part.text] : []).join("\n") ?? "";
  return (JSON.parse(text) as { world: ReturnType<typeof view> }).world;
};

/**
 * An engine's script: it narrates the world's own event (or `narrate`'s text) and offers the tools
 * that `select` picks, every available tool by default, and none after death. `fenced` wraps its JSON
 * in a code fence.
 */
export const engineScript = (select: (world: ReturnType<typeof view>) => ReadonlyArray<string> = (world) => world.availableTools, narrate?: (world: ReturnType<typeof view>) => string, fenced = false): Reply =>
  (context) => {
    const world = userWorld(context);
    const json = JSON.stringify({ narration: narrate?.(world) ?? world.event, tools: world.outcome === "Alive" ? select(world) : [] });
    return say(fenced ? `\`\`\`json\n${json}\n\`\`\`` : json);
  };

/** An adventurer's script: it calls the action `choose` picks for the world it is given, and answers "Done." after the action's result. */
export const adventurerScript = (choose: (world: ReturnType<typeof view>, context: ModelContext) => Action): Reply =>
  (context, request) => {
    if (context.messages.at(-1)?.parts.some((part) => part._tag === "ToolResult")) return say("Done.");
    return call(choose(userWorld(context), context), `action-${request}`);
  };
