/** Tool schemas and an atomic runner: only the engine's current offer may mutate the world. */
import { Effect, Ref, Schema } from "effect";
import { FailureText, ToolName } from "../../agent-machine/names.ts";
import type { ToolOutcome } from "../../agent-machine/observation.ts";
import type { ToolSpec } from "../../agent-session/contracts.ts";
import { parseJson, receivedJson } from "../../agent-session/received.ts";
import type { ToolSource } from "../../agent-session/tool-sources.ts";
import { actionNames, applyAction, type Action, type ActionName, type World, view } from "./world.ts";

const empty = Schema.Record(Schema.String, Schema.Never);
const direction = Schema.Struct({ direction: Schema.Literals(["north", "south", "east", "west", "up", "down", "n", "s", "e", "w", "u", "d"]) });
const target = Schema.Struct({ target: Schema.String });
const ActionInput = Schema.Union([
  Schema.Struct({ tool: Schema.Literals(["look", "inventory"]), input: empty }),
  Schema.Struct({ tool: Schema.Literal("move"), input: direction }),
  Schema.Struct({ tool: Schema.Literals(["examine", "take", "drop", "open", "light"]), input: target }),
]);
const decode = Schema.decodeUnknownResult(ActionInput, { onExcessProperty: "error" });
const descriptions: Record<ActionName, string> = {
  look: "Look around your current location. Costs one game turn.",
  inventory: "Read your actual inventory. Costs one game turn.",
  examine: "Examine a visible object or one you carry, using its exact ID from the world snapshot.",
  move: "Travel through an open exit in the world snapshot. Darkness without light is fatal.",
  take: "Take one visible portable item using its exact ID. It moves into your inventory.",
  drop: "Drop one carried item using its exact ID. It stays in your current room.",
  open: "Open the mailbox or trapdoor when present and closed.",
  light: "Light the lantern in your inventory. It consumes fuel each game turn.",
};
const inputSchema = (name: ActionName) => {
  if (name === "move") return direction;
  return name === "look" || name === "inventory" ? empty : target;
};
export const catalog: ReadonlyArray<ToolSpec> = actionNames.map((name) => ({
  name: ToolName.make(name), description: descriptions[name],
  input: { ...Schema.toJsonSchemaDocument(inputSchema(name)).schema, additionalProperties: false } as Schema.Json,
  kind: "other", replay: "unsafe",
}));
/** The input schema of `move` as it is sent, taking only `directions`. With every direction, it is the catalog's. */
export const moveInputJson = (directions: ReadonlyArray<string>): Schema.Json => ({
  type: "object", properties: { direction: { type: "string", enum: directions } }, required: ["direction"], additionalProperties: false,
});

export interface GameState {
  readonly world: World;
  readonly offered: ReadonlyArray<ActionName>;
  readonly action: Action | undefined;
}
export const rejected = (problem: string): ToolOutcome => ({ _tag: "Failed", reason: { _tag: "InputRejected", problem: FailureText.make(problem) } });

export const worldTools = (state: Ref.Ref<GameState>): ToolSource => ({
  tools: catalog,
  run: (tool, input) => Ref.modify(state, (current): readonly [ToolOutcome, GameState] => {
    if (current.action !== undefined) return [rejected("You already used your one action this turn. Reply briefly without another tool call."), current];
    if (!current.offered.some((offered) => offered === tool)) return [rejected("The Game Engine did not offer that tool this turn."), current];
    const json = parseJson(input);
    if ("reason" in json) return [rejected(json.reason), current];
    const parsed = decode({ tool, input: json.value });
    if (parsed._tag === "Failure") return [rejected(parsed.failure.message), current];
    const changed = applyAction(current.world, parsed.success);
    if ("problem" in changed) return [rejected(changed.problem), current];
    return [
      { _tag: "Succeeded", output: receivedJson(view(changed.world)) },
      { ...current, world: changed.world, action: parsed.success },
    ];
  }),
});

/** The tools a request offers in `current`: the engine's offer until an action succeeds, then none. The session keeps the full supported catalog. */
export const offeredIn = (current: GameState): ReadonlyArray<ToolSpec> =>
  current.action === undefined ? catalog.filter((tool) => current.offered.some((name) => name === tool.name)) : [];
/** The actual request catalog changes each turn (`offeredIn`). */
export const offeredTools = (state: Ref.Ref<GameState>): Effect.Effect<ReadonlyArray<ToolSpec>> => Ref.get(state).pipe(Effect.map(offeredIn));
