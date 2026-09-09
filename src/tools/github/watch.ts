import { z } from "zod";
import { defineTool } from "../../tool.js";
import { DEFAULT_REPO, ghJson, qs } from "../../github/api.js";
import { bad } from "../../github/format.js";
import {
  finishedSummary,
  isFinished,
  sleepFor,
  stillRunning,
  type FailedStep,
  type RunFacts,
} from "../../github/watch-plan.js";

/**
 * Waiting for CI without the sleep-then-ask dance.
 *
 * The dance it replaces was: push, sleep for a guessed number of seconds, call
 * ci_status, discover the run was still queued, sleep again. Every guess is
 * either too short to be useful or longer than the wait actually needed.
 *
 * The one hard constraint is the client's request timeout - a tool that blocks
 * for ten minutes gets killed at sixty seconds and the caller learns nothing.
 * So this returns inside `wait_s` no matter what, and says plainly when the run
 * is still going. Resumable beats indefinite.
 */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function facts(run: any): RunFacts {
  return {
    id: run.id,
    name: run.name ?? "workflow",
    status: run.status ?? "unknown",
    conclusion: run.conclusion ?? null,
    headSha: String(run.head_sha ?? ""),
    branch: run.head_branch ?? "",
    title: String(run.display_title ?? "").split("\n")[0] ?? "",
    url: run.html_url ?? "",
  };
}

/**
 * The run to watch: a given id, the run for a particular commit, or simply the
 * newest on the branch. The sha case asks for more than one run because the
 * newest is not necessarily the one just pushed.
 */
async function findRun(
  repo: string,
  runId: number | undefined,
  branch: string | undefined,
  sha: string | undefined,
): Promise<RunFacts | null> {
  if (runId) return facts(await ghJson(`/repos/${repo}/actions/runs/${runId}`));

  const data = await ghJson(`/repos/${repo}/actions/runs${qs({ branch, per_page: sha ? 20 : 1 })}`);
  const runs: any[] = data.workflow_runs ?? [];
  const match = sha ? runs.find((run) => String(run.head_sha).startsWith(sha)) : runs[0];
  return match ? facts(match) : null;
}

/** Every failing step of every failing job, which is what a red run is asked about. */
async function failedSteps(repo: string, runId: number): Promise<FailedStep[]> {
  const jobs: any[] = (await ghJson(`/repos/${repo}/actions/runs/${runId}/jobs?per_page=30`)).jobs ?? [];
  const found: FailedStep[] = [];

  for (const job of jobs.filter((candidate) => bad(candidate.conclusion))) {
    const steps = (job.steps ?? []).filter((step: any) => bad(step.conclusion));

    if (!steps.length) {
      found.push({
        job: job.name,
        step: "(no step reported)",
        conclusion: job.conclusion,
        url: job.html_url,
      });
      continue;
    }

    for (const step of steps) {
      found.push({
        job: job.name,
        step: step.name,
        conclusion: step.conclusion,
        url: job.html_url,
      });
    }
  }

  return found;
}

export const ghWatch = defineTool({
  name: "gh_watch",
  title: "Wait for a workflow run to finish",
  description:
    "Block until a workflow run finishes, then report the verdict and the exact failing steps. " +
    "Use it straight after a push instead of sleeping and then calling ci_status: pass sha to wait " +
    "for one commit's run, which may not exist yet. It always returns within wait_s, because a call " +
    "that outlives the client's request timeout helps nobody - if the run is still going it says so, " +
    "and you call again.",
  readOnly: true,
  input: {
    repo: z.string().default(DEFAULT_REPO).describe("owner/name."),
    branch: z.string().default("main").describe("Branch to watch."),
    sha: z.string().optional().describe("Wait for this commit's run. Full or short sha."),
    run_id: z.number().int().optional().describe("Watch one specific run instead."),
    wait_s: z
      .number()
      .int()
      .min(5)
      .max(600)
      .default(45)
      .describe(
        "How long to block for. The default sits under the usual 60s client request timeout; " +
          "raise it only if you know the client allows longer.",
      ),
  },
  async run({ repo, branch, sha, run_id, wait_s }) {
    const budgetMs = wait_s * 1_000;
    const started = Date.now();
    let polls = 0;
    let latest: RunFacts | null = null;

    for (;;) {
      polls += 1;
      latest = await findRun(repo, run_id, branch, sha);
      const elapsed = Date.now() - started;

      if (latest && isFinished(latest)) {
        const failures = latest.conclusion === "success" ? [] : await failedSteps(repo, latest.id);
        return finishedSummary(latest, failures, elapsed);
      }

      const nap = sleepFor(elapsed, budgetMs);
      if (nap <= 0) return stillRunning(latest, elapsed, polls);
      await sleep(nap);
    }
  },
});

export const watchTools = [ghWatch];
