import { z } from "zod";
import { defineTool } from "../../tool.js";
import { DEFAULT_REPO, ghJson, qs } from "../../github/api.js";
import { bad, firstLine, short, verdict } from "../../github/format.js";

/**
 * The quick CI verdict. This used to carry its own copy of the GitHub fetch
 * logic, including a second way of reading the token; it now shares the client
 * in src/github/, so authentication, retries and error messages behave the same
 * here as everywhere else. For the actual failing log lines, use gh_actions.
 *
 * It lived in tools/code.ts, and so loaded with the `code` category, until it
 * turned out that nobody looks for a CI verdict among the file readers - the
 * author included, twice in one session.
 */
const ciStatus = defineTool({
  name: "ci_status",
  title: "GitHub Actions verdict, with the failing steps",
  description:
    "Answer 'did the build pass' in one call. Lists the most recent workflow runs for a branch and, " +
    "for any that failed, names the exact steps that broke. Use this after pushing. When you need " +
    'the error text itself rather than the verdict, use gh_actions method="logs".',
  readOnly: true,
  input: {
    repo: z.string().default(DEFAULT_REPO).describe("owner/name."),
    branch: z.string().default("main").describe("Branch to report on."),
    limit: z.number().int().min(1).max(20).default(5).describe("How many recent runs to list."),
    detail_failures: z.boolean().default(true).describe("Drill into failing jobs and steps."),
  },
  async run({ repo, branch, limit, detail_failures }) {
    const data = await ghJson(`/repos/${repo}/actions/runs${qs({ branch, per_page: limit })}`);
    const runs: any[] = data.workflow_runs ?? [];
    if (!runs.length) return `No workflow runs found on ${branch} of ${repo}.`;

    const lines = runs.map((run) => {
      const outcome = run.status === "completed" ? run.conclusion : run.status;
      return `${verdict(run.conclusion, run.status)}  ${short(run.head_sha)}  ${run.name} — ${outcome}  ${firstLine(
        run.display_title,
        60,
      )}`;
    });

    if (detail_failures) {
      for (const run of runs.filter((r) => bad(r.conclusion)).slice(0, 3)) {
        const jobs: any[] =
          (await ghJson(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=30`)).jobs ?? [];

        for (const job of jobs.filter((j) => bad(j.conclusion))) {
          const steps = (job.steps ?? [])
            .filter((step: any) => bad(step.conclusion))
            .map((step: any) => `        step ${step.number}: ${step.name} → ${step.conclusion}`);
          lines.push(
            `\n  ${run.name} / ${job.name} → ${job.conclusion}\n` +
              (steps.length ? `${steps.join("\n")}\n` : "") +
              `        ${job.html_url}`,
          );
        }
      }
    }

    return lines.join("\n");
  },
});

export const ciTools = [ciStatus];
