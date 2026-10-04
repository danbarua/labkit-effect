/**
 * Layers of parsed configuration merged in order, the last write winning: two mappings merge key by
 * key, deeply; any other value, a list included, is replaced whole by a later layer's; a key a later
 * layer does not have keeps the earlier value. The values are as parsed (from YAML or JSON), not
 * decoded, so the same merge serves any configuration: policies, or an overlay that disables some of
 * a base's providers.
 */

const isMapping = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);

/** `after` written over `before`. */
export const over = (before: unknown, after: unknown): unknown => {
  if (after === undefined) return before;
  if (!isMapping(before) || !isMapping(after)) return after;
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return Object.fromEntries(keys.map((key) => [key, over(before[key], after[key])]));
};

/** `layers` written one over another, the first at the bottom, over an empty mapping: the merge of no layers is `{}`. */
export const merged = (layers: ReadonlyArray<unknown>): unknown => layers.reduce<unknown>(over, {});
