/**
 * Cloud provider account management for the panel.
 *
 * Mirrors github.ts: adding an account takes a credential and little else -
 * the provider's verify endpoint turns it into a display name, so there is
 * nothing to mistype. Unlike GitHub, a failed verify is not always fatal: a
 * 401/403 means the credential is bad, but an unreachable or unmapped verify
 * endpoint must not stop an operator from storing a credential they know is
 * good, so those land as "unverified" accounts.
 */
import { Router } from "express";
import { config } from "../config.js";
import { audit } from "../logger.js";
import {
  acceptsEmail,
  effectiveAuth,
  providerSpec,
  allProviderSpecs,
  type ProviderSpec,
} from "../providers/spec.js";
import { customProviderSpec } from "../providers/custom.js";
import { googleAccessToken, resolveTarget } from "../providers/request.js";
import {
  allAccounts,
  findAccount,
  defaultAccountId,
  removeAccount,
  rotateMcpToken,
  setAccountReadOnly,
  setDefaultAccount,
  slug,
  upsertAccount,
} from "../providers/store.js";

/** Dotted-path lookup into a decoded JSON body: "0.owner.email". Exported for tests. */
export function dig(value: unknown, path: string): string | undefined {
  let node: any = value;
  for (const part of path.split(".")) {
    if (node === null || node === undefined) return undefined;
    node = /^\d+$/.test(part) ? node[Number(part)] : node[part];
  }
  return typeof node === "string" && node ? node : undefined;
}

/** Metadata reaches agents; inspect string values without JSON escaping the secret. */
function metadataContainsCredential(value: unknown, token: string): boolean {
  if (typeof value === "string") return value.includes(token);
  if (Array.isArray(value))
    return value.some((item) => metadataContainsCredential(item, token));
  if (value && typeof value === "object")
    return Object.values(value).some((item) =>
      metadataContainsCredential(item, token),
    );
  return false;
}

/**
 * Validate a credential by calling the provider's verify endpoint with it.
 * Deliberately standalone - the account does not exist yet, so nothing here
 * can go through the account-selection machinery.
 */
async function verifyCredential(
  spec: ProviderSpec,
  token: string,
  extra?: Record<string, string>,
): Promise<{ verified: boolean; name?: string; status?: number }> {
  const style = effectiveAuth(spec, extra);
  const check = (spec.verify ?? []).find(
    (v) => !v.auth || v.auth === style.type,
  );
  if (!check) return { verified: false }; // no way to check: accept, marked unverified

  let headers: Record<string, string>;
  switch (style.type) {
    case "bearer":
      headers = { Authorization: `Bearer ${token}` };
      break;
    case "header":
      headers = {
        [style.header]: `${style.prefix ? style.prefix + " " : ""}${token}`,
      };
      break;
    case "email_key":
      headers = { "X-Auth-Email": extra?.email ?? "", "X-Auth-Key": token };
      break;
    case "google_sa":
      // A bad key file fails here, before it is stored. The cache key is
      // throwaway: nothing else will ever resolve "verify-*".
      headers = {
        Authorization: `Bearer ${await googleAccessToken(`verify-${Date.now()}`, token)}`,
      };
      break;
  }

  const response = await fetch(resolveTarget(spec, check.path), {
    method: check.method ?? "GET",
    redirect: "error",
    headers: {
      ...headers,
      Accept: "application/json",
      ...(spec.extraHeaders ?? {}),
      "User-Agent": `${config.serverName}/${config.version}`,
    },
    signal: AbortSignal.timeout(config.cloud.timeoutMs),
  });

  if (response.status === 401 || response.status === 403)
    return { verified: false, status: response.status };
  if (!response.ok) return { verified: false, status: response.status };

  let name: string | undefined;
  if (check.namePath) {
    try {
      name = dig(await response.json(), check.namePath);
    } catch {
      name = undefined;
    }
  }
  return { verified: true, name };
}

