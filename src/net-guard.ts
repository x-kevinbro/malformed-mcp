/**
 * Outbound request policy.
 *
 * This server can already fetch arbitrary URLs, and once a browser is added it
 * will be able to reach anything the host can: the app on 127.0.0.1:3000, the
 * database on 5432, cloud metadata endpoints. That is server-side request
 * forgery with a helpful interface, so the policy lives in one enforced place
 * rather than in each caller's good intentions.
 *
 * Defaults stay permissive because probing internal services is a legitimate
 * and frequent use of this box. Set net.blockPrivate=true, or an explicit
 * net.allowHosts list, to lock it down - and do so before exposing a browser.
 */
import dns from "node:dns/promises";
import net from "node:net";
import { config } from "./config.js";

export class BlockedRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedRequestError";
  }
}

/** Glob match on a hostname: "*", "*.example.com", or an exact host. */
export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  if (p === "*") return true;
  if (p.startsWith("*.")) {
    const suffix = p.slice(1); // ".example.com"
    return h.endsWith(suffix) || h === p.slice(2);
  }
  return h === p;
}

/** Loopback, link-local, RFC1918 and unique-local addresses. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.replace(/^::ffff:/i, "");

  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map(Number);
    const [a = 0, b = 0] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // includes cloud metadata
    if (a >= 224) return true; // multicast and reserved
    return false;
  }

  if (net.isIPv6(ip)) {
    const v6 = ip.toLowerCase();
    if (v6 === "::" || v6 === "::1") return true;
    if (/^f[cd]/.test(v6)) return true; // unique local
    if (v6.startsWith("fe80")) return true; // link local
    return false;
  }

  return false;
}

/**
 * Throw unless this URL may be fetched. Resolves DNS when private addresses are
 * blocked, because a public hostname is free to point at 127.0.0.1.
 */
export async function assertUrlAllowed(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedRequestError(`Not a valid URL: ${rawUrl}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedRequestError(`Blocked ${url.protocol} - only http and https are allowed.`);
  }

  const host = url.hostname;
  const { allowHosts, denyHosts, blockPrivate } = config.net;

  const denied = denyHosts.find((pattern) => hostMatches(host, pattern));
  if (denied) {
    throw new BlockedRequestError(`${host} is blocked by net.denyHosts (matched "${denied}").`);
  }

  if (allowHosts.length > 0 && !allowHosts.some((pattern) => hostMatches(host, pattern))) {
    throw new BlockedRequestError(`${host} is not in net.allowHosts. Permitted: ${allowHosts.join(", ")}.`);
  }

  if (!blockPrivate) return;

  const addresses = net.isIP(host)
    ? [host]
    : await dns
        .lookup(host, { all: true })
        .then((records) => records.map((r) => r.address))
        .catch(() => [] as string[]);

  const priv = addresses.find(isPrivateAddress);
  if (priv) {
    throw new BlockedRequestError(
      `${host} resolves to the private address ${priv}, and net.blockPrivate is enabled.`,
    );
  }
}
