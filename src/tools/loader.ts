/**
 * The loader: the one tool a session starts with that can produce the others.
 *
 * Two mechanisms live here because only one of them is guaranteed to work, and
 * which one depends on the client:
 *
 *   load_tools  reveals a category by enabling its tools and announcing that the
 *               list changed. Cheapest, and the tools arrive with their real
 *               schemas - but a client that ignores notifications/tools/list_changed
 *               will never re-read the list, and the tools stay invisible to it.
 *
 *   call_tool   the fallback that needs nothing from the client: it invokes any
 *               registered tool by name, loading its category first. One extra
 *               round trip, and the model works from the parameter list that
 *               load_tools printed rather than a validated schema.
 *
 * Both respect the profile filter, because a tool the filter rejected was never
 * registered at all: it is absent from the registry, so it can be neither
 * revealed nor called. Read-only grades are likewise untouched - call_tool does
 * not assert anything itself, it just runs the tool, and the tool's own
 * assertWritable() still refuses.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool, registerTools } from "../tool.js";
import { parseToolArgs } from "../categories.js";
import type { CategoryRegistry } from "../categories.js";
import { audit } from "../logger.js";

/** Tell the client its tool list is stale. Harmless if it is not listening. */
function announce(server: McpServer): void {
  try {
    server.sendToolListChanged();
  } catch {
    // Not connected yet, or the client declared no tools capability. The tools
    // are enabled either way, and call_tool works regardless.
  }
}

/** Text blocks out of whatever a tool handler returned. */
function flatten(result: unknown): { text: string; isError: boolean; dropped: number; droppedImages: number } {
  const value = result as {
    content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>;
    isError?: boolean;
  };
  const blocks = Array.isArray(value?.content) ? value.content : [];
  const text = blocks
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
  const droppedImages = blocks.filter((b) => b?.type === "image").length;
  const dropped = blocks.length - blocks.filter((b) => b?.type === "text").length;
  return { text, isError: Boolean(value?.isError), dropped, droppedImages };
}

export function registerLoaderTools(server: McpServer, registry: CategoryRegistry): void {
  const loadTools = defineTool({
    name: "load_tools",
    title: "List tool categories, and load the ones you need",
    description:
      "This session starts with the reading tools only; everything else is grouped into " +
      "categories that load on request. Call with no arguments to see the categories, then " +
      "load the one that fits the job - loading is instant, permanent for this session, and " +
      "the tools then appear in your tool list with full schemas. If they do not appear, your " +
      "client is not re-reading the list: use call_tool instead, which always works.",
    readOnly: true,
    input: {
      categories: z
        .array(z.string())
        .default([])
        .describe('Categories to load, or ["all"]. Empty lists the categories without loading.'),
      verbose: z
        .boolean()
        .default(false)
        .describe("Full descriptions for the loaded tools instead of one-line titles."),
    },
    run({ categories, verbose }) {
      if (!categories.length) return registry.catalogue();

      const result = registry.load(categories);
      if (result.loaded.length) announce(server);
      audit("load_tools", { categories: result.loaded, revealed: result.revealed });

      const out: string[] = [];
      if (result.unknown.length) {
        out.push(`No such category: ${result.unknown.join(", ")}`, "", registry.catalogue(), "");
      }
      if (result.already.length) out.push(`Already loaded: ${result.already.join(", ")}`);
      if (result.loaded.length) {
        out.push(
          `Loaded ${result.loaded.join(", ")} - ${result.revealed} tool(s) now available.`,
          "",
          registry.listing(result.loaded, verbose),
          "",
          "If these are not in your tool list, call them through call_tool.",
        );
      }
      return out.join("\n").trim();
    },
  });

  const callTool = defineTool({
    name: "call_tool",
    title: "Run a tool by name, whether or not it is loaded",
    description:
      "Invokes any tool this server has, loading its category first if needed. Use it when a " +
      "tool you loaded has not appeared in your tool list, or to make a single call without " +
      "loading its whole category. Prefer the tool directly when it is visible: the arguments " +
      "are then schema-checked, and image results survive. Run load_tools first to see the " +
      "parameter names.",
    readOnly: false,
    input: {
      tool: z.string().describe('Exact tool name, e.g. "gh_status".'),
      args: z
        .record(z.string(), z.unknown())
        .default({})
        .describe("Arguments object for that tool, exactly as its parameters describe."),
    },
    async run({ tool, args }) {
      const facts = registry.get(tool);
      if (!facts) {
        throw new Error(
          `No tool named "${tool}" is available. A profile may exclude it, or the name may be ` +
            `wrong.\n\n${registry.catalogue()}`,
        );
      }
      if (!facts.handler) throw new Error(`"${tool}" cannot be called indirectly.`);

      // Reveal the category too: a client that does honour list_changed gets the
      // real schema for the next call rather than proxying forever.
      if (registry.ensureLoadedFor(tool)) announce(server);

      audit("call_tool", { tool, keys: Object.keys(args ?? {}) });

      // The SDK validates against the tool's schema and fills in its defaults
      // before calling the handler. Calling the handler directly skips both, so
      // an omitted parameter with a .default() would arrive as undefined and
      // reach the shell as the string "undefined". Apply the schema here so an
      // indirect call behaves exactly like a direct one.
      const check = parseToolArgs(facts.input, args ?? {});
      if (!check.ok) {
        throw new Error(
          `Invalid arguments for "${tool}": ${check.problems.join("; ")}\n\n` +
            `Parameters: ${facts.params.join(", ")}`,
        );
      }

      const { text, isError, dropped, droppedImages } = flatten(await facts.handler(check.value));

      // The underlying tool already redacted, compacted and clamped this text.
      let note = "";
      if (droppedImages > 0) {
        const other = dropped - droppedImages;
        const detail =
          other > 0
            ? `${droppedImages} image block(s) and ${other} other non-text block(s)`
            : `${droppedImages} image block(s)`;
        note = `\n\n[${detail} omitted. Call ${tool} directly to receive image pixels.]`;
      } else if (dropped > 0) {
        note = `\n\n[${dropped} non-text block(s) omitted. Call ${tool} directly to receive them.]`;
      }
      if (isError) throw new Error(`${text}${note}`);
      return `${text}${note}`;
    },
  });

  registerTools(server, [loadTools, callTool]);
}
