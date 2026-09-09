import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { buildToolFilter } from "./profiles.js";
import { registerShellTools } from "./tools/shell.js";
import { registerFileTools } from "./tools/files.js";
import { registerDockerTools } from "./tools/docker.js";
import { registerGitTools } from "./tools/git.js";
import { registerSystemTools } from "./tools/system.js";
import { registerDatabaseTools } from "./tools/database.js";
import { registerWebTools } from "./tools/web.js";
import { registerAuthoringTools } from "./tools/authoring.js";
import { registerCodeTools } from "./tools/code.js";
import { registerOutputTools } from "./tools/output.js";
import { registerBrowserTools } from "./tools/browser.js";
import { registerAuditTools } from "./tools/audit.js";
import { registerGithubTools } from "./tools/github/index.js";
import { registerSecurityTools } from "./tools/security.js";
import { registerLoaderTools } from "./tools/loader.js";
import { registerProxyTools } from "./tools/proxy.js";
import { createCategoryRegistry, describeParams, type ToolHandle, type ToolHandler } from "./categories.js";

/**
 * Adding a tool group is one entry in this list. Keeping registration as data
 * rather than a run of statements means the set can be counted and checked,
 * and nothing gets silently dropped.
 *
 * The first element is the category the group's tools belong to - what
 * load_tools offers and what it hides. Deriving membership from the registrar
 * rather than from a second list of tool names keeps the two from drifting.
 */
const REGISTRARS: Array<[string, (server: McpServer) => void]> = [
  ["shell", registerShellTools],
  ["files", registerFileTools],
  ["docker", registerDockerTools],
  ["git", registerGitTools],
  ["system", registerSystemTools],
  ["database", registerDatabaseTools],
  ["web", registerWebTools],
  ["authoring", registerAuthoringTools],
  ["code", registerCodeTools],
  ["output", registerOutputTools],
  ["audit", registerAuditTools],
  ["github", registerGithubTools],
  ["security", registerSecurityTools],
  // Reads the cache the bridge filled at startup; a no-op when the browser is
  // disabled or the handshake failed.
  ["browser", registerBrowserTools],
  // Tools proxied from child stdio MCP servers (terminal-security).
  ["proxy", registerProxyTools],
];

const INSTRUCTIONS = `
You have administrative control of the ${config.serverName} host through these tools.

Working defaults
- Default working directory: ${config.defaultCwd}
- Scratch directory for temporary work: ${config.scratchDir}
- Postgres container: ${config.dbContainer} (database ${config.dbName})
- Nginx container: ${config.nginxContainer}
- GitHub clones live at ${config.profilesDir}/<login>/<repo>_work. Never search the disk for a
  checkout: gh_profiles lists every clone with its branch and full path. Pass that path as cwd to
  git, repo_status or commit_push.

How to work
- Keep the VPS clean and organized: always put temporary test files, scratch scripts, experiments,
  and testing logs inside ${config.scratchDir} (never in /root, /tmp, /home, or arbitrary locations across
  the host). Do NOT delete test/scratch files inside ${config.scratchDir} when done—they are kept for review
  and automatically pruned after 3 weeks. If you ever accidentally create temporary files outside
  ${config.scratchDir}, clean them up immediately.
- Prefer the specific tool over run_command when one fits: read_file, read_image, edit_file, search_files,
  docker_logs, compose, journal, db_query.
- Reaching the internet: http_request fetches any URL (docs, APIs, release feeds) and renders HTML
  as readable text; download_file streams a URL to disk and returns its SHA-256.
- Moving files: write_file with encoding=base64 puts a file on the host, read_file with
  encoding=base64 takes one off it.
- search_files uses extended regular expressions. Pass literal:true to match punctuation exactly.
- Exploring code: read_files takes up to 20 paths at once, and outline:true returns just the
  declarations with line numbers - skim the outline, then read only the range you need.
- Read before you write. For source edits use patch_file: it applies several anchored edits in one
  call, checks every anchor first, and leaves the file untouched if any of them is wrong. edit_file
  is the single-edit version, and one patch_file call can span several files at once. write_file is
  for genuinely new files, not for changing existing ones.
- Never pass a secret to run_command: the command is echoed back. Use run_script, whose body is not.
- Take a backup before destructive changes: write_file/edit_file accept backup, and db_backup
  dumps Postgres.
- Long jobs: use start_background_job and inspect the output log with read_file instead of blocking.
- If a command times out, the whole process group is killed. Re-run it in the background.

Output, truncation and cost
- Results are compacted before you see them: escape codes, repeated lines and blank runs are
  removed. "x N more identical line(s)" means exactly that and nothing was altered.
- When a result is too large it is clamped and the WHOLE output is saved with an id. Never re-run
  the command to see the missing middle - call fetch_output with that id, and prefer grep= or
  tail= over reading it all back.
- Ask for less in the first place: read_files with outline:true, search_files before read_file,
  db_query with a LIMIT, docker_logs with a tail. Narrow retrieval beats large retrieval.
- tool_catalog reports the active profile, the output budget and the safety switches. If a tool you
  expect is missing, a profile is probably hiding it.

Secrets and safety
- Tool output is scrubbed for anything secret-shaped before it reaches you. Seeing "[redacted:...]"
  means the value was real and was withheld on purpose - do not try to route around it.
- Read-only mode has two grades: readOnly blocks every write, hostReadOnly blocks only changes to
  this machine. Both are set in src/config.ts.
- Every mutating call is recorded, and audit_log reads the record back. "What was changed here, and
  when?" is a question to answer from the trail rather than by guessing: audit_log summary=true for
  the shape of a session, then event= and contains= to find the specific call.
`.trim();

