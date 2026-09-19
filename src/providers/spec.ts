/**
 * Cloud provider registry.
 *
 * Adding a provider is a data change, not a code change: one entry here with a
 * base URL, an auth style and a verify endpoint, and the panel, the account
 * store, redaction and the cloud_* tools all pick it up. That is what keeps
 * "how many providers?" from being a question this codebase has to answer.
 *
 * The one field to get right is hosts: it is the exhaustive list of hosts an
 * account's credential may be sent to. An agent (or a prompt injection riding
 * on one) can choose any path it likes, but the token only ever leaves this
 * process toward one of these hosts.
 */

export type AuthStyle =
  /** Authorization: Bearer <token> */
  | { type: "bearer" }
  /** A single custom header, e.g. Fastly-Key: <token> */
  | { type: "header"; header: string }
  /** Cloudflare global API key: X-Auth-Email + X-Auth-Key. */
  | { type: "email_key" }
  /**
   * Google service-account JSON exchanged for a short-lived OAuth2 token.
   * The stored "token" is the whole JSON key file.
   */
  | { type: "google_sa" };

export type VerifySpec = {
  /** Only applies to accounts authenticating this way. Absent matches any. */
  auth?: AuthStyle["type"];
  method?: string;
  path: string;
  /** Dotted path into the JSON body used as the account's display name. */
  namePath?: string;
};

export type ProviderSpec = {
  /** Stable identifier used in tool arguments and URLs: "vercel". */
  id: string;
  /** Display name: "Vercel". */
  name: string;
  baseUrl: string;
  /** Hosts a credential may be sent to. Globs like "*.googleapis.com" allowed. */
  hosts: string[];
  /** Supported auth styles, most-preferred first. */
  auth: AuthStyle[];
  /** Static headers every request carries (Heroku's versioned Accept, etc). */
  extraHeaders?: Record<string, string>;
  /** What the panel calls the secret it asks for. */
  tokenLabel: string;
  /** Where a human obtains the token. */
  tokenUrl?: string;
  /** API documentation, surfaced in cloud_providers. */
  docsUrl?: string;
  /** How the panel validates a token on add. Tried in order per auth style. */
  verify?: VerifySpec[];
};

