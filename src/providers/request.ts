/**
 * The cloud provider HTTP client. Every cloud_request tool call goes through
 * here, the same way every gh_* call goes through github/api.ts.
 *
 * This layer owns the things that are easy to get wrong once per provider:
 * which auth header the provider wants, which hosts a credential may be sent
 * to at all, timeouts and retries, and credentials never reaching a log. The
 * tool above reads like a description of a request rather than network code.
 */
import { sign as cryptoSign } from "node:crypto";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { hostMatches, assertUrlAllowed } from "../net-guard.js";
import { effectiveAuth, type AuthStyle, type ProviderSpec } from "./spec.js";
import type { StoredCloudAccount } from "./store.js";
import { allTokens } from "./accounts.js";

const UA = `${config.serverName}/${config.version}`;

/**
 * Strip every known credential from anything heading for a log or an error
 * message. A failing request is when a URL or body is most likely to be
 * echoed, and also when leaking the credential would be worst.
 */
export function redact(text: string): string {
  let out = text;
  for (const token of allTokens())
    out = out.split(token).join("***redacted***");
  return out;
}

/**
 * Where a request actually goes.
 *
 * A bare path joins the provider's base URL; a full URL is honoured so one
 * provider can span several API hosts (Firebase management vs a per-database
 * *.firebasedatabase.app). Either way the final host must match the spec's
 * hosts list - that check, not caller discipline, is what stops a token being
 * POSTed to an arbitrary host chosen by an injected instruction.
 *
 * Credentials only travel over https: a provider whose API is plain http does
 * not belong in this registry.
 */
export function resolveTarget(spec: ProviderSpec, rawPath: string): string {
  const target = /^https?:\/\//i.test(rawPath)
    ? rawPath
    : `${spec.baseUrl}/${rawPath.replace(/^\/+/, "")}`;

  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new Error(`Not a valid URL for ${spec.name}: ${rawPath}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(
      `Refusing to send ${spec.name} credentials over ${url.protocol} - https only.`,
    );
  }
  if (!spec.hosts.some((pattern) => hostMatches(url.hostname, pattern))) {
    throw new Error(
      `${url.hostname} is not a ${spec.name} API host. This account's credential may only be ` +
        `sent to: ${spec.hosts.join(", ")}.`,
    );
  }
  return target;
}

/** base64url without padding, for the JWT segments. */
function b64url(data: string | Buffer): string {
  return Buffer.from(data).toString("base64url");
}

/**
 * Service-account JSON -> OAuth2 access token, by hand.
 *
 * google-auth-library would do this in one call, at the price of the whole
 * google-auth dependency tree for what is a signed JWT and one POST. The
 * cache is keyed by account so two Firebase accounts never receive each
 * other's token, and entries live only in memory: the private key already on
 * disk is the durable credential.
 */
const saCache = new Map<string, { token: string; expiresAt: number }>();

