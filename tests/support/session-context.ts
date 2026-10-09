/**
 * A session's context (`SessionContext`) for a test. `runTest` provides `TestSessionContext()` to
 * every test's program, so code that reads the context runs in a test without a host; a test that
 * runs a host, or that judges paths against folders of its own, provides its own context inside it,
 * which takes the place of this one there.
 */

import { Effect, Layer } from "effect";
import type { KnownEnvironment } from "../../src/agent-environment/command-environment.ts";
import { WordText } from "../../src/agent-environment/command-segments.ts";
import type { Folders } from "../../src/agent-environment/command-units.ts";
import { SessionContext } from "../../src/agent-environment/session-context.ts";
import { defaultCommandEnvironment, environmentWith } from "../../src/agent-host/session-context.ts";
import { SessionId } from "../../src/agent-machine/names.ts";
import { makeSessionProcesses } from "../../src/agent-process/session-processes.ts";

/** The id of the session in the context that `runTest` provides. */
export const testSessionId = SessionId.make("test-session");

/**
 * A session's context: the session `session` (`testSessionId` when left out), working in `working`
 * (`/work/project` when left out), whose folders are `folders` (the working folder and the home
 * folder `/home/test` when left out), and whose environment is `environment`. `folders` may be an
 * effect, read at each use. The folders have no sources, so `foldersFrom` returns all of them,
 * whatever sources its reader includes. When `environment` is left out, the environment is the one a
 * host's builder makes by default (`defaultCommandEnvironment`): this process's environment when the
 * context is made, without its credential variables. The registry of the process groups that its
 * commands start is empty.
 */
export const testSessionContext = (
  options: {
    readonly session?: string;
    readonly working?: string;
    readonly folders?: Folders | Effect.Effect<Folders>;
    readonly environment?: KnownEnvironment;
  } = {},
): Effect.Effect<SessionContext["Service"]> =>
  Effect.gen(function* () {
    const working = options.working ?? "/work/project";
    const given = options.folders ?? { working: WordText.make(working), home: WordText.make("/home/test") };
    const folders = Effect.isEffect(given) ? given : Effect.succeed(given);
    const session = options.session === undefined ? testSessionId : SessionId.make(options.session);
    return {
      session,
      working,
      folders,
      foldersFrom: () => folders,
      environment: options.environment ?? environmentWith(defaultCommandEnvironment),
      processes: yield* makeSessionProcesses(session),
    };
  });

/** Provides `testSessionContext(options)`. */
export const TestSessionContext = (options: Parameters<typeof testSessionContext>[0] = {}): Layer.Layer<SessionContext> =>
  Layer.effect(SessionContext, testSessionContext(options));
