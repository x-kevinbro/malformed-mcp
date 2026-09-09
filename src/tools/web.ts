import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { assertWritable, errorText, fail, ok } from "../result.js";
import { assertUrlAllowed } from "../net-guard.js";
import { config } from "../config.js";
import { audit } from "../logger.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const USER_AGENT = `${config.serverName}/${config.version}`;

/** Turn ["Accept: application/json"] into a header object. */
function parseHeaders(entries: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = { "user-agent": USER_AGENT };
  for (const entry of entries ?? []) {
    const index = entry.indexOf(":");
    if (index <= 0) continue;
    out[entry.slice(0, index).trim().toLowerCase()] = entry.slice(index + 1).trim();
  }
  return out;
}

function renderHeaders(headers: Headers): string {
  const lines: string[] = [];
  headers.forEach((value, key) => {
    lines.push(`${key}: ${key.toLowerCase() === "set-cookie" ? "<redacted>" : value}`);
  });
  return lines.sort().join("\n");
}

function isTextual(contentType: string): boolean {
  return /^(text\/|application\/(json|ld\+json|xml|xhtml\+xml|javascript|graphql|yaml|x-yaml|x-ndjson|x-www-form-urlencoded)|image\/svg\+xml)/i.test(
    contentType,
  );
}

/** Strip markup so a rendered page can be read as prose. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer|ul|ol|table)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function sha256File(target: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(target), hash);
  return hash.digest("hex");
}

function clampTimeout(requested: number | undefined): number {
  if (!requested || Number.isNaN(requested)) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(requested, 1_000), MAX_TIMEOUT_MS);
}

export function registerWebTools(server: McpServer): void {
  server.registerTool(
    "http_request",
    {
      title: "Fetch a URL",
      description:
        "Make an HTTP request from the VPS and return the status, headers and body. Use this to browse the web, " +
        "read documentation, call an API, check for upstream releases, or probe an internal service. " +
        'Set as="text" for readable prose from an HTML page, as="raw" for the untouched body, as="base64" for binary. ' +
        "Pass save_to to write the body straight to a file instead of returning it.",
      inputSchema: {
        url: z.string().url().describe("Absolute URL, http or https."),
        method: z
          .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
          .default("GET")
          .describe("HTTP method."),
        header: z
          .array(z.string())
          .optional()
          .describe('Headers as "Name: value" strings, e.g. ["Accept: application/json"].'),
        body: z.string().optional().describe("Request body for POST/PUT/PATCH."),
        as: z
          .enum(["auto", "text", "raw", "base64"])
          .default("auto")
          .describe(
            "How to render the response. auto = prose for HTML and raw for everything else; text = always strip markup; base64 = binary.",
          ),
        max_bytes: z
          .number()
          .int()
          .positive()
          .max(64 * 1024 * 1024)
          .default(DEFAULT_MAX_BYTES)
          .describe("Maximum body bytes to read."),
        timeout_ms: z.number().int().positive().max(MAX_TIMEOUT_MS).optional().describe("Request timeout."),
        follow_redirects: z.boolean().default(true).describe("Follow 3xx redirects."),
        save_to: z
          .string()
          .optional()
          .describe("Absolute path to write the body to instead of returning it."),
      },
      annotations: { openWorldHint: true },
    },
    async ({ url, method, header, body, as, max_bytes, timeout_ms, follow_redirects, save_to }) => {
      if (save_to) assertWritable("http_request(save_to)");
      await assertUrlAllowed(url);
      const started = Date.now();
      try {
        const response = await fetch(url, {
          method,
          headers: parseHeaders(header),
          ...(body === undefined || method === "GET" || method === "HEAD" ? {} : { body }),
          redirect: follow_redirects ? "follow" : "manual",
          signal: AbortSignal.timeout(clampTimeout(timeout_ms)),
        });

        const contentType = response.headers.get("content-type") ?? "";
        const buffer = Buffer.from(await response.arrayBuffer());
        const elapsed = Date.now() - started;

        const summary =
          `${method} ${url}\n` +
          `${response.status} ${response.statusText} · ${elapsed}ms · ${humanBytes(buffer.length)}` +
          `${response.redirected ? ` · redirected to ${response.url}` : ""}\n` +
          `--- response headers ---\n${renderHeaders(response.headers)}`;

        if (save_to) {
          await fs.mkdir(path.dirname(save_to), { recursive: true });
          await fs.writeFile(save_to, buffer);
          audit("http_request", {
            url,
            method,
            status: response.status,
            savedTo: save_to,
            bytes: buffer.length,
          });
          return ok(`${summary}\n\nSaved ${humanBytes(buffer.length)} to ${save_to}`);
        }

        const truncated = buffer.length > max_bytes;
        const slice = truncated ? buffer.subarray(0, max_bytes) : buffer;
        const note = truncated ? `\n\n… truncated at max_bytes=${max_bytes} of ${buffer.length} total …` : "";

        if (as === "base64")
          return ok(`${summary}\n\n--- body (base64) ---\n${slice.toString("base64")}${note}`);

        if (!isTextual(contentType) && as === "auto") {
          return ok(
            `${summary}\n\nBody is ${contentType || "an unknown type"} — not text. ` +
              `Re-run with as="base64", or pass save_to to write it to disk.`,
          );
        }

        const raw = slice.toString("utf8");
        const isHtml = /html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(raw);
        const rendered = as === "text" || (as === "auto" && isHtml) ? htmlToText(raw) : raw;
        const label = rendered === raw ? "body" : "body (markup stripped)";
        audit("http_request", { url, method, status: response.status, bytes: buffer.length });
        return ok(`${summary}\n\n--- ${label} ---\n${rendered}${note}`);
      } catch (error) {
        const message = errorText(error);
        const hint = /timed?\s?out|abort/i.test(message)
          ? " (the request exceeded timeout_ms — raise it or try again)"
          : /ENOTFOUND|EAI_AGAIN/i.test(message)
            ? " (DNS lookup failed from the VPS)"
            : /ECONNREFUSED/i.test(message)
              ? " (nothing is listening on that host and port)"
              : "";
        return fail(`http_request failed after ${Date.now() - started}ms: ${message}${hint}`);
      }
    },
  );

  server.registerTool(
    "download_file",
    {
      title: "Download a URL to the VPS",
      description:
        "Stream a URL straight to a file on the VPS. Handles large files without buffering them in memory and " +
        "returns the size and SHA-256 so the result can be verified. Use this for release tarballs, backups, " +
        "binaries and assets. To go the other way — VPS to you — use read_file with encoding=base64.",
      inputSchema: {
        url: z.string().url().describe("Absolute URL to download."),
        dest: z.string().min(1).describe("Absolute destination path on the VPS."),
        header: z.array(z.string()).optional().describe('Headers as "Name: value" strings.'),
        overwrite: z.boolean().default(false).describe("Overwrite dest if it already exists."),
        timeout_ms: z
          .number()
          .int()
          .positive()
          .max(MAX_TIMEOUT_MS)
          .optional()
          .describe("Timeout for the whole download."),
        mode: z
          .string()
          .regex(/^[0-7]{3,4}$/)
          .optional()
          .describe('Octal permissions for the saved file, e.g. "755".'),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ url, dest, header, overwrite, timeout_ms, mode }) => {
      assertWritable("download_file");
      await assertUrlAllowed(url);
      const started = Date.now();
      try {
        if (!overwrite) {
          const exists = await fs
            .stat(dest)
            .then(() => true)
            .catch(() => false);
          if (exists) return fail(`${dest} already exists. Pass overwrite:true to replace it.`);
        }

        const response = await fetch(url, {
          headers: parseHeaders(header),
          redirect: "follow",
          signal: AbortSignal.timeout(clampTimeout(timeout_ms ?? MAX_TIMEOUT_MS)),
        });

        if (!response.ok)
          return fail(`download_file: ${url} returned ${response.status} ${response.statusText}.`);
        if (!response.body) return fail(`download_file: ${url} returned an empty body.`);

        const declared = Number(response.headers.get("content-length") ?? 0);
        if (declared > MAX_DOWNLOAD_BYTES) {
          return fail(
            `download_file: refusing ${humanBytes(declared)} — over the ${humanBytes(MAX_DOWNLOAD_BYTES)} cap.`,
          );
        }

        await fs.mkdir(path.dirname(dest), { recursive: true });
        await pipeline(
          Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
          createWriteStream(dest),
        );
        if (mode) await fs.chmod(dest, Number.parseInt(mode, 8));

        const stat = await fs.stat(dest);
        const digest = await sha256File(dest);
        audit("download_file", { url, dest, bytes: stat.size });
        return ok(
          `Downloaded ${url}\n` +
            `→ ${dest}\n` +
            `${humanBytes(stat.size)} · ${Date.now() - started}ms · sha256 ${digest}`,
        );
      } catch (error) {
        await fs.rm(dest, { force: true }).catch(() => undefined);
        return fail(`download_file failed: ${errorText(error)} (partial file removed)`);
      }
    },
  );
}
