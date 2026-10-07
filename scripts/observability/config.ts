/**
 * What the Grafana configuration in `scripts/observability/` and the capture server share: the
 * server's port, and the link from a capture's id to its body. Every script reads them from here.
 */

/** The port of the capture server (`capture-server.ts`), on the loopback interface. */
export const captureServerPort = 3300;

/** A capture id: the UUID that names a capture file (`src/instrumentation/http-captures.ts`). */
export const captureIdPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** Returns the URL at which the capture server serves the body of capture `captureId`. */
export const captureUrlOf = (captureId: string): string => `http://localhost:${captureServerPort}/http-captures/${captureId}.json`;

/** The capture link as a Grafana URL template, the capture id being the matched value (`${__value.raw}`). */
export const captureLinkTemplate = captureUrlOf("${__value.raw}");
