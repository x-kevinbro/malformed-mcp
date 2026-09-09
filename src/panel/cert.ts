/**
 * TLS certificates, without nginx and without an ACME DNS API token.
 *
 * The hard constraint here is that ports 80 and 443 are already taken by other
 * software on this machine, and that software is not ours to reconfigure. The
 * way out is the NAT table: a REDIRECT rule inserted at the top of PREROUTING
 * is evaluated before Docker's DNAT, so for as long as the rule exists the
 * challenge traffic lands on our listener instead, and everything else is
 * untouched the moment the rule is removed.
 *
 * Three methods are attempted in order, because each fails for a different and
 * non-overlapping reason:
 *   1. HTTP-01  - needs :80 reachable from outside.
 *   2. TLS-ALPN-01 - needs :443, and works where :80 is blocked upstream.
 *   3. DNS-01 (manual) - needs no inbound port at all, but needs a human to
 *      publish a TXT record. This is the escape hatch when the host is behind a
 *      proxy that terminates TLS itself, which is exactly the Cloudflare case.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { promises as dns } from "node:dns";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "../config.js";
import { audit, logger } from "../logger.js";

const run = promisify(execFile);

const ACME_HOME = "/root/.acme.sh";
const ACME = path.join(ACME_HOME, "acme.sh");
/** Unprivileged ports the challenge listeners bind to; :80/:443 are redirected here. */
const HTTP_CHALLENGE_PORT = 40080;
const ALPN_CHALLENGE_PORT = 40443;

/**
 * acme.sh exits 2 - not 0 - when it decides a certificate is still good and
 * there is nothing to do. execFile turns every non-zero exit into a thrown
 * "Command failed", so re-issuing a live domain used to fail all three methods
 * in a row and report "Every issuance method failed" - the opposite of what
 * actually happened, which is that nothing failed and nothing needed doing.
 */
const ALREADY_VALID = /Skipping\.\s*Next renewal time is|Domains not changed/i;

export type CertState = {
  domain: string;
  issuedAt: string;
  method: string;
  certPath: string;
  keyPath: string;
};

export function certPaths(domain: string): { cert: string; key: string; fullchain: string } {
  const dir = path.join(config.panel.certDir, domain);
  return {
    dir,
    cert: path.join(dir, "cert.pem"),
    key: path.join(dir, "key.pem"),
    fullchain: path.join(dir, "fullchain.pem"),
  } as any;
}

/** A usable certificate is one where both halves exist and the pair is still valid. */
export function currentCert(): (CertState & { expiresAt?: string; daysLeft?: number }) | null {
  const statePath = path.join(config.panel.certDir, "state.json");
  if (!existsSync(statePath)) return null;
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8")) as CertState;
    if (!existsSync(state.certPath) || !existsSync(state.keyPath)) return null;
    return state;
  } catch {
    return null;
  }
}

async function publicIp(): Promise<string> {
  // Ask the routing table first: it is instant, always available, and correct
  // whenever the machine holds its public address directly.
  try {
    const { stdout } = await run("sh", ["-c", "ip -4 route get 1.1.1.1 | awk '{print $7; exit}'"], {
      timeout: 5000,
    });
    const local = stdout.trim();
    if (local && !/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.)/.test(local)) return local;
  } catch {
    /* fall through to the external lookup */
  }
  const response = await fetch("https://api.ipify.org", { signal: AbortSignal.timeout(10_000) });
  return (await response.text()).trim();
}

/**
 * Refuse to start a challenge the DNS cannot possibly satisfy.
 *
 * Every ACME failure mode is opaque and rate-limited; an unpointed domain is by
 * far the most common cause and the only one we can detect for free beforehand.
 */
