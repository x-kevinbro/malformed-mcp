import fs from "node:fs";
import path from "node:path";
import pino, { type TransportTargetOptions } from "pino";
import { config } from "./config.js";

const redactPaths = [
  "req.headers.authorization",
  'req.headers["x-api-key"]',
  "headers.authorization",
  "token",
  "password",
];

function buildTargets(): TransportTargetOptions[] {
  const targets: TransportTargetOptions[] = [];

  targets.push(
    process.stdout.isTTY
      ? {
          target: "pino-pretty",
          level: config.logLevel,
          options: {
            colorize: true,
            translateTime: "SYS:HH:MM:ss",
            ignore: "pid,hostname,service",
          },
        }
      : {
          target: "pino/file",
          level: config.logLevel,
          options: { destination: 1 },
        },
  );

  if (config.logDir) {
    try {
      fs.mkdirSync(config.logDir, { recursive: true });
      targets.push({
        target: "pino-roll",
        level: "info",
        options: {
          file: path.join(config.logDir, "audit"),
          frequency: "daily",
          extension: ".log",
          mkdir: true,
          limit: { count: 30 },
        },
      });
    } catch (error) {
      process.stderr.write(`[warn] cannot open log dir ${config.logDir}: ${String(error)}\n`);
    }
  }

  return targets;
}

export const logger = pino({
  level: config.logLevel,
  redact: { paths: redactPaths, censor: "[redacted]" },
  base: { service: config.serverName },
  transport: { targets: buildTargets() },
});

/** Structured audit trail. Every mutating tool call lands here. */
export function audit(event: string, details: Record<string, unknown> = {}): void {
  logger.info({ audit: true, event, ...details }, `audit:${event}`);
}
