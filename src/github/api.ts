/**
 * The GitHub HTTP client. Every gh_* tool goes through here.
 *
 * This layer holds the things that are easy to get wrong once and then forget:
 * rate limits, transient failures, redirects that must drop the auth header,
 * tokens that quietly expire, and credentials that must never reach a log.
 * Tools above this file should read like a description of an endpoint rather
 * than like network code.
 */
import fs from "node:fs";
import _sodium from "libsodium-wrappers";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { allTokens, currentAccount, fallbackRepo } from "./accounts.js";

const UA = `${config.serverName}/${config.version}`;

// Learned from response headers so gh_status can warn before a token dies and
// so failures can say how long the rate limit has left. Keyed by profile:
// two accounts have two expiries and two rate-limit budgets, and reporting one
// account's quota under another's name is worse than reporting nothing.
const tokenExpiry = new Map<string, string>();
const lastRate = new Map<string, { remaining: number; limit: number; reset: number }>();

/**
 * The placeholder every tool declares as its repo default.
 *
 * This used to be fallbackRepo() evaluated at import time, which was fine when
 * profiles came from the environment and could not change while the process
 * ran. Profiles now live in a file the panel edits, so a value baked at import
 * would be whatever was configured at boot - usually nothing. It is now a
 * sentinel: index.ts compares against it to detect "the caller named no repo"
 * and substitutes the active profile's repo at call time.
 */
export const DEFAULT_REPO = "";

/** Name of the profile this call is running as, or "" if none is configured. */
function activeName(): string {
  try {
    return currentAccount().name;
  } catch {
    return "";
  }
}

export function githubToken(): string {
  return currentAccount().token;
}

/**
 * Strip the token from anything heading for a log or an error message. A failing
 * request is when a URL or body is most likely to be echoed, and also when
 * leaking the credential would be worst.
 */
export function redact(text: string): string {
  let out = text;
  for (const token of allTokens()) out = out.split(token).join("***redacted***");
  return out;
}

export function apiHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${githubToken()}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": config.github.apiVersion,
    "User-Agent": UA,
    ...extra,
  };
}

