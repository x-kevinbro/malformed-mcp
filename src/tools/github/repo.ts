import { z } from "zod";
import { defineTool } from "../../tool.js";
import { assertGithubWritable } from "../../result.js";
import { audit } from "../../logger.js";
import { DEFAULT_REPO, gh, ghJson, ghPaged, ghSend, qs } from "../../github/api.js";
import { day, firstLine, pad, pretty, short } from "../../github/format.js";

/** Repository metadata, refs, releases, and repository creation. */

export const ghRepo = defineTool({
  name: "gh_repo",
  title: "Repository metadata, branches, tags, releases and creation",
  description:
    "Inspect and manage repositories: settings, branches, tags, releases, collaborators, languages " +
    "and topics, plus 'compare' for the commit range between two refs. Also creates repositories, " +
    "branches, releases and forks. 'compare' is the quickest way to see how far a deployed checkout " +
    "has drifted from its remote.",
  input: {
    method: z.enum([
      "get",
      "branches",
      "tags",
      "releases",
      "latest_release",
      "release_by_tag",
      "collaborators",
      "languages",
      "topics",
      "set_topics",
      "compare",
      "contents",
      "create_branch",
      "create_release",
      "create_repo",
      "update_repo",
      "fork",
      "list_repos",
    ]),
    repo: z.string().default(DEFAULT_REPO),
    base: z.string().optional().describe("Base ref for 'compare'."),
    head: z.string().optional().describe("Head ref for 'compare'."),
    branch: z.string().optional().describe("Branch name to create, or to read contents from."),
    from_ref: z.string().optional().describe("Ref the new branch starts at. Defaults to the default branch."),
    path: z.string().optional().describe("Directory path for 'contents'. Defaults to the root."),
    tag: z.string().optional(),
    name: z.string().optional().describe("Release title, new repository name, or topic target."),
    body: z.string().optional().describe("Release notes or repository description."),
    draft: z.boolean().default(false),
    prerelease: z.boolean().default(false),
    private: z.boolean().default(true).describe("For 'create_repo'. Private by default."),
    auto_init: z.boolean().default(false).describe("For 'create_repo': seed with a README."),
    org: z.string().optional().describe("Create in this organisation instead of the user account."),
    topics: z.array(z.string()).optional(),
    settings: z.record(z.string(), z.any()).optional().describe("Fields for 'update_repo'."),
    limit: z.number().int().min(1).max(100).default(30),
  },
  async run(args) {
    const { repo, method } = args;

    switch (method) {
      case "get": {
        const r = await ghJson(`/repos/${repo}`);
        return [
          `${r.full_name}${r.private ? " (private)" : " (public)"}`,
          `description : ${r.description ?? "—"}`,
          `default     : ${r.default_branch}`,
          `size        : ${r.size} KB   language: ${r.language ?? "—"}`,
          `issues      : ${r.open_issues_count} open`,
          `pushed      : ${r.pushed_at}`,
          `permissions : ${JSON.stringify(r.permissions ?? {})}`,
          `url         : ${r.html_url}`,
        ].join("\n");
      }

      case "branches": {
        const list = await ghPaged(`/repos/${repo}/branches`, { maxPages: 2 });
        return list
          .map((b: any) => `${pad(b.name, 40)} ${short(b.commit?.sha)} ${b.protected ? "protected" : ""}`)
          .join("\n");
      }

      case "tags": {
        const list = await ghPaged(`/repos/${repo}/tags`, { maxPages: 2 });
        return list.map((t: any) => `${pad(t.name, 30)} ${short(t.commit?.sha)}`).join("\n") || "No tags.";
      }

      case "releases": {
        const list: any[] = await ghJson(`/repos/${repo}/releases${qs({ per_page: args.limit })}`);
        if (!list.length) return "No releases.";
        return list
          .map(
            (r) =>
              `${pad(r.tag_name, 20)} ${pad(r.name ?? "", 30)} ${day(r.published_at)}${
                r.draft ? " [draft]" : ""
              }${r.prerelease ? " [prerelease]" : ""}`,
          )
          .join("\n");
      }

      case "latest_release":
      case "release_by_tag": {
        const suffix = method === "latest_release" ? "latest" : `tags/${encodeURIComponent(args.tag ?? "")}`;
        if (method === "release_by_tag" && !args.tag) throw new Error("release_by_tag needs 'tag'.");
        const r = await ghJson(`/repos/${repo}/releases/${suffix}`);
        return `${r.tag_name} — ${r.name}\npublished ${r.published_at}\n${r.html_url}\n\n${r.body ?? ""}`;
      }

      case "collaborators": {
        const list = await ghPaged(`/repos/${repo}/collaborators`, { maxPages: 2 });
        return list
          .map((c: any) => `${pad(c.login, 24)} ${c.role_name ?? ""} ${JSON.stringify(c.permissions ?? {})}`)
          .join("\n");
      }

      case "languages": {
        const data = await ghJson(`/repos/${repo}/languages`);
        const total = Object.values<number>(data).reduce((a, b) => a + b, 0) || 1;
        return Object.entries<number>(data)
          .sort((a, b) => b[1] - a[1])
          .map(([lang, bytes]) => `${pad(lang, 16)} ${((bytes / total) * 100).toFixed(1)}%`)
          .join("\n");
      }

      case "topics": {
        const data = await ghJson(`/repos/${repo}/topics`);
        return (data.names ?? []).join(", ") || "No topics.";
      }

      case "set_topics": {
        assertGithubWritable("gh_repo");
        if (!args.topics) throw new Error("set_topics needs 'topics'.");
        const data = await ghJson(`/repos/${repo}/topics`, {
          method: "PUT",
          body: JSON.stringify({ names: args.topics }),
          headers: { "Content-Type": "application/json" },
        });
        return `Topics are now: ${(data.names ?? []).join(", ")}`;
      }

      case "compare": {
        if (!args.base || !args.head) throw new Error("compare needs 'base' and 'head'.");
        const c = await ghJson(
          `/repos/${repo}/compare/${encodeURIComponent(args.base)}...${encodeURIComponent(args.head)}`,
        );
        const commits = (c.commits ?? [])
          .slice(-20)
          .map((x: any) => `  ${short(x.sha)} ${firstLine(x.commit?.message, 66)}`)
          .join("\n");
        return [
          `${args.base}...${args.head}: ${c.status}`,
          `ahead ${c.ahead_by}, behind ${c.behind_by}, ${c.total_commits} commit(s), ${
            (c.files ?? []).length
          } file(s) changed`,
          commits ? `\nmost recent commits:\n${commits}` : "",
        ].join("\n");
      }

      case "contents": {
        const list = await ghJson(`/repos/${repo}/contents/${args.path ?? ""}${qs({ ref: args.branch })}`);
        if (!Array.isArray(list)) return `${list.path} is a file (${list.size} bytes). Use gh_file.`;
        return list.map((e: any) => `${e.type === "dir" ? "d" : "-"} ${pad(e.size, 9)} ${e.path}`).join("\n");
      }

      case "create_branch": {
        assertGithubWritable("gh_repo");
        if (!args.branch) throw new Error("create_branch needs 'branch'.");
        const from = args.from_ref ?? (await ghJson(`/repos/${repo}`)).default_branch;
        const ref = await ghJson(`/repos/${repo}/git/ref/heads/${from}`);
        await ghSend(`/repos/${repo}/git/refs`, "POST", {
          ref: `refs/heads/${args.branch}`,
          sha: ref.object.sha,
        });
        audit("gh_branch_create", { repo, branch: args.branch, from });
        return `Created ${args.branch} at ${short(ref.object.sha)} (from ${from}).`;
      }

      case "create_release": {
        assertGithubWritable("gh_repo");
        if (!args.tag) throw new Error("create_release needs 'tag'.");
        const r = await ghJson(`/repos/${repo}/releases`, {
          method: "POST",
          body: JSON.stringify({
            tag_name: args.tag,
            name: args.name ?? args.tag,
            body: args.body ?? "",
            draft: args.draft,
            prerelease: args.prerelease,
          }),
          headers: { "Content-Type": "application/json" },
        });
        audit("gh_release_create", { repo, tag: args.tag });
        return `Created release ${r.tag_name}: ${r.html_url}`;
      }

      case "create_repo": {
        assertGithubWritable("gh_repo");
        if (!args.name) throw new Error("create_repo needs 'name'.");
        const endpoint = args.org ? `/orgs/${args.org}/repos` : "/user/repos";
        const r = await ghSend(endpoint, "POST", {
          name: args.name,
          description: args.body ?? "",
          private: args.private,
          auto_init: args.auto_init,
        });
        audit("gh_repo_create", { name: args.name, private: args.private });
        return `Created ${r.json.full_name} (${r.json.private ? "private" : "public"})\n${
          r.json.html_url
        }\nclone: ${r.json.ssh_url}`;
      }

      case "update_repo": {
        assertGithubWritable("gh_repo");
        if (!args.settings) throw new Error("update_repo needs 'settings'.");
        const r = await ghSendJsonSafe(repo, args.settings);
        audit("gh_repo_update", { repo, fields: Object.keys(args.settings) });
        return `Updated ${r.full_name}.\n${pretty(args.settings)}`;
      }

      case "fork": {
        assertGithubWritable("gh_repo");
        const r = await ghSend(`/repos/${repo}/forks`, "POST", args.org ? { organization: args.org } : {});
        audit("gh_repo_fork", { repo });
        return `Fork requested: ${r.json?.full_name ?? repo}. Forking is asynchronous and may take a moment.`;
      }

      case "list_repos": {
        const endpoint = args.org
          ? `/orgs/${args.org}/repos${qs({ per_page: args.limit, sort: "pushed" })}`
          : `/user/repos${qs({ per_page: args.limit, sort: "pushed", affiliation: "owner" })}`;
        const list: any[] = await ghJson(endpoint);
        return list
          .map(
            (r) => `${pad(r.full_name, 44)} ${r.private ? "private" : "public "} pushed ${day(r.pushed_at)}`,
          )
          .join("\n");
      }
    }
  },
});

/** PATCH /repos/{repo} with arbitrary settings, kept out of the switch for clarity. */
async function ghSendJsonSafe(repo: string, settings: Record<string, unknown>): Promise<any> {
  return (await ghSend(`/repos/${repo}`, "PATCH", settings)).json;
}

export const repoTools = [ghRepo];
