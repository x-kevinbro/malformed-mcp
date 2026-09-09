/**
 * Target policy for the security-assessment tools.
 *
 * The rest of this server is useful without a target; a scanner is not. That
 * asymmetry matters, because a scanner or load generator aimed at the wrong
 * host is an attack rather than an assessment. So these tools carry a mandatory
 * allowlist: sec.allowTargets names the hosts they may touch, and a target outside
 * it is refused before any process is started. The default is this deployment's
 * own hosts, so the tools work out of the box without being pointable at the
 * rest of the internet.
 */
import { config } from "./config.js";
import { hostMatches } from "./net-guard.js";

export class SecurityTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecurityTargetError";
  }
}

/**
 * Pull the bare hostname out of whatever form a target arrives in: an
 * "https://host/path" URL, a "host:port" pair, a bracketed IPv6 literal, or a
 * bare host. Returns the lowercased hostname, or null when none is there.
 */
export function extractHost(target: string): string | null {
  const trimmed = target.trim();
  if (!trimmed) return null;

  // A URL, if it parses as one with a scheme.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).hostname.toLowerCase() || null;
    } catch {
      return null;
    }
  }

  // A bracketed IPv6 literal, with or without a port.
  const bracket = /^\[([^\]]+)\]/.exec(trimmed);
  if (bracket && bracket[1]) return bracket[1].toLowerCase();

  // Otherwise a bare host or host:port, tolerating a trailing path.
  const host = trimmed.split("/")[0]?.split(":")[0] ?? "";
  return host.toLowerCase() || null;
}

/**
 * Throw unless this target is on the security allowlist. Returns the resolved
 * hostname so the caller can log exactly what it accepted.
 */
export function assertTargetAllowed(target: string): string {
  const host = extractHost(target);
  if (!host) {
    throw new SecurityTargetError(`Could not read a hostname from target "${target}".`);
  }

  const allow = config.sec.allowTargets;
  if (allow.length === 0) {
    throw new SecurityTargetError(
      "sec.allowTargets is empty, so the security tools have no permitted targets. " +
        "Set it to the hosts you are authorised to test.",
    );
  }

  if (!allow.some((pattern: string) => hostMatches(host, pattern))) {
    throw new SecurityTargetError(
      `${host} is not in sec.allowTargets. These tools may only be aimed at: ${allow.join(", ")}.`,
    );
  }

  return host;
}
