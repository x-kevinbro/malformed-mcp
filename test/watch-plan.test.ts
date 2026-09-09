import test from "node:test";
import assert from "node:assert/strict";
import {
  finishedSummary,
  isFinished,
  nextDelayMs,
  sleepFor,
  stillRunning,
  type RunFacts,
} from "../src/github/watch-plan.js";

const run: RunFacts = {
  id: 7,
  name: "CI",
  status: "completed",
  conclusion: "failure",
  headSha: "abcdef1234567",
  branch: "main",
  title: "a commit that broke something",
  url: "https://github.com/o/r/actions/runs/7",
};

test("a completed run is finished, a queued one is not", () => {
  assert.equal(isFinished({ status: "completed", conclusion: "success" }), true);
  assert.equal(isFinished({ status: "queued", conclusion: null }), false);
  assert.equal(isFinished({ status: "in_progress", conclusion: null }), false);
});

test("a conclusion means finished even if the status has not caught up", () => {
  assert.equal(isFinished({ status: "in_progress", conclusion: "cancelled" }), true);
});

test("the poll interval backs off, and stays inside its bounds", () => {
  assert.equal(nextDelayMs(0), 3_000);
  assert.equal(nextDelayMs(30_000), 6_000);
  assert.equal(nextDelayMs(60_000), 12_000);
  assert.equal(nextDelayMs(10 * 60_000), 15_000, "caps at the ceiling");
  assert.equal(nextDelayMs(-5), 3_000, "a negative elapsed cannot shrink the floor");
});

test("the sleep never overruns the budget", () => {
  assert.equal(sleepFor(0, 45_000), 3_000);
  assert.equal(sleepFor(44_000, 45_000), 1_000, "the last nap is trimmed to what is left");
  assert.equal(sleepFor(45_000, 45_000), 0, "an exhausted budget does not sleep");
  assert.equal(sleepFor(60_000, 45_000), 0, "nor does an overrun one");
});

test("the summary names every failing step and points at the logs", () => {
  const text = finishedSummary(
    run,
    [
      { job: "build", step: "npm run check", conclusion: "failure" },
      { job: "build", step: "upload", conclusion: "failure" },
    ],
    12_000,
  );

  assert.match(text, /^FAIL {2}abcdef1/);
  assert.match(text, /after 12s of waiting/);
  assert.match(text, /build \/ npm run check -> failure/);
  assert.match(text, /build \/ upload -> failure/);
  assert.match(text, /gh_actions method=logs/);
});

test("a passing run is reported without a log pointer it does not need", () => {
  const text = finishedSummary({ ...run, conclusion: "success" }, [], 5_000);
  assert.match(text, /^pass/);
  assert.doesNotMatch(text, /gh_actions/);
});

test("a failure with no failing step still says where to look", () => {
  const text = finishedSummary(run, [], 5_000);
  assert.match(text, /No failing step was reported/);
});

test("the still-running answer tells the caller to call again", () => {
  const text = stillRunning({ ...run, status: "in_progress", conclusion: null }, 45_000, 6);
  assert.match(text, /still going after 45s \(6 checks\)/);
  assert.match(text, /Call gh_watch again/);
});

test("waiting for a run that never appeared says so, and why", () => {
  const text = stillRunning(null, 45_000, 6);
  assert.match(text, /No run found yet after 45s/);
  assert.match(text, /takes a moment to appear after a push/);
});
