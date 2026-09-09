import { z } from "zod";
import { defineTool } from "../../tool.js";
import { assertGithubWritable } from "../../result.js";
import { DEFAULT_REPO, gh, ghJson, ghPaged, ghRaw, qs, tokenStatus } from "../../github/api.js";
import { pretty } from "../../github/format.js";
import { currentAccount, defaultAccountName, listAccounts, withAccount } from "../../github/accounts.js";
import { listClones } from "../../github/store.js";

/** Diagnostics and the raw escape hatch. */

export const ghStatus = defineTool({
  name: "gh_status",
  title: "GitHub token identity, permissions and rate limit",
  description:
    "Start here when anything GitHub-related misbehaves. Reports who the token authenticates as, " +
    "its scopes, when it expires, the remaining rate limit, and the permissions it holds on the " +
    "repository. A private repo answers 404 rather than 403 when a permission is missing, so a " +
    "confusing 'not found' is usually answered here.",
  readOnly: true,
  input: {
    repo: z.string().default(DEFAULT_REPO).describe("owner/name to check access against."),
  },
  async run({ repo }) {
    const out: string[] = [];

    const me = await gh("/user");
    const scopes = me.headers.get("x-oauth-scopes");
    out.push(`profile          : ${currentAccount().name}`);
    out.push(`authenticated as : ${me.json?.login} (${me.json?.type})`);
    out.push(
      `token scopes     : ${scopes || "fine-grained token — the API does not report its permissions"}`,
    );

    const { expiry, rate } = tokenStatus();
    if (expiry) {
      const days = Math.round((Date.parse(expiry) - Date.now()) / 86_400_000);
      const warning = days <= 7 ? "  <-- EXPIRING SOON, rotate it" : "";
      out.push(`token expires    : ${expiry} (${days} day(s))${warning}`);
    } else {
      out.push("token expires    : no expiry reported");
    }

    if (rate) {
      out.push(
        `rate limit       : ${rate.remaining}/${rate.limit} left, resets ${new Date(
          rate.reset * 1000,
        ).toISOString()}`,
      );
    }

    if (repo) {
      try {
        const r = await ghJson(`/repos/${repo}`);
        const p = r.permissions ?? {};
        out.push(`repo ${r.full_name}: private=${r.private} admin=${p.admin} push=${p.push} pull=${p.pull}`);
        out.push(`default branch   : ${r.default_branch}`);
      } catch (error) {
        out.push(`repo ${repo}: NOT ACCESSIBLE — ${(error as Error).message}`);
      }
    } else {
      out.push("repo             : none configured (pass repo: 'owner/name' or set a default repo)");
    }

    return out.join("\n");
  },
});

export const ghApi = defineTool({
  name: "gh_api",
  title: "Call any GitHub REST endpoint",
  description:
    "The escape hatch for anything the other gh_* tools do not wrap. Takes a path like " +
    "'/repos/{owner}/{repo}/releases' and an optional JSON body. Set paginate:true to follow Link " +
    "headers and merge the pages. Prefer a specific tool when one exists: they format their output " +
    "for reading, while this returns raw JSON.",
  input: {
    path: z.string().min(1).describe("API path, e.g. /repos/owner/name/releases. {repo} is expanded."),
    method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]).default("GET"),
    body: z.record(z.string(), z.any()).optional().describe("JSON body for write methods."),
    paginate: z.boolean().default(false).describe("Follow Link headers and merge pages (GET only)."),
    max_pages: z.number().int().min(1).max(20).default(3),
    accept: z.string().optional().describe("Override the Accept header, e.g. for a diff or raw file."),
  },
  async run({ path, method, body, paginate, max_pages, accept }) {
    if (method !== "GET") assertGithubWritable("gh_api");
    // {repo} follows the active profile, so the same path means "my repo" under
    // whichever account the call is running as.
    const target = path.replace("{repo}", currentAccount().repo || DEFAULT_REPO);

    if (paginate && method === "GET") {
      const items = await ghPaged(target, { maxPages: max_pages });
      return `${items.length} item(s)\n${pretty(items)}`;
    }

    const response = await ghRaw(target, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(accept ? { Accept: accept } : {}),
      },
    });

    const head = `${method} ${target} → ${response.status}`;
    if (!response.text) return `${head} (empty response)`;
    return `${head}\n${response.json ? pretty(response.json) : response.text}`;
  },
});

