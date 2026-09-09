/**
 * What the panel is allowed to change, and how a change is applied.
 *
 * Only the fields listed here are editable. A generic "edit any config key"
 * screen would expose the path fields - which must stay inside this folder -
 * and the token, which has its own rotation flow. Anything not in this table is
 * simply not settable from the web.
 *
 * Saving writes runtime/settings.json and nothing more. The new values take
 * effect on the next boot, so the panel reports a restart as pending until the
 * operator performs one.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { Router } from "express";
import { config, ROOT } from "../config.js";
import { audit, logger } from "../logger.js";

export type FieldType = "string" | "number" | "boolean" | "list" | "choice";

export type Field = {
  /** Dotted path into config, e.g. "browser.maxTabs". */
  key: string;
  label: string;
  type: FieldType;
  help?: string;
  choices?: string[];
  min?: number;
  max?: number;
};

export const CATEGORIES: Array<{ name: string; blurb: string; fields: Field[] }> = [
  {
    name: "Network",
    blurb: "Where the server listens and which hosts may reach it.",
    fields: [
      {
        key: "port",
        label: "Port",
        type: "number",
        min: 1,
        max: 65535,
        help: "Serves both the panel and /mcp. Changing this needs the firewall opened to match.",
      },
      {
        key: "bind",
        label: "Bind address",
        type: "string",
        help: "0.0.0.0 for anywhere, 127.0.0.1 for this machine only.",
      },
      {
        key: "publicHosts",
        label: "Public hostnames",
        type: "list",
        help: "Domains this server answers to. Used for CORS and DNS-rebinding protection.",
      },
      {
        key: "ipAllowlist",
        label: "IP allowlist",
        type: "list",
        help: "Empty means any address may connect.",
      },
      { key: "trustProxy", label: "Trusted proxy hops", type: "number", min: 0, max: 10 },
      { key: "dnsRebindProtection", label: "DNS rebinding protection", type: "boolean" },
      {
        key: "publicHost",
        label: "Public host",
        type: "string",
        help: "Primary hostname clients use to reach this server.",
      },
      {
        key: "jsonResponse",
        label: "Plain JSON responses",
        type: "boolean",
        help: "Return MCP responses as JSON instead of a streamed SSE body.",
      },
    ],
  },
  {
    name: "Security",
    blurb: "What the tools are permitted to do and reach.",
    fields: [
      {
        key: "readOnly",
        label: "Read-only (everything)",
        type: "boolean",
        help: "Blocks every write, on this host and on GitHub.",
      },
      { key: "hostReadOnly", label: "Read-only (this host)", type: "boolean" },
      { key: "githubReadOnly", label: "Read-only (GitHub)", type: "boolean" },
      { key: "redactOutput", label: "Redact secrets from output", type: "boolean" },
      { key: "net.allowHosts", label: "Network allowlist", type: "list" },
      { key: "net.denyHosts", label: "Network denylist", type: "list" },
      { key: "net.blockPrivate", label: "Block private networks", type: "boolean" },
      {
        key: "sec.allowTargets",
        label: "Security tool allowlist",
        type: "list",
        help: "Hosts the sec_* tools may scan or load-test. Wildcard * allows all.",
      },
      {
        key: "sec.loadMaxVus",
        label: "Max load test VUs",
        type: "number",
        min: 1,
        help: "Maximum virtual users for sec_load_test.",
      },
      {
        key: "sec.loadMaxDurationS",
        label: "Max load test duration (s)",
        type: "number",
        min: 1,
        help: "Maximum duration in seconds for sec_load_test.",
      },
    ],
  },
  {
    name: "Execution",
    blurb: "Command execution limits.",
    fields: [
      { key: "shell", label: "Shell", type: "string" },
      { key: "timeoutMs", label: "Default timeout (ms)", type: "number", min: 1000 },
      { key: "maxTimeoutMs", label: "Maximum timeout (ms)", type: "number", min: 1000 },
      { key: "maxConcurrentExec", label: "Concurrent commands", type: "number", min: 1, max: 64 },
      {
        key: "maxOutput",
        label: "Default max output characters",
        type: "number",
        min: 1000,
        help: "The agent may request a different budget on tools that expose max_output.",
      },
      {
        key: "compactOutput",
        label: "Output compaction",
        type: "choice",
        choices: ["off", "safe", "aggressive"],
      },
    ],
  },
  {
    name: "Tools",
    blurb: "Which tools are exposed to agents.",
    fields: [
      {
        key: "tools.profile",
        label: "Tool profile",
        type: "choice",
        choices: ["full", "readonly", "debug", "database", "browser"],
      },
      { key: "tools.only", label: "Only these tools", type: "list" },
      {
        key: "tools.exclude",
        label: "Never these tools",
        type: "list",
        help: "Exclusion wins over both the allowlist and the profile.",
      },
      {
        key: "tools.onDemand",
        label: "Load tools on demand",
        type: "boolean",
        help: "Start with reading tools only; the rest load via load_tools per session.",
      },
      {
        key: "tools.preload",
        label: "Preload categories",
        type: "list",
        help: "Categories loaded up front when on-demand is enabled. Use 'all' for everything.",
      },
    ],
  },
  {
    name: "Rate limiting",
    blurb: "How much traffic one client may generate.",
    fields: [
      { key: "rateWindowMs", label: "Window (ms)", type: "number", min: 1000 },
      {
        key: "rateMax",
        label: "Requests per window",
        type: "number",
        min: 0,
        help: "Set to 0 to disable rate limiting.",
      },
      { key: "maxBody", label: "Max request body", type: "string", help: "For example 64mb." },
    ],
  },
  {
    name: "Browser",
    blurb: "The headless browser tools.",
    fields: [
      { key: "browser.enabled", label: "Enabled", type: "boolean" },
      { key: "browser.headless", label: "Headless", type: "boolean" },
      { key: "browser.maxTabs", label: "Maximum tabs", type: "number", min: 1, max: 20 },
      { key: "browser.allowPrivateNet", label: "Allow private networks", type: "boolean" },
      { key: "browser.idleMs", label: "Idle shutdown (ms)", type: "number", min: 10_000 },
      { key: "browser.callTimeoutMs", label: "Call timeout (ms)", type: "number", min: 1000 },
      { key: "browser.lockWaitMs", label: "Lock wait (ms)", type: "number", min: 1000 },
      {
        key: "browser.caps",
        label: "Extra capabilities",
        type: "list",
        help: "Beyond core navigation/input/tabs. For example: pdf.",
      },
      { key: "browser.killOnError", label: "Restart browser on tool error", type: "boolean" },
      { key: "browser.killOnAnyError", label: "Restart browser on any error", type: "boolean" },
    ],
  },
  {
    name: "Database",
    blurb: "Defaults for the db_* tools.",
    fields: [
      { key: "dbContainer", label: "Container", type: "string" },
      { key: "dbName", label: "Database", type: "string" },
      { key: "dbUser", label: "User", type: "string" },
      { key: "nginxContainer", label: "Nginx container", type: "string" },
      { key: "apiContainer", label: "API container", type: "string" },
    ],
  },
  {
    name: "Panel",
    blurb: "This interface.",
    fields: [
      {
        key: "serverName",
        label: "Server name",
        type: "string",
        help: "Shown in the title bar, footer and MCP handshake.",
      },
      { key: "panel.enabled", label: "Panel enabled", type: "boolean" },
      {
        key: "panel.sessionHours",
        label: "Session length (hours)",
        type: "number",
        min: 0,
        max: 720,
        help: "Set to 0 for a login that does not expire.",
      },
      { key: "panel.credit", label: "Footer credit", type: "string" },
      {
        key: "logLevel",
        label: "Log level",
        type: "choice",
        choices: ["trace", "debug", "info", "warn", "error", "fatal"],
      },
    ],
  },
  {
    name: "Sessions",
    blurb: "Long-lived MCP stream hygiene.",
    fields: [
      { key: "sseKeepAliveMs", label: "Keep-alive heartbeat (ms)", type: "number", min: 1000 },
      { key: "sessionIdleMs", label: "Idle session timeout (ms)", type: "number", min: 10_000 },
      { key: "sessionReapMs", label: "Reaper interval (ms)", type: "number", min: 1000 },
      { key: "maxSessions", label: "Maximum concurrent sessions", type: "number", min: 1, max: 4096 },
    ],
  },
  {
    name: "GitHub",
    blurb: "Transport defaults shared by every GitHub profile.",
    fields: [
      { key: "github.apiUrl", label: "API URL", type: "string" },
      { key: "github.apiVersion", label: "API version", type: "string" },
      { key: "github.timeoutMs", label: "Request timeout (ms)", type: "number", min: 1000 },
      { key: "github.downloadTimeoutMs", label: "Download timeout (ms)", type: "number", min: 1000 },
      { key: "github.maxRetries", label: "Max retries", type: "number", min: 0, max: 10 },
    ],
  },
];

