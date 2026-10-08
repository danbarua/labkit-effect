/**
 * How the adventurer's requests are changed for its model. The game makes each request the same for
 * every model (the tools the engine offers); a customisation is given the game's state and that
 * request, and returns the request to send. Each request is recorded as it was sent. `index.ts` gives
 * the adventurer the customisation for its model (`adventurerCustomisations`); a model that has none
 * is sent the requests as the game makes them.
 */
import type { ModelContext } from "../../agent-session/contracts.ts";
import { moveInputJson, type GameState } from "./tools.ts";
import { view } from "./world.ts";

/** One request to the adventurer, as the game makes it. */
export interface AdventurerRequest {
  readonly state: GameState;
  /** The request: it offers the engine's tools until an action succeeds in the game turn, then none. */
  readonly context: ModelContext;
  /**
   * Whether the request may be the game turn's last without an action: the turn-end holds are used
   * up, so an answer in text ends the turn, or it is the last request that the turn's limit allows.
   */
  readonly lastChance: boolean;
}

export type Customisation = (request: AdventurerRequest) => ModelContext;

/**
 * Claude Haiku as the adventurer: Haiku 4.5, and Haiku 5.5, the default. Haiku 4.5 sometimes answers
 * in text when an action is due, and sometimes moves through an exit that is not open. So, while the
 * engine offers tools:
 *
 * - each offered tool is `constrained`, and `move` takes only the open exits, so Haiku cannot write a
 *   direction that the world rejects;
 * - the request that is the game turn's last chance requires a tool call (`toolChoice: "required"`).
 *   The Anthropic adapter sends it with thinking disabled, as the API requires.
 *
 * The reply after an action is offered no tools, and is sent unchanged.
 */
export const haikuAdventurer: Customisation = ({ state, context, lastChance }) =>
  context.tools.length === 0
    ? context
    : {
        ...context,
        ...(lastChance ? { toolChoice: "required" as const } : {}),
        tools: context.tools.map((tool) => ({
          ...tool,
          ...(tool.name === "move" ? { input: moveInputJson(Object.keys(view(state.world).exits)) } : {}),
          constrained: true,
        })),
      };

/** The adventurer's customisation, by `provider/model`. */
export const adventurerCustomisations: Readonly<Record<string, Customisation>> = {
  "anthropic/claude-haiku-4-5": haikuAdventurer,
  "anthropic/claude-haiku-5-5": haikuAdventurer,
};
