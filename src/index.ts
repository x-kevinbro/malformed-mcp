import { randomUUID, timingSafeEqual, X509Certificate } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { readFileSync, watch } from "node:fs";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import cors from "cors";
import compression from "compression";
import rateLimit from "express-rate-limit";
// pino-http ships CommonJS with no default export, so under NodeNext module
// resolution a default import resolves to the module namespace object, which
// is not callable. The named export is the factory.
import { pinoHttp } from "pino-http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { config } from "./config.js";
import { logger, audit } from "./logger.js";
import { createMcpServer } from "./server.js";
import { browserStatus, initBrowserBridge, shutdownBrowser } from "./browser/bridge.js";
import { connectProxiedServers, shutdownProxyTransports } from "./tools/proxy.js";
import { readSessionState, restartNotice, writeSessionState } from "./session-registry.js";
import {
  armStreamHeartbeat,
  enforceSessionCap,
  forgetSession,
  startSessionReaper,
  touchSession,
} from "./session-health.js";
import { panelRouter } from "./panel/routes.js";
import { loadPanel } from "./panel/auth.js";
import { findByMcpToken } from "./github/store.js";
import { withLockedProfile } from "./github/accounts.js";
import { currentCert } from "./panel/cert.js";

const transports = new Map<string, StreamableHTTPServerTransport>();

/**
 * Sessions cannot be resumed across a restart, but they can be explained. We
 * record the ids this process holds open, and read the previous run's file once
 * at startup, so a client returning after a swap is told what happened to it.
 */
const sessionFile = path.join(config.logDir, "sessions.json");
const startedAt = new Date().toISOString();
const previousSessions = readSessionState(sessionFile);
const liveSessions = new Map<string, string>();

