import type { WordText } from "./command-segments.ts";

/** Text before it is branded: the input of a brand's `make`. */
type Text = Parameters<typeof WordText.make>[0];

/**
 * A Markdown code span: `text` between backticks, so that a client that renders Markdown shows it as
 * written (`*.ts` keeps its asterisks, `__init__.py` is not bold). The run of backticks is one longer
 * than the longest run in `text`, and a space pads a `text` that starts or ends with a backtick, as
 * CommonMark requires.
 */
export const codeSpan = (text: Text): Text => {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const ticks = "`".repeat(longest + 1);
  return text.startsWith("`") || text.endsWith("`") ? `${ticks} ${text} ${ticks}` : `${ticks}${text}${ticks}`;
};
