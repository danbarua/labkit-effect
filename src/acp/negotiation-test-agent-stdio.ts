/**
 * The agent in `negotiation-test-agent.ts`, versions 1 and 2, served by `agent.layerStdio` on this
 * process's stdin and stdout, as an editor launches an ACP agent. The layer lives until the process
 * is stopped.
 */

import { BunStdio } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import * as Agent from "./agent.ts";
import { info, v1, v2 } from "./negotiation-test-agent.ts";

Effect.runFork(Layer.launch(Agent.layerStdio({ info, implementations: [v1(), v2()] })).pipe(Effect.provide(BunStdio.layer)));
