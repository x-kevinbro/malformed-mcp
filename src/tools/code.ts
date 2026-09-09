import fs from "node:fs/promises";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool, registerTools } from "../tool.js";

/**
 * Reading many files in one round trip, and skimming a file's shape before
 * reading its body.
 */

/** Top-level declarations. Deliberately regex, not a parser: no new dependency. */
const SYMBOL =
  /^\s*(export\s+)?(default\s+)?(async\s+)?(abstract\s+)?(class|interface|type|enum|function|const|let|var)\s+([A-Za-z0-9_$]+)/;
/** NestJS routes and providers read as structure in this repo, so surface them too. */
const DECORATOR = /^\s*@[A-Z][A-Za-z]*\(/;
/** Methods of a class, which the symbol regex alone would miss. */
const METHOD = /^\s{2}(?:public|private|protected|readonly|async|static|\s)*[A-Za-z0-9_$]+\s*\(/;
/** Control flow reads like a method call to the regex above, but is not structure. */
const NOT_A_SYMBOL = /^\s*(if|for|while|switch|catch|return|else|do|try|await|throw)\b/;

const readFiles = defineTool({
  name: "read_files",
  title: "Read several files, or skim their outlines",
  description:
    "Read up to 20 files in one call instead of one call each. Set outline:true to get just the " +
    "declarations with their line numbers, which is usually enough to decide what to read properly " +
    "and costs a fraction of the file. Unreadable paths are reported inline rather than failing the " +
    "whole call, so you can probe several candidates at once.",
  readOnly: true,
  input: {
    paths: z.array(z.string().min(1)).min(1).max(20).describe("Absolute paths."),
    outline: z
      .boolean()
      .default(false)
      .describe("Return declarations and their line numbers instead of file bodies."),
    start_line: z.number().int().positive().optional().describe("First line to return."),
    end_line: z.number().int().positive().optional().describe("Last line to return."),
    max_lines: z.number().int().positive().default(400).describe("Per-file cap when no end_line."),
    line_numbers: z.boolean().default(true).describe("Prefix each line with its number."),
  },
  async run({ paths, outline, start_line, end_line, max_lines, line_numbers }) {
    const chunks: string[] = [];

    for (const filePath of paths) {
      let text: string;
      try {
        text = await fs.readFile(filePath, "utf8");
      } catch (error) {
        chunks.push(`=== ${filePath} ===\n(unreadable: ${(error as Error).message})`);
        continue;
      }

      const lines = text.split("\n");

      if (outline) {
        const hits = lines
          .map((line, i) => [i + 1, line] as const)
          .filter(
            ([, line]) =>
              !NOT_A_SYMBOL.test(line) && (SYMBOL.test(line) || DECORATOR.test(line) || METHOD.test(line)),
          );
        chunks.push(
          `=== ${filePath} — outline: ${hits.length} symbol(s), ${lines.length} lines ===\n` +
            (hits.length
              ? hits.map(([n, line]) => `${String(n).padStart(5)}  ${line.trim()}`).join("\n")
              : "(nothing matched; read the file directly)"),
        );
        continue;
      }

      const from = Math.max(1, start_line ?? 1);
      const to = Math.min(lines.length, end_line ?? from + max_lines - 1);
      const body = lines
        .slice(from - 1, to)
        .map((line, i) => (line_numbers ? `${String(from + i).padStart(5)}  ${line}` : line))
        .join("\n");
      const more =
        to < lines.length ? `\n… ${lines.length - to} more line(s) — pass start_line: ${to + 1}` : "";

      chunks.push(`=== ${filePath} (lines ${from}-${to} of ${lines.length}) ===\n${body}${more}`);
    }

    return chunks.join("\n\n");
  },
});

export function registerCodeTools(server: McpServer): void {
  registerTools(server, [readFiles]);
}
