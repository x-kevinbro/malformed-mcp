/**
 * GitHub profile management for the panel.
 *
 * Adding an account takes a token and nothing else: /user turns it into a
 * login, display name, avatar and type, so there is no name to invent and no
 * way to mistype it. Repositories are listed through the normal api.ts stack
 * under withAccount(), which means rate limiting, retries and redaction all
 * apply exactly as they do for the gh_* tools.
 *
 * Clones live at profiles/<login>/<repo>_work, inside this folder like
 * everything else.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { Router } from "express";
import { config } from "../config.js";
import { audit } from "../logger.js";
import { withAccount } from "../github/accounts.js";
import { ghPaged } from "../github/api.js";
import {
  allProfiles,
  findProfile,
  profileDir,
  removeProfile,
  rotateMcpToken,
  safeSegment,
  setDefaultLogin,
  upsertProfile,
  workDir,
} from "../github/store.js";

const run = promisify(execFile);

/**
 * Validate a token by asking GitHub who it belongs to.
 *
 * This deliberately does not go through api.ts: that resolves its credential
 * from the active profile, and the whole point here is that the profile does
 * not exist yet.
 */
async function identify(token: string): Promise<{
  login: string;
  name: string;
  email?: string;
  avatarUrl?: string;
  type?: string;
}> {
  const response = await fetch(`${config.github.apiUrl}/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": config.github.apiVersion,
      "User-Agent": `${config.serverName}/${config.version}`,
    },
    signal: AbortSignal.timeout(config.github.timeoutMs),
  });

  if (response.status === 401)
    throw new Error("GitHub rejected that token (401). It may be revoked or mistyped.");
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for /user.`);

  const body = (await response.json()) as Record<string, any>;
  if (!body?.login) throw new Error("GitHub did not return a login for that token.");
  return {
    login: String(body.login),
    name: String(body.name ?? body.login),
    email: body.email ? String(body.email) : undefined,
    avatarUrl: body.avatar_url ? String(body.avatar_url) : undefined,
    type: body.type ? String(body.type) : undefined,
  };
}

/**
 * Clone over HTTPS without the token ever appearing in a command line.
 *
 * Embedding it in the URL would put a live credential in argv, where any other
 * process on the box can read it from /proc, and in any error message git
 * prints. A credential helper reads it from the environment of that one child
 * process instead.
 */
