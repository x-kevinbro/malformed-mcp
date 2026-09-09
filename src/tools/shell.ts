import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runShell, runScriptFile, shq, briefCommand } from "../exec.js";
import { assertWritable, fromExec, fromExecLenient, ok } from "../result.js";
import { audit } from "../logger.js";
import { config } from "../config.js";

export function registerShellTools(server: McpServer): void {
  server.registerTool(
    "run_command",
    {
      title: "Run shell command",
      description:
        "Execute any command on the VPS through a bash login shell with the full privileges of the service user. " +
        "Use this whenever no dedicated tool fits: apt/dnf, curl, systemctl, ss, ufw, openssl, sed, npm, psql, and so on. " +
        "Background long-running work and redirect it to a log file, then read it with read_file.",
      inputSchema: {
        command: z.string().min(1).describe("The shell command to execute."),
        cwd: z.string().optional().describe(`Working directory. Defaults to ${config.defaultCwd}.`),
        timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Kill the process group after this many milliseconds. Max ${config.maxTimeoutMs}.`),
        stdin: z.string().optional().describe("Text piped to the command on stdin."),
        max_output: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Character budget for the returned output. Raise this for one call instead of " +
              "re-running a command whose output was truncated.",
          ),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ command, cwd, timeout_ms, stdin, max_output }) => {
      assertWritable("run_command");
      audit("run_command", { command, cwd: cwd ?? config.defaultCwd });
      const result = await runShell(command, { cwd, timeoutMs: timeout_ms, stdin });
      return fromExec(result, `$ ${briefCommand(command)}`, max_output);
    },
  );

  server.registerTool(
    "run_script",
    {
      title: "Run a multi-line script",
      description:
        "Write a multi-line script to a temporary file and execute it. More reliable than run_command " +
        "for anything involving quotes, heredocs, loops, or newlines. Supports bash, sh, python3 and node.",
      inputSchema: {
        script: z.string().min(1).describe("Full script body."),
        interpreter: z
          .enum(["bash", "sh", "python3", "node"])
          .default("bash")
          .describe("Interpreter used to run the script."),
        cwd: z.string().optional().describe("Working directory."),
        timeout_ms: z.number().int().positive().optional().describe("Timeout in milliseconds."),
        max_output: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Character budget for this result; the agent chooses it per call."),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ script, interpreter, cwd, timeout_ms, max_output }) => {
      assertWritable("run_script");
      audit("run_script", { interpreter, bytes: script.length, cwd: cwd ?? config.defaultCwd });
      const result = await runScriptFile(script, interpreter, { cwd, timeoutMs: timeout_ms });
      return fromExec(result, `# ${interpreter} script (${script.split("\n").length} lines)`, max_output);
    },
  );

  server.registerTool(
    "start_background_job",
    {
      title: "Start a background job",
      description:
        "Launch a command detached from the request, writing stdout and stderr to a log file. " +
        `The complete process group is killed after ${config.maxTimeoutMs} ms. ` +
        "Returns the PID and log path so you can inspect output with read_file.",
      inputSchema: {
        command: z.string().min(1).describe("Command to run in the background."),
        cwd: z.string().optional().describe("Working directory."),
        log_path: z
          .string()
          .optional()
          .describe("Where to write output. Defaults to <logDir>/job-<timestamp>.log."),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ command, cwd, log_path }) => {
      assertWritable("start_background_job");
      const logFile =
        log_path ?? `${config.logDir}/job-${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
      audit("start_background_job", { command, logFile });
      const seconds = Math.ceil(config.maxTimeoutMs / 1_000);
      const wrapper =
        `mkdir -p ${shq(logFile.replace(/\/[^/]*$/, ""))} && ` +
        `nohup setsid timeout --signal=TERM --kill-after=5s ${seconds}s ` +
        `${config.shell} -lc ${shq(command)} > ${shq(logFile)} 2>&1 < /dev/null & ` +
        `echo $!`;
      const result = await runShell(wrapper, { cwd, timeoutMs: 15_000 });
      const pid = result.stdout.trim();
      if (result.exitCode !== 0) return fromExec(result, `$ ${command} &`);
      return ok(
        `Started in background (automatic stop after ${seconds}s).\n  pid: ${pid}\n  log: ${logFile}\n\n` +
          `Inspect it with read_file({ path: "${logFile}" }) or stop it with run_command({ command: "kill -TERM -${pid}" }).`,
      );
    },
  );
}
