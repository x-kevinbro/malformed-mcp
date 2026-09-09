/**
 * Tool categories, loaded on demand.
 *
 * A profile is chosen before the work is known, which is the wrong moment: the
 * session that picks `host` and then needs one `gh_*` call has to reconnect.
 * The manifest is also paid in full on every session - the client fetches ~55 KB
 * of tool list before any work happens, several times in a burst.
 *
 * So the session starts with the reading tools plus a loader, and the rest
 * arrive when the model says which category it wants. Being wrong at the start
 * then costs one round trip instead of a reconnect.
 *
 * This file deliberately does not import config. It is handed what it needs, so
 * it can be tested without a valid environment, and so the registry is per
 * server instance rather than a module-level singleton shared across sessions.
 */

/** What the SDK hands back from registerTool. Narrowed to what we use. */
export type ToolHandle = { enable(): void; disable(): void };

export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

export type ToolFacts = {
  name: string;
  category: string;
  title: string;
  description: string;
  /** Parameter names, with "?" for the optional ones. */
  params: string[];
  handle?: ToolHandle | undefined;
  handler?: ToolHandler | undefined;
  /**
   * The tool's zod raw shape. The SDK applies this before it calls a handler,
   * which is where `.default()` values come from. Reaching a handler directly
   * skips that, so call_tool keeps the shape in order to apply it itself.
   */
  input?: unknown;
};

/**
 * Tools every session keeps regardless of category: reading and orientation.
 * A session that cannot read a file or ask what exists is a session that cannot
 * decide what to load, so these are never hidden.
 */
export const ALWAYS_ON = [
  "read_file",
  "read_files",
  "read_image",
  "list_dir",
  "find_files",
  "search_files",
  "fetch_output",
  "tool_catalog",
];

/**
 * One line per category, shown before anything is loaded. This is the text the
 * model chooses from, so it describes the job rather than the module.
 */
export const CATEGORY_DESCRIPTIONS: Record<string, string> = {
  shell: "Run commands and scripts on the host; background long jobs and tail their logs.",
  files: "Write, edit, move, copy and delete files.",
  docker: "Containers and compose: status, logs, exec, inspect, up and down.",
  git: "Run git commands against a local checkout.",
  system: "Host state: hardware, services, journal, listening ports, packages, nginx, HTTP probes.",
  database: "Postgres: run SQL, inspect the schema, take a dump.",
  web: "Reach the internet from the host: fetch a URL, download a file.",
  authoring: "Change several files atomically, and commit and push.",
  code: "Read many files at once, or skim their declarations.",
  output: "Retrieve truncated results and report what this server can do.",
  audit: "This server's own trail: what it changed, when, and on whose session.",
  github: "The gh_* suite: repositories, files, commits, issues, pull requests, Actions, secrets.",
  security:
    "Assess an allowlisted target: TLS audit, web/vuln scan, content discovery, dependency scan, capped load test.",
  browser: "Drive a real page: navigate, snapshot, click, screenshot, read the console.",
  proxy: "Tools proxied from child stdio MCP servers (terminal-security, browser-puppeteer, filesystem).",
};

/**
 * Parameter names for a zod raw shape, marking the optional ones. Enough for a
 * model to decide whether a tool is the one it wants; the real schema arrives
 * with the tool when the category loads.
 */
export function describeParams(shape: unknown): string[] {
  if (!shape || typeof shape !== "object") return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(shape as Record<string, unknown>)) {
    let optional = false;
    const parser = value as { safeParse?: (input: unknown) => { success: boolean } };
    try {
      optional = parser.safeParse?.(undefined).success ?? false;
    } catch {
      optional = false;
    }
    out.push(optional ? `${key}?` : key);
  }
  return out;
}

export type ArgCheck = { ok: true; value: Record<string, unknown> } | { ok: false; problems: string[] };

/**
 * Validate arguments against a zod raw shape and fill in its defaults.
 *
 * The SDK does this before it calls a tool's handler, so a parameter declared
 * `.default(200)` and then omitted arrives as 200. call_tool reaches the handler
 * directly and would otherwise skip it: the parameter arrives undefined and a
 * tool that interpolates it into a shell sees the string "undefined".
 *
 * Each field is parsed on its own rather than through z.object(), so this file
 * keeps its promise not to import anything - the same duck-typing describeParams
 * already relies on.
 */
export function parseToolArgs(shape: unknown, args: Record<string, unknown>): ArgCheck {
  if (!shape || typeof shape !== "object") return { ok: true, value: args };

  const value: Record<string, unknown> = { ...args };
  const problems: string[] = [];

  for (const [key, field] of Object.entries(shape as Record<string, unknown>)) {
    const parser = field as {
      safeParse?: (input: unknown) => {
        success: boolean;
        data?: unknown;
        error?: { issues?: Array<{ message?: string }> };
      };
    };
    if (typeof parser?.safeParse !== "function") continue;

    let result;
    try {
      result = parser.safeParse(args[key]);
    } catch {
      continue;
    }

    if (!result.success) {
      problems.push(`${key}: ${result.error?.issues?.[0]?.message ?? "invalid"}`);
      continue;
    }
    // An absent optional stays absent rather than becoming an explicit undefined.
    if (result.data === undefined) delete value[key];
    else value[key] = result.data;
  }

  return problems.length ? { ok: false, problems } : { ok: true, value };
}