async function gitClone(cloneUrl: string, token: string, destination: string): Promise<void> {
  const helper = "!f(){ echo username=x-access-token; echo password=$MALFORMEDMCP_GH_TOKEN; };f";
  await run("git", ["-c", "credential.helper=", "-c", `credential.helper=${helper}`, "clone", "--", cloneUrl, destination], {
    env: { ...process.env, MALFORMEDMCP_GH_TOKEN: token, GIT_TERMINAL_PROMPT: "0" },
    timeout: 600_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

function dirSize(target: string): string {
  try {
    return statSync(target).isDirectory() ? "present" : "-";
  } catch {
    return "-";
  }
}

export function githubApiRouter(): Router {
  const r = Router();

  r.get("/api/profiles", (_req, res) => {
    res.json({
      profiles: allProfiles().map((p) => ({
        login: p.login,
        name: p.name,
        type: p.type,
        email: p.email,
        avatarUrl: p.avatarUrl,
        repo: p.repo,
        createdAt: p.createdAt,
        // The MCP token is meant to be copied out and handed to an agent, so
        // unlike the GitHub token it is returned to a signed-in operator.
        mcpToken: p.mcpToken,
        workspace: path.relative(config.profilesDir, profileDir(p.login)),
      })),
    });
  });

  r.post("/api/profiles", async (req, res) => {
    const token = String((req.body ?? {}).token ?? "").trim();
    if (!token) {
      res.status(400).json({ error: "A GitHub personal access token is required." });
      return;
    }
    try {
      const who = await identify(token);
      const profile = upsertProfile({
        login: who.login,
        name: who.name,
        token,
        repo: String((req.body ?? {}).repo ?? "").trim(),
        email: who.email,
        avatarUrl: who.avatarUrl,
        type: who.type,
      });
      mkdirSync(profileDir(profile.login), { recursive: true });
      audit("profile_added", { login: profile.login });
      res.json({ ok: true, login: profile.login, mcpToken: profile.mcpToken });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  r.delete("/api/profiles/:login", (req, res) => {
    const login = String(req.params.login);
    const removed = removeProfile(login);
    if (!removed) {
      res.status(404).json({ error: "No such profile." });
      return;
    }
    // Removing a profile also removes its profiles/<login>/ folder, so no
    // credential-era artifacts or working trees linger after the account is
    // gone. The panel's confirm dialog warns that checkouts go with it. A
    // deletion is worth a second check that the resolved path really is
    // inside the profiles directory.
    let workspaceDeleted = false;
    try {
      const resolved = path.resolve(profileDir(login));
      if (resolved.startsWith(path.resolve(config.profilesDir) + path.sep) && existsSync(resolved)) {
        rmSync(resolved, { recursive: true, force: true });
        workspaceDeleted = true;
      }
    } catch {
      // The profile record is already gone; a failed folder cleanup must not
      // report the whole deletion as failed. The leftover stays visible on disk.
    }
    audit("profile_removed", { login, workspaceDeleted });
    res.json({ ok: true, workspaceDeleted });
  });

  r.post("/api/profiles/:login/rotate", (req, res) => {
    try {
      const mcpToken = rotateMcpToken(String(req.params.login));
      audit("profile_token_rotated", { login: req.params.login });
      res.json({ ok: true, mcpToken });
    } catch (error) {
      res.status(404).json({ error: (error as Error).message });
    }
  });

  r.post("/api/profiles/:login/default", (req, res) => {
    try {
      setDefaultLogin(String(req.params.login));
      res.json({ ok: true });
    } catch (error) {
      res.status(404).json({ error: (error as Error).message });
    }
  });

  /**
   * Change the default repository without re-supplying the GitHub token.
   *
   * The credential is already stored, and demanding it again to edit one text
   * field trains the operator to paste live tokens for trivial reasons.
   */
  r.post("/api/profiles/:login/repo", (req, res) => {
    const login = String(req.params.login);
    const profile = findProfile(login);
    if (!profile) {
      res.status(404).json({ error: "No such profile." });
      return;
    }
    const repo = String((req.body ?? {}).repo ?? "").trim();
    if (repo && !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
      res.status(400).json({ error: "A default repository looks like owner/name." });
      return;
    }
    upsertProfile({ ...profile, repo });
    audit("profile_repo_changed", { login, repo });
    res.json({ ok: true, repo });
  });

  r.get("/api/profiles/:login/repos", async (req, res) => {
    const login = String(req.params.login);
    if (!findProfile(login)) {
      res.status(404).json({ error: "No such profile." });
      return;
    }
    try {
      const repos = await withAccount(login, () =>
        ghPaged("/user/repos?sort=updated&affiliation=owner,collaborator,organization_member", {
          perPage: 100,
          maxPages: 5,
        }),
      );
      res.json({
        repos: repos.map((repo: any) => {
          const target = workDir(login, String(repo.name));
          return {
            name: String(repo.name),
            fullName: String(repo.full_name),
            private: Boolean(repo.private),
            defaultBranch: String(repo.default_branch ?? ""),
            updatedAt: String(repo.updated_at ?? ""),
            cloneUrl: String(repo.clone_url ?? ""),
            cloned: existsSync(target),
            workDir: path.relative(config.profilesDir, target),
          };
        }),
      });
    } catch (error) {
      res.status(502).json({ error: (error as Error).message });
    }
  });

  r.post("/api/profiles/:login/clone", async (req, res) => {
    const login = String(req.params.login);
    const profile = findProfile(login);
    if (!profile) {
      res.status(404).json({ error: "No such profile." });
      return;
    }
    const repo = String((req.body ?? {}).repo ?? "").trim();
    const cloneUrl = String((req.body ?? {}).cloneUrl ?? "").trim();
    if (!repo || !cloneUrl) {
      res.status(400).json({ error: "repo and cloneUrl are required." });
      return;
    }
    // Only ever clone from GitHub itself: cloneUrl arrives over HTTP, and an
    // arbitrary URL here would send the profile's token to whoever asked.
    if (!/^https:\/\/github\.com\//.test(cloneUrl)) {
      res.status(400).json({ error: "Only https://github.com/ clone URLs are accepted." });
      return;
    }

    const target = workDir(login, repo);
    try {
      if (existsSync(target)) {
        res.status(409).json({ error: `Already cloned at ${path.relative(config.profilesDir, target)}.` });
        return;
      }
      mkdirSync(path.dirname(target), { recursive: true });
      await gitClone(cloneUrl, profile.token, target);
      audit("repo_cloned", { login, repo });
      res.json({ ok: true, workDir: path.relative(config.profilesDir, target) });
    } catch (error) {
      try {
        if (existsSync(target)) {
          rmSync(target, { recursive: true, force: true });
        }
      } catch {
        // Ignore cleanup failure
      }
      let message = (error as Error).message.replaceAll(profile.token, "[redacted]");
      if (message.includes("Repository not found") || message.includes("not found")) {
        message += "\nTip: For private repositories, verify your token has 'repo' scope (Classic) or 'Contents: Read/Write' permission for this repo (Fine-grained).";
      }
      res.status(500).json({ error: message.slice(0, 500) });
    }
  });

  r.post("/api/profiles/:login/rename", (req, res) => {
    const login = String(req.params.login);
    const from = String((req.body ?? {}).from ?? "");
    const to = String((req.body ?? {}).to ?? "");
    try {
      const source = workDir(login, from);
      const destination = workDir(login, to);
      if (!existsSync(source)) {
        res.status(404).json({ error: "That working tree does not exist." });
        return;
      }
      if (existsSync(destination)) {
        res.status(409).json({ error: "A working tree with that name already exists." });
        return;
      }
      renameSync(source, destination);
      audit("repo_renamed", { login, from, to });
      res.json({ ok: true, workDir: path.relative(config.profilesDir, destination) });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  r.delete("/api/profiles/:login/work/:repo", (req, res) => {
    const login = String(req.params.login);
    const repo = String(req.params.repo);
    try {
      const target = workDir(login, repo);
      // safeSegment already refuses traversal, but a deletion is worth a second
      // check that the resolved path really is inside the profiles directory.
      const resolved = path.resolve(target);
      if (!resolved.startsWith(path.resolve(config.profilesDir) + path.sep)) {
        res.status(400).json({ error: "Refusing to delete outside the profiles directory." });
        return;
      }
      if (!existsSync(resolved)) {
        res.status(404).json({ error: "That working tree does not exist." });
        return;
      }
      rmSync(resolved, { recursive: true, force: true });
      audit("repo_workdir_deleted", { login, repo });
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  return r;
}

export { dirSize, safeSegment };
