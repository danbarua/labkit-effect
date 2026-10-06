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

export type Customisation = (state: GameState, context: ModelContext) => ModelContext;

/**
 * Claude Haiku 4.5 as the adventurer. Haiku sometimes answers in text when an action is due, and
 * sometimes moves through an exit that is not open. So, while the engine offers tools (until an
 * action succeeds in the game turn):
 *
 * - each request requires a tool call (`toolChoice: "required"`);
 * - each offered tool is `constrained`, and `move` takes only the open exits, so Haiku cannot write a
 *   direction that the world rejects.
 *
 * The reply after an action is offered no tools, and is sent unchanged. The Anthropic API refuses a
 * required tool call while thinking is on, so Haiku plays with its thinking disabled (`index.ts`).
 */
export const haikuAdventurer: Customisation = (state, context) =>
  context.tools.length === 0
    ? context
    : {
        ...context,
        toolChoice: "required",
        tools: context.tools.map((tool) => ({
          ...tool,
          ...(tool.name === "move" ? { input: moveInputJson(Object.keys(view(state.world).exits)) } : {}),
          constrained: true,
        })),
      };

/** The adventurer's customisation, by `provider/model`. */
export const adventurerCustomisations: Readonly<Record<string, Customisation>> = {
  "anthropic/claude-haiku-4-5": haikuAdventurer,
};