const EDITABLE = new Set(CATEGORIES.flatMap((c) => c.fields.map((f) => f.key)));

function settingsFile(): string {
  return path.join(ROOT, "runtime", "settings.json");
}

function readOverrides(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(settingsFile(), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeOverrides(data: Record<string, unknown>): void {
  mkdirSync(path.dirname(settingsFile()), { recursive: true });
  const tmp = `${settingsFile()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, settingsFile());
}

function get(source: any, dotted: string): unknown {
  return dotted.split(".").reduce((acc, part) => (acc == null ? acc : acc[part]), source);
}

function setDotted(target: Record<string, any>, dotted: string, value: unknown): void {
  const parts = dotted.split(".");
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    if (typeof cursor[part] !== "object" || cursor[part] === null) cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts[parts.length - 1]!] = value;
}

/** Coerce a form value to the field's declared type, rejecting nonsense. */
function coerce(field: Field, raw: unknown): unknown {
  switch (field.type) {
    case "number": {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`${field.label} must be a number.`);
      if (field.min !== undefined && n < field.min)
        throw new Error(`${field.label} must be at least ${field.min}.`);
      if (field.max !== undefined && n > field.max)
        throw new Error(`${field.label} must be at most ${field.max}.`);
      return n;
    }
    case "boolean":
      return raw === true || raw === "true" || raw === "on";
    case "list":
      if (Array.isArray(raw)) return raw.map((v) => String(v).trim()).filter(Boolean);
      return String(raw ?? "")
        .split(/[,\n]/)
        .map((v) => v.trim())
        .filter(Boolean);
    case "choice": {
      const value = String(raw ?? "");
      if (field.choices && !field.choices.includes(value)) {
        throw new Error(`${field.label} must be one of: ${field.choices.join(", ")}.`);
      }
      return value;
    }
    default:
      return String(raw ?? "");
  }
}

/**
 * A change is pending whenever the saved overlay differs from what this process
 * booted with. That comparison is what drives the "restart required" banner,
 * and it clears itself once the restart has actually happened.
 */
export function restartPending(): boolean {
  const overrides = readOverrides();
  for (const category of CATEGORIES) {
    for (const field of category.fields) {
      const saved = get(overrides, field.key);
      if (saved === undefined) continue;
      const live = get(config, field.key);
      if (JSON.stringify(saved) !== JSON.stringify(live)) return true;
    }
  }
  return false;
}

export function settingsRouter(): Router {
  const r = Router();

  r.get("/api/settings", (_req, res) => {
    const overrides = readOverrides();
    res.json({
      restartPending: restartPending(),
      categories: CATEGORIES.map((category) => ({
        name: category.name,
        blurb: category.blurb,
        fields: category.fields.map((field) => ({
          ...field,
          // "live" is what this process is running with; "saved" is what the
          // next boot will use. Showing both is what makes a pending restart
          // legible instead of mysterious.
          live: get(config, field.key),
          saved: get(overrides, field.key) ?? get(config, field.key),
          changed:
            get(overrides, field.key) !== undefined &&
            JSON.stringify(get(overrides, field.key)) !== JSON.stringify(get(config, field.key)),
        })),
      })),
    });
  });

  r.post("/api/settings", (req, res) => {
    const patch = (req.body ?? {}) as Record<string, unknown>;
    const overrides = readOverrides();
    const applied: string[] = [];

    try {
      for (const [key, raw] of Object.entries(patch)) {
        if (!EDITABLE.has(key)) throw new Error(`"${key}" is not an editable setting.`);
        const field = CATEGORIES.flatMap((c) => c.fields).find((f) => f.key === key)!;
        setDotted(overrides, key, coerce(field, raw));
        applied.push(key);
      }
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
      return;
    }

    writeOverrides(overrides);
    audit("settings_saved", { keys: applied });
    res.json({
      ok: true,
      applied,
      restartPending: restartPending(),
      note: "Saved. These values take effect when the server restarts.",
    });
  });

  r.post("/api/restart", (_req, res) => {
    audit("restart_requested", {});
    res.json({ ok: true, note: "Restarting. The panel will be unavailable for a few seconds." });

    // Answer first, then go down: the browser needs the response before the
    // socket closes, or the operator sees a network error instead of a restart.
    setTimeout(() => {
      // --no-block matters. Without it systemctl waits for the job to finish,
      // but the job's first act is to stop this unit - which kills the very
      // systemctl that is waiting, inside the same cgroup. The callback then
      // fired with an error and this process exited 1 *while* systemd was
      // restarting it, and the unit landed in failed state instead of coming
      // back. Handing the job to systemd and returning immediately means the
      // restart survives our own death, which is the entire point of it.
      execFile("systemctl", ["restart", "--no-block", "malformed-mcp"], (error) => {
        if (!error) return;
        // Not running under systemd - exit non-zero and let whatever supervises
        // this process bring it back. If nothing does, it stays down, which is
        // honest: the panel said it was restarting and it stopped.
        logger.warn({ err: error }, "systemctl restart failed; exiting for the supervisor");
        process.exit(1);
      });
    }, 250);
  });

  return r;
}

export function settingsFileExists(): boolean {
  return existsSync(settingsFile());
}