export function cloudApiRouter(): Router {
  const r = Router();
  // Signed-in panel sessions are enforced by the parent router. Mutations also
  // require the panel's own origin; credentials must never travel via a URL.
  r.use("/api/cloud", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.get("origin") !== `${req.protocol}://${req.get("host")}`
    ) {
      res
        .status(403)
        .json({ error: "Cloud settings must be submitted from this panel." });
      return;
    }
    next();
  });

  r.get("/api/cloud", (_req, res) => {
    res.json({
      providers: allProviderSpecs().map((spec) => ({
        id: spec.id,
        name: spec.name,
        baseUrl: spec.baseUrl,
        tokenLabel: spec.tokenLabel,
        tokenUrl: spec.tokenUrl,
        docsUrl: spec.docsUrl,
        needsEmail: acceptsEmail(spec),
        isServiceAccount: spec.auth.some((a) => a.type === "google_sa"),
      })),
      accounts: allAccounts().map((a) => ({
        id: a.id,
        provider: a.provider,
        name: a.name,
        slug: slug(a.name),
        readOnly: a.readOnly,
        verified: a.verified,
        createdAt: a.createdAt,
        isDefault: defaultAccountId(a.provider) === a.id,
      })),
    });
  });

  r.post("/api/cloud/accounts", async (req, res) => {
    const body = req.body ?? {};
    const providerId = String(body.provider ?? "").trim();
    const token = String(body.token ?? "").trim();
    const email = String(body.email ?? "").trim();
    const requestedName = String(body.name ?? "").trim();
    const readOnly = body.readOnly !== false;

    let spec: ProviderSpec;
    try {
      spec =
        providerId === "custom"
          ? customProviderSpec(body.custom)
          : providerSpec(providerId);
    } catch (error) {
      res.status(400).json({
        error:
          providerId === "custom"
            ? (error as Error).message
            : "Choose a supported provider or configure a Custom API.",
      });
      return;
    }
    if (!token) {
      res.status(400).json({ error: `${spec.tokenLabel} is required.` });
      return;
    }
    if (acceptsEmail(spec) === false && email) {
      res
        .status(400)
        .json({ error: `${spec.name} does not use an email field.` });
      return;
    }
    if (
      effectiveAuth(spec, email ? { email } : undefined).type === "email_key" &&
      !email
    ) {
      res.status(400).json({
        error: "A Cloudflare global API key needs the account email too.",
      });
      return;
    }

    if (effectiveAuth(spec).type !== "google_sa" && /[\r\n\x00]/.test(token)) {
      res.status(400).json({
        error:
          "An access token must be a single line without control characters.",
      });
      return;
    }
    // Metadata is returned to agents; never allow accidental credential pastes
    // into the account name, provider name, URL or header configuration.
    if (metadataContainsCredential([requestedName, email, spec], token)) {
      res.status(400).json({
        error:
          "Put the credential only in the secret token field, not in account or API settings.",
      });
      return;
    }
    try {
      const extra = email ? { email } : undefined;
      const check = await verifyCredential(spec, token, extra);
      if (check.status === 401 || check.status === 403) {
        res.status(400).json({
          error: `${spec.name} rejected that credential (${check.status}). It may be revoked or mistyped.`,
        });
        return;
      }

      if (check.name?.includes(token))
        throw new Error("Provider returned a credential as account metadata.");
      const name = requestedName || check.name || "default";
      const account = upsertAccount({
        provider: spec.id,
        name,
        token,
        ...(spec.id.startsWith("custom-") ? { customProvider: spec } : {}),
        extra,
        readOnly,
        verified: check.verified,
      });
      audit("cloud_account_added", {
        provider: spec.id,
        account: name,
        verified: check.verified,
      });
      res.json({
        ok: true,
        id: account.id,
        name: account.name,
        verified: check.verified,
      });
    } catch {
      // Verification happens before the credential is registered for redaction.
      // Upstream errors can echo it, so never return their raw text.
      res.status(400).json({
        error:
          "Could not verify or store this credential. Check its format, provider availability and server storage permissions.",
      });
    }
  });

  // Explicit operator-only copy action. Never included in page HTML, account
  // listings or MCP tool results. This bearer token is itself a secret.
  r.post("/api/cloud/accounts/:provider/:slug/mcp-token", (req, res) => {
    const account = findAccount(
      String(req.params.provider),
      String(req.params.slug),
    );
    if (!account) {
      res.status(404).json({ error: "No such account." });
      return;
    }
    res.json({ mcpToken: account.mcpToken });
  });

  r.delete("/api/cloud/accounts/:provider/:slug", (req, res) => {
    const removed = removeAccount(
      String(req.params.provider),
      String(req.params.slug),
    );
    if (!removed) {
      res.status(404).json({ error: "No such account." });
      return;
    }
    audit("cloud_account_removed", {
      provider: req.params.provider,
      slug: req.params.slug,
    });
    res.json({ ok: true });
  });

  r.post("/api/cloud/accounts/:provider/:slug/rotate", (req, res) => {
    try {
      rotateMcpToken(String(req.params.provider), String(req.params.slug));
      audit("cloud_token_rotated", {
        provider: req.params.provider,
        slug: req.params.slug,
      });
      res.json({ ok: true });
    } catch (error) {
      res.status(404).json({ error: (error as Error).message });
    }
  });

  r.post("/api/cloud/accounts/:provider/:slug/readonly", (req, res) => {
    try {
      const readOnly = Boolean((req.body ?? {}).readOnly);
      setAccountReadOnly(
        String(req.params.provider),
        String(req.params.slug),
        readOnly,
      );
      audit("cloud_readonly_changed", {
        provider: req.params.provider,
        slug: req.params.slug,
        readOnly,
      });
      res.json({ ok: true, readOnly });
    } catch (error) {
      res.status(404).json({ error: (error as Error).message });
    }
  });

  r.post("/api/cloud/accounts/:provider/:slug/default", (req, res) => {
    try {
      setDefaultAccount(String(req.params.provider), String(req.params.slug));
      res.json({ ok: true });
    } catch (error) {
      res.status(404).json({ error: (error as Error).message });
    }
  });

  return r;
}
