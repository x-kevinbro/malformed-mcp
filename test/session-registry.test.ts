import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  readSessionState,
  restartNotice,
  timeAgo,
  writeSessionState,
  type SessionState,
} from "../src/session-registry.js";

async function tempFile(name = "sessions.json"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-registry-"));
  return path.join(dir, name);
}

const state = (ids: string[], startedAt = "2026-08-04T04:00:00.000Z"): SessionState => ({
  startedAt,
  sessions: ids.map((id) => ({ id, openedAt: startedAt })),
});

test("a missing file is not an error", async () => {
  assert.equal(readSessionState(await tempFile()), undefined);
});

test("a corrupt file is not an error", async () => {
  const file = await tempFile();
  await fs.writeFile(file, "{ not json", "utf8");
  assert.equal(readSessionState(file), undefined);
});

test("valid json of the wrong shape is rejected", async () => {
  const file = await tempFile();
  await fs.writeFile(file, '{"startedAt":"now"}', "utf8");
  assert.equal(readSessionState(file), undefined);
});

test("state survives a round trip", async () => {
  const file = await tempFile();
  writeSessionState(file, state(["abc", "def"]));
  const read = readSessionState(file);
  assert.equal(read?.sessions.length, 2);
  assert.equal(read?.sessions[0]?.id, "abc");
});

/** Session ids are credentials, and the log directory is not private. */
test("the file is written 0600 and leaves no temporary behind", async () => {
  const file = await tempFile();
  writeSessionState(file, state(["abc"]));
  const { mode } = await fs.stat(file);
  assert.equal(mode & 0o777, 0o600);
  await assert.rejects(() => fs.stat(`${file}.tmp`));
});

test("an unwritable path does not throw", () => {
  // Not a path under /proc: mkdirSync hangs there instead of failing. A regular
  // file cannot contain a directory, so this fails fast with ENOTDIR.
  assert.doesNotThrow(() => writeSessionState("/etc/hostname/no/sessions.json", state(["abc"])));
});

test("a known id is told about the restart", () => {
  const now = Date.parse("2026-08-04T05:00:00.000Z");
  const notice = restartNotice("abc", state(["abc"]), "2026-08-04T04:58:00.000Z", now);
  assert.match(notice ?? "", /restarted 2 minutes ago/);
  assert.match(notice ?? "", /Re-initialize/);
});

/** Blaming a restart for an id that never existed would be a lie. */
test("an unknown id gets no restart story", () => {
  const now = Date.parse("2026-08-04T05:00:00.000Z");
  assert.equal(restartNotice("never-seen", state(["abc"]), "2026-08-04T04:58:00.000Z", now), undefined);
  assert.equal(restartNotice("abc", undefined, "2026-08-04T04:58:00.000Z", now), undefined);
});

test("the gap reads the way a person would say it", () => {
  const now = Date.parse("2026-08-04T05:00:00.000Z");
  assert.equal(timeAgo("2026-08-04T04:59:30.000Z", now), "just now");
  assert.equal(timeAgo("2026-08-04T04:59:00.000Z", now), "1 minute ago");
  assert.equal(timeAgo("2026-08-04T04:30:00.000Z", now), "30 minutes ago");
  assert.equal(timeAgo("2026-08-04T02:00:00.000Z", now), "3 hours ago");
  assert.equal(timeAgo("not a date", now), "an unknown time ago");
});
