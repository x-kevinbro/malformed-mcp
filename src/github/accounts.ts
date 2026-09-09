/**
 * Multiple GitHub identities, one server.
 *
 * The public shape here is unchanged from the environment-variable era, because
 * every gh_* tool and api.ts already speak it. What changed is underneath: the
 * accounts come from runtime/profiles.json via store.ts instead of from
 * GITHUB_PROFILES and suffixed tokens, so the panel can add one without an
 * .env edit or a restart.
 *
 * Selection is still per tool call and still travels through AsyncLocalStorage
 * rather than through every function signature. Threading a profile argument
 * down through gh() -> ghRaw() -> apiHeaders() would have touched every call
 * site in every tool; a request-scoped store keeps the change to the two places
 * that actually care, and concurrent calls on different profiles cannot see
 * each other's credential because each runs inside its own store.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { config } from "../config.js";
import { allProfiles, defaultLogin, findProfile } from "./store.js";

export type GithubAccount = {
  /** The GitHub login, used for display and as the folder name. */
  name: string;
  token: string;
  /** Optional per-profile default repo. */
  repo: string;
  email?: string;
  avatarUrl?: string;
};

const key = (name: string): string => name.trim().toLowerCase();

function toAccount(p: {
  login: string;
  token: string;
  repo: string;
  email?: string;
  avatarUrl?: string;
}): GithubAccount {
  return {
    name: p.login,
    token: p.token,
    repo: p.repo || config.github.repo,
    email: p.email,
    avatarUrl: p.avatarUrl,
  };
}

/**
 * A session pinned to one profile.
 *
 * When an agent authenticates with a profile's own MCP token, that profile is
 * the only one it may act as: withAccount() refuses to switch away from it, and
 * listAccounts() reports just the one. The lock is set by the HTTP layer for
 * the duration of the request, so two agents on different tokens can be served
 * concurrently without either seeing the other's account.
 */
const locked = new AsyncLocalStorage<string>();
const active = new AsyncLocalStorage<string>();

export function withLockedProfile<T>(login: string, fn: () => T): T {
  return locked.run(key(login), fn);
}

export function lockedProfile(): string | undefined {
  return locked.getStore();
}

function visible(): GithubAccount[] {
  const lock = locked.getStore();
  const profiles = allProfiles().map(toAccount);
  if (!lock) return profiles;
  return profiles.filter((a) => key(a.name) === lock);
}

export function listAccounts(): GithubAccount[] {
  return visible();
}

export function defaultAccountName(): string {
  const lock = locked.getStore();
  if (lock) return lock;
  return key(defaultLogin());
}

export function knownProfileNames(): string[] {
  return visible().map((a) => a.name);
}

function unknown(name: string): Error {
  const names = knownProfileNames();
  if (!names.length) {
    return new Error(
      "No GitHub profile is configured. Open the Malformed-MCP panel, go to GitHub Profiles, " +
        "and add one with a personal access token.",
    );
  }
  return new Error(`Unknown GitHub profile "${name}". Available: ${names.join(", ")}. Run gh_profiles.`);
}

/** The profile this call should authenticate as. */
export function currentAccount(): GithubAccount {
  const name = active.getStore() ?? locked.getStore() ?? key(defaultLogin());
  const stored = name ? findProfile(name) : undefined;
  if (!stored) throw unknown(name);

  const lock = locked.getStore();
  if (lock && key(stored.login) !== lock) throw unknown(name);

  if (!stored.token) {
    throw new Error(
      `GitHub profile "${stored.login}" has no token. Re-add it in the panel under GitHub Profiles.`,
    );
  }
  return toAccount(stored);
}

/** Run fn with `name` as the active profile. Undefined leaves the default in place. */
export function withAccount<T>(name: string | undefined, fn: () => T): T {
  const lock = locked.getStore();
  if (name === undefined || name === "") return fn();
  const wanted = key(name);
  // A locked session may name its own profile explicitly; naming any other is
  // reported exactly like a profile that does not exist, so a scoped token
  // cannot be used to probe which other accounts the server holds.
  if (lock && wanted !== lock) throw unknown(name);
  if (!findProfile(wanted)) throw unknown(name);
  return active.run(wanted, fn);
}

/**
 * Every token this server holds. redact() needs all of them, not just the
 * active one: an error raised under one profile can still quote another's
 * credential if something upstream logged it. This deliberately ignores the
 * session lock - redaction must cover credentials the caller cannot see.
 */
export function allTokens(): string[] {
  const tokens = allProfiles().flatMap((p) => [p.token, p.mcpToken]);
  return tokens.filter(Boolean);
}

/** The repo a bare call should target, before any per-profile override. */
export function fallbackRepo(): string {
  const name = locked.getStore() ?? key(defaultLogin());
  const stored = name ? findProfile(name) : undefined;
  return stored?.repo || config.github.repo;
}
