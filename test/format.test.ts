import test from "node:test";
import assert from "node:assert/strict";
import { bad, day, firstLine, numbered, pad, short, slim, verdict } from "../src/github/format.js";

test("bad() treats skipped and neutral as not-failures", () => {
  assert.equal(bad("failure"), true);
  assert.equal(bad("timed_out"), true);
  assert.equal(bad("cancelled"), true);
  assert.equal(bad("success"), false);
  assert.equal(bad("skipped"), false);
  assert.equal(bad("neutral"), false);
  assert.equal(bad(null), false, "a null conclusion means still running");
});

test("verdict() columns are all the same width", () => {
  const widths = new Set(
    [
      verdict("success"),
      verdict("failure"),
      verdict("skipped"),
      verdict(null, "in_progress"),
      verdict(null, "queued"),
      verdict(null, undefined),
    ].map((v) => v.length),
  );
  assert.equal(widths.size, 1, `expected one width, got ${[...widths].join(",")}`);
});

test("short() takes seven characters", () => {
  assert.equal(short("07f0226d3d1f88297920bbc1b4b4cf76d633f129"), "07f0226");
  assert.equal(short(undefined), "");
});

test("firstLine() truncates and keeps only the first line", () => {
  assert.equal(firstLine("one\ntwo\nthree"), "one");
  assert.equal(firstLine("x".repeat(100), 10), `${"x".repeat(10)}\u2026`);
  assert.equal(firstLine(null), "");
});

test("slim() keeps requested keys and drops empties", () => {
  const out = slim([{ a: 1, b: null, c: "keep", d: "drop" }], ["a", "b", "c"]);
  assert.deepEqual(out, [{ a: 1, c: "keep" }]);
});

test("pad() is exactly the requested width", () => {
  assert.equal(pad("ab", 5).length, 5);
  assert.equal(pad("abcdefgh", 3), "abc");
  assert.equal(pad(null, 4), "    ");
});

test("day() takes the date part of an ISO timestamp", () => {
  assert.equal(day("2026-08-03T02:00:11.863Z"), "2026-08-03");
});

test("numbered() starts where told", () => {
  const out = numbered(["first", "second"], 10).split("\n");
  assert.match(out[0] ?? "", /^\s+10\s+first$/);
  assert.match(out[1] ?? "", /^\s+11\s+second$/);
});
