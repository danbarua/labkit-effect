/**
 * The user's settings that `/settings` shows and changes besides the model's: `view.thinking` (`on`,
 * `off`), whether the REPL shows the model's thinking. A change applies at once, and is written into
 * the user's configuration folder (`agent-config` `write.ts`): into the file that sets it, else
 * `settings.yml`. When the file cannot be written, the change still applies until the REPL exits,
 * and `/settings` says that it was not written.
 */

import { Effect, Ref } from "effect";
import { writeSetting } from "../../agent-config/write.ts";
import type { CommandContext } from "./command.ts";
import { invalid } from "./invalid.ts";
import { settingNames } from "./model-settings.ts";

/** Each of the user's settings, by name, with the values it takes. */
export const userSettings = { "view.thinking": ["on", "off"] } as const;

/** A change of one of the user's settings, as `/settings` reads it. */
export interface UserChange {
  readonly name: keyof typeof userSettings;
  readonly value: (typeof userSettings)[keyof typeof userSettings][number];
}

/** Whether `word` (`name=value`) names one of the user's settings rather than one of the model's: its name starts with `view.`. */
export const isUserWord = (word: string): boolean => word.startsWith("view.");

const isUserSetting = (name: string): name is keyof typeof userSettings => name in userSettings;

/** Reads `word` (`name=value`) as a change of one of the user's settings; fails, saying why, when it names none or a value it does not take. */
export const userChangeOf = (word: string) => {
  const [name = "", value = ""] = word.split("=");
  if (!isUserSetting(name)) return Effect.fail(invalid(`Unknown setting: ${name}.`, `The settings are ${settingNames(Object.keys(userSettings))}.`));
  const values: ReadonlyArray<string> = userSettings[name];
  const taken = userSettings[name].find((each) => each === value);
  if (taken === undefined) return Effect.fail(invalid(`Invalid value for ${name}: ${value}.`, `Use one of: ${values.join(", ")}.`));
  const change: UserChange = { name, value: taken };
  return Effect.succeed(change);
};

/** The user's settings in force, in a line: `view.thinking=on`. */
export const userSettingsLine = ({ view }: CommandContext) => Effect.map(Ref.get(view.thinking), (thinking) => `view.thinking=${thinking}`);

/** Applies `change`, writes it into the user's folder, and returns what to say of it: the file written, or that it was not written, and why. */
export const applied = (change: UserChange, { view, configFolder }: CommandContext) =>
  Effect.gen(function* () {
    yield* Ref.set(view.thinking, change.value);
    const said = `${change.name}=${change.value}`;
    // In the configuration, the CLI's settings are under `cli`.
    return yield* writeSetting(configFolder, ["cli", ...change.name.split(".")], change.value, "settings.yml").pipe(
      Effect.map((file) => `${said} (saved to ${file})`),
      Effect.catch((error) => Effect.succeed(String(invalid(`Could not save ${said}: ${error.message}`, "It applies until the REPL exits.").userMessage))),
    );
  });
