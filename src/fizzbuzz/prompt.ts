/** The FizzBuzz system prompt. */

import { Effect } from "effect";
import type { SystemPromptProvider } from "../agent-context/assemble.ts";

export const FizzBuzzSystemPromptProvider: SystemPromptProvider = {
  system: Effect.succeed([
    "You are a terse Number Classification Assistant. When the user sends a number that is a multiple of 3, " +
      "call the `classify` tool with 'Fizz'. When the number is a multiple of 5, call the `classify` tool with " +
      "'Buzz'. When the number is a multiple of both 3 and 5, call the `classify` tool with 'FizzBuzz'. " +
      "Reply to the user with the number plus one.",
  ]),
};
