/**
 * Token compaction.
 *
 * Gzip would shrink the wire and save nothing that matters: the model is billed
 * for the text after decompression. The only real saving is sending fewer
 * characters, so this module removes the ones that carry no information -
 * terminal escape codes, progress-bar carriage returns, trailing whitespace,
 * banks of blank lines, and the same line repeated forty times.
 *
 * Everything here must be lossless in the sense that matters: it may never
 * change what the remaining text says. Code and configuration pass through
 * untouched, which is why the repeat collapser has both a run-length and a
 * line-length floor - "  }" appearing three times in a row is source, not noise.
 */

export type CompactLevel = "off" | "safe" | "aggressive";

/** SGR and cursor escapes from anything that thought it was writing to a TTY. */
const ANSI = /\u001B\[[0-9;?]*[A-Za-z]/g;

/** A bare CR rewrites the line: progress bars emit hundreds per second. */
const BARE_CR = /\r(?!\n)/g;

const TRAILING_WS = /[ \t]+$/gm;
const THREE_PLUS_BLANKS = /\n{3,}/g;

/** "========..." as a visual divider. Twenty characters make the point. */
const LONG_RULE = /^([-=_*#~+])\1{24,}$/;

/** ISO or syslog timestamps at the head of a line, as Docker and Actions emit. */
const LEADING_TIMESTAMP = /^\[?\d{4}-\d{2}-\d{2}[T ][\d:]{5,8}(?:[.,]\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?\]?\s?/;

/** Collapse a run of identical lines only when it is clearly not source code. */
const MIN_RUN = 4;
const MIN_RUN_LINE_LENGTH = 12;

/**
 * Rough token count. Four characters per token is the usual approximation for
 * English and code alike; this only needs to be good enough to report a saving
 * honestly, not to bill anyone.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/**
 * Replace runs of the same line with one copy and a count. Returns the text
 * unchanged when no run is long enough to be worth it.
 */
export function collapseRepeats(text: string, minRun = MIN_RUN): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    let run = 1;
    while (index + run < lines.length && lines[index + run] === line) run++;

    const worthCollapsing = run >= minRun && line.trim().length >= MIN_RUN_LINE_LENGTH;
    if (worthCollapsing) {
      out.push(line, `      \u27e8 \u00d7${run - 1} more identical line(s) \u27e9`);
    } else {
      for (let k = 0; k < run; k++) out.push(line);
    }
    index += run;
  }

  return out.join("\n");
}

/** Shorten decorative rules, which say the same thing at a fifth of the length. */
function shortenRules(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!LONG_RULE.test(trimmed)) return line;
      const char = trimmed[0] ?? "-";
      return char.repeat(20);
    })
    .join("\n");
}

function stripLeadingTimestamps(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(LEADING_TIMESTAMP, ""))
    .join("\n");
}

/**
 * Apply the compaction pipeline.
 *
 * safe       - escape codes, carriage returns, trailing whitespace, blank-line
 *              banks, long rules, and long runs of an identical line.
 * aggressive - additionally strips leading timestamps and collapses shorter
 *              repeat runs. Use where the text is known to be a log.
 */
export function compact(text: string, level: CompactLevel = "safe"): string {
  if (level === "off" || !text) return text;

  let out = stripAnsi(text).replace(BARE_CR, "\n");
  out = out.replace(TRAILING_WS, "");
  out = shortenRules(out);

  if (level === "aggressive") {
    out = stripLeadingTimestamps(out);
    out = collapseRepeats(out, 2);
  } else {
    out = collapseRepeats(out);
  }

  out = out.replace(THREE_PLUS_BLANKS, "\n\n");
  return out;
}

export type Saving = {
  before: number;
  after: number;
  charsSaved: number;
  tokensSaved: number;
  percent: number;
};

export function measure(before: string, after: string): Saving {
  const charsSaved = before.length - after.length;
  return {
    before: before.length,
    after: after.length,
    charsSaved,
    tokensSaved: estimateTokens(before) - estimateTokens(after),
    percent: before.length === 0 ? 0 : Math.round((charsSaved / before.length) * 100),
  };
}

/**
 * Render a value as JSON without the whitespace nobody reads. Two-space indent
 * on a hundred-item array is thousands of tokens of leading spaces; one space
 * reads just as well. Null and undefined fields are dropped entirely, since
 * "this field is absent" is rarely worth a line.
 */
export function compactJson(value: unknown): string {
  const pruned = prune(value);
  return JSON.stringify(pruned, null, 1) ?? String(value);
}

function prune(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(prune);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === null || item === undefined) continue;
      if (Array.isArray(item) && item.length === 0) continue;
      out[key] = prune(item);
    }
    return out;
  }
  return value;
}
