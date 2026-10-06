/** Checks of a tool's input JSON Schema, as the model is sent it. */

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null;

/**
 * Returns the paths of the inputs in `schema` that have no `description`, the inputs of an array's
 * items included (`entries[].status`).
 */
export const undescribedInputs = (schema: unknown, at = ""): ReadonlyArray<string> => {
  if (!isObject(schema)) return [];
  const items = schema["items"] === undefined ? [] : undescribedInputs(schema["items"], `${at}[]`);
  const properties = isObject(schema["properties"]) ? Object.entries(schema["properties"]) : [];
  return [
    ...items,
    ...properties.flatMap(([name, input]) => {
      const path = at === "" ? name : `${at}.${name}`;
      return [...(isObject(input) && typeof input["description"] === "string" ? [] : [path]), ...undescribedInputs(input, path)];
    }),
  ];
};
