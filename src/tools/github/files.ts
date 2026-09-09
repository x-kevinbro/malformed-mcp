import { z } from "zod";
import { defineTool } from "../../tool.js";
import { assertGithubWritable } from "../../result.js";
import { audit } from "../../logger.js";
import { DEFAULT_REPO, gh, ghJson, ghSend, qs } from "../../github/api.js";
import { numbered, short } from "../../github/format.js";

/**
 * Reading and writing file contents on GitHub directly, without a local clone.
 *
 * 'write' handles one file and needs the previous blob SHA, which is resolved
 * automatically. 'push' commits several files at once through the git data API,
 * producing a single commit rather than one per file - which matters because
 * every commit to main triggers a deploy.
 */

export const ghFile = defineTool({
  name: "gh_file",
  title: "Read, write, delete or push files on GitHub",
  description:
    "Work with file contents in the remote repository without cloning. 'read' fetches a file at any " +
    "ref, 'write' commits a single file, 'delete' removes one, and 'push' commits several files as " +
    "one atomic commit. Prefer 'push' for multi-file changes: separate commits to a deploy branch " +
    "would each trigger a pipeline.",
  input: {
    method: z.enum(["read", "write", "delete", "push"]),
    repo: z.string().default(DEFAULT_REPO),
    path: z.string().optional().describe("File path within the repository."),
    ref: z.string().optional().describe("Branch, tag or SHA to read from."),
    branch: z.string().optional().describe("Branch to commit to. Defaults to the default branch."),
    content: z.string().optional().describe("New file content, as plain text."),
    message: z.string().optional().describe("Commit message."),
    files: z
      .array(
        z.object({
          path: z.string(),
          content: z.string().nullable().describe("null deletes the path."),
        }),
      )
      .optional()
      .describe("For 'push': the files to include in one commit."),
    line_numbers: z.boolean().default(false).describe("Number lines when reading."),
    max_lines: z.number().int().min(1).max(3000).default(500),
  },
  async run(args) {
    const { repo, method } = args;

    if (method === "read") {
      if (!args.path) throw new Error("read needs 'path'.");
      const data = await ghJson(`/repos/${repo}/contents/${args.path}${qs({ ref: args.ref })}`);
      if (Array.isArray(data)) return `${args.path} is a directory. Use gh_repo method:"contents".`;
      if (data.encoding !== "base64") return `Unsupported encoding: ${data.encoding}`;

      const text = Buffer.from(data.content, "base64").toString("utf8");
      const lines = text.split("\n");
      const shown = lines.slice(0, args.max_lines);
      const body = args.line_numbers ? numbered(shown) : shown.join("\n");
      const more = lines.length > shown.length ? `\n… ${lines.length - shown.length} more line(s)` : "";
      return `=== ${data.path} @ ${args.ref ?? "default"} (${lines.length} lines, sha ${short(
        data.sha,
      )}) ===\n${body}${more}`;
    }

    if (method === "write") {
      assertGithubWritable("gh_file");
      if (!args.path || args.content === undefined) throw new Error("write needs 'path' and 'content'.");

      // GitHub requires the current blob SHA to overwrite a file; its absence
      // means the file is new. Resolving it here keeps callers from a
      // mandatory extra round trip.
      let sha: string | undefined;
      try {
        const existing = await ghJson(`/repos/${repo}/contents/${args.path}${qs({ ref: args.branch })}`);
        if (!Array.isArray(existing)) sha = existing.sha;
      } catch {
        sha = undefined;
      }

      const result = await ghSend(`/repos/${repo}/contents/${args.path}`, "PUT", {
        message: args.message ?? `Update ${args.path}`,
        content: Buffer.from(args.content, "utf8").toString("base64"),
        ...(sha ? { sha } : {}),
        ...(args.branch ? { branch: args.branch } : {}),
      });
      audit("gh_file_write", { repo, path: args.path, created: !sha });
      return `${sha ? "Updated" : "Created"} ${args.path} — commit ${short(
        result.json?.commit?.sha,
      )}\n${result.json?.commit?.html_url ?? ""}`;
    }

    if (method === "delete") {
      assertGithubWritable("gh_file");
      if (!args.path) throw new Error("delete needs 'path'.");
      const existing = await ghJson(`/repos/${repo}/contents/${args.path}${qs({ ref: args.branch })}`);
      const result = await ghSend(`/repos/${repo}/contents/${args.path}`, "DELETE", {
        message: args.message ?? `Delete ${args.path}`,
        sha: existing.sha,
        ...(args.branch ? { branch: args.branch } : {}),
      });
      audit("gh_file_delete", { repo, path: args.path });
      return `Deleted ${args.path} — commit ${short(result.json?.commit?.sha)}`;
    }

    // push: build a tree, commit it, and move the branch ref - the only way to
    // land several files in a single commit.
    assertGithubWritable("gh_file");
    if (!args.files?.length) throw new Error("push needs a non-empty 'files' array.");

    const branch = args.branch ?? (await ghJson(`/repos/${repo}`)).default_branch;
    const ref = await ghJson(`/repos/${repo}/git/ref/heads/${branch}`);
    const baseCommit = await ghJson(`/repos/${repo}/git/commits/${ref.object.sha}`);

    const tree = args.files.map((file) =>
      file.content === null
        ? { path: file.path, mode: "100644", type: "blob", sha: null }
        : { path: file.path, mode: "100644", type: "blob", content: file.content },
    );

    const newTree = await ghSendJson(`/repos/${repo}/git/trees`, {
      base_tree: baseCommit.tree.sha,
      tree,
    });
    const commit = await ghSendJson(`/repos/${repo}/git/commits`, {
      message: args.message ?? `Update ${args.files.length} file(s)`,
      tree: newTree.sha,
      parents: [ref.object.sha],
    });
    await ghSend(`/repos/${repo}/git/refs/heads/${branch}`, "PATCH", { sha: commit.sha });

    audit("gh_file_push", { repo, branch, count: args.files.length });
    return [
      `Committed ${args.files.length} file(s) to ${branch} as ${short(commit.sha)}`,
      ...args.files.map((f) => `  ${f.content === null ? "delete" : "write "} ${f.path}`),
      commit.html_url ?? "",
    ].join("\n");
  },
});

async function ghSendJson(path: string, body: unknown): Promise<any> {
  return (await ghSend(path, "POST", body)).json;
}

export const fileTools = [ghFile];
