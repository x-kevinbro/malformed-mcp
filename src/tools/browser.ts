/**
 * Browser tools, proxied from @playwright/mcp into this server's tool list.
 *
 * These register with `server.registerTool` directly rather than going through
 * `defineTool`/`registerTools`. The shared helper funnels everything through
 * `ok()`, which is text-only, and browser results carry **image content blocks**
 * for screenshots. Those have to survive.
 *
 * Bypassing `ok()` means the safety pipeline is this file's job: redact and
 * compact every text block on the way out, leave image blocks alone, and
 * forward `isError` from upstream rather than inventing a verdict.
 *
 * Registration is synchronous and reads the cache the bridge filled at startup,
 * so it goes through the same REGISTRARS list and the profile filter in
 * `createMcpServer` applies to browser tools like any other.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "../config.js";
import { compact } from "../compress.js";
import { redactSecrets } from "../redact.js";
import { audit } from "../logger.js";
import { assertWritable } from "../result.js";
import { browserTools, callBrowserTool, type BrowserContentBlock } from "../browser/bridge.js";
import { toShape } from "../browser/schema.js";

/** The same scrubbing every other result gets, applied per text block. */
function cleanText(text: string): string {
  const scrubbed = config.redactOutput ? redactSecrets(text) : text;
  const compacted = compact(scrubbed, config.compactOutput);
  if (compacted.length <= config.maxOutput) return compacted;
  return (
    compacted.slice(0, config.maxOutput) +
    `\n\n[clamped at ${config.maxOutput.toLocaleString()} characters. Large snapshots and network ` +
    `logs are also written to ${config.browser.outputDir}.]`
  );
}

function cleanBlocks(blocks: BrowserContentBlock[]): BrowserContentBlock[] {
  return blocks.map((block) =>
    block.type === "text" && typeof (block as { text?: unknown }).text === "string"
      ? { ...block, text: cleanText((block as { text: string }).text) }
      : block,
  );
}

export function registerBrowserTools(server: McpServer): void {
  const tools = browserTools();
  if (!tools.length) return;

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: toShape(tool.inputSchema),
        annotations: { readOnlyHint: tool.readOnly, destructiveHint: false },
      } as never,
      (async (args: Record<string, unknown>) => {
        try {
          if (!tool.readOnly) assertWritable(tool.name);
          audit(tool.name, { url: args?.url, action: args?.action });
          const result = await callBrowserTool(tool.name, args ?? {});
          return { content: cleanBlocks(result.content), isError: result.isError };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: "text" as const, text: `${tool.name} failed: ${cleanText(message)}` }],
            isError: true,
          };
        }
      }) as never,
    );
  }
}
