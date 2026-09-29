/**
 * The model a session asks, from its facts: the one named by the latest change of model taken
 * (`ModelChangeTaken`), or the one it opened with. A session loaded from its record therefore asks
 * the model it had switched to.
 */

import { Layer } from "effect";
import { ModelProvider } from "./contracts.ts";
import { modelOf } from "./session-setup.ts";

export const ModelFromFacts = Layer.succeed(ModelProvider, { select: (facts) => modelOf(facts) });
