/**
 * Overflow store for oversized tool output.
 *
 * Clamping used to delete the middle of a long result permanently: the only way
 * to see it was to re-run the command and pay for the whole thing again. Now the
 * full text is written to disk and the clamped result carries an id, so the
 * agent can go back for the part it actually needs - a grep, a line range, the
 * tail - instead of the whole thing.
 *
 * The writes are synchronous because ok() is synchronous, and they only happen
 * on overflow, which is rare.
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { config } from "./config.js";

export type SavedOutput = { id: string; file: string; bytes: number; lines: number };

const MAX_FILES = 200;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function ensureDir(): string | null {
  try {
    fs.mkdirSync(config.outputDir, { recursive: true, mode: 0o700 });
    return config.outputDir;
  } catch {
    return null;
  }
}

/** Keep the store bounded. Best-effort: a failure here must never fail a tool. */
function prune(dir: string): void {
  try {
    const entries = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".txt"))
      .map((name) => {
        const file = path.join(dir, name);
        return { file, mtime: fs.statSync(file).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    const now = Date.now();
    entries.forEach((entry, index) => {
      if (index >= MAX_FILES || now - entry.mtime > MAX_AGE_MS) {
        fs.rmSync(entry.file, { force: true });
      }
    });
  } catch {
    /* pruning is housekeeping, not correctness */
  }
}

/** Persist full text and return its handle, or null if the store is unwritable. */
export function saveOutput(text: string): SavedOutput | null {
  const dir = ensureDir();
  if (!dir) return null;

  const id = randomBytes(4).toString("hex");
  const file = path.join(dir, `${id}.txt`);

  try {
    fs.writeFileSync(file, text, { encoding: "utf8", mode: 0o600 });
  } catch {
    return null;
  }

  prune(dir);
  return { id, file, bytes: Buffer.byteLength(text), lines: text.split("\n").length };
}

export type ReadOutputArgs = {
  id: string;
  startLine?: number;
  maxLines?: number;
  grep?: string;
  tail?: number;
};

/** Read part of a stored output. Throws with a readable message when absent. */
export function readOutput(args: ReadOutputArgs): string {
  if (!/^[a-f0-9]{8}$/.test(args.id)) {
    throw new Error(`"${args.id}" is not an output id. Ids are eight hex characters.`);
  }

  const file = path.join(config.outputDir, `${args.id}.txt`);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    throw new Error(
      `No stored output ${args.id}. They are kept for 24 hours and the newest ${MAX_FILES}; ` +
        "re-run the original tool to produce a fresh one.",
    );
  }

  const all = raw.split("\n");
  const header = `output ${args.id}: ${all.length} line(s), ${Buffer.byteLength(raw)} bytes`;

  if (args.grep) {
    const matcher = new RegExp(args.grep, "i");
    const hits = all
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => matcher.test(line));
    const limit = args.maxLines ?? 200;
    const shown = hits.slice(0, limit);
    const body = shown.map(({ line, number }) => `${String(number).padStart(6)}  ${line}`).join("\n");
    return (
      `${header}\n${hits.length} line(s) match /${args.grep}/i` +
      `${hits.length > limit ? `, showing the first ${limit}` : ""}\n\n${body || "(no matches)"}`
    );
  }

  if (args.tail) {
    const start = Math.max(0, all.length - args.tail);
    const body = all
      .slice(start)
      .map((line, index) => `${String(start + index + 1).padStart(6)}  ${line}`)
      .join("\n");
    return `${header}\nlast ${Math.min(args.tail, all.length)} line(s)\n\n${body}`;
  }

  const start = Math.max(1, args.startLine ?? 1);
  const count = args.maxLines ?? 200;
  const slice = all.slice(start - 1, start - 1 + count);
  const body = slice.map((line, index) => `${String(start + index).padStart(6)}  ${line}`).join("\n");
  const end = start + slice.length - 1;

  return (
    `${header}\nlines ${start}-${end}` +
    `${end < all.length ? ` (${all.length - end} more below)` : ""}\n\n${body}`
  );
}
