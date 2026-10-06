/**
 * The CLI's own settings, which `/settings` shows and changes beside the model's: `view.thinking`
 * (`on`, `off`), whether the REPL shows the model's thinking. A change applies at once and is saved
 * as `cli.view.thinking` in the user's configuration folder (`agent-config` `write.ts`): in the file
 * that sets it, else in `settings.yml`. If the file cannot be written, the change still applies until
 * the REPL exits, and `/settings` says it was not saved.
 */

import { Effect, Ref } from "effect";
import { writeSetting } from "../../agent-config/write.ts";
import type { CommandContext } from "./command.ts";
import { invalid } from "./invalid.ts";
import { settingNames } from "./model-settings.ts";

/** The CLI's own settings, by name, with their values. */
export const userSettings = { "view.thinking": ["on", "off"] } as const;

/** A change to one of the CLI's own settings. */
export interface UserChange {
  readonly name: keyof typeof userSettings;
  readonly value: (typeof userSettings)[keyof typeof userSettings][number];
}

/** Whether `word` (`name=value`) names one of the CLI's own settings rather than a model setting: its name starts with `view.`. */
export const isUserWord = (word: string): boolean => word.startsWith("view.");

const isUserSetting = (name: string): name is keyof typeof userSettings => name in userSettings;

/** Parses `word` (`name=value`) as a change to a CLI setting; fails for an unknown setting or an invalid value. */
export const userChangeOf = (word: string) => {
  const [name = "", value = ""] = word.split("=");
  if (!isUserSetting(name)) return Effect.fail(invalid(`Unknown setting: ${name}.`, `The settings are ${settingNames(Object.keys(userSettings))}.`));
  const values: ReadonlyArray<string> = userSettings[name];
  const taken = userSettings[name].find((each) => each === value);
  if (taken === undefined) return Effect.fail(invalid(`Invalid value for ${name}: ${value}.`, `Use one of: ${values.join(", ")}.`));
  const change: UserChange = { name, value: taken };
  return Effect.succeed(change);
};

/** The CLI's own settings as a line: `view.thinking=on`. */
export const userSettingsLine = ({ view }: CommandContext) => Effect.map(Ref.get(view.thinking), (thinking) => `view.thinking=${thinking}`);

/** Applies `change`, saves it to the user's folder, and returns a line naming the file, or saying why it was not saved. */
export const applied = (change: UserChange, { view, configFolder }: CommandContext) =>
  Effect.gen(function* () {
    yield* Ref.set(view.thinking, change.value);
    const said = `${change.name}=${change.value}`;
    // The configuration keeps the CLI's own settings under `cli`.
    return yield* writeSetting(configFolder, ["cli", ...change.name.split(".")], change.value, "settings.yml").pipe(
      Effect.map((file) => `${said} (saved to ${file})`),
      Effect.catch((error) => Effect.succeed(String(invalid(`Could not save ${said}: ${error.message}`, "It applies until the REPL exits.").userMessage))),
    );
  });