export const PROVIDERS: ProviderSpec[] = [
  {
    id: "vercel",
    name: "Vercel",
    baseUrl: "https://api.vercel.com",
    hosts: ["api.vercel.com"],
    auth: [{ type: "bearer" }],
    tokenLabel: "Vercel access token",
    tokenUrl: "https://vercel.com/account/tokens",
    docsUrl: "https://vercel.com/docs/rest-api",
    verify: [{ path: "/v2/user", namePath: "user.username" }],
  },
  {
    id: "heroku",
    name: "Heroku",
    baseUrl: "https://api.heroku.com",
    hosts: ["api.heroku.com"],
    auth: [{ type: "bearer" }],
    extraHeaders: { Accept: "application/vnd.heroku+json; version=3" },
    tokenLabel: "Heroku API key",
    tokenUrl: "https://dashboard.heroku.com/account",
    docsUrl: "https://devcenter.heroku.com/articles/platform-api-reference",
    verify: [{ path: "/account", namePath: "email" }],
  },
  {
    id: "render",
    name: "Render",
    baseUrl: "https://api.render.com/v1",
    hosts: ["api.render.com"],
    auth: [{ type: "bearer" }],
    tokenLabel: "Render API key",
    tokenUrl: "https://render.com/docs/api#creating-an-api-key",
    docsUrl: "https://render.com/docs/api",
    verify: [{ path: "/owners?limit=1", namePath: "0.owner.email" }],
  },
  {
    id: "digitalocean",
    name: "DigitalOcean",
    baseUrl: "https://api.digitalocean.com/v2",
    hosts: ["api.digitalocean.com"],
    auth: [{ type: "bearer" }],
    tokenLabel: "DigitalOcean personal access token",
    tokenUrl: "https://cloud.digitalocean.com/account/api/tokens",
    docsUrl: "https://docs.digitalocean.com/reference/api/",
    verify: [{ path: "/account", namePath: "account.email" }],
  },
  {
    id: "linode",
    name: "Linode",
    baseUrl: "https://api.linode.com/v4",
    hosts: ["api.linode.com"],
    auth: [{ type: "bearer" }],
    tokenLabel: "Linode personal access token",
    tokenUrl: "https://cloud.linode.com/profile/tokens",
    docsUrl: "https://techdocs.akamai.com/linode-api/reference/api",
    verify: [{ path: "/profile", namePath: "username" }],
  },
  {
    id: "fastly",
    name: "Fastly",
    baseUrl: "https://api.fastly.com",
    hosts: ["api.fastly.com"],
    auth: [{ type: "header", header: "Fastly-Key" }],
    tokenLabel: "Fastly API token",
    tokenUrl: "https://manage.fastly.com/account/personal/tokens",
    docsUrl: "https://www.fastly.com/documentation/reference/api/",
    verify: [{ path: "/current_user", namePath: "login" }],
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    baseUrl: "https://api.cloudflare.com/client/v4",
    hosts: ["api.cloudflare.com"],
    // An account carrying an email in extra authenticates with the global key;
    // anything else is an API token. Prefer tokens: they can be scoped.
    auth: [{ type: "bearer" }, { type: "email_key" }],
    tokenLabel: "Cloudflare API token (or global API key + email)",
    tokenUrl: "https://dash.cloudflare.com/profile/api-tokens",
    docsUrl: "https://developers.cloudflare.com/api/",
    verify: [
      { auth: "bearer", path: "/user/tokens/verify", namePath: "result.name" },
      { auth: "email_key", path: "/user", namePath: "result.email" },
    ],
  },
  {
    id: "turso",
    name: "Turso",
    baseUrl: "https://api.turso.tech/v1",
    // *.turso.io covers per-database hostnames (schema/query over HTTP).
    hosts: ["api.turso.tech", "*.turso.io"],
    auth: [{ type: "bearer" }],
    tokenLabel: "Turso platform API token",
    tokenUrl:
      "https://docs.turso.tech/api-reference/introduction#authentication",
    docsUrl: "https://docs.turso.tech/api-reference/",
    verify: [{ path: "/organizations" }],
  },
  {
    id: "firebase",
    name: "Firebase",
    baseUrl: "https://firebase.googleapis.com",
    // googleapis.com is wide on purpose: one service account legitimately
    // reaches Firestore, Hosting, Rules and Auth admin APIs. Narrow it here
    // if the account should only manage projects.
    hosts: ["*.googleapis.com", "*.firebasedatabase.app"],
    auth: [{ type: "google_sa" }],
    tokenLabel: "Service-account JSON (the whole key file)",
    tokenUrl:
      "https://console.firebase.google.com/project/_/settings/serviceaccounts/adminsdk",
    docsUrl: "https://firebase.google.com/docs/reference/management/rest",
    verify: [
      { path: "/v1beta1/projects?pageSize=1", namePath: "results.0.projectId" },
    ],
  },
];

const byId = new Map(PROVIDERS.map((p) => [p.id, p]));

/** The spec for a provider id, or an error naming the ones that exist. */
export function providerSpec(id: string): ProviderSpec {
  const spec = byId.get(id.trim().toLowerCase());
  if (!spec) {
    throw new Error(
      `Unknown provider "${id}". This server knows: ${PROVIDERS.map((p) => p.id).join(", ")}. ` +
        `Adding a new one is one entry in src/providers/spec.ts.`,
    );
  }
  return spec;
}

/** The auth style an account will actually use. */
export function effectiveAuth(
  spec: ProviderSpec,
  extra?: Record<string, string>,
): AuthStyle {
  // The global-key style is opt-in via the account's email field: an operator
  // holding a scoped API token never silently falls back to it.
  const emailKey = spec.auth.find((a) => a.type === "email_key");
  if (emailKey && extra?.email) return emailKey;
  return spec.auth[0]!;
}

/** True when the panel should offer an email field for this provider. */
export function acceptsEmail(spec: ProviderSpec): boolean {
  return spec.auth.some((a) => a.type === "email_key");
}
