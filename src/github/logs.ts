/**
 * Fetching and condensing GitHub Actions logs.
 *
 * A failed job's log is routinely 20,000 lines of setup noise wrapped around
 * five lines that matter. Returning it whole would blow the output clamp and
 * bury the cause, so this module finds the interesting lines and shows them
 * with context. Job-level logs are used rather than the run-level endpoint
 * because a job returns plain text while a run returns a zip.
 */
import { ghDownloadText } from "./api.js";
import { numbered } from "./format.js";

/**
 * Lines worth surfacing. "##[error]" is the authoritative marker that a step
 * failed; the rest catch tools that report failure without the annotation,
 * which most linters and test runners do.
 */
const ERROR_LINE =
  /##\[error\]|(?:^|\s)(?:error|failed|failure|fatal|npm ERR!|ELIFECYCLE|panic:|Traceback|exit code [1-9]|✖|✗|Error:)/i;

/** Actions prefixes every line with an ISO timestamp; it is rarely the point. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/;

/** Group markers add structure for a human reader but only noise for a model. */
const GROUP = /^##\[(group|endgroup)\]/;

export type LogMode = "errors" | "tail" | "full";

export type LogOptions = {
  mode: LogMode;
  tail: number;
  context: number;
  grep?: string;
  stripTimestamps: boolean;
};

function cleanLines(raw: string, stripTimestamps: boolean): string[] {
  return raw
    .split("\n")
    .map((line) => (stripTimestamps ? line.replace(TIMESTAMP, "") : line))
    .filter((line) => !GROUP.test(line));
}

/**
 * Select which lines to show. Returns them already rendered, with a marker
 * wherever lines were dropped so the reader can tell the log is not contiguous.
 */
export function condense(raw: string, options: LogOptions): string {
  const lines = cleanLines(raw, options.stripTimestamps);

  if (options.mode === "full") return numbered(lines);

  if (options.mode === "tail") {
    const start = Math.max(0, lines.length - options.tail);
    return numbered(lines.slice(start), start + 1);
  }

  const matcher = options.grep ? new RegExp(options.grep, "i") : ERROR_LINE;
  const keep = new Set<number>();

  lines.forEach((line, index) => {
    if (!matcher.test(line)) return;
    for (let k = index - options.context; k <= index + options.context; k++) {
      if (k >= 0 && k < lines.length) keep.add(k);
    }
  });

  // The last lines carry the exit status even when nothing matched, so a log
  // with no recognisable error still returns something useful.
  for (let k = Math.max(0, lines.length - options.tail); k < lines.length; k++) keep.add(k);

  const ordered = [...keep].sort((a, b) => a - b);
  if (!ordered.length) return "(no matching lines)";

  const out: string[] = [];
  let previous = -1;
  for (const index of ordered) {
    if (previous >= 0 && index !== previous + 1) {
      out.push(`      … ${index - previous - 1} line(s) omitted …`);
    }
    out.push(`${String(index + 1).padStart(5)}  ${lines[index]}`);
    previous = index;
  }
  return out.join("\n");
}

export async function jobLog(repo: string, jobId: number | string, options: LogOptions): Promise<string> {
  const raw = await ghDownloadText(`/repos/${repo}/actions/jobs/${jobId}/logs`);
  return condense(raw, options);
}
