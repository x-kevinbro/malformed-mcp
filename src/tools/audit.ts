import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "../config.js";
import { defineTool, registerTools } from "../tool.js";
import {
  type AuditFilter,
  type AuditRecord,
  formatAuditRecord,
  matchesAudit,
  parseAuditLine,
  parseWhen,
  summariseAudit,
} from "../audit-query.js";

/**
 * The audit trail has been written since the first tranche and read never.
 * Answering "what did this server actually do, and when" meant a shell and a
 * grep, which is exactly the sort of thing a tool should own.
 *
 * The deciding is in audit-query.ts, which is pure and tested. This file is the
 * file walk.
 */

type LogFile = { path: string; mtimeMs: number };

/**
 * Rotation names the files audit.1.log, audit.2.log, audit.3.log - and the
 * numbering does not follow age: audit.1.log was the newest of the three when
 * this was written. Order by mtime, never by name.
 */
async function auditFiles(dir: string): Promise<LogFile[]> {
  const names = await fs.readdir(dir);
  const found = await Promise.all(
    names
      .filter((name) => /^audit.*\.log$/.test(name))
      .map(async (name) => {
        const full = path.join(dir, name);
        const stat = await fs.stat(full);
        return { path: full, mtimeMs: stat.mtimeMs };
      }),
  );
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Read one file, keeping the matches. These files reach 19MB, so they are
 * streamed a line at a time rather than read whole. Records are appended in
 * time order, so when only `keep` are wanted the newest are the last ones: hold
 * a window of that size instead of the entire history.
 */
async function scanFile(file: string, filter: AuditFilter, keep: number | null): Promise<AuditRecord[]> {
  const found: AuditRecord[] = [];
  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      const record = parseAuditLine(line);
      if (!record) continue;
      if (!matchesAudit(record, filter, line)) continue;
      found.push(record);
      if (keep !== null && found.length > keep) found.shift();
    }
  } finally {
    lines.close();
    stream.destroy();
  }

  return found;
}

const auditLog = defineTool({
  name: "audit_log",
  title: "Read this server's own audit trail",
  description:
    "What this server did and when: every mutating call writes a record, and this reads them back, " +
    "newest first. Filter by event (comma separated, a trailing * matches a prefix, e.g. gh_*), by " +
    "time (since/until take 30m, 6h, 7d or an ISO date) and by substring. Use summary:true for " +
    "counts per event over the window rather than the records themselves - that is the cheap way " +
    "to see what a session touched before reading any of it.",
  readOnly: true,
  input: {
    event: z
      .string()
      .optional()
      .describe("Event names, comma separated. A trailing * matches a prefix, e.g. gh_*."),
    since: z.string().default("24h").describe("How far back: 30m, 6h, 7d, or an ISO date."),
    until: z.string().optional().describe("Upper bound, same formats as since."),
    contains: z.string().optional().describe("Case-insensitive substring the record must contain."),
    limit: z.number().int().min(1).max(500).default(40).describe("Most recent N records."),
    summary: z.boolean().default(false).describe("Counts per event over the window instead of the records."),
  },
  async run({ event, since, until, contains, limit, summary }) {
    const dir = config.logDir;
    if (!dir) {
      throw new Error("logDir is not set, so no audit file was ever written.");
    }

    const now = Date.now();
    const filter: AuditFilter = {
      event,
      contains,
      from: parseWhen(since, now),
      to: parseWhen(until, now),
    };

    const files = await auditFiles(dir);
    if (!files.length) throw new Error(`No audit*.log files in ${dir}.`);

    // Newest file first, stopping as soon as there are enough records - the
    // usual question is about the last few minutes, and the older rotations
    // then cost nothing.
    const collected: AuditRecord[] = [];
    let scanned = 0;
    for (const file of files) {
      collected.push(...(await scanFile(file.path, filter, summary ? null : limit)));
      scanned += 1;
      if (!summary && collected.length >= limit) break;
    }
    collected.sort((a, b) => b.time - a.time);

    const window =
      filter.from === undefined ? "all time" : `since ${new Date(filter.from).toISOString().slice(0, 19)}Z`;
    const searched = `${scanned} of ${files.length} file(s) searched, ${window}`;

    if (summary) return `${searched}\n\n${summariseAudit(collected)}`;

    const shown = collected.slice(0, limit);
    if (!shown.length) return `No audit records matched. ${searched}.`;

    const more = collected.length > shown.length ? ` (more exist; raise limit or narrow the window)` : "";

    return [
      `${shown.length} record(s), newest first - ${searched}${more}`,
      "",
      ...shown.map(formatAuditRecord),
    ].join("\n");
  },
});

export function registerAuditTools(server: McpServer): void {
  registerTools(server, [auditLog]);
}
