import { z } from "zod";
import { defineTool } from "../../tool.js";
import { assertGithubWritable } from "../../result.js";
import { audit } from "../../logger.js";
import { DEFAULT_REPO, gh, ghJson, ghSend, qs } from "../../github/api.js";
import { day, firstLine, pad, short, verdict } from "../../github/format.js";

/**
 * Pull requests. Line-by-line review lives in reviews.ts; this module covers
 * the pull request itself and its lifecycle.
 */

const COPILOT_REVIEWER = "copilot-pull-request-reviewer[bot]";

export const ghPulls = defineTool({
  name: "gh_pulls",
  title: "Pull requests: list, read, create, merge, diff",
  description:
    "Manage pull requests end to end. 'diff' returns the unified patch, 'files' the per-file change " +
    "summary, and 'checks' the CI verdict for the head commit — the fastest way to answer whether a " +
    "PR is safe to merge. For line-specific review comments use gh_review instead.",
  input: {
    method: z.enum([
      "list",
      "get",
      "create",
      "update",
      "merge",
      "close",
      "diff",
      "files",
      "commits",
      "checks",
      "comment",
      "comments",
      "request_reviewers",
      "request_copilot_review",
      "update_branch",
    ]),
    repo: z.string().default(DEFAULT_REPO),
    number: z.number().int().optional(),
    title: z.string().optional(),
    body: z.string().optional(),
    head: z.string().optional().describe("Source branch for 'create'."),
    base: z.string().optional().describe("Target branch for 'create'. Defaults to the default branch."),
    draft: z.boolean().default(false),
    state: z.enum(["open", "closed", "all"]).default("open"),
    merge_method: z.enum(["merge", "squash", "rebase"]).default("squash"),
    commit_title: z.string().optional(),
    reviewers: z.array(z.string()).optional(),
    team_reviewers: z.array(z.string()).optional(),
    limit: z.number().int().min(1).max(100).default(20),
    max_diff_lines: z.number().int().min(50).max(4000).default(600),
  },
  async run(args) {
    const { repo, method } = args;
    const needNumber = () => {
      if (!args.number) throw new Error(`${method} needs 'number'.`);
      return args.number;
    };

    switch (method) {
      case "list": {
        const list: any[] = await ghJson(
          `/repos/${repo}/pulls${qs({ state: args.state, per_page: args.limit })}`,
        );
        if (!list.length) return `No ${args.state} pull requests.`;
        return list
          .map(
            (p) =>
              `#${pad(p.number, 6)} ${pad(p.state, 7)}${p.draft ? " draft" : "      "} ${pad(
                `${p.head?.ref} → ${p.base?.ref}`,
                34,
              )} ${firstLine(p.title, 44)}`,
          )
          .join("\n");
      }

      case "get": {
        const p = await ghJson(`/repos/${repo}/pulls/${needNumber()}`);
        return [
          `#${p.number} ${p.title}`,
          `state     : ${p.state}${p.draft ? " (draft)" : ""}${p.merged ? " MERGED" : ""}`,
          `branches  : ${p.head?.ref} → ${p.base?.ref}`,
          `author    : ${p.user?.login}   created ${day(p.created_at)}`,
          `mergeable : ${p.mergeable} (${p.mergeable_state})`,
          `changes   : +${p.additions} -${p.deletions} across ${p.changed_files} file(s)`,
          `commits   : ${p.commits}   comments: ${p.comments} + ${p.review_comments} review`,
          `url       : ${p.html_url}`,
          "",
          p.body ?? "(no description)",
        ].join("\n");
      }

      case "create": {
        assertGithubWritable("gh_pulls");
        if (!args.title || !args.head) throw new Error("create needs 'title' and 'head'.");
        const base = args.base ?? (await ghJson(`/repos/${repo}`)).default_branch;
        const p = await ghSend(`/repos/${repo}/pulls`, "POST", {
          title: args.title,
          head: args.head,
          base,
          body: args.body ?? "",
          draft: args.draft,
        });
        audit("gh_pr_create", { repo, number: p.json?.number });
        return `Created PR #${p.json?.number}: ${p.json?.html_url}`;
      }

      case "update":
      case "close": {
        assertGithubWritable("gh_pulls");
        const number = needNumber();
        const body: Record<string, unknown> = {};
        if (args.title) body.title = args.title;
        if (args.body !== undefined) body.body = args.body;
        if (args.base) body.base = args.base;
        if (method === "close") body.state = "closed";
        await ghSend(`/repos/${repo}/pulls/${number}`, "PATCH", body);
        audit("gh_pr_update", { repo, number, fields: Object.keys(body) });
        return `Updated PR #${number}.`;
      }

      case "merge": {
        assertGithubWritable("gh_pulls");
        const number = needNumber();
        const result = await ghSend(`/repos/${repo}/pulls/${number}/merge`, "PUT", {
          merge_method: args.merge_method,
          ...(args.commit_title ? { commit_title: args.commit_title } : {}),
        });
        audit("gh_pr_merge", { repo, number, method: args.merge_method });
        return `Merged PR #${number} (${args.merge_method}): ${result.json?.sha}`;
      }

      case "diff": {
        const response = await gh(`/repos/${repo}/pulls/${needNumber()}`, {
          headers: { Accept: "application/vnd.github.diff" },
        });
        const lines = response.text.split("\n");
        if (lines.length <= args.max_diff_lines) return response.text;
        return `${lines.slice(0, args.max_diff_lines).join("\n")}\n\n… ${
          lines.length - args.max_diff_lines
        } more diff line(s). Use method:"files" for a summary, or raise max_diff_lines.`;
      }

      case "files": {
        const list: any[] = await ghJson(`/repos/${repo}/pulls/${needNumber()}/files?per_page=100`);
        return list
          .map((f) => `${pad(f.status, 9)} +${pad(f.additions, 5)} -${pad(f.deletions, 5)} ${f.filename}`)
          .join("\n");
      }

      case "commits": {
        const list: any[] = await ghJson(`/repos/${repo}/pulls/${needNumber()}/commits?per_page=100`);
        return list
          .map(
            (c) => `${short(c.sha)} ${pad(c.commit?.author?.name, 18)} ${firstLine(c.commit?.message, 60)}`,
          )
          .join("\n");
      }

      case "checks": {
        const p = await ghJson(`/repos/${repo}/pulls/${needNumber()}`);
        const data = await ghJson(`/repos/${repo}/commits/${p.head.sha}/check-runs?per_page=50`);
        const runs: any[] = data.check_runs ?? [];
        if (!runs.length) return `No checks reported for ${short(p.head.sha)}.`;
        return runs
          .map((c) => `${verdict(c.conclusion, c.status)}  ${pad(c.name, 34)} ${c.conclusion ?? c.status}`)
          .join("\n");
      }

      case "comment": {
        assertGithubWritable("gh_pulls");
        if (!args.body) throw new Error("comment needs 'body'.");
        // A PR-level comment is an issue comment; review comments differ.
        const c = await ghSend(`/repos/${repo}/issues/${needNumber()}/comments`, "POST", {
          body: args.body,
        });
        return `Commented: ${c.json?.html_url}`;
      }

      case "comments": {
        const list: any[] = await ghJson(`/repos/${repo}/pulls/${needNumber()}/comments?per_page=100`);
        if (!list.length) return "No review comments.";
        return list
          .map((c) => `--- ${c.user?.login} on ${c.path}:${c.line ?? c.original_line} ---\n${c.body}`)
          .join("\n\n");
      }

      case "request_reviewers": {
        assertGithubWritable("gh_pulls");
        await ghSend(`/repos/${repo}/pulls/${needNumber()}/requested_reviewers`, "POST", {
          ...(args.reviewers ? { reviewers: args.reviewers } : {}),
          ...(args.team_reviewers ? { team_reviewers: args.team_reviewers } : {}),
        });
        return `Requested review from ${[...(args.reviewers ?? []), ...(args.team_reviewers ?? [])].join(
          ", ",
        )}.`;
      }

      case "request_copilot_review": {
        assertGithubWritable("gh_pulls");
        await ghSend(`/repos/${repo}/pulls/${needNumber()}/requested_reviewers`, "POST", {
          reviewers: [COPILOT_REVIEWER],
        });
        return `Requested a Copilot review on #${args.number}. It needs Copilot enabled for the repository.`;
      }

      case "update_branch": {
        assertGithubWritable("gh_pulls");
        const r = await ghSend(`/repos/${repo}/pulls/${needNumber()}/update-branch`, "PUT", {});
        return `Branch update queued: ${r.json?.message ?? "ok"}`;
      }
    }
  },
});

export const pullTools = [ghPulls];
