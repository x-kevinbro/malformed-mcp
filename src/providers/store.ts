/**
 * Where cloud provider accounts actually live.
 *
 * Same shape and same reasoning as the GitHub profile store: a record per
 * account in runtime/providers.json, written by the panel without a restart,
 * re-read on every call so a panel edit is live immediately. Each account
 * carries its own mcpToken - the isolation boundary that scopes an agent to
 * exactly this account. The file is 0600 because it holds live credentials.
 *
 * An account's name doubles as its identity within its provider (like the
 * GitHub login), but names arrive from provider APIs and can contain "@", so
 * the URL-safe slug is derived for routing rather than the name itself.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { config } from "../config.js";

export type StoredCloudAccount = {
  /** `${provider}/${slug(name)}` - the stable identity, used by the auth lock. */
  id: string;
  provider: string;
  /** Display name: the email, username or label the verify call returned. */
  name: string;
  /** The credential itself. Never leaves the server. For google_sa, the JSON key. */
  token: string;
  /** Secondary fields - currently just { email } for a Cloudflare global key. */
  extra?: Record<string, string>;
  /** Per-account write gate: true blocks every non-GET cloud_request. */
  readOnly: boolean;
  /** False when the token was accepted without a successful verify call. */
  verified: boolean;
  /** This account's own MCP bearer token. Scopes an agent to this account alone. */
  mcpToken: string;
  createdAt: string;
};

type StoreShape = {
  accounts: StoredCloudAccount[];
  defaults: Record<string, string>;
};

const EMPTY: StoreShape = { accounts: [], defaults: {} };

function readStore(): StoreShape {
  if (!existsSync(config.providerStore)) return { ...EMPTY, defaults: {} };
  try {
    const parsed = JSON.parse(
      readFileSync(config.providerStore, "utf8"),
    ) as StoreShape;
    if (!parsed || !Array.isArray(parsed.accounts))
      return { ...EMPTY, defaults: {} };
    return { accounts: parsed.accounts, defaults: parsed.defaults ?? {} };
  } catch {
    // A corrupt store must not take the server down: cloud tools degrade to
    // "no accounts configured" and the panel can rewrite the file.
    return { ...EMPTY, defaults: {} };
  }
}

function writeStore(store: StoreShape): void {
  mkdirSync(path.dirname(config.providerStore), { recursive: true });
  const tmp = `${config.providerStore}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, config.providerStore);
}

/** URL- and id-safe form of a display name. "ops@example.com" -> "ops-example-com". */
export function slug(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[.]+/, "");
  if (!cleaned)
    throw new Error(`Unusable account name: ${JSON.stringify(name)}`);
  return cleaned;
}

const accountId = (provider: string, name: string): string =>
  `${provider}/${slug(name)}`;

export function allAccounts(): StoredCloudAccount[] {
  return readStore().accounts;
}

export function accountsFor(provider: string): StoredCloudAccount[] {
  return readStore().accounts.filter((a) => a.provider === provider);
}

/** Find by name (case-insensitive), by slug, or by full id. */
export function findAccount(
  provider: string,
  nameOrSlug: string,
): StoredCloudAccount | undefined {
  const wanted = nameOrSlug.trim().toLowerCase();
  return readStore().accounts.find(
    (a) =>
      a.provider === provider &&
      (a.name.toLowerCase() === wanted ||
        slug(a.name) === wanted ||
        a.id === wanted),
  );
}

export function findAccountById(id: string): StoredCloudAccount | undefined {
  return readStore().accounts.find((a) => a.id === id);
}

/** Resolve an incoming bearer token to the cloud account it belongs to, if any. */
export function findCloudByMcpToken(
  token: string,
): StoredCloudAccount | undefined {
  if (!token) return undefined;
  return readStore().accounts.find((a) => a.mcpToken === token);
}

export function defaultAccountId(provider: string): string {
  const store = readStore();
  const wanted = store.defaults[provider];
  if (wanted && store.accounts.some((a) => a.id === wanted)) return wanted;
  return store.accounts.find((a) => a.provider === provider)?.id ?? "";
}

export function setDefaultAccount(provider: string, nameOrSlug: string): void {
  const store = readStore();
  const account = store.accounts.find(
    (a) =>
      a.provider === provider &&
      (a.name.toLowerCase() === nameOrSlug.toLowerCase() ||
        slug(a.name) === nameOrSlug.toLowerCase()),
  );
  if (!account) throw new Error(`No such ${provider} account: ${nameOrSlug}`);
  store.defaults[provider] = account.id;
  writeStore(store);
}

/** Add or replace an account. Re-adding a provider+name updates it in place. */
export function upsertAccount(
  input: Omit<StoredCloudAccount, "id" | "mcpToken" | "createdAt"> & {
    mcpToken?: string;
  },
): StoredCloudAccount {
  const store = readStore();
  const id = accountId(input.provider, input.name);
  const at = store.accounts.findIndex((a) => a.id === id);
  const existing = at >= 0 ? store.accounts[at] : undefined;

  const account: StoredCloudAccount = {
    ...input,
    id,
    // Rotating the provider credential must not invalidate the MCP token an
    // agent is already configured with, so an existing one is kept.
    mcpToken: input.mcpToken ?? existing?.mcpToken ?? newMcpToken(),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };

  if (at >= 0) store.accounts[at] = account;
  else store.accounts.push(account);
  if (!store.defaults[input.provider]) store.defaults[input.provider] = id;
  writeStore(store);
  return account;
}

export function removeAccount(provider: string, nameOrSlug: string): boolean {
  const store = readStore();
  const account = store.accounts.find(
    (a) =>
      a.provider === provider &&
      (a.name.toLowerCase() === nameOrSlug.toLowerCase() ||
        slug(a.name) === nameOrSlug.toLowerCase()),
  );
  if (!account) return false;
  store.accounts = store.accounts.filter((a) => a.id !== account.id);
  if (store.defaults[provider] === account.id) {
    store.defaults[provider] =
      store.accounts.find((a) => a.provider === provider)?.id ?? "";
  }
  writeStore(store);
  return true;
}

/** Mint a fresh MCP token for one account, invalidating whatever it had. */
export function rotateMcpToken(provider: string, nameOrSlug: string): string {
  const store = readStore();
  const account = store.accounts.find(
    (a) =>
      a.provider === provider &&
      (a.name.toLowerCase() === nameOrSlug.toLowerCase() ||
        slug(a.name) === nameOrSlug.toLowerCase()),
  );
  if (!account) throw new Error(`No such ${provider} account: ${nameOrSlug}`);
  account.mcpToken = newMcpToken();
  writeStore(store);
  return account.mcpToken;
}

export function setAccountReadOnly(
  provider: string,
  nameOrSlug: string,
  readOnly: boolean,
): void {
  const store = readStore();
  const account = store.accounts.find(
    (a) =>
      a.provider === provider &&
      (a.name.toLowerCase() === nameOrSlug.toLowerCase() ||
        slug(a.name) === nameOrSlug.toLowerCase()),
  );
  if (!account) throw new Error(`No such ${provider} account: ${nameOrSlug}`);
  account.readOnly = readOnly;
  writeStore(store);
}

export function newMcpToken(): string {
  return `bm_${randomBytes(24).toString("hex")}`;
}
