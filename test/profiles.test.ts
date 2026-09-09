import test from "node:test";
import assert from "node:assert/strict";
import { buildToolFilter, PROFILES, profileSummary } from "../src/profiles.js";

const filter = (profile: string, only: string[] = [], exclude: string[] = []) =>
  buildToolFilter({ profile, only, exclude });

test("full allows everything", () => {
  const f = filter("full");
  assert.ok(f.allow("run_command", false));
  assert.ok(f.allow("docker_logs", false));
});

test("readonly keeps only tools that declare themselves read-only", () => {
  const f = filter("readonly");
  assert.ok(f.allow("read_file", true));
  assert.equal(f.allow("run_command", false), false);
  assert.equal(f.allow("write_file", false), false);
});

test("every profile keeps reading and fetch_output available", () => {
  // A profile that cannot read files or retrieve a truncated result is a trap.
  for (const name of Object.keys(PROFILES)) {
    if (name === "readonly" || name === "full") continue;
    const f = filter(name);
    assert.ok(f.allow("read_files", true), `${name} should allow read_files`);
    assert.ok(f.allow("fetch_output", true), `${name} should allow fetch_output`);
    assert.ok(f.allow("tool_catalog", true), `${name} should allow tool_catalog`);
  }
});

test("prefix globs match, and exact names do not over-match", () => {
  const f = filter("full", ["db_*", "journal"]);
  assert.ok(f.allow("db_query", true));
  assert.ok(f.allow("journal", false));
  assert.equal(f.allow("journal_tail", true), false, "exact name must not match by prefix");
});

test("exclude beats both the allowlist and the profile", () => {
  const f = filter("full", ["db_*"], ["db_backup"]);
  assert.ok(f.allow("db_query", false));
  assert.equal(f.allow("db_backup", false), false);
});

test("an unknown profile falls back to full rather than hiding everything", () => {
  // Failing closed here would silently disarm the server on a typo.
  const f = filter("typo-here");
  assert.ok(f.allow("run_command", false));
  assert.match(f.describe(), /unknown/);
});

test("the policy describes itself for the startup log", () => {
  assert.match(filter("debug", [], ["db_query"]).describe(), /profile=debug.*exclude=db_query/);
  assert.match(profileSummary(), /readonly/);
});
