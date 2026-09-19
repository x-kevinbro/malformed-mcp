/**
 * The cloud provider tool surface: one generic, authenticated request tool
 * plus a directory tool that says what is configured.
 *
 * Breadth lives in the provider registry (src/providers/spec.ts), not here:
 * every provider, present and future, is reachable through cloud_request with
 * its stored credential, so there is no per-provider tool suite to write and
 * none to keep in sync with an API that changes monthly. The gh_* suite stays
 * the example of the other trade - hand-written convenience where the call
 * volume justifies it.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool, registerTools } from "../tool.js";
import { assertCloudWritable } from "../result.js";
import { PROVIDERS, providerSpec } from "../providers/spec.js";
import { resolveAccount, visibleAccounts } from "../providers/accounts.js";
import { defaultAccountId } from "../providers/store.js";
import { cloudFetch, describeCloudFailure } from "../providers/request.js";
import { audit } from "../logger.js";

/** Methods that cannot change anything at the provider. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const providersTool = defineTool({
  name: "cloud_providers",
  title: "List the cloud providers and accounts this server knows",
  description:
    "Lists every provider this server can call (Vercel, Heroku, Render, DigitalOcean, Linode, " +
    "Fastly, Cloudflare, Firebase, Turso), which accounts are configured for each, and how to " +
    "authenticate the call. Accounts are added in the web panel, Cloud Providers tab - an agent " +
    "cannot add one itself. Use cloud_request for the actual call.",
  readOnly: true,
  input: {},
  run() {
    const lines: string[] = [];
    for (const spec of PROVIDERS) {
      const accounts = visibleAccounts(spec.id);
      const fallback = defaultAccountId(spec.id);
      lines.push(`${spec.id} - ${spec.name} (${spec.baseUrl})`);
      if (spec.docsUrl) lines.push(`  docs: ${spec.docsUrl}`);
      if (!accounts.length) {
        lines.push(
          `  no account configured - add one in the panel, Cloud Providers tab`,
        );
      }
      for (const account of accounts) {
        const marks = [
          account.id === fallback ? "default" : "",
          account.readOnly ? "read-only" : "writable",
          account.verified ? "" : "unverified",
        ]
          .filter(Boolean)
          .join(", ");
        lines.push(`  account: ${account.name} (${marks})`);
      }
    }
    lines.push(
      "",
      'Call one with cloud_request, e.g. { provider: "vercel", path: "/v9/projects" }. ' +
        'The "account" argument picks among several accounts on one provider.',
    );
    return lines.join("\n");
  },
});

const requestTool = defineTool({
  name: "cloud_request",
  title: "Make an authenticated call to a configured cloud provider API",
  description:
    "Calls any HTTP endpoint of a configured provider with its stored credential - the auth " +
    "header, retries and host checks are handled here. provider is one of the ids from " +
    'cloud_providers; path is a bare API path ("/v9/projects") or a full https URL on one of ' +
    "the provider's own hosts. GET/HEAD/OPTIONS always work; anything else is refused when the " +
    "server or the account is read-only. The credential is never shown to you: seeing " +
    '"[redacted" in a result means a real secret was withheld on purpose.',
  readOnly: false,
  destructive: true,
  input: {
    provider: z
      .string()
      .describe(
        `Provider id. One of: ${PROVIDERS.map((p) => p.id).join(", ")}.`,
      ),
    account: z
      .string()
      .optional()
      .describe(
        "Which configured account to act as, by name. Defaults to the provider's default " +
          "account. A session scoped to one account's MCP token can only ever use that one.",
      ),
    method: z
      .string()
      .default("GET")
      .describe(
        'HTTP method: "GET" (default), "POST", "PUT", "PATCH", "DELETE", "HEAD".',
      ),
    path: z
      .string()
      .describe(
        'API path such as "/v2/account", or a full https URL on one of the provider\'s own ' +
          "API hosts. Anything else is refused before any credential is attached.",
      ),
    query: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Query parameters, e.g. { "per_page": 50 }.'),
    body: z
      .unknown()
      .optional()
      .describe("JSON request body for POST/PUT/PATCH."),
  },
  async run({ provider, account, method, path, query, body }) {
    const spec = providerSpec(provider);
    const acct = resolveAccount(spec.id, account);
    const verb = method.toUpperCase();

    if (!SAFE_METHODS.has(verb)) {
      assertCloudWritable("cloud_request");
      if (acct.readOnly) {
        throw new Error(
          `The ${spec.name} account "${acct.name}" is read-only. Toggle it writable in the ` +
            `panel (Cloud Providers tab) if this change is intended.`,
        );
      }
    }

    audit("cloud_request", {
      provider: spec.id,
      account: acct.name,
      method: verb,
      path,
    });

    const response = await cloudFetch(spec, acct, {
      method: verb,
      path,
      query,
      body,
    });
    if (!response.ok)
      throw new Error(describeCloudFailure(spec, response, verb, path));

    const pretty =
      response.json !== undefined
        ? JSON.stringify(response.json, null, 2)
        : response.text || "(empty body)";
    return `${verb} ${path} -> ${response.status}\n\n${pretty}`;
  },
});

export function registerCloudTools(server: McpServer): void {
  registerTools(server, [providersTool, requestTool]);
}
