import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runShell, shq } from "../exec.js";
import { gitCredentialEnv } from "../github/store.js";
import { assertWritable, errorText, fail, ok } from "../result.js";
import { audit } from "../logger.js";
import { config } from "../config.js";
import { writeAtomicPreservingMode } from "../atomic-write.js";

/**
 * Tools that exist to cut the two real costs of editing a repository through a
 * model: tokens burned echoing work back, and half-applied writes that leave a
 * file broken. Both were observed repeatedly before these existed — anchored
 * edits were hand-rolled as python heredocs, which the transcript then echoed
 * in full, and a push race had to be retried by hand.
 */
export function registerAuthoringTools(server: McpServer): void {
  server.registerTool(
    "patch_file",
    {
      title: "Apply several anchored edits atomically",
      description:
        "Apply a list of exact find/replace edits across one or more files in a single call. Every " +
        "anchor is checked " +
        "before anything is written: if one is missing or matches a different number of times than " +
        "expected, the file is left untouched and the error names the offending edit. Use this instead of " +
        "sed or python splices, and instead of write_file when you are changing part of a file — you never " +
        "resend content you are not changing.",
      inputSchema: {
        path: z
          .string()
          .min(1)
          .optional()
          .describe("Default file for any edit that does not name its own path."),
        edits: z
          .array(
            z.object({
              path: z
                .string()
                .min(1)
                .optional()
                .describe("Overrides the top-level path, letting one call span several files."),
              old: z.string().min(1).describe("Exact text to find, including indentation and newlines."),
              new: z.string().describe("Replacement text. An empty string deletes the match."),
              count: z
                .number()
                .int()
                .positive()
                .optional()
                .describe("Expected occurrences. Defaults to 1; the patch aborts if the real count differs."),
            }),
          )
          .min(1)
          .describe("Applied in order across all named files. All succeed or none are written."),
        dry_run: z.boolean().default(false).describe("Validate and report without writing."),
        warn_over: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Report inserted lines longer than this, e.g. 80 to catch formatter violations early."),
      },
      annotations: { destructiveHint: true },
    },
    async ({ path: defaultPath, edits, dry_run, warn_over }) => {
      try {
        assertWritable("patch_file");

        // Group by file so one call can carry a refactor across several files,
        // and so a bad anchor in the last file still prevents writing the first.
        const targets = new Map<string, { original: string; draft: string }>();
        const applied: string[] = [];

        for (const [index, edit] of edits.entries()) {
          const filePath = edit.path ?? defaultPath;
          if (!filePath) {
            return fail(`Edit ${index + 1} names no path, and no top-level path was given.`);
          }

          let target = targets.get(filePath);
          if (!target) {
            const original = await fs.readFile(filePath, "utf8");
            target = { original, draft: original };
            targets.set(filePath, target);
          }

          const expected = edit.count ?? 1;
          const found = target.draft.split(edit.old).length - 1;

          if (found !== expected) {
            return fail(
              `patch_file aborted \u2014 nothing was written to any of the ${targets.size} file(s).\n` +
                `Edit ${index + 1} of ${edits.length} in ${filePath} expected ${expected} ` +
                `occurrence(s), found ${found}.\n` +
                `Anchor: ${JSON.stringify(edit.old.slice(0, 200))}\n` +
                (found === 0
                  ? "That anchor is not in the file. Re-read it \u2014 whitespace, indentation and " +
                    "punctuation must match byte for byte."
                  : "That anchor is ambiguous. Extend it until it is unique, or set count explicitly."),
            );
          }

          target.draft = target.draft.split(edit.old).join(edit.new);
          applied.push(`  ${index + 1}. ${filePath} \u2014 ${found} replacement(s)`);
        }

        const changed = [...targets.entries()].filter(([, t]) => t.draft !== t.original);
        if (!changed.length) {
          return ok("No change \u2014 every replacement produced text identical to what was there.");
        }

        // Only complain about long lines this patch actually introduced.
        const warnings: string[] = [];
        if (warn_over) {
          for (const [filePath, t] of changed) {
            const preexisting = new Set(t.original.split("\n"));
            t.draft.split("\n").forEach((line, i) => {
              if (line.length > warn_over && !preexisting.has(line)) {
                warnings.push(`  ${filePath}:${i + 1} \u2014 ${line.length} chars`);
              }
            });
          }
        }

        if (!dry_run) {
          // Sibling write then rename, preserving the mode. See atomic-write.ts
          // for why both halves of that matter.
          for (const [filePath, t] of changed) {
            await writeAtomicPreservingMode(filePath, t.draft);
          }
          audit("patch_file", { files: changed.map(([p]) => p), edits: edits.length });
        }

        const summary = changed
          .map(([p, t]) => `  ${p} \u00b7 ${t.original.length} \u2192 ${t.draft.length} bytes`)
          .join("\n");

        return ok(
          `${dry_run ? "Dry run, nothing written" : "Patched"} ${changed.length} file(s), ` +
            `${edits.length} edit(s).\n${summary}\n${applied.join("\n")}` +
            (warnings.length
              ? `\n\nInserted lines over ${warn_over} characters:\n${warnings.slice(0, 20).join("\n")}`
              : ""),
        );
      } catch (error) {
        return fail(`patch_file failed: ${errorText(error)}`);
      }
    },
  );

  server.registerTool(
    "commit_push",
    {
      title: "Commit and push, rebasing on rejection",
      description:
        "Stage, commit and push in one call. If the branch moved while you were working the push is " +
        "rejected; this fetches, rebases and retries rather than failing. On a rebase conflict it aborts " +
        "cleanly, keeps your commit, and reports the conflicting files. Refuses to run in the deploy " +
        "checkout, which the next deploy would hard-reset.",
      inputSchema: {
        message: z.string().min(1).describe("Commit message. The first line is the subject."),
        cwd: z.string().min(1).describe("Repository directory. Use the work clone, not the deploy checkout."),
        paths: z.array(z.string()).optional().describe("Paths to stage. Defaults to every change."),
        branch: z.string().default("main").describe("Remote branch to push to."),
        attempts: z.number().int().min(1).max(5).default(3).describe("Push attempts before giving up."),
        allow_empty: z.boolean().default(false).describe("Commit even when nothing is staged."),
        allow_deploy_dir: z
          .boolean()
          .default(false)
          .describe("Permit committing inside the deploy checkout. Almost always a mistake."),
      },
      annotations: { destructiveHint: true },
    },
    async ({ message, cwd, paths, branch, attempts, allow_empty, allow_deploy_dir }) => {
      const messageFile = path.join(os.tmpdir(), `mcp-commit-${randomBytes(6).toString("hex")}.txt`);
      try {
        assertWritable("commit_push");

        const resolved = path.resolve(cwd);
        const deployDirs = [path.resolve(config.defaultCwd), path.resolve(config.composeDir)];
        if (!allow_deploy_dir && deployDirs.includes(resolved)) {
          return fail(
            `Refusing to commit in ${resolved}: that is the deploy checkout and the next deploy ` +
              `hard-resets it, destroying the commit. Author in a separate work clone instead, or pass ` +
              `allow_deploy_dir if you really mean it.`,
          );
        }

        audit("commit_push", { dir: resolved, branch, subject: message.split("\n")[0] });
        await fs.writeFile(messageFile, message, "utf8");

        const stage = paths?.length ? `git add -- ${paths.map(shq).join(" ")}` : "git add -A";
        const script = [
          "set -o pipefail",
          `${stage} || exit 90`,
          `if [ -z "$(git diff --cached --name-only)" ] && [ "${allow_empty}" != "true" ]; then`,
          '  echo "NOTHING_STAGED"; exit 91',
          "fi",
          `git commit -q ${allow_empty ? "--allow-empty " : ""}-F ${shq(messageFile)} || exit 92`,
          "attempt=1",
          `while [ "$attempt" -le ${attempts} ]; do`,
          `  if git push -q origin "HEAD:${branch}" 2>/tmp/mcp-push-err; then`,
          '    echo "pushed on attempt $attempt"; exit 0',
          "  fi",
          '  echo "push rejected on attempt $attempt, rebasing"',
          `  git fetch -q origin ${shq(branch)} || exit 93`,
          "  if ! git rebase -q FETCH_HEAD; then",
          "    git rebase --abort 2>/dev/null",
          '    echo "REBASE_CONFLICT"',
          "    git diff --name-only --diff-filter=U",
          "    exit 94",
          "  fi",
          "  sleep 2",
          "  attempt=$((attempt + 1))",
          "done",
          "tail -3 /tmp/mcp-push-err",
          "exit 95",
        ].join("\n");

        const result = await runShell(script, {
          cwd: resolved,
          timeoutMs: 300_000,
          // Authenticate as the profile that owns this working tree, exactly
          // like the panel's clone flow. See gitCredentialEnv.
          env: gitCredentialEnv(resolved),
        });
        const out = `${result.stdout}\n${result.stderr}`.trim();

        if (result.exitCode === 0) {
          const head = await runShell("git log --oneline -1", { cwd: resolved, timeoutMs: 15_000 });
          return ok(`Pushed to ${branch}.\n${head.stdout.trim()}\n${out}`);
        }

        const hint: Record<number, string> = {
          90: "Staging failed — check the paths exist.",
          91: "Nothing was staged, so there was nothing to commit. Confirm your edits landed where you think.",
          92: "The commit itself failed. Check user.name and user.email are set in this clone.",
          93: "Could not fetch. If this is 'Permission denied (publickey)', the ssh key selection is wrong.",
          94: "Rebase conflicted and was aborted. Your commit is intact; reconcile with origin and retry.",
          95:
            `Push rejected on all ${attempts} attempt(s). The commit exists locally, so only the ` +
            `push failed — the git error is above. Something else pushing to ${branch} is one ` +
            `cause; a protected branch, or a credential the remote refuses, are others.`,
        };

        return fail(
          `commit_push failed (exit ${result.exitCode}).\n${out}` +
            (hint[result.exitCode] ? `\n\n${hint[result.exitCode]}` : ""),
        );
      } catch (error) {
        return fail(`commit_push failed: ${errorText(error)}`);
      } finally {
        void fs.unlink(messageFile).catch(() => undefined);
      }
    },
  );
}