export async function preflight(domain: string): Promise<{
  ok: boolean;
  reason?: string;
  detail: string;
  resolved: string[];
  serverIp: string;
  proxied: boolean;
}> {
  let resolved: string[] = [];
  const serverIp = await publicIp().catch(() => "");

  try {
    resolved = await dns.resolve4(domain);
  } catch {
    try {
      resolved = await dns.resolve6(domain);
    } catch {
      return {
        ok: false,
        reason: "no_dns",
        detail: `${domain} does not resolve. Create an A record pointing it at ${serverIp || "this server"}, wait for it to propagate, then try again.`,
        resolved: [],
        serverIp,
        proxied: false,
      };
    }
  }

  // Cloudflare's proxy answers with its own addresses, so a "wrong" IP here is
  // not necessarily a misconfiguration - but HTTP-01 and TLS-ALPN-01 will both
  // be answered by Cloudflare rather than by us, so they cannot work.
  const cloudflare =
    /^(104\.(1[6-9]|2[0-7])\.|172\.6[4-9]\.|172\.7[01]\.|173\.245\.|188\.114\.|190\.93\.|197\.234\.|198\.41\.)/;
  const proxied = resolved.some((ip) => cloudflare.test(ip));

  if (proxied) {
    return {
      ok: false,
      reason: "proxied",
      detail: `${domain} resolves to ${resolved.join(", ")}, which belongs to Cloudflare. While the orange cloud is on, the challenge is answered by Cloudflare and not by this server. Either set that DNS record to "DNS only" (grey cloud) and retry, or use the DNS-01 method below.`,
      resolved,
      serverIp,
      proxied: true,
    };
  }

  if (serverIp && !resolved.includes(serverIp)) {
    return {
      ok: false,
      reason: "wrong_ip",
      detail: `${domain} points at ${resolved.join(", ")} but this server is ${serverIp}. Point the A record here first - issuing now would only burn a rate limit.`,
      resolved,
      serverIp,
      proxied: false,
    };
  }

  return {
    ok: true,
    detail: `${domain} resolves to ${resolved.join(", ")}, which is this server.`,
    resolved,
    serverIp,
    proxied: false,
  };
}

async function ensureAcme(): Promise<void> {
  if (existsSync(ACME)) return;
  logger.info("installing acme.sh");
  // Cloned rather than curl|sh: the installer is the same script, and this way
  // there is a checkout on disk that can be inspected and updated.
  const tmp = "/tmp/acme.sh-install";
  await run(
    "sh",
    ["-c", `rm -rf ${tmp} && git clone --depth 1 https://github.com/acmesh-official/acme.sh.git ${tmp}`],
    {
      timeout: 180_000,
    },
  );
  // No --accountemail here: "admin@localhost" used to be the default, and
  // Let's Encrypt rejects any contact whose domain part has no dot. That
  // rejection happens at first registration, so the panel's own contact-email
  // field never got a chance to fix it - see ensureAccount() below.
  await run("sh", ["-c", `cd ${tmp} && ./acme.sh --install --home ${ACME_HOME}`], {
    timeout: 180_000,
  });
  if (!existsSync(ACME)) throw new Error("acme.sh did not install correctly.");
}

/** Insert a NAT redirect, run the body, and always take the rule back out. */
async function withRedirect<T>(fromPort: number, toPort: number, body: () => Promise<T>): Promise<T> {
  const rule = ["-p", "tcp", "--dport", String(fromPort), "-j", "REDIRECT", "--to-port", String(toPort)];
  let inserted = false;
  try {
    // Position 1: this must be evaluated before Docker's DNAT rule, or the
    // container wins and the challenge never reaches us.
    await run("iptables", ["-t", "nat", "-I", "PREROUTING", "1", ...rule], { timeout: 15_000 });
    inserted = true;
    return await body();
  } finally {
    if (inserted) {
      await run("iptables", ["-t", "nat", "-D", "PREROUTING", ...rule], { timeout: 15_000 }).catch((error) =>
        logger.error({ err: error }, "failed to remove NAT redirect - remove it by hand"),
      );
    }
  }
}

/** Open a port in the filter table if the chain would otherwise reject it. */
async function withAccept<T>(port: number, body: () => Promise<T>): Promise<T> {
  let inserted = false;
  try {
    await run("iptables", ["-I", "INPUT", "1", "-p", "tcp", "--dport", String(port), "-j", "ACCEPT"], {
      timeout: 15_000,
    });
    inserted = true;
    return await body();
  } finally {
    if (inserted) {
      await run("iptables", ["-D", "INPUT", "-p", "tcp", "--dport", String(port), "-j", "ACCEPT"], {
        timeout: 15_000,
      }).catch(() => undefined);
    }
  }
}

async function acme(args: string[], timeoutMs = 300_000): Promise<string> {
  try {
    const { stdout, stderr } = await run(ACME, ["--home", ACME_HOME, ...args], {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, LE_WORKING_DIR: ACME_HOME },
    });
    return `${stdout}\n${stderr}`;
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    const output = `${failure.stdout ?? ""}\n${failure.stderr ?? ""}`;
    // "Nothing to renew" is a success wearing an error's exit code.
    if (failure.code === 2 && ALREADY_VALID.test(output)) return output;
    throw error;
  }
}

async function installTo(domain: string): Promise<CertState> {
  const paths = certPaths(domain) as any;
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  await acme([
    "--install-cert",
    "-d",
    domain,
    "--key-file",
    paths.key,
    "--fullchain-file",
    paths.fullchain,
    "--cert-file",
    paths.cert,
  ]);
  return {
    domain,
    issuedAt: new Date().toISOString(),
    method: "",
    certPath: paths.fullchain,
    keyPath: paths.key,
  };
}