export const ghRateLimit = defineTool({
  name: "gh_rate_limit",
  title: "Remaining GitHub API quota per category",
  description:
    "Shows the quota for core, search, GraphQL and code search separately. Checking this does not " +
    "itself consume quota. Useful when calls start failing with 403 and you need to know whether to " +
    "wait or fix a permission.",
  readOnly: true,
  input: {},
  async run() {
    const data = await ghJson("/rate_limit");
    const rows = Object.entries<any>(data.resources ?? {}).map(([name, value]) => {
      const resetIn = Math.max(0, Math.round((value.reset * 1000 - Date.now()) / 1000));
      return `${name.padEnd(22)} ${String(value.remaining).padStart(6)}/${String(value.limit).padEnd(6)} resets in ${resetIn}s`;
    });
    return rows.join("\n");
  },
});

export const ghProfiles = defineTool({
  name: "gh_profiles",
  title: "Which GitHub accounts this server can act as",
  description:
    "Lists the configured GitHub profiles, their default repositories, and which one is used when " +
    "a call does not name one, then the repositories cloned on this host for each profile, with the " +
    "branch and absolute path of every working tree. Start here before any repository work instead " +
    "of searching the disk for a checkout. Every gh_* tool takes a profile argument to switch " +
    "between them. Token values are never returned - set verify:true to prove each one still " +
    "authenticates, which reports the login GitHub associates with it.",
  readOnly: true,
  input: {
    verify: z
      .boolean()
      .default(false)
      .describe("Call /user with each token to confirm it works and report who it belongs to."),
  },
  async run({ verify }) {
    const accounts = listAccounts();
    if (!accounts.length) {
      return (
        "No GitHub profile is configured.\n\n" +
        "Open the Malformed-MCP panel, go to GitHub Profiles, and add one with a\n" +
        "personal access token. The login, name and repositories are read from\n" +
        "the token, so there is nothing else to fill in."
      );
    }

    const fallback = defaultAccountName();
    const width = Math.max(...accounts.map((a) => a.name.length));
    const out: string[] = [];

    for (const account of accounts) {
      const marker = account.name.toLowerCase() === fallback ? "  (default)" : "";
      const repo = account.repo || "-";
      const state = account.token ? "token stored" : "NO TOKEN STORED";
      const who = account.email ? `  ${account.email}` : "";
      let line = `${account.name.padEnd(width)}  repo: ${repo}${who}  ${state}${marker}`;

      if (verify && account.token) {
        try {
          const me = await withAccount(account.name, () => ghJson("/user"));
          line += `  ->  authenticates as ${me?.login}`;
        } catch (error) {
          line += `  ->  FAILED: ${(error as Error).message.slice(0, 120)}`;
        }
      }
      out.push(line);

      // Where the code actually is. Without this the only way to locate a
      // checkout is to search the filesystem for it, which is slow and which a
      // renamed working tree defeats outright.
      const clones = listClones(account.name);
      if (!clones.length) {
        out.push("    (nothing cloned yet - clone from the panel's Repositories view)");
        continue;
      }
      const repoWidth = Math.max(...clones.map((clone) => clone.repo.length));
      for (const clone of clones) {
        out.push(`    ${clone.repo.padEnd(repoWidth)}  [${clone.branch}]  ${clone.path}`);
      }
    }

    out.push(
      "",
      'Pass profile="<name>" to any gh_* tool to use a different account.',
      "Pass a clone path as cwd to git, repo_status or commit_push to work inside it.",
    );
    return out.join("\n");
  },
});

export const metaTools = [ghStatus, ghApi, ghRateLimit, ghProfiles];
