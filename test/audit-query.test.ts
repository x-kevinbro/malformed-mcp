import test from "node:test";
import assert from "node:assert/strict";
import {
  eventMatches,
  formatAuditRecord,
  looksLikeAudit,
  matchesAudit,
  parseAuditLine,
  parseWhen,
  summariseAudit,
} from "../src/audit-query.js";

const AUDIT_LINE =
  '{"level":30,"time":1785743853274,"service":"bytelink-vps","audit":true,' +
  '"event":"write_file","path":"/opt/tool-mcp/x.ts","bytes":120,"msg":"audit:write_file"}';

// Four lines in five of the file look like this one.
const NOISE_LINE =
  '{"level":30,"time":1785743824257,"service":"bytelink-vps",' +
  '"req":{"id":48,"method":"POST","url":"/mcp"},"msg":"request completed"}';

test("the request noise that fills the file is not an audit record", () => {
  assert.equal(looksLikeAudit(NOISE_LINE), false);
  assert.equal(parseAuditLine(NOISE_LINE), null);
});

test("an audit record parses, and the pino envelope is stripped", () => {
  const record = parseAuditLine(AUDIT_LINE);
  assert.ok(record);
  assert.equal(record.event, "write_file");
  assert.equal(record.time, 1785743853274);
  assert.deepEqual(record.details, { path: "/opt/tool-mcp/x.ts", bytes: 120 });
});

test("a half-written last line is skipped, not thrown", () => {
  assert.equal(parseAuditLine('{"audit":true,"event":"write_f'), null);
});

test("audit:true without an event name is not a record", () => {
  assert.equal(parseAuditLine('{"audit":true,"time":1}'), null);
});

test("event patterns: exact, prefix and comma lists", () => {
  assert.equal(eventMatches("gh_file_write", "gh_*"), true);
  assert.equal(eventMatches("write_file", "gh_*"), false);
  assert.equal(eventMatches("db_query", "write_file,db_query"), true);
  assert.equal(eventMatches("db_query", undefined), true);
  assert.equal(eventMatches("db_query", "   "), true);
});

test("relative and absolute times both read", () => {
  const now = 1_000_000_000;
  assert.equal(parseWhen("30m", now), now - 1_800_000);
  assert.equal(parseWhen("6h", now), now - 21_600_000);
  assert.equal(parseWhen("7d", now), now - 604_800_000);
  assert.equal(parseWhen(undefined, now), undefined);
  assert.equal(parseWhen("2026-08-03T00:00:00Z", now), Date.parse("2026-08-03T00:00:00Z"));
});

test("an unreadable time says so rather than silently matching everything", () => {
  assert.throws(() => parseWhen("last tuesday", 0), /cannot read a time/);
});

test("the window excludes records outside it, at both ends", () => {
  const record = { time: 100, event: "db_query", details: {} };
  assert.equal(matchesAudit(record, { from: 100 }), true);
  assert.equal(matchesAudit(record, { from: 101 }), false);
  assert.equal(matchesAudit(record, { to: 100 }), true);
  assert.equal(matchesAudit(record, { to: 99 }), false);
});

test("contains searches the record, case-insensitively", () => {
  const record = { time: 1, event: "db_query", details: { sql: "SELECT * FROM users" } };
  assert.equal(matchesAudit(record, { contains: "users" }), true);
  assert.equal(matchesAudit(record, { contains: "USERS" }), true);
  assert.equal(matchesAudit(record, { contains: "orders" }), false);
});

test("a formatted record leads with the time and the event", () => {
  const record = parseAuditLine(AUDIT_LINE);
  assert.ok(record);
  const line = formatAuditRecord(record);
  assert.match(line, /^2026-08-\d\dT\d\d:\d\d:\d\dZ {2}write_file /);
  assert.match(line, /path=\/opt\/tool-mcp\/x\.ts bytes=120$/);
});

test("a long value is trimmed rather than flooding the result", () => {
  const line = formatAuditRecord({
    time: 1785743853274,
    event: "db_query",
    details: { sql: "x".repeat(400) },
  });
  assert.ok(line.length < 140, `too long: ${line.length}`);
  assert.match(line, /\u2026$/);
});

test("the summary counts events, commonest first", () => {
  const summary = summariseAudit([
    { time: 2000, event: "run_script", details: {} },
    { time: 1000, event: "write_file", details: {} },
    { time: 3000, event: "run_script", details: {} },
  ]);
  assert.match(summary, /3 record\(s\), 2 event type\(s\)/);
  const scriptAt = summary.indexOf("run_script");
  const writeAt = summary.indexOf("write_file");
  assert.ok(scriptAt < writeAt, "the commonest event should come first");
});

test("an empty summary says nothing matched", () => {
  assert.match(summariseAudit([]), /No audit records matched/);
});
