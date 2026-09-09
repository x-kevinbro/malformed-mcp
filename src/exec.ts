import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { execa, type Options } from "execa";
import { config } from "./config.js";
import { createGate } from "./concurrency.js";

/**
 * Every child process this server starts passes through here. The gate is on
 * runShell alone: runScriptFile delegates to it, and taking the gate in both
 * would deadlock the moment the limit was reached.
 */
const execGate = createGate(config.maxConcurrentExec);

/** For tool_catalog: what the shell ceiling is, and how close we are to it. */
export function execConcurrency(): { limit: number; active: number; queued: number } {
  return { limit: execGate.limit, active: execGate.active, queued: execGate.queued };
}

export type ExecResult = {
  command: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
};

/** Clamp long output so a single `journalctl` never blows up the transcript. */
export function clamp(text: string, max = config.maxOutput): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  const dropped = text.length - max;
  return `${text.slice(0, half)}\n\n… [${dropped.toLocaleString()} characters truncated] …\n\n${text.slice(-half)}`;
}

/** Single-quote a value for safe interpolation into a bash command. */
export function shq(value: string | number): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Shorten a command before echoing it back. Repeating a 3 KB heredoc costs
 * far more than the output it produced, and the caller already knows what it
 * sent.
 */
export function briefCommand(command: string, max = 120): string {
  const lines = command.split("\n");
  const first = (lines[0] ?? "").trim();
  const head = first.length > max ? `${first.slice(0, max)}…` : first;
  return lines.length > 1 ? `${head} … (+${lines.length - 1} more lines)` : head;
}

export function resolveCwd(cwd?: string): string {
  const target = cwd?.trim() || config.defaultCwd;
  try {
    if (fs.statSync(target).isDirectory()) return target;
  } catch {
    /* fall through */
  }
  return os.homedir();
}

function resolveTimeout(requested?: number): number {
  if (!requested || Number.isNaN(requested)) return config.timeoutMs;
  return Math.min(Math.max(requested, 1_000), config.maxTimeoutMs);
}

export type RunOptions = {
  cwd?: string;
  timeoutMs?: number;
  stdin?: string;
  env?: Record<string, string>;
};

/** Run a command through the configured login shell. Never throws. */
export async function runShell(command: string, options: RunOptions = {}): Promise<ExecResult> {
  const cwd = resolveCwd(options.cwd);
  const timeout = resolveTimeout(options.timeoutMs);
  // Wait for a slot before starting the clock. Time spent queueing is not time
  // the command took, and the timeout budget belongs to the command.
  const release = await execGate.acquire();
  const started = Date.now();

  const execaOptions: Options = {
    cwd,
    timeout,
    reject: false,
    all: false,
    cleanup: true,
    killSignal: "SIGKILL",
    forceKillAfterDelay: 5_000,
    maxBuffer: 128 * 1024 * 1024,
    encoding: "utf8",
    env: options.env ? { ...process.env, ...options.env } : process.env,
    ...(options.stdin === undefined ? {} : { input: options.stdin }),
  };

  try {
    const result = await execa(config.shell, ["-lc", command], execaOptions);
    return {
      command,
      cwd,
      exitCode: typeof result.exitCode === "number" ? result.exitCode : -1,
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
      timedOut: Boolean(result.timedOut),
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return {
      command,
      cwd,
      exitCode: -1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      timedOut: false,
      durationMs: Date.now() - started,
    };
  } finally {
    // Not conditional on success. A slot leaked on the error path is a slot
    // gone for the lifetime of the process.
    release();
  }
}

/** Write a script to a temp file and execute it — safer than escaping heredocs. */
export async function runScriptFile(
  script: string,
  interpreter: string,
  options: RunOptions = {},
): Promise<ExecResult> {
  const extension = interpreter.includes("python") ? "py" : interpreter === "node" ? "mjs" : "sh";
  const dir = config.scratchDir || os.tmpdir();
  const file = path.join(dir, `mcp-${randomBytes(8).toString("hex")}.${extension}`);
  await fs.promises.writeFile(file, script, { encoding: "utf8", mode: 0o700 });
  try {
    return await runShell(`${interpreter} ${shq(file)}`, options);
  } finally {
    void fs.promises.unlink(file).catch(() => undefined);
  }
}

/** Render an ExecResult as readable text for the model. */
export function formatResult(result: ExecResult, header?: string, max?: number): string {
  const lines: string[] = [];
  if (header) lines.push(header);
  lines.push(
    `exit=${result.exitCode} · ${result.durationMs}ms · cwd=${result.cwd}` +
      (result.timedOut ? " · TIMED OUT (process group killed)" : ""),
  );
  const stdout = result.stdout.trimEnd();
  const stderr = result.stderr.trimEnd();
  if (stdout) lines.push(`--- stdout ---\n${stdout}`);
  if (stderr) lines.push(`--- stderr ---\n${stderr}`);
  if (!stdout && !stderr) lines.push("(no output)");
  return clamp(lines.join("\n"), max ?? config.maxOutput);
}
