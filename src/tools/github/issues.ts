import { z } from "zod";
import { defineTool } from "../../tool.js";
import { assertGithubWritable } from "../../result.js";
import { audit } from "../../logger.js";
import { DEFAULT_REPO, gh, ghJson, ghSend, qs } from "../../github/api.js";
import { day, firstLine, pad } from "../../github/format.js";

/** Issues, their comments, labels and sub-issue hierarchy. */

export const ghIssues = defineTool({
  name: "gh_issues",
  title: "Issues: list, read, create, update, comment",
  description:
    "Full issue management. Also handles sub-issues, which model a parent task broken into children. " +
    "Note that the REST issues endpoints return pull requests too; this tool filters them out so " +
    "'list' shows only real issues.",
  input: {
    method: z.enum([
      "list",
      "get",
      "create",
      "update",
      "close",
      "comment",
      "comments",
      "labels",
      "add_labels",
      "sub_issues",
      "add_sub_issue",
      "issue_types",
    ]),
    repo: z.string().default(DEFAULT_REPO),
    number: z.number().int().optional().describe("Issue number."),
    sub_issue_number: z.number().int().optional().describe("Child issue for 'add_sub_issue'."),
    title: z.string().optional(),
    body: z.string().optional(),
    state: z.enum(["open", "closed", "all"]).default("open"),
    state_reason: z
      .enum(["completed", "not_planned", "reopened"])
      .optional()
      .describe("Always set this when closing, so the history stays meaningful."),
    labels: z.array(z.string()).optional(),
    assignees: z.array(z.string()).optional(),
    milestone: z.number().int().optional(),
    limit: z.number().int().min(1).max(100).default(30),
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
          `/repos/${repo}/issues${qs({
            state: args.state,
            labels: args.labels?.join(","),
            per_page: args.limit,
          })}`,
        );
        // The issues endpoint includes PRs; they have a pull_request key.
        const issues = list.filter((i) => !i.pull_request);
        if (!issues.length) return `No ${args.state} issues.`;
        return issues
          .map(
            (i) =>
              `#${pad(i.number, 6)} ${pad(i.state, 7)} ${pad(day(i.created_at), 11)} ${pad(
                i.user?.login,
                16,
              )} ${firstLine(i.title, 54)}`,
          )
          .join("\n");
      }

      case "get": {
        const i = await ghJson(`/repos/${repo}/issues/${needNumber()}`);
        return [
          `#${i.number} ${i.title}`,
          `state    : ${i.state}${i.state_reason ? ` (${i.state_reason})` : ""}`,
          `author   : ${i.user?.login}   created ${i.created_at}`,
          `labels   : ${(i.labels ?? []).map((l: any) => l.name).join(", ") || "—"}`,
          `assignees: ${(i.assignees ?? []).map((a: any) => a.login).join(", ") || "—"}`,
          `comments : ${i.comments}`,
          `url      : ${i.html_url}`,
          "",
          i.body ?? "(no description)",
        ].join("\n");
      }

      case "create": {
        assertGithubWritable("gh_issues");
        if (!args.title) throw new Error("create needs 'title'.");
        const i = await ghSend(`/repos/${repo}/issues`, "POST", {
          title: args.title,
          body: args.body ?? "",
          ...(args.labels ? { labels: args.labels } : {}),
          ...(args.assignees ? { assignees: args.assignees } : {}),
          ...(args.milestone ? { milestone: args.milestone } : {}),
        });
        audit("gh_issue_create", { repo, number: i.json?.number });
        return `Created #${i.json?.number}: ${i.json?.html_url}`;
      }

      case "update":
      case "close": {
        assertGithubWritable("gh_issues");
        const number = needNumber();
        const body: Record<string, unknown> = {};
        if (args.title) body.title = args.title;
        if (args.body !== undefined) body.body = args.body;
        if (args.labels) body.labels = args.labels;
        if (args.assignees) body.assignees = args.assignees;
        if (method === "close") {
          body.state = "closed";
          body.state_reason = args.state_reason ?? "completed";
        }
        const i = await ghSend(`/repos/${repo}/issues/${number}`, "PATCH", body);
        audit("gh_issue_update", { repo, number, fields: Object.keys(body) });
        return `Updated #${number} (${i.json?.state}). ${i.json?.html_url}`;
      }

      case "comment": {
        assertGithubWritable("gh_issues");
        if (!args.body) throw new Error("comment needs 'body'.");
        const c = await ghSend(`/repos/${repo}/issues/${needNumber()}/comments`, "POST", {
          body: args.body,
        });
        return `Commented: ${c.json?.html_url}`;
      }

      case "comments": {
        const list: any[] = await ghJson(
          `/repos/${repo}/issues/${needNumber()}/comments${qs({ per_page: args.limit })}`,
        );
        if (!list.length) return "No comments.";
        return list.map((c) => `--- ${c.user?.login} at ${c.created_at} ---\n${c.body}`).join("\n\n");
      }

      case "labels": {
        const list: any[] = await ghJson(`/repos/${repo}/labels?per_page=100`);
        return list.map((l) => `${pad(l.name, 28)} ${l.description ?? ""}`).join("\n");
      }

      case "add_labels": {
        assertGithubWritable("gh_issues");
        if (!args.labels?.length) throw new Error("add_labels needs 'labels'.");
        const result = await ghSend(`/repos/${repo}/issues/${needNumber()}/labels`, "POST", {
          labels: args.labels,
        });
        return `Labels are now: ${(result.json ?? []).map((l: any) => l.name).join(", ")}`;
      }

      case "sub_issues": {
        const list: any[] = await ghJson(`/repos/${repo}/issues/${needNumber()}/sub_issues`);
        if (!list.length) return "No sub-issues.";
        return list.map((i) => `#${pad(i.number, 6)} ${pad(i.state, 7)} ${i.title}`).join("\n");
      }

      case "add_sub_issue": {
        assertGithubWritable("gh_issues");
        if (!args.sub_issue_number) throw new Error("add_sub_issue needs 'sub_issue_number'.");
        // This endpoint wants the child's internal id, not its number.
        const child = await ghJson(`/repos/${repo}/issues/${args.sub_issue_number}`);
        await ghSend(`/repos/${repo}/issues/${needNumber()}/sub_issues`, "POST", {
          sub_issue_id: child.id,
        });
        return `Added #${args.sub_issue_number} as a sub-issue of #${args.number}.`;
      }

      case "issue_types": {
        // Organisation-level feature; a user-owned repo has none.
        const owner = repo.split("/")[0];
        try {
          const list: any[] = await ghJson(`/orgs/${owner}/issue-types`);
          return list.map((t) => `${pad(t.name, 20)} ${t.description ?? ""}`).join("\n");
        } catch {
          return `${owner} is a user account, not an organisation, so it has no custom issue types.`;
        }
      }
    }
  },
});

export const issueTools = [ghIssues];
