/** `Received` JSON content as plain data, for a test's observations and expectations. */
export function json(value: unknown): { mediaType: "application/json"; body: { _tag: "Text"; text: string } } {
  return { mediaType: "application/json", body: { _tag: "Text", text: JSON.stringify(value) } };
}
