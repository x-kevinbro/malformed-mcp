import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runShell, shq } from "../exec.js";
import { assertWritable, fromExec, fromExecLenient } from "../result.js";
import { audit } from "../logger.js";

export function registerSystemTools(server: McpServer): void {
  server.registerTool(
    "system_info",
    {
      title: "System overview",
      description:
        "Host, kernel, uptime, load, memory, disk usage, and the heaviest processes. Start here when diagnosing.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const command = [
        "echo '=== host ==='; hostnamectl 2>/dev/null || uname -a",
        "echo; echo '=== uptime / load ==='; uptime",
        "echo; echo '=== memory ==='; free -h",
        "echo; echo '=== disk ==='; df -hT -x tmpfs -x devtmpfs",
        "echo; echo '=== top by memory ==='; ps aux --sort=-%mem | head -n 12",
      ].join("; ");
      const result = await runShell(command, { timeoutMs: 30_000 });
      return fromExecLenient(result, "system overview");
    },
  );

  server.registerTool(
    "service",
    {
      title: "Control a systemd service",
      description:
        "Inspect or control a systemd unit: status, start, stop, restart, reload, enable, disable.",
      inputSchema: {
        action: z
          .enum(["status", "start", "stop", "restart", "reload", "enable", "disable", "is-active"])
          .describe("Action to perform."),
        name: z.string().min(1).describe("Unit name, e.g. nginx, docker or malformed-mcp."),
      },
      annotations: { destructiveHint: true },
    },
    async ({ action, name }) => {
      if (action !== "status" && action !== "is-active") assertWritable("service");
      audit("service", { action, name });
      const result = await runShell(`systemctl ${action} ${shq(name)} --no-pager 2>&1`, {
        timeoutMs: 60_000,
      });
      return fromExecLenient(result, `systemctl ${action} ${name}`);
    },
  );

  server.registerTool(
    "journal",
    {
      title: "Read systemd journal",
      description: "Read journalctl output for a unit, optionally filtered by time and priority.",
      inputSchema: {
        unit: z.string().optional().describe("Unit name. Omit for the full system journal."),
        lines: z.number().int().positive().max(5000).default(200).describe("Lines from the end."),
        since: z.string().optional().describe('Time filter, e.g. "1 hour ago" or "2026-08-01".'),
        priority: z
          .enum(["emerg", "alert", "crit", "err", "warning", "notice", "info", "debug"])
          .optional()
          .describe("Minimum priority."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ unit, lines, since, priority }) => {
      const parts = ["journalctl --no-pager", `-n ${lines}`];
      if (unit) parts.push(`-u ${shq(unit)}`);
      if (since) parts.push(`--since ${shq(since)}`);
      if (priority) parts.push(`-p ${priority}`);
      const result = await runShell(`${parts.join(" ")} 2>&1`, { timeoutMs: 60_000 });
      return fromExecLenient(result, parts.join(" "));
    },
  );

  server.registerTool(
    "package_manager",
    {
      title: "Install or query system packages",
      description: "Install, remove, update or search packages using apt or dnf, whichever the host uses.",
      inputSchema: {
        action: z.enum(["install", "remove", "update", "search", "list-installed"]).describe("Action."),
        packages: z.string().optional().describe("Space-separated package names."),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ action, packages }) => {
      assertWritable("package_manager");
      audit("package_manager", { action, packages });
      const pkgs = packages ? shq(packages).replace(/^'|'$/g, "") : "";
      const script = `
set -e
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  case ${shq(action)} in
    install) apt-get update -qq && apt-get install -y ${pkgs} ;;
    remove) apt-get remove -y ${pkgs} ;;
    update) apt-get update -qq && apt-get upgrade -y ;;
    search) apt-cache search ${pkgs} | head -n 50 ;;
    list-installed) dpkg -l | tail -n +6 | awk '{print $2, $3}' | head -n 200 ;;
  esac
elif command -v dnf >/dev/null 2>&1; then
  case ${shq(action)} in
    install) dnf install -y ${pkgs} ;;
    remove) dnf remove -y ${pkgs} ;;
    update) dnf upgrade -y ;;
    search) dnf search ${pkgs} | head -n 50 ;;
    list-installed) rpm -qa | head -n 200 ;;
  esac
else
  echo 'No supported package manager found (apt-get or dnf).' >&2
  exit 1
fi`;
      const result = await runShell(script, { timeoutMs: 900_000 });
      return fromExec(result, `package_manager ${action}`);
    },
  );
}
