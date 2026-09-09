import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runShell, shq } from "../exec.js";
import { assertWritable, fromExec, fromExecLenient, fail } from "../result.js";
import { audit } from "../logger.js";
import { config } from "../config.js";

export function registerDockerTools(server: McpServer): void {
  server.registerTool(
    "docker_status",
    {
      title: "Docker containers",
      description: "List containers with status, health, ports and image. Add all to include stopped ones.",
      inputSchema: {
        all: z.boolean().default(false).describe("Include stopped containers."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ all }) => {
      const command = `docker ps ${all ? "-a" : ""} --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}\\t{{.Image}}'`;
      const result = await runShell(command, { timeoutMs: 30_000 });
      return fromExec(result, "docker ps");
    },
  );

  server.registerTool(
    "docker_logs",
    {
      title: "Container logs",
      description:
        "Tail logs from a container by name or id. Run docker_status first if you do not know the name.",
      inputSchema: {
        container: z.string().min(1).describe("Container name or id."),
        tail: z.number().int().positive().max(5000).default(200).describe("Lines from the end."),
        since: z.string().optional().describe('Only newer logs, e.g. "15m" or "2026-08-01T10:00:00".'),
        grep: z.string().optional().describe("Filter output to lines containing this text."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ container, tail, since, grep }) => {
      const sinceFlag = since ? `--since ${shq(since)}` : "";
      const filter = grep ? ` | grep -- ${shq(grep)}` : "";
      const command = `docker logs --tail ${tail} ${sinceFlag} ${shq(container)} 2>&1${filter}`;
      const result = await runShell(command, { timeoutMs: 60_000 });
      return fromExecLenient(result, `docker logs ${container}`);
    },
  );

  server.registerTool(
    "docker_exec",
    {
      title: "Run a command inside a container",
      description: "Execute a shell command inside a running container.",
      inputSchema: {
        container: z.string().min(1).describe("Container name or id."),
        command: z.string().min(1).describe("Command to run inside the container."),
        user: z.string().optional().describe('Run as this user, e.g. "root".'),
        timeout_ms: z.number().int().positive().optional().describe("Timeout in milliseconds."),
      },
      annotations: { destructiveHint: true },
    },
    async ({ container, command, user, timeout_ms }) => {
      assertWritable("docker_exec");
      const userFlag = user ? `-u ${shq(user)}` : "";
      audit("docker_exec", { container, command, user });
      const result = await runShell(
        `docker exec -i ${userFlag} ${shq(container)} sh -lc ${shq(command)} 2>&1`,
        { timeoutMs: timeout_ms },
      );
      return fromExec(result, `docker exec ${container} — ${command}`);
    },
  );

  server.registerTool(
    "compose",
    {
      title: "Run docker compose",
      description:
        'Run a docker compose subcommand in the project directory, for example "ps", "up -d --build", ' +
        '"restart backend", "logs --tail 100 backend", "down". Builds can take several minutes.',
      inputSchema: {
        args: z.string().min(1).describe('Everything after "docker compose".'),
        project_dir: z.string().optional().describe(`Project directory. Defaults to ${config.composeDir}.`),
        timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Timeout in milliseconds. Defaults to 900000 for builds."),
      },
      annotations: { destructiveHint: true },
    },
    async ({ args, project_dir, timeout_ms }) => {
      assertWritable("compose");
      const dir = project_dir ?? config.composeDir;
      audit("compose", { args, dir });
      const result = await runShell(`docker compose ${args} 2>&1`, {
        cwd: dir,
        timeoutMs: timeout_ms ?? 900_000,
      });
      return fromExec(result, `$ docker compose ${args}`);
    },
  );

  server.registerTool(
    "docker_inspect",
    {
      title: "Inspect a container",
      description: "Show detailed JSON for a container: mounts, env, networks, restart policy, health.",
      inputSchema: {
        container: z.string().min(1).describe("Container name or id."),
        format: z.string().optional().describe('Optional Go template, e.g. "{{json .State}}".'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ container, format }) => {
      const formatFlag = format ? `--format ${shq(format)}` : "";
      const result = await runShell(`docker inspect ${formatFlag} ${shq(container)}`, {
        timeoutMs: 30_000,
      });
      return fromExec(result);
    },
  );
}
