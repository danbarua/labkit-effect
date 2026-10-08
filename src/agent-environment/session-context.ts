/**
 * The session that the harness runs, as the code inside it reads it: the session's id, its working
 * folder, the folders that its paths are judged against, and the environment variables of the
 * processes that the harness starts for it. Each host provides it once, where the
 * session's resources start (`agent-host/session-context.ts`), and everything inside the session
 * reads it: the policies, the tools, the recording of what a call changes, and the previews of a
 * write. The loop's requests run in fibers that inherit it, so a tool or a policy reads the context of
 * the session it runs in.
 *
 * The service has no default value: code that reads it and runs where no host provides it does not
 * compile.
 */

import { Context, type Effect } from "effect";
import type { SessionId } from "../agent-machine/names.ts";
import type { KnownEnvironment } from "./command-environment.ts";
import type { Folders } from "./command-units.ts";

/** The context of the session that the code runs in. */
export class SessionContext extends Context.Service<
  SessionContext,
  {
    readonly session: SessionId;
    /** The working folder, as an absolute path. */
    readonly working: string;
    /**
     * The folders that paths are judged against, all absolute: the working folder, the home folder,
     * and the additional folders. Read it at each use: the user can add a folder while the session
     * runs (the CLI's `/add-dir`).
     */
    readonly folders: Effect.Effect<Folders>;
    /**
     * The environment variables of each process that the harness starts for the session: a command
     * the model runs on the local disk (`run_command`), and an MCP server, whose own `env` is set over
     * them. The host's builder makes them once, when it makes the context, from the configuration's
     * `commandEnvironment`. A command that the editor runs in its terminal does not receive them.
     */
    readonly environment: KnownEnvironment;
  }
>()("agent-environment/SessionContext") {}
