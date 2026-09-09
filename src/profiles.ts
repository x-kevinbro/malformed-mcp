/**
 * Tool profiles.
 *
 * Every tool's name, description and JSON schema is sent to the model before it
 * does anything at all. At fifty-one tools that is a fixed cost on every single
 * session, paid whether or not the work touches GitHub, the database or nginx.
 *
 * A profile narrows the set. It is the largest single token saving available
 * here, and it doubles as a safety control: a session that cannot see a tool
 * cannot call it.
 */

export type ToolPredicate = (name: string, readOnly: boolean) => boolean;

/** Prefix glob: "gh_*" or an exact name. */
function matches(name: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1));
  return name === pattern;
}

function anyMatch(name: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matches(name, pattern));
}

/** Tools worth having in almost any profile: reading and orientation. */
const CORE = [
  "read_file",
  "read_files",
  "read_image",
  "list_dir",
  "find_files",
  "search_files",
  "fetch_output",
  "tool_catalog",
];

export const PROFILES: Record<string, { description: string; allow: ToolPredicate }> = {
  full: {
    description: "Everything. The default.",
    allow: () => true,
  },

  readonly: {
    description: "Only tools that cannot change anything.",
    allow: (_name, readOnly) => readOnly,
  },

  debug: {
    description: "Diagnosing a misbehaving service: logs, probes and inspection.",
    allow: (name) =>
      anyMatch(name, [
        "docker_*",
        "journal",
        "audit_log",
        "service",
        "system_info",
        "http_request",
        "db_query",
        "db_schema",
        ...CORE,
      ]),
  },

  database: {
    description: "Database work only.",
    allow: (name) => anyMatch(name, ["db_*", "docker_exec", ...CORE]),
  },

  browser: {
    description: "Driving a real page, plus enough of the host to explain what it shows.",
    allow: (name) =>
      anyMatch(name, ["browser_*", "http_request", "docker_logs", "journal", ...CORE]),
  },
};

/**
 * Upstream ships ~21 browser tools with long descriptions. Dropped into every
 * manifest they would roughly double the cost that tranche 2 spent effort
 * removing, including on the sessions that never open a page. So the narrow
 * profiles do not carry them: a profile chosen for one job should not pay for
 * another.
 */
for (const [name, profile] of Object.entries(PROFILES)) {
  if (name === "full" || name === "browser" || name === "readonly") continue;
  const inner = profile.allow;
  profile.allow = (toolName, readOnly) =>
    toolName.startsWith("browser_") ? false : inner(toolName, readOnly);
}

export type ToolFilter = {
  allow: ToolPredicate;
  /** Human-readable summary of the active policy, for the startup log. */
  describe: () => string;
};

/**
 * Compose the active filter: profile first, then an explicit allowlist, then an
 * exclude list. Exclude always wins, so it can be trusted as a kill switch.
 */
export function buildToolFilter(options: { profile: string; only: string[]; exclude: string[] }): ToolFilter {
  const profile = PROFILES[options.profile] ?? PROFILES.full;
  const known = options.profile in PROFILES;

  return {
    allow(name, readOnly) {
      if (options.exclude.length && anyMatch(name, options.exclude)) return false;
      if (options.only.length) return anyMatch(name, options.only);
      return profile!.allow(name, readOnly);
    },
    describe() {
      const parts = [known ? `profile=${options.profile}` : `profile=full (unknown "${options.profile}")`];
      if (options.only.length) parts.push(`only=${options.only.join(",")}`);
      if (options.exclude.length) parts.push(`exclude=${options.exclude.join(",")}`);
      return parts.join(" ");
    },
  };
}

/** Names and one-line descriptions, for documentation and error messages. */
export function profileSummary(): string {
  return Object.entries(PROFILES)
    .map(([name, { description }]) => `  ${name.padEnd(9)} ${description}`)
    .join("\n");
}
