/** Observations as tests give them to a session, made with the branded constructors so that the compiler checks them. */

import { InputText, ModelName, ProviderName } from "../../src/agent-machine/names.ts";
import type { Observation } from "../../src/agent-machine/observation.ts";

/** The user's input `text`. */
export const userInput = (text: string): Observation => ({ _tag: "InputArrived", from: { _tag: "User" }, text: InputText.make(text) });

/** The user's change to `provider`'s `model`, with no settings. */
export const modelChange = (provider: string, model: string): Observation => ({ _tag: "ModelChangeArrived", provider: ProviderName.make(provider), model: ModelName.make(model) });
