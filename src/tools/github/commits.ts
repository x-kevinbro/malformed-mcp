import { z } from "zod";
import { defineTool } from "../../tool.js";
import { DEFAULT_REPO, ghJson, qs } from "../../github/api.js";
import { day, firstLine, pad, short } from "../../github/format.js";

/** Commit history and individual commit detail. */

export const ghCommits = defineTool({
  name: "gh_commits",
  title: "Commit history and commit detail",
  description:
    "List commits on a branch, inspect one commit with its changed files, or search commit messages. " +
    "Filters by author, path and date. Use this to see what landed on the remote that a local or " +
    "deployed checkout has not yet picked up.",
  readOnly: true,
  input: {
    method: z.enum(["list", "get", "search"]).default("list"),
    repo: z.string().default(DEFAULT_REPO),
    sha: z.string().optional().describe("Commit SHA for 'get', or starting ref for 'list'."),
    branch: z.string().optional(),
    path: z.string().optional().describe("Only commits touching this path."),
    author: z.string().optional(),
    since: z.string().optional().describe("ISO 8601 timestamp."),
    until: z.string().optional().describe("ISO 8601 timestamp."),
    query: z.string().optional().describe("Search terms for 'search'."),
    limit: z.number().int().min(1).max(100).default(20),
    show_files: z.boolean().default(true).describe("For 'get': list the changed files."),
  },
  async run(args) {
    const { repo, method } = args;

    if (method === "get") {
      if (!args.sha) throw new Error("get needs 'sha'.");
      const c = await ghJson(`/repos/${repo}/commits/${args.sha}`);
      const stats = c.stats ?? {};
      const lines = [
        `commit ${c.sha}`,
        `author : ${c.commit?.author?.name} <${c.commit?.author?.email}>  ${c.commit?.author?.date}`,
        `stats  : +${stats.additions ?? 0} -${stats.deletions ?? 0} across ${(c.files ?? []).length} file(s)`,
        `url    : ${c.html_url}`,
        "",
        c.commit?.message ?? "",
      ];
      if (args.show_files) {
        lines.push(
          "",
          ...(c.files ?? []).map(
            (f: any) => `  ${pad(f.status, 9)} +${pad(f.additions, 5)} -${pad(f.deletions, 5)} ${f.filename}`,
          ),
        );
      }
      return lines.join("\n");
    }

    if (method === "search") {
      if (!args.query) throw new Error("search needs 'query'.");
      const q = /\b(repo|org|user):/.test(args.query) ? args.query : `repo:${repo} ${args.query}`;
      const data = await ghJson(`/search/commits${qs({ q, per_page: args.limit })}`);
      const items: any[] = data.items ?? [];
      if (!items.length) return `No commits matched: ${q}`;
      return items
        .map(
          (i) =>
            `${short(i.sha)} ${pad(day(i.commit?.author?.date), 11)} ${pad(
              i.commit?.author?.name,
              18,
            )} ${firstLine(i.commit?.message, 60)}`,
        )
        .join("\n");
    }

    const list: any[] = await ghJson(
      `/repos/${repo}/commits${qs({
        sha: args.sha ?? args.branch,
        path: args.path,
        author: args.author,
        since: args.since,
        until: args.until,
        per_page: args.limit,
      })}`,
    );
    if (!list.length) return "No commits matched.";
    return list
      .map(
        (c) =>
          `${short(c.sha)} ${pad(day(c.commit?.author?.date), 11)} ${pad(
            c.commit?.author?.name,
            18,
          )} ${firstLine(c.commit?.message, 60)}`,
      )
      .join("\n");
  },
});

export const commitTools = [ghCommits];
