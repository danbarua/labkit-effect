/**
 * The outcomes to record for the requests of a turn that were made and have no outcome, because the
 * process carrying them out ended, or because an imported record of another harness stops before
 * them:
 *
 * - the model request: `ModelResponded` with ending `Indeterminate`, because no response was
 *   observed;
 * - a call whose tool began to run: `ToolEnded` with `Indeterminate`, because its end was not
 *   observed;
 * - a call that had not begun (it was waiting for an answer): `ToolEnded` with `NotRun`;
 * - the turn-end review: `TurnEndReviewed`, with no input from the hooks.
 */

import type { CallId, ModelName, ProviderName, TurnId } from "./names.ts";
import type { ModelPart, Observation } from "./observation.ts";
import { MediaType, ReceivedText } from "./received.ts";
import type { World } from "./router.ts";

/**
 * Returns the outcomes to record for `turn`'s requests under way in `world`: those of its step, or
 * its turn-end review. `asked` is the model that the step's request went to, and `arrived` holds the
 * parts of its response that are known to have arrived.
 */
export function notObserved(
  world: World,
  turn: TurnId,
  asked: { readonly provider: ProviderName; readonly model: ModelName },
  arrived: ReadonlyArray<ModelPart>,
): ReadonlyArray<Observation> {
  const reviewing = world.turns.get(turn)?.state;
  if (reviewing?._tag === "AfterAnswer" || reviewing?._tag === "AfterAnswerSteered" || reviewing?._tag === "InterruptingReview")
    return [{ _tag: "TurnEndReviewed", turn }];
  const step = [...(world.steps.get(turn)?.values() ?? [])]
    .map((machine) => machine.state)
    .flatMap((state) => (state._tag === "AwaitingModel" || state._tag === "RunningTools" ? [state] : []))[0];
  if (step === undefined) return [];
  const began = (call: CallId): boolean => {
    const state = world.calls.get(call)?.state;
    return state?._tag === "Running" && state.began;
  };
  const callEnds = step.unsettled.map(
    (call): Observation => ({ _tag: "ToolEnded", call, outcome: { _tag: "Failed", reason: { _tag: began(call) ? "Indeterminate" : "NotRun" } } }),
  );
  return step._tag === "RunningTools"
    ? callEnds
    : [
        ...callEnds,
        {
          _tag: "ModelResponded",
          turn,
          provider: asked.provider,
          model: asked.model,
          parts: arrived,
          ending: { _tag: "Indeterminate" },
          metadata: { mediaType: MediaType.make("application/json"), body: { _tag: "Text", text: ReceivedText.make("{}") } },
        },
      ];
}