export type LoadResult = {
  loaded: string[];
  already: string[];
  unknown: string[];
  revealed: number;
};

export type CategoryRegistry = {
  record: (facts: ToolFacts) => void;
  /** Hide everything outside ALWAYS_ON and the preloaded categories. */
  start: (options: { onDemand: boolean; preload: string[] }) => number;
  load: (names: string[]) => LoadResult;
  /** Load whatever category owns this tool. Returns true if anything changed. */
  ensureLoadedFor: (toolName: string) => boolean;
  get: (toolName: string) => ToolFacts | undefined;
  onDemand: () => boolean;
  loadedCategories: () => string[];
  categories: () => Array<{ name: string; description: string; count: number; loaded: boolean }>;
  /** The menu: one line per category, for a session that has loaded nothing. */
  catalogue: () => string;
  /** Names, titles and parameters for the given categories. */
  listing: (names: string[], verbose: boolean) => string;
};

export function createCategoryRegistry(): CategoryRegistry {
  const tools = new Map<string, ToolFacts>();
  const loaded = new Set<string>();
  let onDemand = false;

  const inCategory = (name: string): ToolFacts[] =>
    [...tools.values()].filter((tool) => tool.category === name);

  const known = (): string[] => [...new Set([...tools.values()].map((t) => t.category))].sort();

  function reveal(name: string): number {
    let count = 0;
    for (const tool of inCategory(name)) {
      if (ALWAYS_ON.includes(tool.name)) continue;
      tool.handle?.enable();
      count += 1;
    }
    loaded.add(name);
    return count;
  }

  return {
    record(facts) {
      tools.set(facts.name, facts);
    },

    start({ onDemand: enabled, preload }) {
      // preload=["all"] asks for every category at startup, which is the same
      // request as not loading on demand at all: nothing ends up hidden, so the
      // session is not an on-demand one and the loader has nothing to reveal.
      const everything = preload.includes("all");
      onDemand = enabled && !everything;
      if (!onDemand) {
        for (const category of known()) loaded.add(category);
        return 0;
      }

      for (const category of preload) if (known().includes(category)) loaded.add(category);

      let hidden = 0;
      for (const tool of tools.values()) {
        if (ALWAYS_ON.includes(tool.name)) continue;
        if (loaded.has(tool.category)) continue;
        tool.handle?.disable();
        hidden += 1;
      }
      return hidden;
    },

    load(names) {
      const result: LoadResult = { loaded: [], already: [], unknown: [], revealed: 0 };
      const all = known();
      const wanted = names.includes("all") ? all : names;

      for (const name of wanted) {
        if (!all.includes(name)) {
          result.unknown.push(name);
          continue;
        }
        if (loaded.has(name)) {
          result.already.push(name);
          continue;
        }
        result.revealed += reveal(name);
        result.loaded.push(name);
      }
      return result;
    },

    ensureLoadedFor(toolName) {
      const tool = tools.get(toolName);
      if (!tool || loaded.has(tool.category)) return false;
      reveal(tool.category);
      return true;
    },

    get: (toolName) => tools.get(toolName),
    onDemand: () => onDemand,
    loadedCategories: () => [...loaded].sort(),

    categories: () =>
      known().map((name) => ({
        name,
        description: CATEGORY_DESCRIPTIONS[name] ?? "",
        count: inCategory(name).length,
        loaded: loaded.has(name),
      })),

    catalogue() {
      const rows = known().map((name) => {
        const mark = loaded.has(name) ? "*" : " ";
        const count = String(inCategory(name).length).padStart(2);
        return `${mark} ${name.padEnd(9)} ${count}  ${CATEGORY_DESCRIPTIONS[name] ?? ""}`;
      });
      return [
        "category   tools  what it is for   (* = already loaded)",
        ...rows,
        "",
        'Load one with load_tools categories=["github"], or several at once. Loading is',
        "cheap and permanent for this session; the tools then appear in your tool list.",
      ].join("\n");
    },

    listing(names, verbose) {
      const out: string[] = [];
      for (const name of names) {
        const group = inCategory(name);
        if (!group.length) continue;
        out.push(`--- ${name} (${group.length}) ---`);
        for (const tool of group) {
          out.push(`${tool.name}(${tool.params.join(", ")})`);
          out.push(`    ${verbose ? tool.description : tool.title}`);
        }
        out.push("");
      }
      return out.join("\n").trimEnd();
    },
  };
}
