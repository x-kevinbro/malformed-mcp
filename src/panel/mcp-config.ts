/**
 * The MCP servers this host builds and wires together.
 *
 * Integrated into the control panel so an operator can see the exact set of
 * MCP servers running here, list each one's tools, check for updates, and copy
 * the client configuration verbatim.
 *
 * Bearer tokens are deliberately placeholders. Real credentials live in
 * runtime/token.txt and in each GitHub profile's issued token — never in a
 * file that gets committed to the repository.
 */

import path from "node:path";
import { config, ROOT } from "../config.js";
import { currentCert } from "./cert.js";

export const MCP_TOKEN_PLACEHOLDER = "YOUR_MCP_TOKEN_HERE";

/** How the panel checks for and applies updates to a server. */
export type UpdateSpec =
  | { type: "git"; dir: string; restart: string[] }
  | { type: "npm"; pkg: string; dir: string; restart: string[] }
  | { type: "self" };

export type McpServerEntry = {
  /** The key this server appears under in the client config. */
  key: string;
  /** How the client reaches it. */
  transport: "http" | "stdio";
  /** For http transports: the endpoint URL. */
  url?: string;
  /** For stdio transports: the command… */
  command?: string;
  /** …and its arguments. */
  args?: string[];
  /** One-line description shown in the panel. */
  note: string;
  /** The systemd unit backing this server, if any. */
  service?: string;
  /** How the panel checks for and applies updates. */
  update: UpdateSpec;
};

export const mcpServers: McpServerEntry[] = [
  {
    key: "malformed-mcp",
    transport: "http",
    get url() {
      const cert = currentCert();
      const host = cert?.domain || config.publicHost || "localhost";
      const scheme = cert?.domain ? "https" : "http";
      return `${scheme}://${host}:${config.port}/mcp`;
    },
    note: "This host — the Linux box, GitHub and a real headless browser over one StreamableHTTP endpoint.",
    service: "malformed-mcp.service",
    update: { type: "self" },
  },
  {
    key: "filesystem",
    transport: "stdio",
    command: path.join(ROOT, "node_modules", ".bin", "mcp-server-filesystem"),
    args: [path.join(ROOT, "mcp-workspace")],
    note: "Official filesystem MCP server scoped to this host's mcp-workspace directory.",
    service: "mcp-filesystem.service",
    update: {
      type: "npm",
      pkg: "@modelcontextprotocol/server-filesystem",
      dir: ROOT,
      restart: ["mcp-filesystem.service"],
    },
  },
  {
    key: "browser-puppeteer",
    transport: "stdio",
    command: path.join(ROOT, "node_modules", ".bin", "mcp-server-puppeteer"),
    args: [],
    note: "Official headless browser Puppeteer MCP server for page automation.",
    service: "mcp-puppeteer.service",
    update: {
      type: "npm",
      pkg: "@modelcontextprotocol/server-puppeteer",
      dir: ROOT,
      restart: ["mcp-puppeteer.service"],
    },
  },
  {
    key: "terminal-security",
    transport: "stdio",
    command: path.join(ROOT, "vendor", "mcp-kali-server", ".venv", "bin", "python"),
    args: [path.join(ROOT, "vendor", "mcp-kali-server", "client.py"), "--server", "http://127.0.0.1:5000"],
    note: "Kali MCP bridge (Wh0am123/MCP-Kali-Server) talking to a local Flask tools API on 127.0.0.1:5000.",
    service: "mcp-kali.service",
    update: {
      type: "git",
      dir: path.join(ROOT, "vendor", "mcp-kali-server"),
      restart: ["mcp-kali-api.service", "mcp-kali.service"],
    },
  },
];

/** The client configuration, rendered exactly as an MCP client expects it. */
export function clientConfig(): { mcpServers: Record<string, unknown> } {
  const servers: Record<string, unknown> = {};
  for (const server of mcpServers) {
    if (server.transport === "http") {
      servers[server.key] = {
        url: server.url,
        headers: { Authorization: `Bearer ${MCP_TOKEN_PLACEHOLDER}` },
      };
    } else {
      servers[server.key] = { command: server.command, args: server.args ?? [] };
    }
  }
  return { mcpServers: servers };
}

/** The same configuration as pretty-printed JSON, for display and download. */
export function clientConfigJson(): string {
  return JSON.stringify(clientConfig(), null, 2);
}