/**
 * Appended only when tools actually start hidden, so the instructions never
 * describe a loader the session does not have.
 */
const ON_DEMAND_NOTE = `

Loading tools
- This session starts with the reading tools only. The rest are grouped into categories that load
  on request. load_tools with no arguments lists them; loading one is instant and lasts the whole
  session. Load the category before planning work that needs it, not after a tool turns out to be
  missing.
- If a tool you just loaded is not in your tool list, your client did not re-read it. call_tool runs
  any tool by name regardless, and needs nothing from the client.`;

/** The shape we need from registerTool, without depending on the SDK's generics. */
type ToolConfig = {
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean };
};

type RegisterToolFn = (name: string, toolConfig: ToolConfig, handler: unknown) => unknown;

export function createMcpServer(): McpServer {
  // Every tool is listed up front unless a session deliberately asks for the
  // loader. Hiding them behind load_tools trades one fixed cost for a variable
  // one: a client that ignores notifications/tools/list_changed can only reach
  // a hidden tool through call_tool, which adds a round trip to every call,
  // moves argument checking off the client, and flattens image results. That is
  // the wrong trade for a client that never re-reads its list.
  // tools.preload=all is the same request spelled the other way round.
  const onDemand = config.tools.onDemand && !config.tools.preload.includes("all");

  const server = new McpServer(
    { name: config.serverName, version: config.version },
    {
      // listChanged is what lets a category appear mid-session.
      capabilities: { tools: { listChanged: true }, logging: {} },
      instructions: onDemand ? `${INSTRUCTIONS}${ON_DEMAND_NOTE}` : INSTRUCTIONS,
    },
  );

  const filter = buildToolFilter(config.tools);
  const registry = createCategoryRegistry();
  const original = server.registerTool.bind(server) as RegisterToolFn;
  const skipped: string[] = [];
  let category = "";

  // Every tool's name, description and schema is sent to the model before it
  // does any work, so a narrower profile is a real saving on every session -
  // and a tool the model cannot see is a tool it cannot call. Intercepting
  // registration catches all groups, including the few that call registerTool
  // directly rather than going through registerTools().
  const filtered: RegisterToolFn = (name, toolConfig, handler) => {
    if (!filter.allow(name, Boolean(toolConfig?.annotations?.readOnlyHint))) {
      skipped.push(name);
      return undefined;
    }
    const registered = original(name, toolConfig, handler);
    // Recorded whether or not on-demand loading is on: the registry is also how
    // call_tool finds a handler, and a filtered-out tool is absent from it, so
    // the profile cannot be undone by loading a category.
    registry.record({
      name,
      category,
      title: toolConfig?.title ?? name,
      description: toolConfig?.description ?? "",
      params: describeParams(toolConfig?.inputSchema),
      input: toolConfig?.inputSchema,
      handle: registered as ToolHandle | undefined,
      handler: handler as ToolHandler | undefined,
    });
    return registered;
  };

  (server as unknown as { registerTool: RegisterToolFn }).registerTool = filtered;
  try {
    for (const [name, register] of REGISTRARS) {
      category = name;
      register(server);
    }
  } finally {
    category = "";
    (server as unknown as { registerTool: RegisterToolFn }).registerTool = original;
  }

  // Registered after the filter is lifted. The loader is the one tool that must
  // never be hidden, or a narrowed session has no way back to everything else.
  if (onDemand) {
    registerLoaderTools(server, registry);
    const hidden = registry.start({ onDemand: true, preload: config.tools.preload });
    logger.info({ hidden, loaded: registry.loadedCategories() }, "tools load on demand");
  } else {
    // Nothing is hidden, so load_tools and call_tool are not registered either:
    // an indirection that can only reach tools the client already has is noise
    // in the manifest and an invitation to route around a working schema.
    registry.start({ onDemand: false, preload: [] });
    logger.info({ categories: registry.loadedCategories().length }, "all tools listed up front");
  }

  if (skipped.length) {
    logger.info(
      { policy: filter.describe(), hidden: skipped.length, tools: skipped },
      "tool profile applied",
    );
  }

  return server;
}

/**
 * Every tool this host can expose, regardless of the active profile or the
 * on-demand loader. Used by the control panel to show the full catalogue.
 * Registration is intercepted rather than the running server queried, so the
 * list is complete even when tools.onDemand hides most of them at runtime.
 */
export function listAllTools(): Array<{ name: string; description: string; category: string }> {
  const server = new McpServer(
    { name: config.serverName, version: config.version },
    { capabilities: { tools: { listChanged: true }, logging: {} } },
  );
  const tools: Array<{ name: string; description: string; category: string }> = [];
  const original = server.registerTool.bind(server) as RegisterToolFn;
  let category = "";
  const capture: RegisterToolFn = (name, toolConfig, handler) => {
    tools.push({ name, description: toolConfig?.description ?? "", category });
    return original(name, toolConfig, handler);
  };
  (server as unknown as { registerTool: RegisterToolFn }).registerTool = capture;
  try {
    for (const [name, register] of REGISTRARS) {
      category = name;
      register(server);
    }
  } finally {
    (server as unknown as { registerTool: RegisterToolFn }).registerTool = original;
  }
  return tools.sort(
    (a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name),
  );
}