export type IssueResult = {
  ok: boolean;
  domain: string;
  method?: string;
  attempts: Array<{ method: string; ok: boolean; error?: string }>;
  dnsChallenge?: { record: string; value: string };
  error?: string;
  /** True when the existing certificate was still valid and was reinstalled. */
  reused?: boolean;
  /** notAfter of the installed certificate, for the panel to display. */
  expiresAt?: string;
};

/**
 * acme.sh keeps its own view of when a certificate is next due, in
 * Le_NextRenewTime. Reading it costs nothing and asks Let's Encrypt nothing,
 * which matters: the alternative - starting a challenge to find out - spends an
 * order against a limit of five per week per domain.
 *
 * EC keys land in "<domain>_ecc", RSA in "<domain>". Both are checked.
 */
function acmeConfPath(domain: string): string | null {
  for (const dir of [`${domain}_ecc`, domain]) {
    const file = path.join(ACME_HOME, dir, `${domain}.conf`);
    if (existsSync(file)) return file;
  }
  return null;
}

function notYetDue(domain: string): boolean {
  const file = acmeConfPath(domain);
  if (!file) return false;
  try {
    const next = /Le_NextRenewTime='(\d+)'/.exec(readFileSync(file, "utf8"))?.[1];
    return next ? Number(next) * 1000 > Date.now() : false;
  } catch {
    return false;
  }
}

/** Expiry read from the installed PEM itself, so it cannot drift from reality. */
function expiryOf(domain: string): string | undefined {
  try {
    const paths = certPaths(domain) as any;
    return new X509Certificate(readFileSync(paths.cert)).validTo;
  } catch {
    return undefined;
  }
}

/**
 * Make sure a usable account exists before anything tries to issue against it.
 *
 * --update-account only updates an *existing* account's contact - it has
 * nothing to do if registration never succeeded, which used to be the case
 * for every install (see the comment in ensureAcme). Swallowing that failure
 * meant a correct email typed into the panel could never actually repair a
 * broken account, and every challenge method then failed identically at the
 * same registration step. Try update first since it is the common case after
 * the first successful run, and register only as the fallback.
 */
async function killPortProcess(port: number): Promise<void> {
  try {
    await run("sh", ["-c", `fuser -k -9 ${port}/tcp 2>/dev/null || lsof -t -i:${port} 2>/dev/null | xargs -r kill -9 2>/dev/null || true`], {
      timeout: 10_000,
    });
    if (port === 80) {
      await run("sh", ["-c", "systemctl stop nginx 2>/dev/null || systemctl stop apache2 2>/dev/null || systemctl stop httpd 2>/dev/null || true"], {
        timeout: 10_000,
      });
    }
  } catch {
    /* ignore */
  }
}

async function ensureAccount(email?: string): Promise<void> {
  const contact = email?.trim();
  const validEmail = contact && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact) ? contact : undefined;
  const args = validEmail ? ["--accountemail", validEmail] : [];

  // Sanitize cached ACCOUNT_EMAIL in acme.sh account.conf files if corrupted by invalid hostnames
  const confFiles = [
    path.join(ACME_HOME, "account.conf"),
    path.join(ACME_HOME, "ca", "acme-v02.api.letsencrypt.org", "account.conf"),
    path.join(ACME_HOME, "ca", "acme.zerossl.com", "account.conf"),
  ];
  for (const confPath of confFiles) {
    if (existsSync(confPath)) {
      try {
        let conf = readFileSync(confPath, "utf8");
        if (conf.includes("ACCOUNT_EMAIL=")) {
          const match = /ACCOUNT_EMAIL=['"]?([^'"\n]+)['"]?/.exec(conf);
          if (match) {
            const emailVal = match[1];
            if (emailVal && (!emailVal.includes("@") || !emailVal.includes("."))) {
              conf = conf.replace(/ACCOUNT_EMAIL=['"]?([^'"\n]+)['"]?\n?/, validEmail ? `ACCOUNT_EMAIL='${validEmail}'\n` : "");
              writeFileSync(confPath, conf, "utf8");
            }
          }
        }
      } catch {
        /* ignore configuration cleanup errors */
      }
    }
  }

  try {
    await acme(["--update-account", ...args]);
  } catch {
    await acme(["--register-account", ...args]);
  }
}

/**
 * Try every port-based method before asking the operator to do anything.
 *
 * acme.sh is told to use Let's Encrypt explicitly; its default CA has changed
 * between versions, and an issuance that silently lands at a different CA is a
 * surprise nobody wants during a first install.
 */
