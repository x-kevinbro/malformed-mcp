/**
 * Rendering helpers shared by the gh_* tools.
 *
 * GitHub payloads are enormous and mostly URLs. Returning them raw burns the
 * output clamp on fields nobody reads, so tools render fixed-width lines and
 * pick fields deliberately. Keeping that here stops each tool inventing its own
 * slightly different table.
 */

export const pretty = (value: unknown): string => JSON.stringify(value, null, 2);

/** Short SHA, the way git shows it. */
export const short = (sha?: string): string => (sha ? String(sha).slice(0, 7) : "");

/**
 * True when a CI conclusion means something went wrong. "skipped" and
 * "neutral" are not failures, and a null conclusion means still running.
 */
export const bad = (conclusion: unknown): boolean =>
  Boolean(conclusion) && conclusion !== "success" && conclusion !== "skipped" && conclusion !== "neutral";

/** Four-character status column, so runs and jobs line up when listed. */
export function verdict(conclusion: unknown, status?: unknown): string {
  if (conclusion === "success") return "pass";
  if (conclusion === "skipped") return "skip";
  if (bad(conclusion)) return "FAIL";
  if (status === "in_progress") return "run ";
  if (status === "queued") return "wait";
  return "····";
}

/** Keep only the named fields, dropping nulls, before printing an object. */
export function slim<T extends Record<string, any>>(items: T[], keys: string[]): any[] {
  return items.map((item) => {
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      if (item?.[key] !== undefined && item[key] !== null) out[key] = item[key];
    }
    return out;
  });
}

/** First line only - commit messages and PR titles are frequently multi-line. */
export function firstLine(text: unknown, max = 72): string {
  const line = String(text ?? "").split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

export function pad(value: unknown, width: number): string {
  return String(value ?? "")
    .padEnd(width)
    .slice(0, width);
}

/** Render a list, or a clear note when it is empty, never a bare "[]". */
export function listOr(items: string[], emptyMessage: string): string {
  return items.length ? items.join("\n") : emptyMessage;
}

/** ISO date without the time, for columns where the clock does not matter. */
export const day = (value: unknown): string => String(value ?? "").slice(0, 10);

/** Number the lines of a text block, matching how read_files presents code. */
export function numbered(lines: string[], startLine = 1): string {
  return lines.map((line, index) => `${String(startLine + index).padStart(5)}  ${line}`).join("\n");
}