function persistSessions(): void {
  const sessions = [...liveSessions].map(([id, openedAt]) => ({ id, openedAt }));
  writeSessionState(sessionFile, { startedAt, sessions });
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

function presentedToken(req: Request): string {
  const header = req.header("authorization") ?? "";
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  const apiKey = req.header("x-api-key");
  return apiKey ? apiKey.trim() : "";
}

function ipAllowed(ip: string): boolean {
  if (config.ipAllowlist.length === 0) return true;
  return config.ipAllowlist.some((entry) => {
    if (ip === entry) return true;
    // A prefix entry has to stop on an address boundary. A bare startsWith let
    // "10.0.0.1" also admit "10.0.0.199", silently widening the allowlist well
    // past what whoever wrote the entry intended.
    const prefix = entry.endsWith(".") ? entry : `${entry}.`;
    return ip.startsWith(prefix);
  });
}

function jsonRpcError(code: number, message: string) {
  return { jsonrpc: "2.0" as const, error: { code, message }, id: null };
}

function authenticate(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip ?? "unknown";

  if (!ipAllowed(ip)) {
    audit("blocked_ip", { ip });
    res.status(403).json(jsonRpcError(-32003, "Forbidden: IP not in allowlist."));
    return;
  }

  const token = presentedToken(req);
  const isAdmin = Boolean(token) && constantTimeEquals(token, config.token);
  // A GitHub profile's own token authenticates too, but only as that profile:
  // the lock below is what stops one agent's credential from reaching another
  // account's repositories.
  const profile = isAdmin ? undefined : findByMcpToken(token);

  if (!isAdmin && !profile) {
    audit("auth_failed", { ip, path: req.path });
    res
      .status(401)
      .set("WWW-Authenticate", 'Bearer realm="malformed-mcp"')
      .json(
        jsonRpcError(
          -32001,
          "Unauthorized: send Authorization: Bearer <token>. The panel issues one per GitHub profile.",
        ),
      );
    return;
  }

  if (profile) {
    audit("auth_profile", { ip, profile: profile.login });
    withLockedProfile(profile.login, () => next());
    return;
  }

  next();
}

async function main(): Promise<void> {
  // Handshake before the listener opens, because tool registration has to be
  // synchronous. This does not launch Chromium; upstream starts the browser on
  // the first navigation, so an eager handshake costs nothing.
  // Mints the admin password on first boot, before anything can be served.
  if (config.panel.enabled) loadPanel();

  await initBrowserBridge();
  await connectProxiedServers();

  const app = express();

  app.set("trust proxy", config.trustProxy);
  app.disable("x-powered-by");
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(compression());
  app.use(
    cors({
      // A wildcard origin on a credentialed admin endpoint lets any page the
      // browser visits read the response. Non-browser MCP clients send no
      // Origin header at all, so they are unaffected by this list.
      origin: config.publicHosts.map((host) => `https://${host}`),
      exposedHeaders: ["Mcp-Session-Id"],
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "Mcp-Session-Id",
        "MCP-Protocol-Version",
        "X-Api-Key",
      ],
    }),
  );
  app.use(
    pinoHttp({
      logger,
      autoLogging: {
        ignore: (req: IncomingMessage) => req.url === "/health",
      },
    }),
  );
  app.use(express.json({ limit: config.maxBody }));

  // A zero ceiling explicitly disables request throttling.
  if (config.rateMax > 0) {
    app.use(
      rateLimit({
        windowMs: config.rateWindowMs,
        limit: config.rateMax,
        standardHeaders: "draft-7",
        legacyHeaders: false,
        skip: (req) => req.path === "/health",
      }),
    );
  }

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      name: config.serverName,
      version: config.version,
      readOnly: config.readOnly,
      hostReadOnly: config.hostReadOnly,
      commit: config.gitSha ? config.gitSha.slice(0, 7) : "unknown",
      sessions: transports.size,
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  // A browser pointed at the endpoint reaches for /mcp/health, which has never
  // existed. The auth gate below answered 401, which reads like a broken
  // deployment rather than a wrong path, so send it to the real health route.
  app.get("/mcp/health", (_req, res) => {
    res.redirect(308, "/health");
  });

  // The panel owns "/", the MCP endpoint owns "/mcp". One listener, one port.
  if (config.panel.enabled) app.use(panelRouter());

  app.use("/mcp", authenticate);

  app.post("/mcp", async (req, res) => {
    try {
      const sessionId = req.header("mcp-session-id");
      const existing = sessionId ? transports.get(sessionId) : undefined;

      if (existing) {
        touchSession(sessionId!);
        await existing.handleRequest(req, res, req.body);
        return;
      }

      if (sessionId && !existing) {
        const notice = restartNotice(sessionId, previousSessions, startedAt, Date.now());
        if (notice) audit("session_lost", { sessionId, ip: req.ip });
        res
          .status(404)
          .json(jsonRpcError(-32004, notice ?? "Unknown session. Re-initialize the connection."));
        return;
      }

      if (!isInitializeRequest(req.body)) {
        res
          .status(400)
          .json(
            jsonRpcError(-32000, "Bad Request: no session id and the request is not an initialize call."),
          );
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: config.jsonResponse,
        ...(config.dnsRebindProtection && config.publicHosts.length > 0
          ? {
              enableDnsRebindingProtection: true,
              // Every configured hostname, plus the addresses the health and
              // deploy probes use. The bind address was missing, so a probe
              // against config.bind was rejected as a rebinding attempt.
              allowedHosts: [
                ...config.publicHosts.flatMap((host) => [host, `${host}:443`]),
                `127.0.0.1:${config.port}`,
                `localhost:${config.port}`,
                `${config.bind}:${config.port}`,
              ],
            }
          : {}),
        onsessioninitialized: (id: string) => {
          transports.set(id, transport);
          liveSessions.set(id, new Date().toISOString());
          touchSession(id);
          persistSessions();
          audit("session_open", { sessionId: id, ip: req.ip });
          // Clients that open a session per parallel call would otherwise grow
          // this map without bound against a fixed memory budget.
          void enforceSessionCap(transports, config.maxSessions).then((evicted) => {
            if (!evicted.length) return;
            for (const gone of evicted) liveSessions.delete(gone);
            persistSessions();
            audit("session_evicted", { sessions: evicted, reason: "max_sessions" });
          });
        },
        onsessionclosed: (id: string) => {
          transports.delete(id);
          liveSessions.delete(id);
          forgetSession(id);
          persistSessions();
          audit("session_close", { sessionId: id });
        },
      });

      transport.onclose = () => {
        if (!transport.sessionId) return;
        transports.delete(transport.sessionId);
        liveSessions.delete(transport.sessionId);
        persistSessions();
      };

      const mcpServer = createMcpServer();
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error({ err: error }, "POST /mcp failed");
      if (!res.headersSent) {
        res.status(500).json(jsonRpcError(-32603, "Internal server error."));
      }
    }
  });

  // Server-initiated notification stream.
  app.get("/mcp", async (req, res) => {
    const sessionId = req.header("mcp-session-id");
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      const notice = sessionId
        ? restartNotice(sessionId, previousSessions, startedAt, Date.now())
        : undefined;
      res.status(400).json(jsonRpcError(-32000, notice ?? "Missing or unknown Mcp-Session-Id."));
      return;
    }
    touchSession(sessionId!);

    // The transport writes nothing to this stream between messages. Without a
    // heartbeat the first middlebox with an idle timeout closes it and takes
    // the session with it - which is the "server went away" failure seen when
    // several of these are open at once. Tied to res close rather than to the
    // handleRequest promise, which resolves once the stream is established.
    const stopHeartbeat = armStreamHeartbeat(res, config.sseKeepAliveMs);
    res.on("close", stopHeartbeat);

    await transport.handleRequest(req, res);
  });

  // Explicit session teardown.
  app.delete("/mcp", async (req, res) => {
    const sessionId = req.header("mcp-session-id");
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.status(204).end();
      return;
    }
    await transport.handleRequest(req, res);
    transports.delete(sessionId!);
    liveSessions.delete(sessionId!);
    forgetSession(sessionId!);
    persistSessions();
  });

  // TLS terminates in this process or not at all: there is deliberately no
  // reverse proxy in front of it. When a certificate has been issued the same
  // port serves HTTPS instead of HTTP - the panel and /mcp both move with it.
  const cert = currentCert();
  let tls: { key: Buffer; cert: Buffer } | null = null;
  if (cert) {
    try {
      tls = { key: readFileSync(cert.keyPath), cert: readFileSync(cert.certPath) };
    } catch (error) {
      // A missing or unreadable key must not take the server down: falling back
      // to HTTP keeps the panel reachable so the certificate can be reissued.
      logger.error({ err: error }, "certificate unreadable - serving plain HTTP");
    }
  }
  const scheme = tls ? "https" : "http";
  const baseServer = tls ? https.createServer(tls, app) : http.createServer(app);

  // A renewal rewrites the PEMs on disk, but a TLS server keeps the secure
  // context it was constructed with. Without this the process would go on
  // presenting the expired certificate - with the valid replacement sitting in
  // the same directory - until somebody happened to restart it.
  if (tls && cert) {
    const certDir = path.dirname(cert.certPath);
    const watched = new Set([path.basename(cert.certPath), path.basename(cert.keyPath)]);

    const reloadCert = (): void => {
      try {
        const next = { key: readFileSync(cert.keyPath), cert: readFileSync(cert.certPath) };
        (baseServer as https.Server).setSecureContext(next);
        const expiresAt = new X509Certificate(next.cert).validTo;
        logger.info({ domain: cert.domain, expiresAt }, "certificate reloaded from disk");
        audit("cert_reloaded", { domain: cert.domain, expiresAt });
      } catch (error) {
        // A half-written pair is the normal case mid-renewal. Keep serving the
        // context we already have; the next write fires this again.
        logger.error({ err: error }, "certificate reload failed - keeping the current one");
      }
    };

    // The two files land moments apart, so debounce: one renewal should mean
    // one reload, not one per file.
    let pending: NodeJS.Timeout | undefined;
    const schedule = (_event: string, filename: string | Buffer | null): void => {
      const name = typeof filename === "string" ? filename : filename?.toString();
      if (name && !watched.has(name)) return;
      if (pending) clearTimeout(pending);
      pending = setTimeout(reloadCert, 1_000);
      pending.unref();
    };

    // Watch the directory rather than the files: a renewal that replaces a file
    // gives it a new inode, and a watch on the old one would go deaf.
    try {
      const watcher = watch(certDir, schedule);
      watcher.unref();
      watcher.on("error", (error) => {
        logger.warn({ err: error }, "certificate watcher failed - renewals need a restart");
      });
      logger.info({ certDir }, "watching for certificate renewals");
    } catch (error) {
      logger.warn({ err: error, certDir }, "could not watch for certificate renewals");
    }
  }

  const httpServer = baseServer.listen(config.port, config.bind, () => {
    logger.info(
      {
        url: `${scheme}://${cert?.domain ?? config.publicHosts[0] ?? config.bind}:${config.port}`,
        bind: `${config.bind}:${config.port}`,
        cwd: config.defaultCwd,
        shell: config.shell,
        readOnly: config.readOnly,
        publicHost: config.publicHosts.join(", ") || "(not set)",
        ipAllowlist: config.ipAllowlist.length ? config.ipAllowlist : "(none)",
        browser: browserStatus(),
      },
      `${config.serverName} v${config.version} ready — panel on / and MCP on /mcp`,
    );
    audit("server_start", { port: config.port, tls: Boolean(tls) });
  });

  // Tool calls can legitimately run for many minutes.
  httpServer.requestTimeout = 0;
  httpServer.headersTimeout = 0;
  httpServer.setTimeout(0);
  httpServer.keepAliveTimeout = 120_000;

  // Sessions are never resumable across a restart, so one that has gone quiet
  // is dead weight holding a transport and its server open.
  const stopReaper = startSessionReaper(transports, {
    idleMs: config.sessionIdleMs,
    intervalMs: config.sessionReapMs,
    onReap: (ids) => {
      for (const id of ids) liveSessions.delete(id);
      persistSessions();
      logger.info({ count: ids.length }, "reaped idle MCP sessions");
      audit("session_reaped", { sessions: ids });
    },
  });

  const shutdown = (signal: string): void => {
    stopReaper();
    audit("server_stop", { signal });
    logger.info(`Received ${signal}, shutting down.`);
    for (const transport of transports.values()) {
      void transport.close().catch(() => undefined);
    }
    transports.clear();
    // Chromium does not die with its parent, and swap.sh restarts this service
    // often. An orphaned browser keeps its half-gigabyte until the box is out.
    void shutdownBrowser().catch(() => undefined);
    void shutdownProxyTransports().catch(() => undefined);
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => logger.error({ reason }, "Unhandled rejection"));
  process.on("uncaughtException", (error) => logger.error({ err: error }, "Uncaught exception"));
}

void main();
