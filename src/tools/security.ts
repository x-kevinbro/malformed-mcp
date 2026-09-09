/**
 * Security-assessment tools.
 *
 * A deliberately scoped set: TLS auditing, non-destructive web vulnerability
 * scanning, content discovery, local dependency/SAST scanning, and a capped
 * load test. Every tool that reaches the network first runs its target through
 * assertTargetAllowed, so it can only be aimed at a host on sec.allowTargets.
 *
 * Notably absent, and intentionally so: credential brute-forcers, exploitation
 * frameworks and uncapped flooders. Their dominant use is unauthorised access
 * or taking a service down, and this box hosts production and this server. An
 * allowlist scopes a scanner; nothing scopes those.
 *
 * These shell out to whichever well-known binary is installed and return a
 * clear "install one of these" message when none is, rather than failing
 * cryptically. Long scans should be run through start_background_job.
 *
 * Registration is by raw registerTool rather than defineTool because these
 * return a formatted ExecResult (fromExecLenient), which defineTool - whose
 * run() returns a plain string - cannot express.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runShell, shq } from "../exec.js";
import { fail, fromExecLenient, type ToolResult } from "../result.js";
import { config } from "../config.js";
import { audit } from "../logger.js";
import { assertTargetAllowed } from "../sec-guard.js";

const SCAN_TIMEOUT_MS = 300_000;

/** True when `bin` is on PATH. */
async function hasBinary(bin: string): Promise<boolean> {
  const result = await runShell(`command -v ${shq(bin)} >/dev/null 2>&1`, { timeoutMs: 10_000 });
  return result.exitCode === 0;
}

/** The first of `bins` that is installed, or null when none are. */
async function firstAvailable(bins: string[]): Promise<string | null> {
  for (const bin of bins) {
    if (await hasBinary(bin)) return bin;
  }
  return null;
}

/** Resolve which binary to use: the named one if present, or the first available. */
async function resolveTool(requested: string, candidates: string[]): Promise<string | null> {
  if (requested === "auto") return firstAvailable(candidates);
  return (await hasBinary(requested)) ? requested : null;
}

/** A uniform "install one of these first" message. */
function missingBinary(bins: string[]): ToolResult {
  const first = bins[0] ?? "the tool";
  return fail(
    `None of these are installed: ${bins.join(", ")}. ` +
      `Install one with package_manager (action="install", packages=["${first}"]), then run this again.`,
  );
}

