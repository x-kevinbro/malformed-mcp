/**
 * Multiple cloud accounts per provider, one server.
 *
 * A straight generalisation of the GitHub profile machinery: selection is per
 * tool call and travels through AsyncLocalStorage, and an agent that
 * authenticates with an account's own MCP token is locked to that account -
 * it cannot see, name or probe the others, on any provider. Two agents on
 * different tokens are served concurrently without either seeing the other's
 * credential because each runs inside its own store.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { providerSpec } from "./spec.js";
import {
  accountsFor,
  allAccounts,
  defaultAccountId,
  findAccount,
  findAccountById,
  type StoredCloudAccount,
} from "./store.js";

/** The id of the account an authenticated session is locked to, if any. */
const locked = new AsyncLocalStorage<string>();

export function withLockedCloudAccount<T>(id: string, fn: () => T): T {
  return locked.run(id, fn);
}

export function lockedCloudAccountId(): string | undefined {
  return locked.getStore();
}

/** Accounts the current session may see: all of them, or just the locked one. */
export function visibleAccounts(provider?: string): StoredCloudAccount[] {
  const lock = locked.getStore();
  if (lock) {
    const account = findAccountById(lock);
    return account && (!provider || account.provider === provider)
      ? [account]
      : [];
  }
  return provider ? accountsFor(provider) : allAccounts();
}

function unknown(provider: string, name?: string): Error {
  const spec = providerSpec(provider);
  const names = visibleAccounts(provider).map((a) => a.name);
  if (!names.length) {
    return new Error(
      `No ${spec.name} account is configured. Open the Malformed-MCP panel, Cloud Providers tab, ` +
        `and add one with ${spec.tokenLabel}.`,
    );
  }
  return new Error(
    `Unknown ${spec.name} account "${name}". Available: ${names.join(", ")}. Run cloud_providers.`,
  );
}

/**
 * The account a cloud_request call should authenticate as. An explicit name
 * wins; otherwise the provider default; a locked session may only ever resolve
 * to its own account - naming another is reported exactly like an account that
 * does not exist, so a scoped token cannot probe what else the server holds.
 */
export function resolveAccount(
  provider: string,
  name?: string,
): StoredCloudAccount {
  const lock = locked.getStore();

  if (!name) {
    const lockedAccount = lock ? findAccountById(lock) : undefined;
    if (lockedAccount) {
      if (lockedAccount.provider !== provider) throw unknown(provider);
      return lockedAccount;
    }
    const id = defaultAccountId(provider);
    const account = id ? findAccountById(id) : undefined;
    if (!account) throw unknown(provider);
    return account;
  }

  const account = findAccount(provider, name);
  if (!account) throw unknown(provider, name);
  if (lock && account.id !== lock) throw unknown(provider, name);
  return account;
}

/**
 * Every credential this server holds, for redact(). This deliberately ignores
 * the session lock - redaction must cover credentials the caller cannot see.
 */
export function allTokens(): string[] {
  try {
    return allAccounts()
      .flatMap((a) => [a.token, a.mcpToken])
      .filter(Boolean);
  } catch {
    return [];
  }
}
