/**
 * The pure half of `gh_watch`.
 *
 * Waiting for CI is mostly arithmetic: when to ask again, when to stop, and how
 * to report what happened. None of that needs a token or a network, so it lives
 * here where it can be tested without either - the same reason `atomic-write.ts`
 * and `parseToolArgs` were pulled out of the modules that use them.
 */

export type RunFacts = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  headSha: string;
  branch: string;
  title: string;
  url: string;
};

export type FailedStep = {
  job: string;
  step: string;
  conclusion: string;
  url?: string;
};

/** GitHub sets a conclusion only once the run is over. */
export function isFinished(run: { status?: string | null; conclusion?: unknown }): boolean {
  return run.status === "completed" || Boolean(run.conclusion);
}

/**
 * Ask often at first, then less: the interval doubles every 30 seconds between
 * a floor and a ceiling. A run that started two seconds ago is worth checking
 * again soon; one that has been going five minutes will not finish in the next
 * three, and polling it hard only spends rate limit.
 */
export function nextDelayMs(elapsedMs: number, floor = 3_000, ceiling = 15_000): number {
  const doublings = Math.floor(Math.max(elapsedMs, 0) / 30_000);
  return Math.min(floor * 2 ** doublings, ceiling);
}

/**
 * How long to sleep before the next poll, never past the budget. A caller who
 * asked for 45 seconds should get an answer at 45 seconds, not at whatever the
 * next multiple of the poll interval happens to land on.
 */
export function sleepFor(elapsedMs: number, budgetMs: number): number {
  const remaining = budgetMs - elapsedMs;
  if (remaining <= 0) return 0;
  return Math.min(nextDelayMs(elapsedMs), remaining);
}

const seconds = (ms: number): string => `${Math.round(ms / 1000)}s`;

/** The verdict, plus the steps that broke when there are any. */
export function finishedSummary(run: RunFacts, failures: FailedStep[], elapsedMs: number): string {
  const mark = run.conclusion === "success" ? "pass" : run.conclusion === "skipped" ? "skip" : "FAIL";
  const lines = [
    `${mark}  ${run.headSha.slice(0, 7)}  ${run.name} - ${run.conclusion} after ${seconds(elapsedMs)} of waiting`,
    run.title,
    run.url,
  ];

  for (const failure of failures) {
    lines.push(`  ${failure.job} / ${failure.step} -> ${failure.conclusion}`);
  }

  if (failures.length) {
    lines.push("For the error text itself: gh_actions method=logs.");
  } else if (mark === "FAIL") {
    lines.push("No failing step was reported. gh_actions method=logs has the output.");
  }

  return lines.join("\n");
}

/**
 * The answer when the budget runs out first. This is an ordinary outcome rather
 * than an error: the tool promises to return inside `wait_s`, so it has to be
 * able to say "not yet" in a form the caller can act on.
 */
export function stillRunning(run: RunFacts | null, elapsedMs: number, polls: number): string {
  if (!run) {
    return [
      `No run found yet after ${seconds(elapsedMs)} (${polls} checks).`,
      "A run takes a moment to appear after a push. Call gh_watch again.",
    ].join("\n");
  }

  return [
    `${run.status}  ${run.headSha.slice(0, 7)}  ${run.name} - still going after ${seconds(elapsedMs)} (${polls} checks)`,
    run.title,
    run.url,
    "Not finished. Call gh_watch again to keep waiting.",
  ].join("\n");
}
