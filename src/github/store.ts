/**
 * Where GitHub profiles actually live.
 *
 * They used to be environment variables: GITHUB_PROFILES plus a suffixed token
 * per name, read once at boot. That cannot work for a panel that adds accounts
 * at runtime - a new profile would need an .env edit and a restart, and the
 * suffix rules ("-" folded to "_", uppercased) leaked shell constraints into
 * the user interface.
 *
 * A profile is now a record in runtime/profiles.json, keyed by the GitHub login
 * the token resolves to rather than a name the user invents. The panel adds one
 * by posting a token: the login, display name and avatar all come back from
 * /user, so there is nothing else to type.
 *
 * Each profile also carries its own mcpToken. That is the isolation boundary:
 * an agent authenticating with a profile's token can only ever act as that
 * profile, and cannot see or name the others. The file is 0600 because it holds
 * live credentials.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { config } from "../config.js";

export type StoredProfile = {
  /** GitHub login, as returned by /user. The stable identity and folder name. */
  login: string;
  /** Display name, for the panel. Falls back to the login. */
  name: string;
  /** The GitHub token itself. Never leaves the server. */
  token: string;
  /** Optional default repo, owner/name. */
  repo: string;
  email?: string;
  avatarUrl?: string;
  /** Account type from GitHub: User or Organization. */
  type?: string;
  /** This profile's own MCP bearer token. Scopes an agent to this account alone. */
  mcpToken: string;
  createdAt: string;
};

type StoreShape = { profiles: StoredProfile[]; defaultLogin?: string };

const EMPTY: StoreShape = { profiles: [] };

function readStore(): StoreShape {
  if (!existsSync(config.profileStore)) return { ...EMPTY };
  try {
    const parsed = JSON.parse(readFileSync(config.profileStore, "utf8")) as StoreShape;
    if (!parsed || !Array.isArray(parsed.profiles)) return { ...EMPTY };
    return parsed;
  } catch {
    // A corrupt store must not take the server down: GitHub tools degrade to
    // "no profiles configured", every other tool is unaffected, and the panel
    // can rewrite the file.
    return { ...EMPTY };
  }
}

