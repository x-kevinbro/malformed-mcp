import test from "node:test";
import assert from "node:assert/strict";
import { condense, type LogOptions } from "../src/github/logs.js";

const options = (overrides: Partial<LogOptions> = {}): LogOptions => ({
  mode: "errors",
  tail: 5,
  context: 1,
  stripTimestamps: true,
  ...overrides,
});

/** A log shaped like a real one: noise, a buried failure, then a summary. */
const RAW = [
  "2026-08-02T20:00:00.000Z ##[group]Run actions/checkout@v5",
  "2026-08-02T20:00:01.000Z Syncing repository",
  "2026-08-02T20:00:02.000Z ##[endgroup]",
  "2026-08-02T20:00:03.000Z installing dependencies",
  "2026-08-02T20:00:04.000Z added 812 packages",
  "2026-08-02T20:00:05.000Z linting backend",
  "2026-08-02T20:00:06.000Z ##[error]  25:11  error  Unsafe assignment of an `any` value",
  "2026-08-02T20:00:07.000Z after the error",
  "2026-08-02T20:00:08.000Z filler one",
  "2026-08-02T20:00:09.000Z filler two",
  "2026-08-02T20:00:10.000Z summary line",
].join("\n");

test("errors mode surfaces the failing line", () => {
  const out = condense(RAW, options());
  assert.match(out, /Unsafe assignment/);
});

test("errors mode drops the setup noise", () => {
  const out = condense(RAW, options());
  assert.doesNotMatch(out, /Syncing repository/);
  assert.doesNotMatch(out, /added 812 packages/);
});

test("group markers are always stripped", () => {
  assert.doesNotMatch(condense(RAW, options({ mode: "full" })), /##\[(group|endgroup)\]/);
});

test("timestamps are stripped when asked, kept when not", () => {
  assert.doesNotMatch(condense(RAW, options({ mode: "full" })), /2026-08-02T20:00:00/);
  assert.match(condense(RAW, options({ mode: "full", stripTimestamps: false })), /2026-08-02T20:00:00/);
});

test("context lines are included around a match", () => {
  const out = condense(RAW, options({ context: 1 }));
  assert.match(out, /linting backend/, "the line before the error");
  assert.match(out, /after the error/, "the line after it");
});

test("the tail is always kept, so a log with no error still says something", () => {
  const clean = ["step one", "step two", "all good", "done", "bye"].join("\n");
  assert.match(condense(clean, options()), /bye/);
});

test("tail mode returns only the last lines, numbered from the right place", () => {
  const out = condense(RAW, options({ mode: "tail", tail: 2 }));
  assert.match(out, /summary line/);
  assert.match(out, /filler two/);
  assert.doesNotMatch(out, /linting backend/);
  assert.match(out, /^\s+8\s/m, "numbering should reflect the original position");
});

test("full mode keeps every non-group line", () => {
  const lines = condense(RAW, options({ mode: "full" })).split("\n");
  assert.equal(lines.length, 9, "11 lines minus the 2 group markers");
});

test("omission markers appear where lines were dropped", () => {
  const out = condense(RAW, options({ context: 0, tail: 1 }));
  assert.match(out, /line\(s\) omitted/);
});

test("a contiguous keep range has no omission marker", () => {
  assert.doesNotMatch(condense(RAW, options({ context: 1, tail: 5 })), /line\(s\) omitted/);
});

test("a custom grep overrides the error matcher", () => {
  const out = condense(RAW, options({ grep: "812 packages", context: 0, tail: 1 }));
  assert.match(out, /added 812 packages/);
});
