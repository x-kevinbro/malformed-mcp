import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool, registerTools } from "../tool.js";
import { readOutput } from "../output-store.js";
import { PROFILES, profileSummary } from "../profiles.js";
import { config } from "../config.js";
import { browserStatus } from "../browser/bridge.js";
import { execConcurrency } from "../exec.js";

const fetchOutput = defineTool({
  name: "fetch_output",
  title: "Read the full text of a truncated result",
  description:
    "When a result is too large it is clamped, and the whole thing is saved with an id. This " +
    "retrieves any part of it: a line range, the tail, or every line matching a pattern. Use it " +
    "instead of re-running the original command - the output already exists and re-running costs " +
    "the tokens again. Stored for 24 hours.",
  readOnly: true,
  input: {
    id: z.string().describe("The eight-character id from the truncation notice."),
    start_line: z.number().int().min(1).optional().describe("First line to return. Defaults to 1."),
    max_lines: z.number().int().min(1).max(5000).optional().describe("How many lines. Defaults to 200."),
    grep: z
      .string()
      .optional()
      .describe("Case-insensitive regular expression. Returns only matching lines, with line numbers."),
    tail: z.number().int().min(1).max(5000).optional().describe("Return the last N lines instead."),
  },
  run({ id, start_line, max_lines, grep, tail }) {
    return readOutput({
      id,
      ...(start_line === undefined ? {} : { startLine: start_line }),
      ...(max_lines === undefined ? {} : { maxLines: max_lines }),
      ...(grep === undefined ? {} : { grep }),
      ...(tail === undefined ? {} : { tail }),
    });
  },
});

const toolCatalog = defineTool({
  name: "tool_catalog",
  title: "What this server can do, and what is currently switched on",
  description:
    "Lists the active tool profile and what it includes. Useful when a tool you expected is not " +
    "available: a profile may be hiding it rather than it being absent. Also reports the output " +
    "budget and compaction settings that govern how much text results may use.",
  readOnly: true,
  input: {
    verbose: z.boolean().default(false).describe("Include the full list of profiles."),
  },
  run({ verbose }) {
    const out: string[] = [];

    out.push(`server           : ${config.serverName} v${config.version}`);
    out.push(`commit           : ${config.gitSha ? config.gitSha.slice(0, 7) : "unknown"}`);
    out.push(
      `tool profile     : ${config.tools.profile}${config.tools.profile in PROFILES ? "" : "  <-- unknown, using full"}`,
    );
    if (config.tools.only.length) out.push(`explicit allow   : ${config.tools.only.join(", ")}`);
    if (config.tools.exclude.length) out.push(`excluded         : ${config.tools.exclude.join(", ")}`);
    const onDemand = config.tools.onDemand && !config.tools.preload.includes("all");
    if (onDemand) {
      out.push(
        `tool loading     : on demand - reading tools plus load_tools${
          config.tools.preload.length ? `, preloaded: ${config.tools.preload.join(", ")}` : ""
        }`,
      );
      out.push("                   call load_tools to see the categories and reveal a group");
    } else {
      out.push("tool loading     : all up front - every tool is in your tool list with its schema");
      out.push("                   call each tool directly; there is no load_tools step");
    }

    out.push("");
    out.push(
      `output budget    : ${config.maxOutput.toLocaleString()} chars (~${Math.ceil(config.maxOutput / 4).toLocaleString()} tokens) per result`,
    );
    out.push(`compaction       : ${config.compactOutput}`);
    out.push(`redaction        : ${config.redactOutput ? "on" : "OFF"}`);
    out.push(`overflow store   : ${config.outputDir} (fetch_output)`);

    out.push("");
    out.push(`read-only        : global=${config.readOnly} host=${config.hostReadOnly}`);

    // Three different ceilings sit in front of a parallel batch of calls, and
    // they are easy to confuse. Naming all three together is the point.
    const exec = execConcurrency();
    out.push("");
    out.push(
      `shell slots      : ${exec.limit} at once (maxConcurrentExec)` +
        `${exec.active || exec.queued ? ` - ${exec.active} running, ${exec.queued} queued` : ""}`,
    );
    out.push("                   over the limit calls queue in order; they are never refused");
    out.push(
      `request rate     : ${config.rateMax} requests per ${Math.round(config.rateWindowMs / 1000)}s per IP`,
    );
    out.push(
      `browser          : one browser, ${config.browser.maxTabs} tab${
        config.browser.maxTabs === 1 ? "" : "s"
      }, one action at a time, whatever the caller does`,
    );
    if (config.browser.killOnError) {
      out.push(`                   a failed or stranded action terminates the browser process`);
    }

    if (verbose) {
      out.push("", "--- available profiles (tools.profile) ---", profileSummary());
      out.push("", `browser          : ${browserStatus()}`);
    }

    return out.join("\n");
  },
});

export function registerOutputTools(server: McpServer): void {
  registerTools(server, [fetchOutput, toolCatalog]);
}
