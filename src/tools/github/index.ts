import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools, type ToolSpec } from "../../tool.js";
import { currentAccount, defaultAccountName, knownProfileNames, withAccount } from "../../github/accounts.js";
import { DEFAULT_REPO } from "../../github/api.js";
import { metaTools } from "./meta.js";
import { actionsTools } from "./actions.js";
import { secretsTools } from "./secrets.js";
import { repoTools } from "./repo.js";
import { fileTools } from "./files.js";
import { commitTools } from "./commits.js";
import { issueTools } from "./issues.js";
import { pullTools } from "./pulls.js";
import { reviewTools } from "./reviews.js";
import { searchTools } from "./search.js";
import { securityTools } from "./security.js";
import { orgTools } from "./org.js";
import { ciTools } from "./ci.js";
import { watchTools } from "./watch.js";

/**
 * The GitHub tool surface, one module per subject.
 *
 * This was a single 1,241-line file. Splitting it by subject means editing the
 * secrets behaviour never risks touching pull requests, and any one file can be
 * read in full without spending most of a context window. To add a subject:
 * create the module, export an array of tools from it, and add it below.
 */

/** Tools that describe the accounts themselves, so they take no account. */
const NO_PROFILE = new Set(["gh_profiles"]);

/**
 * Give every GitHub tool a `profile` argument, in one place.
 *
 * The alternative was adding the same parameter to sixteen schemas and
 * remembering it in the seventeenth. Here the argument is added to the schema,
 * stripped back off before the tool body sees it, and used to pick the
 * credential for the duration of the call.
 *
 * The repo rewrite deserves a note. Each tool declares
 * `repo: z.string().default(DEFAULT_REPO)`, so by the time the body runs the
 * argument is always populated - there is no way for the body to tell "the
 * caller asked for this repo" from "the caller said nothing". Comparing against
 * DEFAULT_REPO recovers that distinction: if the value is still the baked-in
 * default, nobody chose it, and a profile carrying its own GITHUB_REPO_<NAME>
 * should supply it instead. An explicit repo argument always wins.
 */
function withProfile(spec: ToolSpec<any>): ToolSpec<any> {
  if (NO_PROFILE.has(spec.name)) return spec;

  const names = knownProfileNames();
  const choices = names.length ? ` One of: ${names.join(", ")}.` : "";
  const fallback = defaultAccountName() || "the configured token";

  return {
    ...spec,
    input: {
      ...spec.input,
      profile: z
        .string()
        .optional()
        .describe(
          `Which GitHub account to act as. Defaults to ${fallback}.${choices} ` +
            `A profile may carry its own default repo, which an explicit repo argument overrides.`,
        ),
    },
    run: (args: any) => {
      const { profile, ...rest } = args ?? {};
      return withAccount(profile, () => {
        const account = currentAccount();
        if (account.repo && typeof rest.repo === "string" && rest.repo === DEFAULT_REPO) {
          rest.repo = account.repo;
        }
        return spec.run(rest);
      });
    },
  };
}

export const githubTools = [
  ...metaTools,
  ...actionsTools,
  ...secretsTools,
  ...repoTools,
  ...fileTools,
  ...commitTools,
  ...issueTools,
  ...pullTools,
  ...reviewTools,
  ...searchTools,
  ...securityTools,
  ...orgTools,
  ...ciTools,
  ...watchTools,
].map(withProfile);

export function registerGithubTools(server: McpServer): void {
  registerTools(server, githubTools);
}
