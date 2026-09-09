import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

/**
 * Malformed-MCP configuration.
 *
 * Everything this server needs is defined here, in code. There is no .env, no
 * environment variables, and nothing is read from outside this folder. A web
 * interface will edit these values later; until then this file is the single
 * place to change behaviour.
 *
 * Every runtime path is derived from ROOT, so the server reads and writes only
 * inside its own directory.
 */

/** The folder this server lives in. Both dist/ and src/ sit one level down. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A path inside this folder's runtime area. Nothing escapes ROOT. */
const runtime = (...parts: string[]): string => path.join(ROOT, "runtime", ...parts);

/**
 * The bearer token clients present. Generated once into runtime/token.txt and
 * reused afterwards, so a fresh copy of this folder is usable without editing
 * anything. Delete that file to roll the token.
 */
function loadToken(): string {
  const file = runtime("token.txt");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    // No token yet: fall through and mint one.
  }
  const token = randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, token + "\n", { mode: 0o600 });
  return token;
}

/** Widened deliberately: `as const` would freeze these into literal types. */
const defaults = {
  token: loadToken(),
  serverName: "malformed-mcp",
  version: "2.0.0",
  /** No git checkout here by design, so there is no commit to report. */
  gitSha: "",

  port: 40000,
  /** The panel has to be reachable from outside the box, not just from it. */
  bind: "0.0.0.0",
  publicHost: "",
  publicHosts: [] as string[],

  shell: "/bin/bash",
  /** Commands run inside this folder unless a tool is given another directory. */
  defaultCwd: ROOT,
  /** Dedicated directory inside malformed-mcp for scratch files, test scripts, and test logs. */
  scratchDir: path.join(ROOT, "scratch"),

  timeoutMs: 120_000,
  /** No tool-started process may live longer than ten minutes. */
  maxTimeoutMs: 600_000,
  /** Default only: tools with max_output let the agent choose per call. */
  maxOutput: 24_000,
  maxBody: "128mb",

  ipAllowlist: [] as string[],
  readOnly: false,
  hostReadOnly: false,
  githubReadOnly: false,
  dnsRebindProtection: false,
  trustProxy: 1,
  jsonResponse: false,

  /**
   * Scrub secret-shaped strings from every tool result. Off by default: the
   * operator asked for an agent with nothing held back, and redaction is the
   * one setting that changes what the agent is allowed to *see* rather than
   * what it is allowed to do. Turn it back on before handing an MCP token to
   * anyone you would not hand the server's credentials to.
   */
  redactOutput: false,
  compactOutput: "safe" as "off" | "safe" | "aggressive",
  outputDir: runtime("output"),

  tools: {
    profile: "full",
    only: [] as string[],
    exclude: [] as string[],
    onDemand: false,
    preload: ["all"] as string[],
  },

  net: {
    allowHosts: [] as string[],
    denyHosts: [] as string[],
    blockPrivate: false,
  },

  sec: {
    allowTargets: ["*"] as string[],
    loadMaxVus: 50,
    loadMaxDurationS: 60,
  },

  logLevel: "info" as "trace" | "debug" | "info" | "warn" | "error" | "fatal",
  logDir: runtime("logs"),
  backupDir: runtime("backups"),

  /**
   * The headless browser. On by default, like everything else here: a tool that
   * exists but is switched off is indistinguishable, from the agent's side,
   * from a tool that was never written.
   *
   * allowPrivateNet=true is what makes that legal at boot - the bridge refuses
   * to start unless either the net guard blocks private addresses or this says
   * the SSRF exposure is accepted on purpose. A page can ask the browser for
   * 127.0.0.1 or the cloud metadata endpoint, and that request never passes
   * through the net guard, so this is a real exposure knowingly taken.
   */
  browser: {
    enabled: true,
    allowPrivateNet: true,
    headless: true,
    viewport: { width: 1280, height: 720 },
    outputDir: runtime("browser"),
    /** Beyond the core set: PDF export. Core nav/input/tabs are always on. */
    caps: ["pdf"] as string[],
    maxTabs: 8,
    idleMs: 300_000,
    lockWaitMs: 30_000,
    callTimeoutMs: 180_000,
    killOnError: true,
    killOnAnyError: false,
  },

  /**
   * The web panel, served from the same listener as /mcp. One port, one
   * process: / is the interface, /mcp is the endpoint agents talk to.
   */
  panel: {
    enabled: true,
    /** Shown in the footer of every page. */
    credit: "by dark_byte",
    /** 0 means the signed browser login never expires. */
    sessionHours: 0,
    /** Admin credential + panel state, never the GitHub tokens. */
    store: runtime("panel.json"),
    /** TLS material, once a certificate has been issued. */
    certDir: runtime("certs"),
  },

  rateWindowMs: 60_000,
  /** 0 disables the HTTP request limiter. */
  rateMax: 0,
  maxConcurrentExec: 32,

  /**
   * Session hygiene. Each MCP session holds a long-lived GET open, and the
   * transport writes nothing to it while idle - so every NAT and proxy in the
   * path treats it as dead and drops it, which is what a burst of parallel
   * calls collapsing actually looks like. The heartbeat keeps the stream
   * visibly alive; the reaper and the ceiling stop sessions accumulating from
   * clients that open one per call.
   */
  sseKeepAliveMs: 15_000,
  /** Close a session with no activity for this long. */
  sessionIdleMs: 1_800_000,
  /** How often the reaper runs. */
  sessionReapMs: 60_000,
  /** Hard ceiling on concurrent sessions; least recently used is evicted. */
  maxSessions: 64,

  composeDir: ROOT,
  dbContainer: "postgres",
  dbName: "postgres",
  dbUser: "postgres",
  nginxContainer: "nginx",
  apiContainer: "api",

  /**
   * GitHub. Tokens are no longer read from the environment: the web panel
   * writes them to the profile store, and each profile carries its own. These
   * are the transport-level defaults shared by every profile.
   */
  /** GitHub working trees: profiles/<login>/<repo>_work, all inside this folder. */
  profilesDir: path.join(ROOT, "profiles"),
  /** Where the panel persists GitHub profiles and their per-profile MCP tokens. */
  profileStore: runtime("profiles.json"),

  github: {
    token: "",
    repo: "",
    apiUrl: "https://api.github.com",
    apiVersion: "2022-11-28",
    timeoutMs: 30_000,
    downloadTimeoutMs: 120_000,
    maxRetries: 3,
  },
};

