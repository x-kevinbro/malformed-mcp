import { clamp, formatResult, type ExecResult } from "./exec.js";
import { config } from "./config.js";
import { redactSecrets } from "./redact.js";
import { compact, estimateTokens } from "./compress.js";
import { saveOutput } from "./output-store.js";

export type TextContentBlock = { type: "text"; text: string };
export type ImageContentBlock = { type: "image"; data: string; mimeType: string };
export type ToolResult = {
  content: Array<TextContentBlock | ImageContentBlock>;
  isError?: boolean;
};

/**
 * How much text formatResult may build before ok() takes over. Large enough
 * that the overflow store sees the whole output, small enough to bound memory.
 */
const BUILD_CAP = 8_000_000;

/** Only mention compaction when it saved enough to be worth a line about it. */
const REPORT_SAVING_OVER = 600;

/**
 * Every tool result leaves through ok() or fail(), which makes this the one
 * place worth treating carefully. Three things happen here, in this order:
 *
 *  1. Redaction, before anything else, so a secret cannot be sliced in half by
 *     truncation and slip through as two harmless-looking fragments.
 *  2. Compaction, which removes characters that carry no information - escape
 *     codes, progress-bar carriage returns, banks of blank lines, the same line
 *     repeated forty times. The model is billed for these exactly like prose.
 *  3. Clamping, and if the text is still too long, the full version goes to disk
 *     and the notice carries an id. Truncation used to be permanent, so the only
 *     way to see the middle was to re-run the command and pay for all of it
 *     again; now the agent can fetch just the part it needs.
 */
function render(text: string, max?: number): string {
  const limit = max ?? config.maxOutput;
  const scrubbed = config.redactOutput ? redactSecrets(text) : text;
  const compacted = compact(scrubbed, config.compactOutput);
  const saved = scrubbed.length - compacted.length;

  if (compacted.length <= limit) {
    if (saved > REPORT_SAVING_OVER) {
      return `${compacted}\n\n[compacted: ${saved.toLocaleString()} characters of repetition and whitespace removed, ~${estimateTokens(
        " ".repeat(saved),
      ).toLocaleString()} tokens]`;
    }
    return compacted;
  }

  const stored = saveOutput(compacted);
  if (!stored) return clamp(compacted, limit);

  // Reserve room for the notice so the result still lands inside the budget.
  const notice =
    `\n\n\u2026 truncated. The full ${stored.lines.toLocaleString()} line(s) ` +
    `(${stored.bytes.toLocaleString()} bytes, ~${estimateTokens(compacted).toLocaleString()} tokens) ` +
    `are stored as ${stored.id}.\n` +
    `Do not re-run the command - read what you need with ` +
    `fetch_output id="${stored.id}" (grep="...", tail=N, or start_line/max_lines).\n\n`;

  const room = Math.max(200, limit - notice.length);
  const head = Math.ceil(room * 0.7);
  const tail = room - head;

  return compacted.slice(0, head) + notice + compacted.slice(compacted.length - tail);
}

export function ok(text: string, max?: number): ToolResult {
  return { content: [{ type: "text", text: render(text, max) }] };
}

export function fail(text: string): ToolResult {
  return { content: [{ type: "text", text: render(text) }], isError: true };
}

/** Image results bypass render(): base64 must not be redacted, compacted or clamped. */
export function okImage(
  dataOrImages: string | Array<{ data: string; mimeType: string; note?: string }>,
  mimeType?: string,
  note?: string,
): ToolResult {
  const content: Array<TextContentBlock | ImageContentBlock> = [];
  if (Array.isArray(dataOrImages)) {
    for (const img of dataOrImages) {
      if (img.note) {
        content.push({ type: "text", text: render(img.note) });
      }
      content.push({ type: "image", data: img.data, mimeType: img.mimeType });
    }
  } else {
    if (note) {
      content.push({ type: "text", text: render(note) });
    }
    if (mimeType) {
      content.push({ type: "image", data: dataOrImages, mimeType });
    }
  }
  return { content };
}

/** Map a shell result onto a tool result, treating non-zero exit as an error. */
export function fromExec(result: ExecResult, header?: string, max?: number): ToolResult {
  // Build the full text and let render() decide what to keep, so the overflow
  // store receives everything rather than an already-truncated copy.
  const text = formatResult(result, header, BUILD_CAP);
  return result.exitCode === 0 && !result.timedOut ? ok(text, max) : fail(text);
}

/** Report the shell result without treating non-zero exit as failure. */
export function fromExecLenient(result: ExecResult, header?: string): ToolResult {
  return ok(formatResult(result, header, BUILD_CAP));
}

export class ReadOnlyError extends Error {
  constructor(tool: string, flag: string) {
    super(`${flag} is enabled \u2014 "${tool}" is disabled on this server.`);
    this.name = "ReadOnlyError";
  }
}

/**
 * Read-only comes in three grades, because the useful postures are asymmetric:
 * "let the agent ship code but never touch production" and "let it fix the box
 * but never rewrite history" are both reasonable, and a single global switch
 * can express neither.
 */
export function assertWritable(tool: string): void {
  if (config.hostReadOnly) {
    throw new ReadOnlyError(tool, config.readOnly ? "readOnly" : "hostReadOnly");
  }
}

/** Guard for anything that mutates state on GitHub rather than on this host. */
export function assertGithubWritable(tool: string): void {
  if (config.githubReadOnly) {
    throw new ReadOnlyError(tool, config.readOnly ? "readOnly" : "githubReadOnly");
  }
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