/** Accepts "/repos/o/r" or a full URL, so Link-header pagination can feed back in. */
export function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${config.github.apiUrl}/${path.replace(/^\/+/, "")}`;
}

export function qs(params: Record<string, unknown>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

export type GhResponse = {
  status: number;
  ok: boolean;
  headers: Headers;
  text: string;
  json: any;
};

export function tokenStatus(): {
  expiry: string | null;
  rate: { remaining: number; limit: number; reset: number } | null;
} {
  const who = activeName();
  return { expiry: tokenExpiry.get(who) ?? null, rate: lastRate.get(who) ?? null };
}

function recordMeta(headers: Headers): void {
  const who = activeName();

  const expiry = headers.get("github-authentication-token-expiration");
  if (expiry) tokenExpiry.set(who, expiry);

  const remaining = headers.get("x-ratelimit-remaining");
  const limit = headers.get("x-ratelimit-limit");
  const reset = headers.get("x-ratelimit-reset");
  if (remaining && limit && reset) {
    lastRate.set(who, {
      remaining: Number(remaining),
      limit: Number(limit),
      reset: Number(reset),
    });
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long to wait before retrying. GitHub tells us directly via Retry-After on
 * secondary limits; otherwise back off exponentially with jitter so several
 * parallel tool calls do not retry in lockstep.
 */
function retryDelayMs(response: Response | null, attempt: number): number {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 60_000);
  }
  const base = Math.min(500 * 2 ** attempt, 15_000);
  return base + Math.floor(Math.random() * 250);
}

function isRetryable(response: Response): boolean {
  if (response.status === 429) return true;
  if (response.status >= 500 && response.status !== 501) return true;
  // A secondary rate limit arrives as 403 carrying Retry-After.
  if (response.status === 403 && response.headers.get("retry-after")) return true;
  return false;
}

/**
 * A primary rate limit is not worth retrying - the window can be an hour away.
 * Fail immediately and say when it reopens rather than hanging the tool call.
 */
function primaryLimitExhausted(response: Response): boolean {
  return response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0";
}

export async function ghRaw(path: string, init: RequestInit = {}): Promise<GhResponse> {
  const target = apiUrl(path);
  const attempts = config.github.maxRetries + 1;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    let response: Response;
    try {
      response = await fetch(target, {
        ...init,
        headers: { ...apiHeaders(), ...((init.headers as Record<string, string>) ?? {}) },
        signal: AbortSignal.timeout(config.github.timeoutMs),
      });
    } catch (error) {
      // Network fault or timeout: worth another go, but not forever.
      lastError = error;
      if (attempt === attempts - 1) break;
      await sleep(retryDelayMs(null, attempt));
      continue;
    }

    recordMeta(response.headers);

    if (isRetryable(response) && !primaryLimitExhausted(response) && attempt < attempts - 1) {
      const wait = retryDelayMs(response, attempt);
      logger.warn({ status: response.status, attempt: attempt + 1, waitMs: wait }, "github request retrying");
      await sleep(wait);
      continue;
    }

    const text = await response.text();
    let json: any;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    return { status: response.status, ok: response.ok, headers: response.headers, text, json };
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(redact(`GitHub request to ${path} failed after ${attempts} attempt(s): ${reason}`));
}

/**
 * A failed GitHub call is usually a permission problem wearing a different
 * status code, so the message names the likely cause instead of leaving the
 * reader to guess.
 */
function describeFailure(r: GhResponse, path: string, method: string): string {
  const message = r.json?.message ?? r.text.slice(0, 300);
  const errors = Array.isArray(r.json?.errors)
    ? ` (${r.json.errors
        .map((e: any) => e.message ?? `${e.resource ?? "?"}.${e.field ?? "?"}: ${e.code ?? "?"}`)
        .join("; ")})`
    : "";

  let hint = "";
  if (r.status === 401) hint = " — the token is invalid or expired. Run gh_status.";
  else if (r.status === 403 && r.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(r.headers.get("x-ratelimit-reset") ?? 0);
    hint = ` — rate limit exhausted; it reopens ${reset ? new Date(reset * 1000).toISOString() : "shortly"}.`;
  } else if (r.status === 403) hint = " — authenticated but not permitted, usually a missing scope.";
  else if (r.status === 404)
    hint =
      " — missing, or invisible to this token. A private repo answers 404 rather than 403 when a scope is absent, so check gh_status before assuming it does not exist.";
  else if (r.status === 409) hint = " — a conflict, often an empty repository or a moved ref.";
  else if (r.status === 422) hint = " — understood but rejected; check the field names above.";

  return redact(`GitHub ${method} ${path} → ${r.status}: ${message}${errors}${hint}`);
}

export async function gh(path: string, init: RequestInit = {}): Promise<GhResponse> {
  const response = await ghRaw(path, init);
  if (!response.ok) throw new Error(describeFailure(response, path, init.method ?? "GET"));
  return response;
}

export async function ghJson(path: string, init: RequestInit = {}): Promise<any> {
  return (await gh(path, init)).json;
}

/** POST/PATCH/PUT/DELETE with a JSON body, without repeating the content type. */
export async function ghSend(path: string, method: string, body?: unknown): Promise<GhResponse> {
  return gh(path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
  });
}

export async function ghSendJson(path: string, method: string, body?: unknown): Promise<any> {
  return (await ghSend(path, method, body)).json;
}

function nextLink(headers: Headers): string | null {
  const link = headers.get("link");
  if (!link) return null;
  const entry = link
    .split(",")
    .map((s) => s.trim())
    .find((s) => /rel="next"/.test(s));
  return entry?.match(/<([^>]+)>/)?.[1] ?? null;
}

/**
 * Follow Link headers. GitHub wraps list payloads in a different key per
 * endpoint, so unwrap by shape rather than making every caller name the key.
 */
export async function ghPaged(
  path: string,
  opts: { perPage?: number; maxPages?: number } = {},
): Promise<any[]> {
  const perPage = opts.perPage ?? 100;
  const maxPages = opts.maxPages ?? 5;
  let next: string | null = apiUrl(path) + (path.includes("?") ? "&" : "?") + `per_page=${perPage}`;
  const out: any[] = [];

  for (let page = 0; page < maxPages && next; page++) {
    const response: GhResponse = await gh(next);
    const body = response.json;
    const items = Array.isArray(body)
      ? body
      : (body?.items ??
        body?.workflow_runs ??
        body?.jobs ??
        body?.artifacts ??
        body?.secrets ??
        body?.variables ??
        body?.workflows ??
        body?.environments ??
        body?.repositories ??
        []);
    out.push(...items);
    next = nextLink(response.headers);
  }
  return out;
}

/**
 * Log and artifact endpoints answer 302 with a pre-signed storage URL. The
 * Authorization header must NOT travel to that host: it is unnecessary because
 * the URL is already signed, and the host rejects requests carrying one.
 * Redirects are followed by hand so the stripping is explicit rather than a
 * property of whichever fetch implementation happens to be underneath.
 */
async function followSigned(path: string): Promise<Response> {
  const first = await fetch(apiUrl(path), {
    headers: apiHeaders(),
    redirect: "manual",
    signal: AbortSignal.timeout(config.github.timeoutMs),
  });
  recordMeta(first.headers);

  if (first.status >= 300 && first.status < 400) {
    const location = first.headers.get("location");
    if (!location) throw new Error(`GitHub redirected without a Location header: ${path}`);
    const second = await fetch(location, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(config.github.downloadTimeoutMs),
    });
    if (!second.ok) {
      throw new Error(`Download failed: ${second.status} ${second.statusText} for ${path}`);
    }
    return second;
  }

  if (!first.ok) {
    const body = await first.text();
    const hint =
      first.status === 410
        ? " — logs expire (90 days by default) and this run's are gone."
        : first.status === 404
          ? " — no such run or job, or the logs are not ready yet."
          : "";
    throw new Error(redact(`GitHub GET ${path} → ${first.status}: ${body.slice(0, 200)}${hint}`));
  }

  return first;
}

export async function ghDownloadText(path: string): Promise<string> {
  return (await followSigned(path)).text();
}

/** Stream a signed download to disk - used for run-log and artifact zips. */
export async function ghDownloadFile(path: string, destination: string): Promise<number> {
  const response = await followSigned(path);
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.promises.writeFile(destination, buffer);
  return buffer.length;
}

/**
 * libsodium sealed box, as the REST guide specifies. ORIGINAL is a real base64
 * variant, not a placeholder: the URL-safe variants produce a value GitHub
 * rejects with a 422.
 */
export async function sealSecret(value: string, publicKeyBase64: string): Promise<string> {
  await _sodium.ready;
  const sodium: any = _sodium;
  const binaryKey = sodium.from_base64(publicKeyBase64, sodium.base64_variants.ORIGINAL);
  const binarySecret = sodium.from_string(value);
  const sealed = sodium.crypto_box_seal(binarySecret, binaryKey);
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
}