/**
 * Settings the panel has changed.
 *
 * The defaults above stay the source of truth in code; runtime/settings.json
 * holds only what an operator actually edited. Keeping the two separate means
 * an upgrade still picks up new defaults, and "reset this field" is a delete
 * rather than a guess at what the original value was.
 *
 * The overlay is applied at boot and never re-read, which is why the panel
 * requires a restart to apply a change: a value that took effect halfway
 * through a running process would leave the server in a state that matches
 * neither the old configuration nor the new one.
 */
function applyOverrides<T extends Record<string, unknown>>(base: T): T {
  let overrides: Record<string, unknown>;
  try {
    overrides = JSON.parse(fs.readFileSync(runtime("settings.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return base;
  }

  const merge = (target: any, patch: any): any => {
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (!(key in target)) continue; // ignore unknown keys rather than inventing settings
      const current = target[key];
      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        current !== null &&
        typeof current === "object" &&
        !Array.isArray(current)
      ) {
        merge(current, value);
      } else if (value !== null && value !== undefined) {
        target[key] = value;
      }
    }
    return target;
  };

  return merge(base, overrides) as T;
}

export const config = applyOverrides(defaults);

/** Paths are derived from ROOT and must not be overridable from the panel. */
config.outputDir = defaults.outputDir;
config.logDir = defaults.logDir;
config.backupDir = defaults.backupDir;
config.profilesDir = defaults.profilesDir;
config.profileStore = defaults.profileStore;
config.panel.store = defaults.panel.store;
config.panel.certDir = defaults.panel.certDir;
config.browser.outputDir = defaults.browser.outputDir;
config.scratchDir = defaults.scratchDir;

/**
 * Clean up files and folders inside scratchDir older than maxAgeDays (default: 21 days / 3 weeks).
 * Scratch files are kept for review/history and pruned once they exceed this threshold.
 */
export function cleanOldScratchFiles(dir = config.scratchDir, maxAgeDays = 21): number {
  let cleaned = 0;
  try {
    if (!fs.existsSync(dir)) return 0;
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs < cutoff) {
          if (entry.isDirectory()) {
            fs.rmSync(fullPath, { recursive: true, force: true });
          } else {
            fs.unlinkSync(fullPath);
          }
          cleaned++;
        }
      } catch {
        /* ignore individual file errors */
      }
    }
  } catch {
    /* ignore top-level directory errors */
  }
  return cleaned;
}

try {
  fs.mkdirSync(config.scratchDir, { recursive: true });
  cleanOldScratchFiles(config.scratchDir, 21);
} catch {
  /* ignore */
}

export type Config = typeof config;