function writeStore(store: StoreShape): void {
  mkdirSync(path.dirname(config.profileStore), { recursive: true });
  const tmp = `${config.profileStore}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, config.profileStore);
}

/**
 * The store is re-read rather than cached. Profiles change while the server is
 * running - that is the whole point of the panel - and a cache would hand a
 * stale credential to the next call. The file is small and the read is warm.
 */
export function allProfiles(): StoredProfile[] {
  return readStore().profiles;
}

export function findProfile(login: string): StoredProfile | undefined {
  const wanted = login.trim().toLowerCase();
  return readStore().profiles.find((p) => p.login.toLowerCase() === wanted);
}

/** Resolve an incoming bearer token to the profile it belongs to, if any. */
export function findByMcpToken(token: string): StoredProfile | undefined {
  if (!token) return undefined;
  return readStore().profiles.find((p) => p.mcpToken === token);
}

export function defaultLogin(): string {
  const store = readStore();
  if (store.defaultLogin && store.profiles.some((p) => p.login === store.defaultLogin)) {
    return store.defaultLogin;
  }
  return store.profiles[0]?.login ?? "";
}

export function setDefaultLogin(login: string): void {
  const store = readStore();
  if (!store.profiles.some((p) => p.login === login)) throw new Error(`No such profile: ${login}`);
  store.defaultLogin = login;
  writeStore(store);
}

/** Add or replace a profile. Re-adding an existing login updates it in place. */
export function upsertProfile(
  input: Omit<StoredProfile, "mcpToken" | "createdAt"> & { mcpToken?: string },
): StoredProfile {
  const store = readStore();
  const at = store.profiles.findIndex((p) => p.login.toLowerCase() === input.login.toLowerCase());
  const existing = at >= 0 ? store.profiles[at] : undefined;

  const profile: StoredProfile = {
    ...input,
    // Rotating the GitHub token must not invalidate the MCP token an agent is
    // already configured with, so an existing one is kept unless replaced.
    mcpToken: input.mcpToken ?? existing?.mcpToken ?? newMcpToken(),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };

  if (at >= 0) store.profiles[at] = profile;
  else store.profiles.push(profile);
  if (!store.defaultLogin) store.defaultLogin = profile.login;
  writeStore(store);
  return profile;
}

export function removeProfile(login: string): boolean {
  const store = readStore();
  const before = store.profiles.length;
  store.profiles = store.profiles.filter((p) => p.login.toLowerCase() !== login.toLowerCase());
  if (store.profiles.length === before) return false;
  if (store.defaultLogin?.toLowerCase() === login.toLowerCase()) {
    store.defaultLogin = store.profiles[0]?.login;
  }
  writeStore(store);
  return true;
}

/** Mint a fresh MCP token for one profile, invalidating whatever it had. */
export function rotateMcpToken(login: string): string {
  const store = readStore();
  const profile = store.profiles.find((p) => p.login.toLowerCase() === login.toLowerCase());
  if (!profile) throw new Error(`No such profile: ${login}`);
  profile.mcpToken = newMcpToken();
  writeStore(store);
  return profile.mcpToken;
}

export function newMcpToken(): string {
  return `bm_${randomBytes(24).toString("hex")}`;
}

/**
 * Every checkout for a profile lives under profiles/<login>/, and every working
 * tree is suffixed _work so a clone can never be mistaken for the server's own
 * files. Both components are sanitised: a repo name arrives from the GitHub API
 * but the same helper serves the panel's rename box, which is user input, and a
 * name containing "../" would otherwise escape the folder entirely.
 */
export function profileDir(login: string): string {
  return path.join(config.profilesDir, safeSegment(login));
}

const WORK_SUFFIX = "_work";

export function workDir(login: string, repoName: string): string {
  return path.join(profileDir(login), `${safeSegment(repoName)}${WORK_SUFFIX}`);
}

export type ProfileClone = {
  /** Repository name, with the _work suffix stripped back off. */
  repo: string;
  /** Absolute path to the working tree. */
  path: string;
  /** Checked-out branch, a short SHA when detached, or "?" if unreadable. */
  branch: string;
};

/**
 * The clones that exist for a profile.
 *
 * Read from disk rather than from the store, because the store never recorded
 * them: the panel clones, renames and deletes working trees directly, so a list
 * built from remembered names would keep advertising a path that has since
 * moved. Scanning for the _work suffix means what is reported is what is there.
 */
export function listClones(login: string): ProfileClone[] {
  try {
    return listClonesIn(profileDir(login));
  } catch {
    return []; // an unusable login has no folder to scan
  }
}

/** The same listing against an explicit folder. Separated so it is testable. */
export function listClonesIn(dir: string): ProfileClone[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // no folder yet: the profile simply has nothing cloned
  }

  return entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(WORK_SUFFIX))
    .map((entry) => {
      const full = path.join(dir, entry.name);
      return {
        repo: entry.name.slice(0, -WORK_SUFFIX.length),
        path: full,
        branch: headBranch(full),
      };
    })
    .sort((a, b) => a.repo.localeCompare(b.repo));
}

/**
 * Read the checked-out branch straight from .git/HEAD.
 *
 * Spawning git once per clone would turn a listing meant for orientation into a
 * process fan-out. The file is a single line and answers the same question.
 */
function headBranch(dir: string): string {
  try {
    return parseHeadRef(readFileSync(path.join(dir, ".git", "HEAD"), "utf8"));
  } catch {
    return "?"; // not a checkout, or unreadable: say so rather than guess
  }
}

/** "ref: refs/heads/main" -> "main"; a bare SHA means a detached HEAD. */
export function parseHeadRef(head: string): string {
  const trimmed = head.trim();
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(trimmed);
  if (ref) return ref[1]!;
  return trimmed ? `detached ${trimmed.slice(0, 8)}` : "?";
}

/**
 * Git credential environment for a working tree under profiles/<login>/.
 *
 * The clone flow already injects the profile token through a credential
 * helper that reads it from the child's environment; every other git
 * invocation (commit_push, the git tool, repo_status) historically ran bare
 * and only worked if a stray host credential happened to match. This is the
 * shared fix: resolve which profile owns the working tree from its path and
 * hand back env vars that scope the token to that one child process. The
 * token never appears in argv or on disk. Outside the profiles directory, or
 * for an unknown login, it returns {} and git behaves exactly as before.
 */
export function gitCredentialEnv(cwd: string): Record<string, string> {
  const base = path.resolve(config.profilesDir) + path.sep;
  const resolved = path.resolve(cwd);
  if (!resolved.startsWith(base)) return {};
  const login = resolved.slice(base.length).split(path.sep)[0] ?? "";
  const profile = findProfile(login);
  if (!profile) return {};
  return {
    MALFORMEDMCP_GH_TOKEN: profile.token,
    GIT_TERMINAL_PROMPT: "0",
    // Reset any inherited helpers first so a stale ~/.git-credentials can
    // never shadow the profile's own token, then install ours.
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "!f(){ echo username=x-access-token; echo password=$MALFORMEDMCP_GH_TOKEN; };f",
  };
}

export function safeSegment(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[/\\]/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .replace(/^[.]+/, "");
  if (!cleaned) throw new Error(`Unusable name: ${JSON.stringify(value)}`);
  return cleaned;
}
