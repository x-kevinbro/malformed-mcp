/**
 * Session hygiene for the Streamable HTTP transport.
 *
 * Three things were missing, and together they are what makes a burst of
 * parallel tool calls look like "the MCP server went away":
 *
 * 1. No heartbeat. Each session keeps a long-lived GET /mcp open, and the
 *    transport writes nothing to it while it is idle. To every NAT, proxy and
 *    load balancer in the path an idle stream is indistinguishable from a dead
 *    one, so they drop it - all of them at once, which is why a dozen sessions
 *    aborted in the same second after ~9 minutes of silence. The SDK ships an
 *    equivalent helper (server/sseKeepAlive.js) that it never arms itself; this
 *    is the same idea, kept local so the fix does not depend on a deep import.
 *
 * 2. No reaping. A session left only on an explicit DELETE, so clients that
 *    open one session per call accumulated them without bound.
 *
 * 3. No ceiling. Unbounded sessions against a fixed memory budget is a slow
 *    leak that surfaces as an OOM restart, which drops every *other* session
 *    too.
 *
 * Idleness is measured from the last request that referenced the session, not
 * from when it opened: a session in continuous use must never be reaped.
 */

import type { Response } from "express";

/** The part of a transport this module needs. Structural, to avoid a hard dep. */
export type ClosableTransport = { close: () => Promise<void> };

const lastSeen = new Map<string, number>();

/** Mark a session as alive. Call this on every request that names one. */
export function touchSession(id: string): void {
  lastSeen.set(id, Date.now());
}

/** Drop bookkeeping for a session that is gone. */
export function forgetSession(id: string): void {
  lastSeen.delete(id);
}

/** How long a session has been idle, in ms. Unknown sessions read as 0. */
export function idleFor(id: string, now: number = Date.now()): number {
  const seen = lastSeen.get(id);
  return seen === undefined ? 0 : now - seen;
}

export function trackedSessions(): number {
  return lastSeen.size;
}

/**
 * Write periodic SSE comment frames to keep the stream visibly alive.
 *
 * A frame beginning with ":" is a comment: every SSE client ignores it, so this
 * cannot be confused with a protocol message. Each write is one complete frame,
 * so it cannot interleave with a half-written message from the transport.
 *
 * Returns a disposer; call it when the response closes.
 */
export function armStreamHeartbeat(res: Response, intervalMs: number): () => void {
  if (!Number.isFinite(intervalMs) || intervalMs < 1) return () => undefined;

  const timer = setInterval(() => {
    // writableEnded goes true the moment the peer disappears. Writing then
    // raises ERR_STREAM_WRITE_AFTER_END, which as an unhandled throw inside a
    // timer would take the process down.
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(": ping\n\n");
    } catch {
      // The stream died between the check and the write. Nothing to do: the
      // close handler is what cleans up.
    }
  }, intervalMs);

  // unref so a live heartbeat never keeps the process from exiting.
  timer.unref?.();

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * Close sessions that have gone quiet for longer than idleMs.
 *
 * Returns the ids it closed, so the caller can log or audit them.
 */
export async function reapIdleSessions(
  transports: Map<string, ClosableTransport>,
  idleMs: number,
): Promise<string[]> {
  const now = Date.now();
  const expired: string[] = [];

  for (const id of transports.keys()) {
    // A session with no recorded activity yet is given the full grace period
    // rather than reaped immediately after opening.
    if (!lastSeen.has(id)) {
      touchSession(id);
      continue;
    }
    if (idleFor(id, now) > idleMs) expired.push(id);
  }

  for (const id of expired) {
    const transport = transports.get(id);
    transports.delete(id);
    forgetSession(id);
    if (transport) await transport.close().catch(() => undefined);
  }

  return expired;
}

/**
 * Enforce a hard ceiling by closing the least recently used sessions.
 *
 * Evicting the oldest is the right choice over refusing the newest: the client
 * asking for a session now is the one doing work, and a refusal only makes it
 * retry, which is the load you were trying to shed.
 */
export async function enforceSessionCap(
  transports: Map<string, ClosableTransport>,
  maxSessions: number,
): Promise<string[]> {
  if (!Number.isFinite(maxSessions) || maxSessions < 1) return [];
  const overBy = transports.size - maxSessions;
  if (overBy <= 0) return [];

  const byAge = [...transports.keys()].sort((a, b) => (lastSeen.get(a) ?? 0) - (lastSeen.get(b) ?? 0));
  const doomed = byAge.slice(0, overBy);

  for (const id of doomed) {
    const transport = transports.get(id);
    transports.delete(id);
    forgetSession(id);
    if (transport) await transport.close().catch(() => undefined);
  }

  return doomed;
}

/**
 * Run the reaper on a timer. Returns a stop function.
 */
export function startSessionReaper(
  transports: Map<string, ClosableTransport>,
  options: {
    idleMs: number;
    intervalMs: number;
    onReap?: (ids: string[]) => void;
  },
): () => void {
  const timer = setInterval(() => {
    void reapIdleSessions(transports, options.idleMs)
      .then((ids) => {
        if (ids.length && options.onReap) options.onReap(ids);
      })
      .catch(() => undefined);
  }, options.intervalMs);

  timer.unref?.();
  return () => clearInterval(timer);
}