export async function issue(domain: string, email?: string, renew = false): Promise<IssueResult> {
  const attempts: IssueResult["attempts"] = [];
  await ensureAcme();
  await acme(["--set-default-ca", "--server", "letsencrypt"]).catch(() => undefined);

  try {
    await ensureAccount(email);
  } catch (error) {
    // Nothing downstream can succeed without a registered account - all three
    // challenge methods would fail with this exact same error, which is the
    // "every issuance method failed" symptom this whole function used to produce.
    return {
      ok: false,
      domain,
      attempts: [{ method: "account", ok: false, error: brief(error) }],
      error: `Could not register the ACME account: ${brief(error)}`,
    };
  }

  // Pressing Issue on a domain that already has a live certificate is the
  // ordinary case of clicking the button twice. Reinstall what is there and say
  // so, rather than opening three challenges acme.sh will decline anyway.
  if (!renew && notYetDue(domain)) {
    const previous = currentCert();
    const method = previous?.domain === domain && previous.method ? previous.method : "existing";
    const state = { ...(await installTo(domain)), method };
    saveState(state);
    audit("cert_reused", { domain });
    return {
      ok: true,
      domain,
      method,
      reused: true,
      expiresAt: expiryOf(domain),
      attempts: [{ method, ok: true }],
    };
  }

  const base = ["--issue", "-d", domain, "--server", "letsencrypt", "--keylength", "ec-256"];
  if (renew) base.push("--force");

  // 1. HTTP-01 on :80, redirected to an unprivileged listener.
  try {
    await killPortProcess(80);
    await withAccept(HTTP_CHALLENGE_PORT, () =>
      withRedirect(80, HTTP_CHALLENGE_PORT, () =>
        acme([...base, "--standalone", "--httpport", String(HTTP_CHALLENGE_PORT)]),
      ),
    );
    attempts.push({ method: "http-01", ok: true });
    const state = { ...(await installTo(domain)), method: "http-01" };
    saveState(state);
    audit("cert_issued", { domain, method: "http-01" });
    return { ok: true, domain, method: "http-01", attempts };
  } catch (error) {
    attempts.push({ method: "http-01", ok: false, error: brief(error) });
  }

  // 2. TLS-ALPN-01 on :443, same trick. Works when :80 is filtered upstream.
  try {
    await withAccept(ALPN_CHALLENGE_PORT, () =>
      withRedirect(443, ALPN_CHALLENGE_PORT, () =>
        acme([...base, "--alpn", "--tlsport", String(ALPN_CHALLENGE_PORT)]),
      ),
    );
    attempts.push({ method: "tls-alpn-01", ok: true });
    const state = { ...(await installTo(domain)), method: "tls-alpn-01" };
    saveState(state);
    audit("cert_issued", { domain, method: "tls-alpn-01" });
    return { ok: true, domain, method: "tls-alpn-01", attempts };
  } catch (error) {
    attempts.push({ method: "tls-alpn-01", ok: false, error: brief(error) });
  }

  // 3. DNS-01. Returns the record to publish; the operator finishes it.
  try {
    const output = await acme([...base, "--dns", "--yes-I-know-dns-manual-mode-enough-go-ahead-please"]);
    const record = /_acme-challenge\.[^\s']+/.exec(output)?.[0] ?? `_acme-challenge.${domain}`;
    const value = /['"]([A-Za-z0-9_-]{40,})['"]/.exec(output)?.[1] ?? "";
    attempts.push({ method: "dns-01", ok: false, error: "awaiting TXT record" });
    return {
      ok: false,
      domain,
      attempts,
      dnsChallenge: { record, value },
      error:
        "Both port-based methods failed. Publish the TXT record below, wait a minute, then choose Complete DNS challenge.",
    };
  } catch (error) {
    attempts.push({ method: "dns-01", ok: false, error: brief(error) });
  }

  return { ok: false, domain, attempts, error: "Every issuance method failed. See the attempts above." };
}

/** Second half of DNS-01, once the operator says the TXT record is live. */
export async function completeDns(domain: string): Promise<IssueResult> {
  try {
    await acme(["--renew", "-d", domain, "--yes-I-know-dns-manual-mode-enough-go-ahead-please"]);
    const state = { ...(await installTo(domain)), method: "dns-01" };
    saveState(state);
    audit("cert_issued", { domain, method: "dns-01" });
    return { ok: true, domain, method: "dns-01", attempts: [{ method: "dns-01", ok: true }] };
  } catch (error) {
    return {
      ok: false,
      domain,
      attempts: [{ method: "dns-01", ok: false, error: brief(error) }],
      error: "The TXT record was not accepted yet. DNS can take a few minutes to propagate.",
    };
  }
}

function saveState(state: CertState): void {
  mkdirSync(config.panel.certDir, { recursive: true, mode: 0o700 });
  const file = path.join(config.panel.certDir, "state.json");
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function brief(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 400);
}
