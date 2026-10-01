/** A mistake in how the CLI was called, said to the user in words; the process exits with a failure. */

import { CliError } from "effect/cli";

export const invalid = (message: string) => new CliError.UserError({ cause: message, userMessage: message });
