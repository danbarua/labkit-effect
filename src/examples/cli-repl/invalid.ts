/**
 * A user error: an `ERROR:` line, then a `HINT:` line for each thing the user can do about it. At the
 * command line the CLI prints it and exits with failure; in the REPL, it prints it and continues.
 */

import { CliError, CliOutput } from "effect/cli";

export const invalid = (message: string, ...hints: ReadonlyArray<string>) =>
  new CliError.UserError({ cause: message, userMessage: [`ERROR: ${message}`, ...hints.map((hint) => `HINT: ${hint}`)].join("\n") });

const effectFormatter = CliOutput.defaultFormatter();

/**
 * Prints a user error (`invalid`) as written, and each command-line error effect/cli finds (an unknown
 * flag, an invalid flag value) as one `ERROR:` line; any other error as effect/cli prints it.
 * effect/cli prints the help before its own errors.
 */
export const saidFormatter: CliOutput.Formatter = {
  formatHelpDoc: effectFormatter.formatHelpDoc,
  formatCliError: effectFormatter.formatCliError,
  formatVersion: effectFormatter.formatVersion,
  formatErrors: (errors) => errors.map((error) => `ERROR: ${error.message}`).join("\n"),
  formatError: (error) => (error._tag === "UserError" && error.userMessage !== undefined ? error.userMessage : effectFormatter.formatError(error)),
};
