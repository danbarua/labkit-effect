/**
 * What the REPL shows, which the user can change while it runs: whether it shows the model's
 * thinking. It starts from the configuration (`cli.view.thinking`). Option+T toggles it until the
 * REPL exits; `/settings view.thinking=on|off` sets it and saves it. It does not change requests.
 */

import { Effect, Option, Ref, type Terminal } from "effect";

export interface View {
  readonly thinking: Ref.Ref<"on" | "off">;
}

/** Returns a view that starts with `thinking`. */
export const viewOf = (thinking: "on" | "off") => Effect.map(Ref.make(thinking), (made): View => ({ thinking: made }));

/** Toggles whether thinking is shown, and returns the note the REPL prints. */
export const toggleThinking = (view: View) =>
  Ref.modify(view.thinking, (now) => (now === "on" ? (["thinking hidden (Option+T shows it)", "off"] as const) : (["thinking shown (Option+T hides it)", "on"] as const)));

/** Option+T as terminals send it: Escape then `t` when Option sends Meta, otherwise `†` on macOS. */
export const optionT = ["\x1bt", "†"];

/** Whether a key the terminal read is Option+T. */
export const isOptionT = (input: Terminal.UserInput): boolean => (input.key.name === "t" && input.key.meta) || Option.getOrUndefined(input.input) === "†";