export async function googleAccessToken(
  accountId: string,
  serviceAccountJson: string,
): Promise<string> {
  const cached = saCache.get(accountId);
  if (cached && cached.expiresAt - 300_000 > Date.now()) return cached.token;

  let key: { client_email?: string; private_key?: string; token_uri?: string };
  try {
    key = JSON.parse(serviceAccountJson);
  } catch {
    throw new Error(
      "The stored Firebase credential is not valid JSON. Re-add the account with the whole service-account key file.",
    );
  }
  if (!key.client_email || !key.private_key) {
    throw new Error(
      "The service-account JSON has no client_email/private_key - is it a key file?",
    );
  }
  const tokenUri = key.token_uri ?? "https://oauth2.googleapis.com/token";

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: key.client_email,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
    }),
  );
  const unsigned = `${header}.${claims}`;
  const signature = cryptoSign(
    "RSA-SHA256",
    Buffer.from(unsigned),
    key.private_key,
  );

  const response = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature.toString("base64url")}`,
    }).toString(),
    signal: AbortSignal.timeout(config.cloud.timeoutMs),
  });

  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    throw new Error(
      redact(`Google token exchange answered ${response.status}: ${body}`),
    );
  }
  const body = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!body.access_token)
    throw new Error("Google token exchange returned no access_token.");

  saCache.set(accountId, {
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  });
  return body.access_token;
}

/** The Authorization header(s) for one request, by the account's auth style. */
export async function authHeaders(
  spec: ProviderSpec,
  account: StoredCloudAccount,
): Promise<Record<string, string>> {
  const style: AuthStyle = effectiveAuth(spec, account.extra);
  switch (style.type) {
    case "bearer":
      return { Authorization: `Bearer ${account.token}` };
    case "header":
      return { [style.header]: account.token };
    case "email_key":
      return {
        "X-Auth-Email": account.extra?.email ?? "",
        "X-Auth-Key": account.token,
      };
    case "google_sa":
      return {
        Authorization: `Bearer ${await googleAccessToken(account.id, account.token)}`,
      };
  }
}

export type CloudResponse = {
  status: number;
  ok: boolean;
  headers: Headers;
  text: string;
  json: unknown;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  if (response.status === 403 && response.headers.get("retry-after"))
    return true;
  return false;
}

export async function cloudFetch(
  spec: ProviderSpec,
  account: StoredCloudAccount,
  request: {
    method: string;
    path: string;
    query?: Record<string, unknown>;
    body?: unknown;
  },
): Promise<CloudResponse> {
  let target = resolveTarget(spec, request.path);
  if (request.query) {
    const parts = Object.entries(request.query)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(
        ([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
      );
    if (parts.length)
      target += (target.includes("?") ? "&" : "?") + parts.join("&");
  }

  // The hosts list above is the credential boundary; this is the operator's
  // own net policy (net.denyHosts / blockPrivate) applied on top, exactly as
  // the web tools already enforce it.
  await assertUrlAllowed(target);

  const headers: Record<string, string> = {
    "User-Agent": UA,
    Accept: "application/json",
    ...(spec.extraHeaders ?? {}),
    ...(await authHeaders(spec, account)),
  };
  if (request.body !== undefined) headers["Content-Type"] = "application/json";

  const attempts = config.cloud.maxRetries + 1;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    let response: Response;
    try {
      response = await fetch(target, {
        method: request.method,
        headers,
        body:
          request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: AbortSignal.timeout(config.cloud.timeoutMs),
      });
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) break;
      await sleep(retryDelayMs(null, attempt));
      continue;
    }

    if (isRetryable(response) && attempt < attempts - 1) {
      const wait = retryDelayMs(response, attempt);
      logger.warn(
        {
          provider: spec.id,
          status: response.status,
          attempt: attempt + 1,
          waitMs: wait,
        },
        "cloud request retrying",
      );
      await sleep(wait);
      continue;
    }

    // A provider answer can be arbitrarily large; the tool's own clamp runs
    // after this, but there is no reason to hold a 200 MB error page in
    // memory first.
    const text = (await response.text()).slice(0, config.cloud.maxBytes);
    let json: unknown;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    return {
      status: response.status,
      ok: response.ok,
      headers: response.headers,
      text,
      json,
    };
  }

  const reason =
    lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    redact(
      `${spec.name} request failed after ${attempts} attempt(s): ${reason}`,
    ),
  );
}

/**
 * A failed provider call is usually a permission problem wearing a different
 * status code, so the message names the likely cause instead of leaving the
 * reader to guess.
 */
export function describeCloudFailure(
  spec: ProviderSpec,
  r: CloudResponse,
  method: string,
  path: string,
): string {
  const body = r.json as
    { message?: string; error?: { message?: string } | string } | undefined;
  const message =
    (typeof body?.error === "object"
      ? body.error?.message
      : typeof body?.error === "string"
        ? body.error
        : undefined) ??
    body?.message ??
    r.text.slice(0, 300);

  let hint = "";
  if (r.status === 401)
    hint =
      " - the credential is invalid or expired. Re-add the account in the panel.";
  else if (r.status === 403)
    hint =
      " - authenticated but not permitted; the token is missing a scope/permission.";
  else if (r.status === 404)
    hint =
      " - missing, or invisible to this credential. Check the path and the account.";
  else if (r.status === 429)
    hint = " - rate limited; slow down or retry later.";
  else if (r.status === 422)
    hint = " - understood but rejected; check the field names above.";

  return redact(
    `${spec.name} ${method} ${path} -> ${r.status}: ${message}${hint}`,
  );
}
