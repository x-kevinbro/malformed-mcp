/**
 * Live introspection and update control for the wired-in MCP servers.
 *
 * Two things the static config cannot answer on its own: what tools each
 * server actually exposes right now, and whether a newer version is available.
 * Both are discovered here — tools by speaking MCP to the server, updates by
 * asking git or npm — and cached briefly so the panel can poll without cost.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { audit } from "../logger.js";
import { listAllTools } from "../server.js";
import type { McpServerEntry } from "./mcp-config.js";

const pexec = promisify(execFile);

export type ToolInfo = { name: string; description: string; category?: string };
export type ToolsResult = { at: number; tools?: ToolInfo[]; error?: string };

const toolsCache = new Map<string, ToolsResult>();
const TOOLS_TTL = 60_000;

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Spawn a stdio MCP server briefly, list its tools, and shut it back down. */
async function stdioTools(entry: McpServerEntry): Promise<ToolInfo[]> {
  const transport = new StdioClientTransport({
    command: entry.command!,
    args: entry.args ?? [],
    env: {
      ...getDefaultEnvironment(),
      PUPPETEER_SKIP_DOWNLOAD: "1",
      ALLOW_DANGEROUS: "true",
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "malformed-panel", version: "1.0.0" });
  try {
    await client.connect(transport);
    const res = await client.listTools();
    return (res.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? "",
    }));
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}

/** The tool catalogue for one server, cached briefly. */
export async function listServerTools(
  entry: McpServerEntry,
  force = false,
): Promise<ToolsResult> {
  const cached = toolsCache.get(entry.key);
  if (cached && !force && Date.now() - cached.at < TOOLS_TTL) return cached;

  let result: ToolsResult;
  try {
    if (entry.update.type === "self") {
      // The host's own tools are enumerated in-process: authoritative, and it
      // never depends on the network round trip or the on-demand loader.
      result = { at: Date.now(), tools: listAllTools() };
    } else if (entry.transport === "stdio") {
      const tools = await withTimeout(
        stdioTools(entry),
        30_000,
        "Timed out starting the server to list its tools.",
      );
      result = { at: Date.now(), tools };
    } else {
      result = { at: Date.now(), error: "Live tool listing is not supported for this server." };
    }
  } catch (error) {
    result = { at: Date.now(), error: (error as Error).message };
  }
  toolsCache.set(entry.key, result);
  return result;
}

export type UpdateStatus = {
  key: string;
  kind: McpServerEntry["update"]["type"];
  current?: string;
  latest?: string;
  updateAvailable: boolean;
  note: string;
  error?: string;
};

const updateCache = new Map<string, { at: number; status: UpdateStatus }>();
const UPDATE_TTL = 300_000;

/** The installed version of a package vendored under a project's node_modules. */
function installedVersion(dir: string, pkg: string): string | undefined {
  try {
    const pj = path.join(dir, "node_modules", ...pkg.split("/"), "package.json");
    if (existsSync(pj)) {
      const version = JSON.parse(readFileSync(pj, "utf8")).version;
      if (typeof version === "string") return version;
    }
  } catch {
    // Not installed yet, or an unreadable entry: treat as unknown.
  }
  return undefined;
}

export async function checkUpdate(
  entry: McpServerEntry,
  force = false,
): Promise<UpdateStatus> {
  const cached = updateCache.get(entry.key);
  if (cached && !force && Date.now() - cached.at < UPDATE_TTL) return cached.status;

  const u = entry.update;
  let status: UpdateStatus;
  try {
    if (u.type === "git") {
      if (!existsSync(u.dir)) {
        status = {
          key: entry.key,
          kind: "git",
          updateAvailable: false,
          note: "Not cloned on disk yet.",
        };
      } else {
        try {
          await pexec("git", ["-C", u.dir, "fetch", "--quiet"], { timeout: 45_000 });
        } catch {
          // Ignore fetch error, check current local HEAD
        }
        const cur = (await pexec("git", ["-C", u.dir, "rev-parse", "HEAD"])).stdout.trim();
        let upstream = cur;
        try {
          upstream = (await pexec("git", ["-C", u.dir, "rev-parse", "@{u}"])).stdout.trim();
        } catch {
          // No upstream tracking branch: report as up to date with itself.
        }
        const behind = cur !== upstream;
        status = {
          key: entry.key,
          kind: "git",
          current: cur.slice(0, 7),
          latest: upstream.slice(0, 7),
          updateAvailable: behind,
          note: behind ? "A newer commit is available upstream." : "Up to date with upstream.",
        };
      }
    } else if (u.type === "npm") {
      const latest = (await pexec("npm", ["view", u.pkg, "version"], { timeout: 45_000 })).stdout.trim();
      const current = installedVersion(u.dir, u.pkg);
      const behind = Boolean(current && latest && current !== latest);
      status = {
        key: entry.key,
        kind: "npm",
        current: current ?? "not cached",
        latest,
        updateAvailable: behind,
        note: current
          ? behind
            ? `Cached ${current}, latest ${latest}.`
            : `Running the latest (${latest}).`
          : `Latest published is ${latest}. Update to fetch it.`,
      };
    } else {
      status = {
        key: entry.key,
        kind: "self",
        updateAvailable: false,
        note: "This host updates by rebuilding and redeploying its own code.",
      };
    }
  } catch (error) {
    status = {
      key: entry.key,
      kind: u.type,
      updateAvailable: false,
      note: "Could not check for updates.",
      error: (error as Error).message,
    };
  }
  updateCache.set(entry.key, { at: Date.now(), status });
  return status;
}

export async function applyUpdate(
  entry: McpServerEntry,
): Promise<{ ok: boolean; log: string }> {
  const u = entry.update;
  if (u.type === "self") {
    return {
      ok: false,
      log: "This host is updated by rebuilding and redeploying its own code, not from the panel.",
    };
  }

  const log: string[] = [];
  const run = async (cmd: string, args: string[]) => {
    try {
      const r = await pexec(cmd, args, { timeout: 300_000 });
      log.push(`$ ${cmd} ${args.join(" ")}\n${(r.stdout || "").trim() || "(no output)"}`);
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string; message: string };
      log.push(`$ ${cmd} ${args.join(" ")}\n${(e.stdout || "") + (e.stderr || "") || e.message}`);
      throw new Error(`${cmd} ${args.join(" ")} failed`);
    }
  };

  try {
    if (u.type === "git") {
      await run("git", ["-C", u.dir, "pull", "--ff-only"]);
      const pip = `${u.dir}/.venv/bin/pip`;
      if (existsSync(pip) && existsSync(`${u.dir}/requirements.txt`)) {
        await run(pip, ["install", "-q", "-r", `${u.dir}/requirements.txt`]);
      }
    } else if (u.type === "npm") {
      // The server runs from this project's node_modules, so updating means
      // installing the latest published version in place, then restarting.
      await run("npm", [
        "install",
        `${u.pkg}@latest`,
        "--prefix",
        u.dir,
        "--no-fund",
        "--no-audit",
      ]);
    }
    for (const unit of u.restart) await run("systemctl", ["restart", unit]);
    toolsCache.delete(entry.key);
    updateCache.delete(entry.key);
    audit("mcp_server_updated", { key: entry.key, kind: u.type });
    return { ok: true, log: log.join("\n\n") };
  } catch (error) {
    audit("mcp_server_update_failed", { key: entry.key, kind: u.type });
    return { ok: false, log: `${log.join("\n\n")}\n\n${(error as Error).message}` };
  }
}
