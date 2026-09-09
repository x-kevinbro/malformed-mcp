/**
 * A FIFO concurrency gate.
 *
 * Nothing stood in front of the shell before this. The rate limiter caps
 * requests per minute per IP, which is a different quantity: one request can
 * start a command that runs for thirty minutes, and maxTimeoutMs allows
 * exactly that. An agent making parallel calls could therefore hold dozens of
 * live child processes against MemoryMax=2G, and the unit is Restart=always -
 * so the OOM killer does not merely fail the offending call, it restarts the
 * server and drops every session with it.
 *
 * The gate queues rather than refuses. Refusing is right for the browser, where
 * there is one shared, stateful resource and a queue would only defer a
 * conflict; it is wrong here, where the work is independent and waiting costs
 * nothing but time. A model that receives "too busy, retry" will retry, which
 * is precisely the load you were trying to shed.
 *
 * Order is preserved: callers leave in the order they arrived. That matters
 * because an agent that fires read, patch, read expects the patch to have
 * happened before the second read.
 */
export type Gate = {
  /** Wait for a slot. Resolves with the release function; call it exactly once. */
  acquire: () => Promise<() => void>;
  /** How many slots exist. */
  readonly limit: number;
  /** How many are in use right now. */
  readonly active: number;
  /** How many callers are waiting for one. */
  readonly queued: number;
};

export function createGate(limit: number): Gate {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`Concurrency limit must be a positive integer, got ${limit}.`);
  }

  let active = 0;
  const waiting: Array<() => void> = [];

  async function acquire(): Promise<() => void> {
    if (active < limit) {
      // Claim the slot synchronously, before any await. Two callers in the same
      // tick would otherwise both see room and both take the last slot.
      active += 1;
    } else {
      // Join the queue. The slot is handed straight over on release, so `active`
      // is deliberately not incremented here - it never dropped.
      await new Promise<void>((resolve) => waiting.push(resolve));
    }

    let released = false;
    return () => {
      // Idempotent. A double release would hand out a slot that is still in use,
      // and the bug would only show under load, which is the worst time to find
      // it.
      if (released) return;
      released = true;
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    };
  }

  return {
    acquire,
    get limit() {
      return limit;
    },
    get active() {
      return active;
    },
    get queued() {
      return waiting.length;
    },
  };
}
