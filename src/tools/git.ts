import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runShell, shq, briefCommand } from "../exec.js";
import { gitCredentialEnv } from "../github/store.js";
import { fromExec, fromExecLenient } from "../result.js";
import { audit } from "../logger.js";
import { config } from "../config.js";

export function registerGitTools(server: McpServer): void {
  server.registerTool(
    "git",
    {
      title: "Run a git command",
      description:
        'Run git in the project repository, for example "status --short", "log --oneline -20", ' +
        '"diff HEAD~1", "fetch --prune origin", "rev-parse HEAD".',
      inputSchema: {
        args: z.string().min(1).describe('Everything after "git".'),
        cwd: z.string().optional().describe(`Repository directory. Defaults to ${config.defaultCwd}.`),
        timeout_ms: z.number().int().positive().optional().describe("Timeout in milliseconds."),
      },
      annotations: { openWorldHint: true },
    },
    async ({ args, cwd, timeout_ms }) => {
      audit("git", { args, cwd: cwd ?? config.defaultCwd });
      const result = await runShell(`git ${args} 2>&1`, {
        cwd,
        timeoutMs: timeout_ms ?? 180_000,
        env: gitCredentialEnv(cwd ?? config.defaultCwd),
      });
      return fromExec(result, `$ git ${briefCommand(args)}`);
    },
  );

  server.registerTool(
    "repo_status",
    {
      title: "Repository snapshot",
      description:
        "One-shot overview of the deployed checkout: current branch, HEAD commit, dirty files, " +
        "and how far behind origin it is.",
      inputSchema: {
        cwd: z.string().optional().describe(`Repository directory. Defaults to ${config.defaultCwd}.`),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ cwd }) => {
      const command = [
        "echo '=== branch ==='",
        "git rev-parse --abbrev-ref HEAD",
        "echo; echo '=== head ==='",
        "git log -1 --pretty='%h %an %ad %s' --date=iso",
        "echo; echo '=== working tree ==='",
        "git status --short --branch",
        "echo; echo '=== behind/ahead of origin ==='",
        "git fetch --quiet --prune origin || true",
        "git rev-list --left-right --count HEAD...@{upstream} 2>/dev/null || echo 'no upstream'",
      ].join("; ");
      const result = await runShell(command, {
        cwd,
        timeoutMs: 120_000,
        env: gitCredentialEnv(cwd ?? config.defaultCwd),
      });
      return fromExecLenient(result, "repository status");
    },
  );
}
