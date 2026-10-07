/**
 * Every event the Zork spectator logs, by the area that logs it. The key is the event's name in the log.
 */

export const logKeys = {
  game: {
    /** A game ended without the world's outcome; the details carry the labels of its players, the error the pages show, and the whole cause. */
    failed: "zork-spectator.game.failed",
  },
} as const;
