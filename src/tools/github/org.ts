import { z } from "zod";
import { defineTool } from "../../tool.js";
import { DEFAULT_REPO, ghJson, ghPaged, qs } from "../../github/api.js";
import { day, firstLine, pad } from "../../github/format.js";

/**
 * Organisations, teams and members.
 *
 * The configured repository belongs to a user account rather than an
 * organisation, so most of this returns nothing today. It exists so the server
 * does not need changing the moment the project moves under an org, which is
 * also when team-based review assignment starts to matter.
 */

function notAnOrg(name: string, error: unknown): string {
  const message = (error as Error).message;
  if (/\b404\b/.test(message)) {
    return `'${name}' is not an organisation (or is invisible to this token). User accounts have no teams or org-level settings.`;
  }
  return message;
}

export const ghOrg = defineTool({
  name: "gh_org",
  title: "Organisations, teams and members",
  description:
    "Inspect organisations the token can see, along with their teams, team members and repositories. " +
    "Team slugs from here are what gh_pulls needs for team_reviewers. A user-owned repository has no " +
    "organisation, and the tool says so plainly rather than failing.",
  readOnly: true,
  input: {
    method: z.enum(["list_orgs", "get", "teams", "team_members", "members", "repos", "memberships"]),
    org: z.string().optional().describe("Organisation login. Defaults to the configured repo owner."),
    team_slug: z.string().optional().describe("Team slug for 'team_members'."),
    role: z.enum(["all", "admin", "member"]).default("all"),
    limit: z.number().int().min(1).max(100).default(50),
  },
  async run({ method, org, team_slug, role, limit }) {
    const owner = org ?? DEFAULT_REPO.split("/")[0] ?? "";

    try {
      switch (method) {
        case "list_orgs": {
          const list: any[] = await ghJson(`/user/orgs${qs({ per_page: limit })}`);
          if (!list.length) {
            return "This token belongs to a user account that is not a member of any organisation.";
          }
          return list.map((o) => `${pad(o.login, 24)} ${firstLine(o.description, 50)}`).join("\n");
        }

        case "get": {
          const o = await ghJson(`/orgs/${owner}`);
          return [
            `${o.login} — ${o.name ?? ""}`,
            `plan        : ${o.plan?.name ?? "unknown"}`,
            `repos       : ${o.public_repos} public, ${o.total_private_repos ?? "?"} private`,
            `members can : create repos=${o.members_can_create_repositories}`,
            `created     : ${day(o.created_at)}`,
          ].join("\n");
        }

        case "teams": {
          const list = await ghPaged(`/orgs/${owner}/teams`, { maxPages: 2 });
          if (!list.length) return `${owner} has no teams.`;
          return list
            .map((t: any) => `${pad(t.slug, 24)} ${pad(t.privacy, 10)} ${firstLine(t.description, 44)}`)
            .join("\n");
        }

        case "team_members": {
          if (!team_slug) throw new Error("team_members needs 'team_slug'.");
          const list = await ghPaged(`/orgs/${owner}/teams/${team_slug}/members`, { maxPages: 2 });
          return list.map((m: any) => `${pad(m.login, 24)} ${m.type}`).join("\n") || "No members.";
        }

        case "members": {
          const list = await ghPaged(`/orgs/${owner}/members${qs({ role })}`, { maxPages: 2 });
          return list.map((m: any) => `${pad(m.login, 24)} ${m.type}`).join("\n") || "No members.";
        }

        case "repos": {
          const list: any[] = await ghJson(`/orgs/${owner}/repos${qs({ per_page: limit, sort: "pushed" })}`);
          return list
            .map((r) => `${pad(r.full_name, 44)} ${r.private ? "private" : "public "} ${day(r.pushed_at)}`)
            .join("\n");
        }

        case "memberships": {
          const m = await ghJson(`/user/memberships/orgs/${owner}`);
          return `${owner}: role=${m.role} state=${m.state}`;
        }
      }
    } catch (error) {
      return notAnOrg(owner, error);
    }
  },
});

export const orgTools = [ghOrg];
