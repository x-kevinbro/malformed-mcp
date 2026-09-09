import { z } from "zod";
import { defineTool } from "../../tool.js";
import { assertGithubWritable } from "../../result.js";
import { audit } from "../../logger.js";
import { DEFAULT_REPO, gh, ghJson, ghSend, sealSecret } from "../../github/api.js";
import { day, pad } from "../../github/format.js";

/**
 * Actions secrets, variables and environments.
 *
 * Secrets are write-only: GitHub never returns a value, so 'list' shows names
 * and timestamps only. Writing one requires encrypting it against the
 * repository's public key with a libsodium sealed box, which is handled here so
 * callers never deal with the crypto.
 */

type Scope = "repo" | "environment" | "org" | "dependabot" | "codespaces";

/** Each scope keeps its secrets under a different base path. */
function scopeBase(scope: Scope, repo: string, org?: string, environment?: string): string {
  switch (scope) {
    case "repo":
      return `/repos/${repo}/actions`;
    case "dependabot":
      return `/repos/${repo}/dependabot`;
    case "codespaces":
      return `/repos/${repo}/codespaces`;
    case "org": {
      const owner = org ?? repo.split("/")[0];
      return `/orgs/${owner}/actions`;
    }
    case "environment": {
      if (!environment) throw new Error("scope 'environment' needs the 'environment' argument.");
      return `/repos/${repo}/environments/${encodeURIComponent(environment)}`;
    }
  }
}

export const ghSecrets = defineTool({
  name: "gh_secrets",
  title: "Actions secrets, variables and environments",
  description:
    "Read and write GitHub Actions secrets and variables at repository, environment, organisation, " +
    "Dependabot or Codespaces scope. Secret values are encrypted with a libsodium sealed box before " +
    "upload, as the API requires. Values can never be read back — 'list' returns names and " +
    "timestamps, which is enough to confirm a secret exists and when it was last rotated.",
  input: {
    method: z.enum([
      "list",
      "set",
      "delete",
      "public_key",
      "list_variables",
      "get_variable",
      "set_variable",
      "delete_variable",
      "environments",
    ]),
    repo: z.string().default(DEFAULT_REPO),
    scope: z.enum(["repo", "environment", "org", "dependabot", "codespaces"]).default("repo"),
    org: z.string().optional().describe("Organisation for scope 'org'. Defaults to the repo owner."),
    environment: z.string().optional().describe("Environment name for scope 'environment'."),
    name: z.string().optional().describe("Secret or variable name. Conventionally UPPER_SNAKE_CASE."),
    value: z.string().optional().describe("Plaintext value; it is encrypted before it leaves the box."),
    visibility: z.enum(["all", "private", "selected"]).optional().describe("Organisation secrets only."),
  },
  async run({ method, repo, scope, org, environment, name, value, visibility }) {
    const base = scopeBase(scope as Scope, repo, org, environment);

    switch (method) {
      case "list": {
        const data = await ghJson(`${base}/secrets?per_page=100`);
        const secrets: any[] = data.secrets ?? [];
        if (!secrets.length) return `No secrets at ${scope} scope.`;
        return [
          `${secrets.length} secret(s) at ${scope} scope (values are never readable):`,
          ...secrets.map((s) => `  ${pad(s.name, 32)} updated ${day(s.updated_at)}`),
        ].join("\n");
      }

      case "public_key": {
        const key = await ghJson(`${base}/secrets/public-key`);
        return `key_id=${key.key_id}\nkey=${key.key}`;
      }

      case "set": {
        assertGithubWritable("gh_secrets");
        if (!name || value === undefined) throw new Error("set needs both 'name' and 'value'.");
        const key = await ghJson(`${base}/secrets/public-key`);
        const encrypted = await sealSecret(value, key.key);
        const response = await ghSend(`${base}/secrets/${encodeURIComponent(name)}`, "PUT", {
          encrypted_value: encrypted,
          key_id: key.key_id,
          ...(visibility ? { visibility } : {}),
        });
        // Name and scope only. The value must never reach the audit log.
        audit("gh_secret_set", { repo, scope, name, status: response.status });
        return `${response.status === 201 ? "Created" : "Updated"} secret ${name} at ${scope} scope.`;
      }

      case "delete": {
        assertGithubWritable("gh_secrets");
        if (!name) throw new Error("delete needs 'name'.");
        await gh(`${base}/secrets/${encodeURIComponent(name)}`, { method: "DELETE" });
        audit("gh_secret_delete", { repo, scope, name });
        return `Deleted secret ${name} from ${scope} scope.`;
      }

      case "list_variables": {
        const data = await ghJson(`${base}/variables?per_page=100`);
        const variables: any[] = data.variables ?? [];
        if (!variables.length) return `No variables at ${scope} scope.`;
        return variables.map((v) => `  ${pad(v.name, 28)} = ${v.value}`).join("\n");
      }

      case "get_variable": {
        if (!name) throw new Error("get_variable needs 'name'.");
        const v = await ghJson(`${base}/variables/${encodeURIComponent(name)}`);
        return `${v.name} = ${v.value}  (updated ${day(v.updated_at)})`;
      }

      case "set_variable": {
        assertGithubWritable("gh_secrets");
        if (!name || value === undefined) throw new Error("set_variable needs 'name' and 'value'.");
        // PATCH updates an existing variable; POST creates one. Try the update
        // first and fall back, so callers need not know which case they are in.
        try {
          await ghSend(`${base}/variables/${encodeURIComponent(name)}`, "PATCH", { name, value });
          audit("gh_variable_set", { repo, scope, name, created: false });
          return `Updated variable ${name}.`;
        } catch {
          await ghSend(`${base}/variables`, "POST", { name, value });
          audit("gh_variable_set", { repo, scope, name, created: true });
          return `Created variable ${name}.`;
        }
      }

      case "delete_variable": {
        assertGithubWritable("gh_secrets");
        if (!name) throw new Error("delete_variable needs 'name'.");
        await gh(`${base}/variables/${encodeURIComponent(name)}`, { method: "DELETE" });
        audit("gh_variable_delete", { repo, scope, name });
        return `Deleted variable ${name}.`;
      }

      case "environments": {
        const data = await ghJson(`/repos/${repo}/environments`);
        const envs: any[] = data.environments ?? [];
        if (!envs.length) return "No environments configured.";
        return envs
          .map((e) => {
            const rules = (e.protection_rules ?? []).map((r: any) => r.type).join(", ") || "none";
            return `${pad(e.name, 22)} protection: ${rules}`;
          })
          .join("\n");
      }
    }
  },
});

export const secretsTools = [ghSecrets];
