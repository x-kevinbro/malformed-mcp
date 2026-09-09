import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { defineTool } from "../../tool.js";
import { assertGithubWritable } from "../../result.js";
import { audit } from "../../logger.js";
import { DEFAULT_REPO, gh, ghDownloadFile, ghJson, ghSend, qs } from "../../github/api.js";
import { bad, firstLine, pad, short, verdict } from "../../github/format.js";
import { jobLog, type LogMode } from "../../github/logs.js";

/**
 * GitHub Actions: runs, jobs, logs and the controls to re-run or cancel them.
 * This is the half of GitHub that the official MCP server does not expose at
 * all, and the reason a build failure can be diagnosed without leaving chat.
 */

async function latestRunId(repo: string, branch?: string): Promise<number> {
  const data = await ghJson(`/repos/${repo}/actions/runs${qs({ branch, per_page: 1 })}`);
  const run = data.workflow_runs?.[0];
  if (!run) throw new Error(`No workflow runs found for ${repo}${branch ? ` on ${branch}` : ""}.`);
  return run.id;
}

export const ghActions = defineTool({
  name: "gh_actions",
  title: "Workflow runs, jobs, logs, re-runs and dispatch",
  description:
    "Everything about GitHub Actions. 'runs' lists recent runs; 'logs' is the one to reach for when " +
    "CI is red — it finds the failing jobs, extracts the error lines with surrounding context and " +
    "skips the setup noise, so a 20,000 line log comes back as the handful of lines that explain the " +
    "failure. Omit run_id and it uses the most recent run.",
  input: {
    method: z
      .enum([
        "runs",
        "run",
        "jobs",
        "logs",
        "download_logs",
        "rerun",
        "rerun_failed",
        "cancel",
        "dispatch",
        "workflows",
        "artifacts",
        "usage",
      ])
      .describe("What to do."),
    repo: z.string().default(DEFAULT_REPO),
    run_id: z.number().int().optional().describe("Defaults to the most recent run."),
    job_id: z.number().int().optional().describe("Target a single job for 'logs'."),
    branch: z.string().optional(),
    workflow: z.string().optional().describe("Workflow file name or id, e.g. deploy.yml."),
    status: z.string().optional().describe("Filter runs, e.g. failure, success, in_progress."),
    limit: z.number().int().min(1).max(50).default(10),
    inputs: z.record(z.string(), z.any()).optional().describe("Inputs for 'dispatch'."),
    ref: z.string().optional().describe("Ref for 'dispatch'. Defaults to the default branch."),

    failed_only: z.boolean().default(true).describe("For 'logs': only jobs that did not pass."),
    max_jobs: z.number().int().min(1).max(10).default(3).describe("For 'logs': job cap."),
    mode: z
      .enum(["errors", "tail", "full"])
      .default("errors")
      .describe("errors = matching lines with context; tail = the end; full = everything."),
    tail: z.number().int().min(10).max(2000).default(120),
    context: z.number().int().min(0).max(20).default(3).describe("Lines kept around each match."),
    grep: z.string().optional().describe("Custom regex instead of the built-in error patterns."),
    strip_timestamps: z.boolean().default(true),
    dest: z.string().optional().describe("For 'download_logs': where to write the zip."),
  },
  async run(args) {
    const { repo, method } = args;
    const base = `/repos/${repo}/actions`;

    switch (method) {
      case "runs": {
        const data = await ghJson(
          `${base}/runs${qs({
            branch: args.branch,
            status: args.status,
            per_page: args.limit,
            ...(args.workflow ? {} : {}),
          })}`,
        );
        const runs: any[] = data.workflow_runs ?? [];
        if (!runs.length) return "No workflow runs matched.";
        return runs
          .map(
            (r) =>
              `${verdict(r.conclusion, r.status)}  ${pad(r.id, 12)} ${pad(r.name, 18)} ${short(
                r.head_sha,
              )} ${pad(r.head_branch, 14)} ${firstLine(r.display_title, 50)}`,
          )
          .join("\n");
      }

      case "run": {
        const id = args.run_id ?? (await latestRunId(repo, args.branch));
        const r = await ghJson(`${base}/runs/${id}`);
        return [
          `run ${r.id} — ${r.name}`,
          `status     : ${r.status} / ${r.conclusion ?? "pending"}`,
          `branch     : ${r.head_branch} @ ${short(r.head_sha)}`,
          `title      : ${firstLine(r.display_title, 100)}`,
          `event      : ${r.event} (attempt ${r.run_attempt})`,
          `started    : ${r.run_started_at}`,
          `url        : ${r.html_url}`,
        ].join("\n");
      }

      case "jobs": {
        const id = args.run_id ?? (await latestRunId(repo, args.branch));
        const jobs: any[] = (await ghJson(`${base}/runs/${id}/jobs?per_page=50`)).jobs ?? [];
        return jobs
          .map((j) => {
            const steps = (j.steps ?? [])
              .filter((s: any) => bad(s.conclusion))
              .map((s: any) => `        failed step ${s.number}: ${s.name}`)
              .join("\n");
            return `${verdict(j.conclusion, j.status)}  ${pad(j.id, 12)} ${j.name}${
              steps ? `\n${steps}` : ""
            }`;
          })
          .join("\n");
      }

      case "logs": {
        const options = {
          mode: args.mode as LogMode,
          tail: args.tail,
          context: args.context,
          grep: args.grep,
          stripTimestamps: args.strip_timestamps,
        };

        if (args.job_id) return jobLog(repo, args.job_id, options);

        const id = args.run_id ?? (await latestRunId(repo, args.branch));
        const run = await ghJson(`${base}/runs/${id}`);
        const all: any[] = (await ghJson(`${base}/runs/${id}/jobs?per_page=50`)).jobs ?? [];
        const wanted = (args.failed_only ? all.filter((j) => bad(j.conclusion)) : all).slice(
          0,
          args.max_jobs,
        );

        if (!wanted.length) {
          return `run ${id} (${run.conclusion}): no ${
            args.failed_only ? "failing " : ""
          }jobs. Pass failed_only:false to read passing jobs.`;
        }

        const sections: string[] = [
          `run ${id} — ${run.name} on ${run.head_branch} @ ${short(run.head_sha)} → ${run.conclusion}`,
          run.html_url,
        ];

        for (const job of wanted) {
          const failedSteps = (job.steps ?? [])
            .filter((s: any) => bad(s.conclusion))
            .map((s: any) => `  failed step ${s.number}: ${s.name} → ${s.conclusion}`)
            .join("\n");
          sections.push(
            `\n${"=".repeat(72)}\njob ${job.id} ${job.name} → ${job.conclusion}\n${
              failedSteps ? `${failedSteps}\n` : ""
            }${"=".repeat(72)}`,
          );
          try {
            sections.push(await jobLog(repo, job.id, options));
          } catch (error) {
            sections.push(`(log unavailable: ${(error as Error).message})`);
          }
        }
        return sections.join("\n");
      }

      case "download_logs": {
        const id = args.run_id ?? (await latestRunId(repo, args.branch));
        const dest = args.dest ?? path.join(os.tmpdir(), `run-${id}-logs.zip`);
        const bytes = await ghDownloadFile(`${base}/runs/${id}/logs`, dest);
        return `Wrote ${bytes.toLocaleString()} bytes to ${dest}. Unzip it with: unzip -o ${dest} -d ${dest}.d`;
      }

      case "rerun":
      case "rerun_failed": {
        assertGithubWritable("gh_actions");
        const id = args.run_id ?? (await latestRunId(repo, args.branch));
        const suffix = method === "rerun_failed" ? "rerun-failed-jobs" : "rerun";
        await ghSend(`${base}/runs/${id}/${suffix}`, "POST", {});
        audit("gh_actions_rerun", { repo, runId: id, method });
        return `Re-run requested for run ${id} (${suffix}).`;
      }

      case "cancel": {
        assertGithubWritable("gh_actions");
        const id = args.run_id ?? (await latestRunId(repo, args.branch));
        await ghSend(`${base}/runs/${id}/cancel`, "POST", {});
        audit("gh_actions_cancel", { repo, runId: id });
        return `Cancellation requested for run ${id}.`;
      }

      case "dispatch": {
        assertGithubWritable("gh_actions");
        if (!args.workflow) throw new Error("dispatch needs 'workflow', e.g. deploy.yml");
        const ref = args.ref ?? (await ghJson(`/repos/${repo}`)).default_branch;
        await ghSend(`${base}/workflows/${args.workflow}/dispatches`, "POST", {
          ref,
          ...(args.inputs ? { inputs: args.inputs } : {}),
        });
        audit("gh_actions_dispatch", { repo, workflow: args.workflow, ref });
        return `Dispatched ${args.workflow} on ${ref}. It takes a moment to appear; then run method:"runs".`;
      }

      case "workflows": {
        const list: any[] = (await ghJson(`${base}/workflows?per_page=100`)).workflows ?? [];
        return list
          .map((w) => `${pad(w.state, 18)} ${pad(w.id, 12)} ${pad(w.name, 26)} ${w.path}`)
          .join("\n");
      }

      case "artifacts": {
        const id = args.run_id ?? (await latestRunId(repo, args.branch));
        const list: any[] = (await ghJson(`${base}/runs/${id}/artifacts`)).artifacts ?? [];
        if (!list.length) return `Run ${id} produced no artifacts.`;
        return list
          .map(
            (a) =>
              `${pad(a.id, 12)} ${pad(a.name, 30)} ${(a.size_in_bytes / 1024).toFixed(0)} KB  expired=${a.expired}`,
          )
          .join("\n");
      }

      case "usage": {
        const id = args.run_id ?? (await latestRunId(repo, args.branch));
        const u = await ghJson(`${base}/runs/${id}/timing`);
        const ms = u.run_duration_ms ?? 0;
        return `run ${id}: ${(ms / 1000).toFixed(1)}s billable=${JSON.stringify(u.billable ?? {})}`;
      }
    }
  },
});

export const actionsTools = [ghActions];
