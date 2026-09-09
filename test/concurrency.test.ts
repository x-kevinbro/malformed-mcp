import assert from "node:assert/strict";
import test from "node:test";
import { createGate } from "../src/concurrency.js";

/** A promise plus the handles to settle it from the outside. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("the limit is never exceeded, however many callers arrive at once", async () => {
  const gate = createGate(3);
  const gates = Array.from({ length: 10 }, () => deferred());
  let running = 0;
  let peak = 0;

  const work = gates.map(async (blocker) => {
    const release = await gate.acquire();
    running += 1;
    peak = Math.max(peak, running);
    await blocker.promise;
    running -= 1;
    release();
  });

  // Let all ten reach the gate, then drain them one at a time.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peak, 3, "only three should have started");
  assert.equal(gate.active, 3);
  assert.equal(gate.queued, 7);

  for (const blocker of gates) {
    blocker.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  }
  await Promise.all(work);

  assert.equal(peak, 3, "the ceiling should hold for the whole drain, not just the start");
  assert.equal(gate.active, 0);
  assert.equal(gate.queued, 0);
});

test("callers are served in the order they arrived", async () => {
  const gate = createGate(1);
  const entered: number[] = [];
  const blockers = Array.from({ length: 5 }, () => deferred());

  const work = blockers.map(async (blocker, index) => {
    const release = await gate.acquire();
    entered.push(index);
    await blocker.promise;
    release();
  });

  for (const blocker of blockers) {
    await new Promise((resolve) => setImmediate(resolve));
    blocker.resolve();
  }
  await Promise.all(work);

  assert.deepEqual(entered, [0, 1, 2, 3, 4]);
});

test("a throw inside one slot does not wedge the queue", async () => {
  const gate = createGate(1);

  const first = (async () => {
    const release = await gate.acquire();
    try {
      throw new Error("boom");
    } finally {
      release();
    }
  })();

  await assert.rejects(first, /boom/);

  // The slot must come back, or every later caller waits forever.
  const release = await gate.acquire();
  assert.equal(gate.active, 1);
  release();
  assert.equal(gate.active, 0);
});

test("releasing twice does not hand out a slot that is still in use", async () => {
  const gate = createGate(1);
  const release = await gate.acquire();
  release();
  release();
  assert.equal(gate.active, 0, "a double release must not drive the count negative");

  const again = await gate.acquire();
  assert.equal(gate.active, 1);
  again();
});

test("a nonsense limit is rejected at construction, not at the first call", () => {
  assert.throws(() => createGate(0), /positive integer/);
  assert.throws(() => createGate(-1), /positive integer/);
  assert.throws(() => createGate(1.5), /positive integer/);
});
