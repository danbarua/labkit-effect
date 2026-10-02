/**
 * The agent in `negotiation-test-agent.ts`, versions 1 and 2, run by `agent.runStdio` on this
 * process's stdin and stdout, as an editor launches an ACP agent. It runs until stdin closes, then
 * exits 0.
 */

import { BunRuntime, BunStdio } from "@effect/platform-bun";
import { Effect } from "effect";
import * as Agent from "./agent.ts";
import { info, v1, v2 } from "./negotiation-test-agent.ts";

Agent.runStdio({ info, implementations: [v1(), v2()] }).pipe(Effect.provide(BunStdio.layer), BunRuntime.runMain);
