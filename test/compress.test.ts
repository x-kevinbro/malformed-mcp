import test from "node:test";
import assert from "node:assert/strict";
import {
  collapseRepeats,
  compact,
  compactJson,
  estimateTokens,
  measure,
  stripAnsi,
} from "../src/compress.js";

test("terminal colour codes are removed", () => {
  assert.equal(stripAnsi("\u001B[31merror\u001B[0m: failed"), "error: failed");
});

test("a progress bar's carriage returns become real lines, not one mangled one", () => {
  const out = compact("10%\r50%\r100%\n");
  assert.match(out, /10%/);
  assert.match(out, /100%/);
  assert.doesNotMatch(out, /\r/);
});

test("a long run of the same line collapses to one copy and a count", () => {
  const line = "npm WARN deprecated inflight@1.0.6";
  const out = collapseRepeats([line, line, line, line, line].join("\n"));
  assert.match(out, /\u00d74 more identical line\(s\)/);
  assert.equal(out.split("\n").filter((l) => l === line).length, 1);
});

test("source code is never collapsed, however repetitive it looks", () => {
  // Closing braces repeat constantly in real code. The line-length floor is
  // what keeps compaction from corrupting a file the agent asked to read.
  const code = ["  }", "  }", "  }", "  }", "  }"].join("\n");
  assert.equal(compact(code), code);
});

test("a repeated run shorter than the floor is left alone", () => {
  const text = ["a long enough line here", "a long enough line here"].join("\n");
  assert.equal(collapseRepeats(text), text);
});

test("banks of blank lines shrink to one", () => {
  assert.equal(compact("a\n\n\n\n\n\nb"), "a\n\nb");
});

test("decorative rules are shortened but still read as rules", () => {
  const out = compact(`${"=".repeat(200)}\ndone`);
  assert.match(out, /^={20}$/m);
  assert.ok(out.length < 60);
});

test("trailing whitespace goes", () => {
  assert.equal(compact("value    \nnext\t\n"), "value\nnext\n");
});

test("level off is a true passthrough", () => {
  const noisy = `\u001B[31mx\u001B[0m   \n\n\n\n`;
  assert.equal(compact(noisy, "off"), noisy);
});

test("aggressive strips leading timestamps that repeat on every log line", () => {
  const log = "2026-08-03T01:02:03.123Z starting\n2026-08-03T01:02:04.456Z ready";
  const out = compact(log, "aggressive");
  assert.equal(out, "starting\nready");
  // Safe mode must not touch them: timestamps often matter.
  assert.equal(compact(log, "safe"), log);
});

test("compaction reports an honest saving", () => {
  const before = [
    "same repeated line here",
    "same repeated line here",
    "same repeated line here",
    "same repeated line here",
  ].join("\n");
  const after = compact(before);
  const saving = measure(before, after);
  assert.ok(saving.charsSaved > 0);
  assert.ok(saving.percent > 0 && saving.percent <= 100);
  assert.equal(saving.after, after.length);
});

test("token estimates track length", () => {
  assert.equal(estimateTokens(""), 0);
  assert.ok(estimateTokens("x".repeat(4000)) > estimateTokens("x".repeat(400)));
});

test("compactJson drops empty fields and indents by one", () => {
  const out = compactJson({ name: "a", note: null, tags: [], nested: { keep: 1, drop: undefined } });
  assert.doesNotMatch(out, /note|tags|drop/);
  assert.match(out, /"name": "a"/);
  assert.match(out, /^ "name"/m, "one-space indent");
});

test("compactJson is smaller than pretty-printed JSON for a list", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ id: i, name: `row ${i}`, note: null }));
  assert.ok(compactJson(rows).length < JSON.stringify(rows, null, 2).length);
});
