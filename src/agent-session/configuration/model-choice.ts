/**
 * The model a session asks, from its facts: the one named by the latest change of model taken
 * (`ModelChangeTaken`), or the one it opened with. A session loaded from its record therefore asks
 * the model it had switched to. The target carries what is known of the model (`KnownModels`), which
 * the adapters shape the request to.
 */

import { Effect, Layer } from "effect";
import { ModelProvider } from "../contracts.ts";
import { KnownModels, knownCapabilities } from "./well-known-models.ts";
import { modelOf } from "./session-setup.ts";

export const ModelFromFacts = Layer.effect(
  ModelProvider,
  Effect.gen(function* () {
    const sources = yield* KnownModels;
    return {
      select: (facts) =>
        Effect.gen(function* () {
          const target = yield* modelOf(facts);
          const capabilities = yield* knownCapabilities(target.provider, target.model).pipe(Effect.provideService(KnownModels, sources));
          return capabilities === undefined ? target : { ...target, capabilities };
        }),
    };
  }),
);