/** Build an http(s) URL from a target, defaulting a bare host to https. */
function toUrl(target: string, host: string): string {
  const trimmed = target.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${host}`;
}

export function registerSecurityTools(server: McpServer): void {
  server.registerTool(
    "sec_tls_audit",
    {
      title: "Audit a host's TLS configuration",
      description:
        "Check the TLS setup of an allowlisted host: protocol versions, cipher suites, certificate " +
        "chain and expiry. Uses testssl.sh or sslyze when installed, and falls back to an openssl " +
        "probe otherwise. Read-only and safe against production. Target must be on sec.allowTargets.",
      inputSchema: {
        target: z.string().min(1).describe('Host, host:port or https URL, e.g. "dark-byte.org".'),
        port: z.number().int().positive().max(65535).default(443).describe("TLS port."),
        timeout_ms: z.number().int().positive().max(config.maxTimeoutMs).optional().describe("Timeout."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ target, port, timeout_ms }) => {
      const host = assertTargetAllowed(target);
      const hostport = `${host}:${port}`;
      audit("sec_tls_audit", { host, port });
      const t = timeout_ms ?? SCAN_TIMEOUT_MS;

      const tool = await firstAvailable(["testssl.sh", "testssl", "sslyze"]);
      if (tool === "testssl.sh" || tool === "testssl") {
        const r = await runShell(`${tool} --quiet --color 0 ${shq(hostport)}`, { timeoutMs: t });
        return fromExecLenient(r, `${tool} ${hostport}`);
      }
      if (tool === "sslyze") {
        const r = await runShell(`sslyze ${shq(hostport)}`, { timeoutMs: t });
        return fromExecLenient(r, `sslyze ${hostport}`);
      }

      // openssl is effectively always present; enough for a first look.
      const script =
        `echo '=== protocols ==='; for p in tls1 tls1_1 tls1_2 tls1_3; do ` +
        `printf '%s: ' "$p"; echo | openssl s_client -connect ${shq(hostport)} -"$p" 2>/dev/null ` +
        `| grep -q 'BEGIN CERTIFICATE' && echo ACCEPTED || echo rejected; done; ` +
        `echo; echo '=== certificate ==='; echo | openssl s_client -connect ${shq(hostport)} 2>/dev/null ` +
        `| openssl x509 -noout -issuer -subject -dates 2>/dev/null`;
      const r = await runShell(script, { timeoutMs: Math.min(t, 60_000) });
      return fromExecLenient(r, `openssl probe ${hostport} (install testssl.sh or sslyze for a full audit)`);
    },
  );

  server.registerTool(
    "sec_web_scan",
    {
      title: "Scan a web target for known vulnerabilities",
      description:
        "Run a non-destructive web vulnerability scan against an allowlisted URL using nuclei or " +
        "nikto. Reports outdated software, misconfigurations and known CVEs; it does not attempt " +
        "exploitation. Large scans take minutes, so start_background_job is often wise. Target must " +
        "be on sec.allowTargets.",
      inputSchema: {
        target: z.string().min(1).describe("Absolute http(s) URL, or a host that defaults to https."),
        tool: z.enum(["auto", "nuclei", "nikto"]).default("auto").describe("Scanner to use."),
        severity: z.string().optional().describe('nuclei severity filter, e.g. "medium,high,critical".'),
        timeout_ms: z.number().int().positive().max(config.maxTimeoutMs).optional().describe("Timeout."),
      },
      annotations: { openWorldHint: true },
    },
    async ({ target, tool, severity, timeout_ms }) => {
      const host = assertTargetAllowed(target);
      const url = toUrl(target, host);
      const chosen = await resolveTool(tool, ["nuclei", "nikto"]);
      if (!chosen) return missingBinary(tool === "auto" ? ["nuclei", "nikto"] : [tool]);
      audit("sec_web_scan", { host, tool: chosen });
      const t = timeout_ms ?? SCAN_TIMEOUT_MS;

      if (chosen === "nuclei") {
        const sev = severity ? ` -severity ${shq(severity)}` : "";
        const r = await runShell(`nuclei -duc -nc -u ${shq(url)}${sev}`, { timeoutMs: t });
        return fromExecLenient(r, `nuclei ${url}`);
      }
      const r = await runShell(`nikto -ask no -nointeractive -host ${shq(url)}`, { timeoutMs: t });
      return fromExecLenient(r, `nikto ${url}`);
    },
  );

  server.registerTool(
    "sec_dir_discover",
    {
      title: "Discover hidden paths on a web target",
      description:
        "Content and endpoint discovery against an allowlisted URL using ffuf or gobuster, with a " +
        "capped request rate so it does not overload the target. Needs a wordlist. Target must be " +
        "on sec.allowTargets.",
      inputSchema: {
        target: z.string().min(1).describe('Base URL, e.g. "https://dark-byte.org".'),
        wordlist: z
          .string()
          .optional()
          .describe("Absolute path to a wordlist. Falls back to a common seclists path."),
        rate: z.number().int().positive().max(200).default(40).describe("Max requests per second."),
        tool: z.enum(["auto", "ffuf", "gobuster"]).default("auto").describe("Discovery tool."),
        timeout_ms: z.number().int().positive().max(config.maxTimeoutMs).optional().describe("Timeout."),
      },
      annotations: { openWorldHint: true },
    },
    async ({ target, wordlist, rate, tool, timeout_ms }) => {
      const host = assertTargetAllowed(target);
      const trimmed = target.trim();
      const base = /^https?:\/\//i.test(trimmed) ? trimmed.replace(/\/+$/, "") : `https://${host}`;
      const list = wordlist ?? "/usr/share/seclists/Discovery/Web-Content/common.txt";

      const exists = (await runShell(`test -f ${shq(list)}`, { timeoutMs: 5_000 })).exitCode === 0;
      if (!exists) {
        return fail(
          `Wordlist not found at ${list}. Pass wordlist=<path>, or install one ` +
            `(e.g. package_manager action="install", packages=["seclists"]).`,
        );
      }

      const chosen = await resolveTool(tool, ["ffuf", "gobuster"]);
      if (!chosen) return missingBinary(tool === "auto" ? ["ffuf", "gobuster"] : [tool]);
      audit("sec_dir_discover", { host, rate, tool: chosen });
      const t = timeout_ms ?? SCAN_TIMEOUT_MS;

      if (chosen === "ffuf") {
        const r = await runShell(`ffuf -s -rate ${rate} -w ${shq(list)} -u ${shq(`${base}/FUZZ`)}`, {
          timeoutMs: t,
        });
        return fromExecLenient(r, `ffuf ${base}/FUZZ`);
      }
      const r = await runShell(`gobuster dir -q --no-color -w ${shq(list)} -u ${shq(base)}`, {
        timeoutMs: t,
      });
      return fromExecLenient(r, `gobuster ${base}`);
    },
  );

  server.registerTool(
    "sec_dep_scan",
    {
      title: "Scan local code or an image for vulnerabilities",
      description:
        "Static supply-chain and code scan of the host itself: dependency and container CVEs with " +
        "trivy or grype, and code-level findings with semgrep. Runs entirely locally against a path " +
        "or a Docker image, so no network target and no allowlist apply.",
      inputSchema: {
        tool: z.enum(["auto", "trivy", "grype", "semgrep"]).default("auto").describe("Scanner."),
        path: z
          .string()
          .default(config.defaultCwd)
          .describe("Filesystem path to scan (trivy/grype fs, semgrep)."),
        image: z.string().optional().describe("Docker image to scan instead of a path (trivy/grype)."),
        timeout_ms: z.number().int().positive().max(config.maxTimeoutMs).optional().describe("Timeout."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ tool, path: scanPath, image, timeout_ms }) => {
      const chosen = await resolveTool(tool, ["trivy", "grype", "semgrep"]);
      if (!chosen) return missingBinary(tool === "auto" ? ["trivy", "grype", "semgrep"] : [tool]);
      audit("sec_dep_scan", { tool: chosen, image: image ?? null, path: image ? null : scanPath });
      const t = timeout_ms ?? SCAN_TIMEOUT_MS;

      if (chosen === "trivy") {
        const cmd = image
          ? `trivy image --no-progress ${shq(image)}`
          : `trivy fs --no-progress ${shq(scanPath)}`;
        const r = await runShell(cmd, { timeoutMs: t });
        return fromExecLenient(r, cmd);
      }
      if (chosen === "grype") {
        const arg = image ?? scanPath;
        const r = await runShell(`grype ${shq(arg)}`, { timeoutMs: t });
        return fromExecLenient(r, `grype ${arg}`);
      }
      const r = await runShell(`semgrep --error --quiet --config auto ${shq(scanPath)}`, { timeoutMs: t });
      return fromExecLenient(r, `semgrep ${scanPath}`);
    },
  );

  server.registerTool(
    "sec_load_test",
    {
      title: "Capacity-test an allowlisted endpoint",
      description:
        "Generate HTTP load against an allowlisted URL to measure behaviour under concurrency, " +
        "using k6, hey or ApacheBench. Concurrency and duration are hard-capped by " +
        "sec.loadMaxVus and sec.loadMaxDurationS so this stays a measurement, not a " +
        "denial of service. Target must be on sec.allowTargets.",
      inputSchema: {
        target: z.string().min(1).describe("Absolute http(s) URL, or a host that defaults to https."),
        vus: z.number().int().positive().describe("Concurrent virtual users / connections (capped)."),
        duration_s: z.number().int().positive().describe("Duration in seconds (capped)."),
        tool: z.enum(["auto", "k6", "hey", "ab"]).default("auto").describe("Load generator."),
      },
      annotations: { openWorldHint: true },
    },
    async ({ target, vus, duration_s, tool }) => {
      const host = assertTargetAllowed(target);
      const url = toUrl(target, host);
      const cappedVus = Math.min(vus, config.sec.loadMaxVus);
      const cappedDur = Math.min(duration_s, config.sec.loadMaxDurationS);
      const note =
        cappedVus !== vus || cappedDur !== duration_s
          ? ` (capped to ${cappedVus} VUs / ${cappedDur}s by sec.loadMax*)`
          : "";

      const chosen = await resolveTool(tool, ["k6", "hey", "ab"]);
      if (!chosen) return missingBinary(tool === "auto" ? ["k6", "hey", "ab"] : [tool]);
      audit("sec_load_test", { host, vus: cappedVus, duration_s: cappedDur, tool: chosen });
      const t = (cappedDur + 30) * 1000;

      if (chosen === "hey") {
        const r = await runShell(`hey -z ${cappedDur}s -c ${cappedVus} ${shq(url)}`, { timeoutMs: t });
        return fromExecLenient(r, `hey ${url}${note}`);
      }
      if (chosen === "ab") {
        const requests = cappedVus * cappedDur;
        const r = await runShell(`ab -c ${cappedVus} -n ${requests} -t ${cappedDur} ${shq(url)}`, {
          timeoutMs: t,
        });
        return fromExecLenient(r, `ab ${url}${note}`);
      }
      // k6 reads its script from stdin with `run -`, so no temp file is needed.
      const script =
        `import http from "k6/http";\nimport { sleep } from "k6";\n` +
        `export const options = { vus: ${cappedVus}, duration: "${cappedDur}s" };\n` +
        `export default function () {\n  http.get(${JSON.stringify(url)});\n  sleep(1);\n}\n`;
      const r = await runShell(`k6 run -`, { stdin: script, timeoutMs: t });
      return fromExecLenient(r, `k6 run (${cappedVus} VUs, ${cappedDur}s) ${url}${note}`);
    },
  );
}
