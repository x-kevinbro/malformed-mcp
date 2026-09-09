/**
 * Gateway proxying tools from child stdio MCP servers into this server's tool list.
 *
 * Discovers tools exposed by child MCP servers defined with transport="stdio" in
 * `mcpServers` (src/panel/mcp-config.ts) and re-registers them with a prefix onto
 * this server. Calls to proxied tools are forwarded to the child client.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mcpServers } from "../panel/mcp-config.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { toShape, type JsonSchema } from "../browser/schema.js";

export type ProxiedToolDef = {
  prefixedName: string;
  originalName: string;
  title: string;
  description: string;
  inputSchema: JsonSchema | undefined;
  client: Client;
  key: string;
};

const PREFIX_MAP: Record<string, string> = {
  "terminal-security": "kali_",
  "browser-puppeteer": "puppeteer_",
  "filesystem": "fs_",
};

function getPrefix(key: string): string {
  if (PREFIX_MAP[key]) return PREFIX_MAP[key];
  return `${key.replace(/[^a-zA-Z0-9]/g, "_")}_`;
}

let proxiedTools: ProxiedToolDef[] = [];
const connectedClients: Array<{ key: string; client: Client; transport: StdioClientTransport }> = [];

/**
 * Connects to each child stdio MCP server at startup, lists its tools, and caches definitions.
 * Failures for individual child servers are logged and skipped without blocking malformed-mcp.
 */
export async function connectProxiedServers(): Promise<void> {
  const stdioServers = mcpServers.filter((s) => s.transport === "stdio");
  proxiedTools = [];

  for (const server of stdioServers) {
    if (!server.command) {
      logger.warn({ key: server.key }, "stdio child server missing command, skipping");
      continue;
    }

    const prefix = getPrefix(server.key);
    logger.info(
      { key: server.key, command: server.command, args: server.args, prefix },
      "connecting to proxied stdio MCP server",
    );

    try {
      const transport = new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
      });

      const client = new Client(
        { name: `${config.serverName}-proxy-${server.key}`, version: config.version },
        { capabilities: {} },
      );

      // Connect with a 15-second timeout
      const connectPromise = client.connect(transport);
      let timeoutId: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("Connection timeout")), 15_000);
        timeoutId.unref();
      });

      try {
        await Promise.race([connectPromise, timeoutPromise]);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }

      connectedClients.push({ key: server.key, client, transport });

      const listed = await client.listTools();
      for (const tool of listed.tools) {
        const prefixedName = `${prefix}${tool.name}`;
        const rawTitle = (tool.annotations?.title as string | undefined) ?? tool.title ?? tool.name;
        const title = `[${server.key}] ${rawTitle}`;
        const description = `[${server.key}] ${tool.description ?? ""}`.trim();

        proxiedTools.push({
          prefixedName,
          originalName: tool.name,
          title,
          description,
          inputSchema: tool.inputSchema as JsonSchema | undefined,
          client,
          key: server.key,
        });
      }

      logger.info(
        { key: server.key, count: listed.tools.length, prefix },
        "proxied stdio MCP server connected successfully",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ key: server.key, err: message }, "failed to proxy child stdio MCP server, skipping");
    }
  }
}

export function registerProxyTools(server: McpServer): void {
  if (!proxiedTools.length) return;

  for (const tool of proxiedTools) {
    server.registerTool(
      tool.prefixedName,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: toShape(tool.inputSchema),
      } as never,
      (async (args: Record<string, unknown>) => {
        try {
          const result = await tool.client.callTool({
            name: tool.originalName,
            arguments: args ?? {},
          });

          return {
            content: result.content ?? [],
            structuredContent: (result as { structuredContent?: unknown }).structuredContent,
            isError: Boolean(result.isError),
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: "text" as const, text: `Proxied tool ${tool.prefixedName} failed: ${message}` }],
            isError: true,
          };
        }
      }) as never,
    );
  }
}

export async function shutdownProxyTransports(): Promise<void> {
  logger.info({ count: connectedClients.length }, "shutting down proxied stdio MCP child servers");
  for (const { key, transport } of connectedClients) {
    try {
      await transport.close();
    } catch (error) {
      logger.warn({ key, err: String(error) }, "error closing proxied child transport");
    }
  }
  connectedClients.length = 0;
  proxiedTools = [];
}
