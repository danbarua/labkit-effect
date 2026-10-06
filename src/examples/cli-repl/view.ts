/**
 * What the REPL shows of a session, as the user changes it while the REPL runs: whether it shows the
 * model's thinking. It starts as the configuration says (`view.thinking`). Option+T toggles it until
 * the REPL exits; `/settings view.thinking=on|off` sets it and writes it to the user's configuration.
 * It changes nothing in a request.
 */

import { Effect, Option, Ref, type Terminal } from "effect";

export interface View {
  readonly thinking: Ref.Ref<"on" | "off">;
}

/** The view that `thinking` starts. */
export const viewOf = (thinking: "on" | "off") => Effect.map(Ref.make(thinking), (made): View => ({ thinking: made }));

/** Shows the thinking if it is hidden, and hides it if it is shown; returns what the REPL then says of it. */
export const toggleThinking = (view: View) =>
  Ref.modify(view.thinking, (now) => (now === "on" ? (["thinking hidden (Option+T shows it)", "off"] as const) : (["thinking shown (Option+T hides it)", "on"] as const)));

/**
 * Option+T, as the terminal sends it: Escape then `t` where Option is set to send Meta, or `†`, which
 * macOS sends for Option+T otherwise.
 */
export const optionT = ["\x1bt", "†"];

/** Whether a key that the terminal read is Option+T. */
export const isOptionT = (input: Terminal.UserInput): boolean => (input.key.name === "t" && input.key.meta) || Option.getOrUndefined(input.input) === "†";
