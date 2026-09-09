import { z } from "zod";
import { defineTool } from "../../tool.js";
import { assertGithubWritable } from "../../result.js";
import { audit } from "../../logger.js";
import { DEFAULT_REPO, gh, ghJson, ghSend } from "../../github/api.js";
import { day, firstLine, pad } from "../../github/format.js";

/**
 * Pull request reviews, including line-anchored comments.
 *
 * Two shapes are supported deliberately:
 *
 *   submit  - one call carrying every comment. Atomic, and the right choice
 *             when the whole review is already known.
 *   pending - create a draft review, attach comments across several calls,
 *             then submit. Necessary when comments are discovered while
 *             reading the diff, because each one can be added as it is found
 *             without publishing a notification per comment.
 *
 * Anchoring rules that are easy to get wrong: 'line' is the line number in the
 * file after the change, and it must fall inside the diff hunk or GitHub
 * rejects the comment with a 422. Use side:"LEFT" to comment on a removed line.
 */

const commentSchema = z.object({
  path: z.string().describe("File path, exactly as it appears in the diff."),
  body: z.string().describe("Comment text. Markdown is supported."),
  line: z.number().int().optional().describe("Line number in the file after the change."),
  start_line: z.number().int().optional().describe("First line, for a multi-line comment."),
  side: z.enum(["LEFT", "RIGHT"]).default("RIGHT").describe("LEFT comments on a removed line."),
  subject_type: z.enum(["line", "file"]).optional().describe("Use 'file' to comment on a whole file."),
});

export const ghReview = defineTool({
  name: "gh_review",
  title: "Review pull requests with line-level comments",
  description:
    "Write pull request reviews. 'submit' posts an entire review with all its line comments in one " +
    "call. For a review built up while reading the diff, use 'create_pending', then 'add_comment' " +
    "per finding, then 'submit_pending' — the draft stays private until submitted, so the author is " +
    "notified once rather than per comment. 'reply' answers an existing review comment thread.",
  input: {
    method: z.enum([
      "submit",
      "create_pending",
      "add_comment",
      "submit_pending",
      "delete_pending",
      "list",
      "get",
      "reply",
      "dismiss",
    ]),
    repo: z.string().default(DEFAULT_REPO),
    number: z.number().int().describe("Pull request number."),
    review_id: z.number().int().optional().describe("Needed for 'get' and 'dismiss'."),
    comment_id: z.number().int().optional().describe("Thread to answer, for 'reply'."),
    body: z.string().optional().describe("Review summary, reply text, or dismissal reason."),
    event: z
      .enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"])
      .default("COMMENT")
      .describe("A token cannot APPROVE a pull request it opened itself."),
    comments: z.array(commentSchema).optional().describe("Line comments for 'submit'."),
    comment: commentSchema.optional().describe("A single comment for 'add_comment'."),
    commit_id: z.string().optional().describe("Pin the review to a commit SHA. Defaults to the head."),
  },
  async run(args) {
    const { repo, number, method } = args;
    const base = `/repos/${repo}/pulls/${number}`;

    switch (method) {
      case "list": {
        const list: any[] = await ghJson(`${base}/reviews?per_page=100`);
        if (!list.length) return "No reviews yet.";
        return list
          .map(
            (r) =>
              `${pad(r.id, 12)} ${pad(r.state, 18)} ${pad(r.user?.login, 18)} ${day(
                r.submitted_at,
              )} ${firstLine(r.body, 40)}`,
          )
          .join("\n");
      }

      case "get": {
        if (!args.review_id) throw new Error("get needs 'review_id'.");
        const r = await ghJson(`${base}/reviews/${args.review_id}`);
        const comments: any[] = await ghJson(`${base}/reviews/${args.review_id}/comments`);
        return [
          `review ${r.id} by ${r.user?.login} — ${r.state}`,
          r.body ?? "",
          "",
          ...comments.map((c) => `  ${c.path}:${c.line ?? c.original_line}\n    ${c.body}`),
        ].join("\n");
      }

      case "submit": {
        assertGithubWritable("gh_review");
        // Posting comments inline with the review is atomic: either the whole
        // review lands or none of it does.
        const r = await ghSend(`${base}/reviews`, "POST", {
          event: args.event,
          ...(args.body ? { body: args.body } : {}),
          ...(args.commit_id ? { commit_id: args.commit_id } : {}),
          ...(args.comments?.length ? { comments: args.comments } : {}),
        });
        audit("gh_review_submit", {
          repo,
          number,
          event: args.event,
          comments: args.comments?.length ?? 0,
        });
        return `Submitted ${args.event} review ${r.json?.id} with ${
          args.comments?.length ?? 0
        } line comment(s).\n${r.json?.html_url ?? ""}`;
      }

      case "create_pending": {
        assertGithubWritable("gh_review");
        // Omitting 'event' leaves the review in PENDING state.
        const r = await ghSend(`${base}/reviews`, "POST", {
          ...(args.body ? { body: args.body } : {}),
          ...(args.commit_id ? { commit_id: args.commit_id } : {}),
          comments: [],
        });
        return `Created pending review ${r.json?.id}. Add comments with method:"add_comment", then submit_pending.`;
      }

      case "add_comment": {
        assertGithubWritable("gh_review");
        if (!args.comment) throw new Error("add_comment needs 'comment'.");
        const head = args.commit_id ?? (await ghJson(base)).head.sha;
        const c = args.comment;
        const r = await ghSend(`${base}/comments`, "POST", {
          body: c.body,
          path: c.path,
          commit_id: head,
          side: c.side,
          ...(c.subject_type === "file"
            ? { subject_type: "file" }
            : { line: c.line, ...(c.start_line ? { start_line: c.start_line } : {}) }),
        });
        return `Added comment on ${c.path}:${c.line ?? "file"} (id ${r.json?.id}).`;
      }

      case "submit_pending": {
        assertGithubWritable("gh_review");
        if (!args.review_id) throw new Error("submit_pending needs 'review_id'.");
        const r = await ghSend(`${base}/reviews/${args.review_id}/events`, "POST", {
          event: args.event,
          ...(args.body ? { body: args.body } : {}),
        });
        audit("gh_review_submit_pending", { repo, number, event: args.event });
        return `Submitted review ${args.review_id} as ${args.event}. ${r.json?.html_url ?? ""}`;
      }

      case "delete_pending": {
        assertGithubWritable("gh_review");
        if (!args.review_id) throw new Error("delete_pending needs 'review_id'.");
        await gh(`${base}/reviews/${args.review_id}`, { method: "DELETE" });
        return `Discarded pending review ${args.review_id}.`;
      }

      case "reply": {
        assertGithubWritable("gh_review");
        if (!args.comment_id || !args.body) throw new Error("reply needs 'comment_id' and 'body'.");
        const r = await ghSend(`${base}/comments/${args.comment_id}/replies`, "POST", {
          body: args.body,
        });
        return `Replied in thread ${args.comment_id}: ${r.json?.html_url ?? "ok"}`;
      }

      case "dismiss": {
        assertGithubWritable("gh_review");
        if (!args.review_id) throw new Error("dismiss needs 'review_id'.");
        await ghSend(`${base}/reviews/${args.review_id}/dismissals`, "PUT", {
          message: args.body ?? "Dismissed.",
          event: "DISMISS",
        });
        return `Dismissed review ${args.review_id}.`;
      }
    }
  },
});

export const reviewTools = [ghReview];
