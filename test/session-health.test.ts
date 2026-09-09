import assert from "node:assert/strict";
import test from "node:test";
import type { Response } from "express";
import {
  armStreamHeartbeat,
  enforceSessionCap,
  forgetSession,
  idleFor,
  reapIdleSessions,
  touchSession,
  type ClosableTransport,
} from "../src/session-health.js";

/** A transport that records whether it was closed. */
function fakeTransport(): ClosableTransport & { closed: boolean } {
  const t = {
    closed: false,
    close: async () => {
      t.closed = true;
    },
  };
  return t;
}

function sessions(ids: string[]) {
  const map = new Map<string, ClosableTransport & { closed: boolean }>();
  for (const id of ids) map.set(id, fakeTransport());
  return map;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a brand new session gets a full grace period instead of being reaped at once", async () => {
  const map = sessions(["fresh"]);
  forgetSession("fresh");

  // Nothing has touched it yet, so the first sweep must only start its clock.
  const first = await reapIdleSessions(map, -1);
  assert.deepEqual(first, [], "an untouched session must survive its first sweep");
  assert.equal(map.size, 1);
  assert.equal(map.get("fresh")!.closed, false);

  // Now that it is being tracked, an expired idle window does reap it.
  const second = await reapIdleSessions(map, -1);
  assert.deepEqual(second, ["fresh"]);
  assert.equal(map.size, 0, "the reaped session must leave the map");
});

test("a session in continuous use is never reaped", async () => {
  const map = sessions(["busy", "quiet"]);
  touchSession("busy");
  touchSession("quiet");

  await sleep(30);
  // Only "busy" reports activity, so only "quiet" has aged past the window.
  touchSession("busy");

  const reaped = await reapIdleSessions(map, 20);
  assert.deepEqual(reaped, ["quiet"]);
  assert.equal(map.has("busy"), true, "an active session must not be collected");
  assert.equal(map.get("busy")!.closed, false);
});

test("reaping closes the transport, it does not just drop the reference", async () => {
  const map = sessions(["leaky"]);
  const transport = map.get("leaky")!;
  touchSession("leaky");

  await reapIdleSessions(map, -1);
  assert.equal(transport.closed, true, "the transport must be closed or its server leaks");
  assert.equal(idleFor("leaky"), 0, "bookkeeping for a reaped session must be dropped");
});

test("the ceiling evicts the least recently used, and keeps the newest work", async () => {
  const map = sessions(["oldest", "older", "newer", "newest"]);
  // Stagger activity so the LRU order is unambiguous.
  for (const id of ["oldest", "older", "newer", "newest"]) {
    touchSession(id);
    await sleep(5);
  }

  const evicted = await enforceSessionCap(map, 2);
  assert.deepEqual(evicted, ["oldest", "older"], "the two stalest sessions should go");
  assert.equal(map.size, 2);
  assert.deepEqual([...map.keys()].sort(), ["newer", "newest"]);
  assert.equal(map.get("newer")!.closed, false, "a surviving session must stay open");
});

test("a session count under the ceiling is left completely alone", async () => {
  const map = sessions(["a", "b"]);
  touchSession("a");
  touchSession("b");
  assert.deepEqual(await enforceSessionCap(map, 64), []);
  assert.equal(map.size, 2);
  // A nonsensical ceiling must not be read as "evict everything".
  assert.deepEqual(await enforceSessionCap(map, 0), []);
  assert.equal(map.size, 2);
});

test("the heartbeat writes comment frames, and stops when told to", async () => {
  const writes: string[] = [];
  const res = {
    writableEnded: false,
    destroyed: false,
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
  } as unknown as Response;

  const stop = armStreamHeartbeat(res, 10);
  await sleep(55);
  const seen = writes.length;
  assert.ok(seen >= 2, `expected repeated keepalives, got ${seen}`);
  // An SSE comment frame: every client ignores it, so it can never be mistaken
  // for a protocol message.
  assert.ok(
    writes.every((frame) => frame.startsWith(":") && frame.endsWith("\n\n")),
    "keepalives must be complete SSE comment frames",
  );

  stop();
  await sleep(40);
  assert.equal(writes.length, seen, "no frames may be written after the disposer runs");
  stop(); // idempotent
});

test("the heartbeat does not write to a stream that has already ended", async () => {
  const writes: string[] = [];
  const res = {
    writableEnded: true,
    destroyed: false,
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
  } as unknown as Response;

  const stop = armStreamHeartbeat(res, 5);
  await sleep(30);
  stop();
  assert.deepEqual(writes, [], "writing after end would throw inside a bare timer");
});

test("an invalid interval disables the heartbeat rather than spinning", () => {
  const res = {
    writableEnded: false,
    destroyed: false,
    write: () => true,
  } as unknown as Response;

  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const stop = armStreamHeartbeat(res, bad);
    assert.equal(typeof stop, "function");
    stop();
  }
});
