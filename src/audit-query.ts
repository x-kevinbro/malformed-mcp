/**
 * Reading the audit trail back.
 *
 * `audit()` has written a structured record for every mutating call since the
 * first tranche, and until now there was no way to read one back without a
 * shell. Worse, the file called `audit.log` is not an audit log: it is this
 * server's entire pino stream, and four lines in five are HTTP request noise.
 * The audit records are the ones carrying `audit:true`.
 *
 * This half is pure - no filesystem, no config - so the parsing, the time
 * window and the formatting are testable without a log directory, and the tool
 * half stays a walk over files.
 */

export type AuditRecord = {
  /** Epoch milliseconds, as pino writes it. */
  time: number;
  event: string;
  details: Record<string, unknown>;
};

export type AuditFilter = {
  /** Comma-separated names; a trailing * matches a prefix. Empty matches all. */
  event?: string;
  from?: number;
  to?: number;
  contains?: string;
};

/** Keys pino puts on every line. They are noise in an audit view. */
const ENVELOPE = new Set(["level", "time", "service", "audit", "event", "msg", "pid", "hostname"]);

/**
 * Cheap pre-check. Running JSON.parse over all 12,000 lines of a 19MB file to
 * find the 2,000 that matter is the slow way round.
 */
export function looksLikeAudit(line: string): boolean {
  return line.includes('"audit":true');
}

export function parseAuditLine(line: string): AuditRecord | null {
  if (!looksLikeAudit(line)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // A half-written final line is normal: the file is being appended to.
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const row = parsed as Record<string, unknown>;
  if (row.audit !== true || typeof row.event !== "string") return null;

  const details: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!ENVELOPE.has(key)) details[key] = value;
  }

  return {
    time: typeof row.time === "number" ? row.time : 0,
    event: row.event,
    details,
  };
}

export function eventMatches(event: string, pattern?: string): boolean {
  if (!pattern || !pattern.trim()) return true;
  return pattern
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .some((part) => (part.endsWith("*") ? event.startsWith(part.slice(0, -1)) : event === part));
}

const RELATIVE = /^(\d+)\s*([smhd])$/;
const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * "30m", "6h", "7d", or an absolute date. Relative is what gets typed in
 * practice, so it is what the tool documents first.
 */
export function parseWhen(value: string | undefined, now: number): number | undefined {
  if (value === undefined || !value.trim()) return undefined;

  const relative = RELATIVE.exec(value.trim().toLowerCase());
  if (relative) {
    const [, amount = "0", unit = "m"] = relative;
    return now - Number(amount) * (UNIT_MS[unit] ?? 60_000);
  }

  const absolute = Date.parse(value);
  if (Number.isNaN(absolute)) {
    throw new Error(`cannot read a time from "${value}" - try 30m, 6h, 7d or an ISO date`);
  }
  return absolute;
}

export function matchesAudit(record: AuditRecord, filter: AuditFilter, raw = ""): boolean {
  if (!eventMatches(record.event, filter.event)) return false;
  if (filter.from !== undefined && record.time < filter.from) return false;
  if (filter.to !== undefined && record.time > filter.to) return false;
  if (filter.contains) {
    const hay = (raw || JSON.stringify(record.details)).toLowerCase();
    if (!hay.includes(filter.contains.toLowerCase())) return false;
  }
  return true;
}

/** A long value is usually a command or a SQL statement. Show its head. */
function showValue(value: unknown, width = 70): string {
  const text = typeof value === "string" ? value : value === null ? "null" : String(JSON.stringify(value));
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > width ? `${flat.slice(0, width - 1)}\u2026` : flat;
}

export function formatAuditRecord(record: AuditRecord): string {
  const when = record.time ? `${new Date(record.time).toISOString().slice(0, 19)}Z` : "(no time)";
  const pairs = Object.entries(record.details)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${showValue(value)}`)
    .join(" ");
  return `${when}  ${record.event.padEnd(20)} ${pairs}`.trimEnd();
}

export function summariseAudit(records: AuditRecord[]): string {
  if (!records.length) return "No audit records matched.";

  const counts = new Map<string, number>();
  for (const record of records) {
    counts.set(record.event, (counts.get(record.event) ?? 0) + 1);
  }

  const rows = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([event, count]) => `${String(count).padStart(6)}  ${event}`);

  const times = records.map((record) => record.time).filter((time) => time > 0);
  const span = times.length
    ? `${new Date(Math.min(...times)).toISOString().slice(0, 19)}Z .. ` +
      `${new Date(Math.max(...times)).toISOString().slice(0, 19)}Z`
    : "unknown";

  return [`${records.length} record(s), ${counts.size} event type(s)`, `span: ${span}`, "", ...rows].join(
    "\n",
  );
}
