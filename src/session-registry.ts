/**
 * Session bookkeeping that outlives the process.
 *
 * A session itself cannot survive a restart. The SDK keeps transport state in
 * memory and exposes sessionId as a getter with no setter, so there is no
 * supported way to readopt an id after the process dies. What we can fix is the
 * explanation: a client presenting an id from before a swap should be told the
 * session existed and that the server restarted under it, rather than getting a
 * bare "Unknown session" that reads like the id was never valid.
 *
 * Imports nothing but node builtins so it can be unit tested without a
 * configured environment.
 */
import fs from "node:fs";
import path from "node:path";

export type SessionRecord = { id: string; openedAt: string };

export type SessionState = {
  /** ISO time at which the process that wrote this file started. */
  startedAt: string;
  sessions: SessionRecord[];
};

/**
 * The previous run's state. A missing, unreadable or corrupt file is an ordinary
 * outcome, not an error: it just means we cannot say anything useful yet.
 */
export function readSessionState(file: string): SessionState | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const { startedAt, sessions } = parsed as Partial<SessionState>;
    if (typeof startedAt !== "string" || !Array.isArray(sessions)) return undefined;
    const clean = sessions.filter((entry): entry is SessionRecord => !!entry && typeof entry.id === "string");
    return { startedAt, sessions: clean };
  } catch {
    return undefined;
  }
}

/**
 * Replaces the file in one rename so a restart mid-write cannot leave a torn
 * file behind. Best effort throughout: bookkeeping must never take the server
 * down, and 0600 because session ids are credentials.
 */
export function writeSessionState(file: string, state: SessionState): void {
  const temp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // Nothing further to try.
    }
  }
}

/** A rough, readable gap: "just now", "3 minutes ago", "2 hours ago". */
export function timeAgo(fromIso: string, now: number): string {
  const then = Date.parse(fromIso);
  if (Number.isNaN(then)) return "an unknown time ago";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/**
 * The message for a session id the running process does not know.
 *
 * Returns undefined when the id was never seen, so the caller keeps the generic
 * answer instead of blaming a restart that had nothing to do with it.
 */
export function restartNotice(
  sessionId: string,
  previous: SessionState | undefined,
  restartedAt: string,
  now: number,
): string | undefined {
  if (!previous) return undefined;
  if (!previous.sessions.some((entry) => entry.id === sessionId)) return undefined;
  return (
    `This session was open until the server restarted ${timeAgo(restartedAt, now)}. ` +
    `Sessions do not survive a restart. Re-initialize the connection; the new session id will differ.`
  );
}
