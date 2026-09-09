import { z } from "zod";
import { defineTool } from "../../tool.js";
import { DEFAULT_REPO, ghJson, qs } from "../../github/api.js";
import { day, firstLine, pad, short } from "../../github/format.js";

/**
 * GitHub search across code, repositories, issues, PRs, users and commits.
 *
 * Search has its own much lower rate limit than the rest of the API, so results
 * are capped and the tool nudges toward a scoped query.
 */

const SCOPED = /\b(repo|org|user):/;

export const ghSearch = defineTool({
  name: "gh_search",
  title: "Search code, repos, issues, PRs, users and commits",
  description:
    "Query GitHub's search index. Unless the query already carries a repo:, org: or user: qualifier, " +
    "it is scoped to the configured repository automatically — an unscoped code search across all of " +
    "GitHub is rarely what you want. Sorting is a separate argument; do not put 'sort:' in the query.",
  readOnly: true,
  input: {
    type: z.enum(["code", "repos", "issues", "prs", "users", "commits", "topics"]).default("code"),
    query: z.string().min(1).describe("Search terms plus optional qualifiers such as language:ts."),
    repo: z.string().default(DEFAULT_REPO).describe("Used to scope the query when it is unscoped."),
    sort: z.string().optional().describe("e.g. indexed, stars, updated, author-date."),
    order: z.enum(["asc", "desc"]).default("desc"),
    limit: z.number().int().min(1).max(50).default(20),
    global: z.boolean().default(false).describe("Search all of GitHub instead of scoping to repo."),
  },
  async run({ type, query, repo, sort, order, limit, global: isGlobal }) {
    const scopable = type === "code" || type === "issues" || type === "prs" || type === "commits";
    let q = query;
    if (scopable && !isGlobal && !SCOPED.test(query)) q = `repo:${repo} ${query}`;
    if (type === "prs") q = `${q} is:pr`;
    if (type === "issues" && !/is:pr/.test(q)) q = `${q} is:issue`;

    const endpoint =
      type === "repos" ? "repositories" : type === "prs" ? "issues" : type === "topics" ? "topics" : type;

    const data = await ghJson(`/search/${endpoint}${qs({ q, sort, order, per_page: limit })}`);
    const items: any[] = data.items ?? [];
    const header = `${data.total_count ?? items.length} result(s) for: ${q}`;
    if (!items.length) return `${header}\n(nothing matched)`;

    const body = items.map((i) => {
      switch (type) {
        case "code":
          return `  ${i.path}${i.repository ? `  [${i.repository.full_name}]` : ""}`;
        case "repos":
          return `  ${pad(i.full_name, 44)} ★${pad(i.stargazers_count, 7)} ${firstLine(i.description, 50)}`;
        case "issues":
        case "prs":
          return `  #${pad(i.number, 6)} ${pad(i.state, 7)} ${pad(day(i.created_at), 11)} ${firstLine(
            i.title,
            54,
          )}`;
        case "users":
          return `  ${pad(i.login, 24)} ${i.type}  ${i.html_url}`;
        case "commits":
          return `  ${short(i.sha)} ${pad(day(i.commit?.author?.date), 11)} ${firstLine(
            i.commit?.message,
            56,
          )}`;
        default:
          return `  ${i.name ?? i.display_name}  ${firstLine(i.short_description, 60)}`;
      }
    });

    return [header, ...body].join("\n");
  },
});

export const searchTools = [ghSearch];
