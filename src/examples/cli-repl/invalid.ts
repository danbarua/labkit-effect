/**
 * A mistake, said to the user as an `ERROR:` line and, for each thing the user can do about it, a
 * `HINT:` line. At the command line the process prints it and exits with a failure; in the REPL, the
 * REPL prints it and goes on.
 */

import { CliError, CliOutput } from "effect/cli";

export const invalid = (message: string, ...hints: ReadonlyArray<string>) =>
  new CliError.UserError({ cause: message, userMessage: [`ERROR: ${message}`, ...hints.map((hint) => `HINT: ${hint}`)].join("\n") });

const effectFormatter = CliOutput.defaultFormatter();

/**
 * Prints a mistake (`invalid`) as it is said, and the mistakes effect/cli finds in the command line (a
 * flag it does not know, a value a flag does not take) as an `ERROR:` line each; any other error as
 * effect/cli prints it. effect/cli prints the help before the mistakes it finds.
 */
export const saidFormatter: CliOutput.Formatter = {
  formatHelpDoc: effectFormatter.formatHelpDoc,
  formatCliError: effectFormatter.formatCliError,
  formatVersion: effectFormatter.formatVersion,
  formatErrors: (errors) => errors.map((error) => `ERROR: ${error.message}`).join("\n"),
  formatError: (error) => (error._tag === "UserError" && error.userMessage !== undefined ? error.userMessage : effectFormatter.formatError(error)),
};
