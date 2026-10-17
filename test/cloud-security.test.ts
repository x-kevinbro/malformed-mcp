import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Script } from "node:vm";
import express from "express";
import { config } from "../src/config.js";
import { customProviderSpec } from "../src/providers/custom.js";
import { allProviderSpecs, providerSpec } from "../src/providers/spec.js";
import {
  authHeaders,
  cloudFetch,
  resolveTarget,
} from "../src/providers/request.js";
import { findAccount, upsertAccount } from "../src/providers/store.js";
import {
  withLockedCloudAccount,
  resolveAccount,
  visibleAccounts,
} from "../src/providers/accounts.js";
import { redactSecrets, resetRedactionCache } from "../src/redact.js";
import { panelRouter } from "../src/panel/routes.js";
import { issueSession, SESSION_COOKIE } from "../src/panel/auth.js";
import { ok, fail } from "../src/result.js";
import { cloudPageContent } from "../src/panel/cloud-page.js";

const dir = mkdtempSync(path.join(tmpdir(), "cloud-security-"));
config.providerStore = path.join(dir, "providers.json");
config.panel.store = path.join(dir, "panel.json");
const api = express();
api.use(express.json());
api.use(panelRouter());
const server = api.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}`;
const cookie = `${SESSION_COOKIE}=${issueSession()}`;
const nativeFetch = globalThis.fetch;
const secret = "opaque-custom-credential-for-testing";
const custom = {
  id: "example",
  name: "Example",
  baseUrl: "https://api.example.com/v1",
  auth: "bearer",
};
async function request(route: string, body?: unknown, origin = base) {
  return nativeFetch(base + route, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Cookie: cookie,
      Origin: origin,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "manual",
  });
}
test.after(async () => {
  globalThis.fetch = nativeFetch;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  rmSync(dir, { recursive: true, force: true });
});

test("cloud settings require a signed-in panel session", async () => {
  assert.equal((await nativeFetch(base + "/api/cloud")).status, 401);
  assert.equal(
    (await nativeFetch(base + "/cloud", { redirect: "manual" })).status,
    302,
  );
});

test("cross-origin and missing-origin token submissions are refused", async () => {
  assert.equal(
    (
      await request(
        "/api/cloud/accounts",
        { provider: "custom", token: secret, custom },
        "https://evil.example",
      )
    ).status,
    403,
  );
  const missing = await nativeFetch(base + "/api/cloud/accounts", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(missing.status, 403);
});

test("custom credentials are stored privately, listed without secrets and default read-only", async () => {
  resetRedactionCache();
  redactSecrets("warm the redaction cache before adding a credential");
  const response = await request("/api/cloud/accounts", {
    provider: "custom",
    token: secret,
    custom,
    name: "production",
  });
  assert.equal(response.status, 200);
  const added = (await response.json()) as any;
  assert.equal(added.verified, false);
  assert.equal(added.mcpToken, undefined);
  const account = findAccount("custom-example", "production")!;
  assert.equal(account.token, secret);
  assert.equal(account.readOnly, true);
  assert.equal(statSync(config.providerStore).mode & 0o777, 0o600);
  assert.ok(allProviderSpecs().some((p) => p.id === "custom-example"));
  const listing = await request("/api/cloud");
  assert.equal(listing.headers.get("cache-control"), "no-store");
  const text = await listing.text();
  assert.ok(!text.includes(secret));
  assert.ok(!text.includes(account.mcpToken));
  assert.equal(
    redactSecrets(`echo ${secret}`),
    "echo [redacted:config-secret]",
    "new tokens are redacted immediately, without cache reset",
  );
});

test("custom API destinations cannot be broadened or silently redefined", () => {
  const spec = providerSpec("custom-example");
  assert.equal(
    resolveTarget(spec, "/files"),
    "https://api.example.com/v1/files",
  );
  for (const url of [
    "http://api.example.com/files",
    "https://evil.example/files",
    "https://api.example.com:9443/files",
    "https://user:password@api.example.com/files",
  ]) {
    assert.throws(() => resolveTarget(spec, url));
  }
  assert.throws(
    () =>
      customProviderSpec({ ...custom, baseUrl: "https://other.example.com" }),
    /already has different settings/,
  );
  for (const baseUrl of [
    "http://api.example.com",
    "https://user:password@api.example.com",
    "https://api.example.com?token=abc",
    "https://127.0.0.1",
    "https://[::1]",
    "https://localhost",
  ]) {
    assert.throws(() => customProviderSpec({ ...custom, baseUrl }));
  }
  for (const header of ["Host", "Cookie", "Authorization\r\nX-Evil"]) {
    assert.throws(() =>
      customProviderSpec({ ...custom, auth: "header", header }),
    );
  }
});

test("account-scoped MCP sessions stay scoped for custom APIs", () => {
  const first = findAccount("custom-example", "production")!;
  upsertAccount({
    ...first,
    name: "other",
    token: "another-opaque-credential",
  });
  withLockedCloudAccount(first.id, () => {
    assert.equal(visibleAccounts().length, 1);
    assert.equal(resolveAccount(first.provider).id, first.id);
    assert.throws(() => resolveAccount(first.provider, "other"));
    assert.throws(
      () => resolveAccount("custom-hidden-provider"),
      /No cloud account is available/,
    );
    assert.throws(
      () => resolveAccount("koyeb"),
      /No cloud account is available/,
    );
  });
});

test("API-key headers support raw values and optional authentication schemes", async () => {
  const account = findAccount("custom-example", "production")!;
  const raw = customProviderSpec({
    id: "raw",
    name: "Raw",
    baseUrl: "https://api.raw.example",
    auth: "header",
    header: "X-API-Key",
  });
  assert.deepEqual(await authHeaders(raw, account), { "X-API-Key": secret });
  const prefixed = customProviderSpec({
    id: "prefixed",
    name: "Prefixed",
    baseUrl: "https://api.prefixed.example",
    auth: "header",
    header: "Authorization",
    prefix: "Token",
  });
  assert.deepEqual(await authHeaders(prefixed, account), {
    Authorization: `Token ${secret}`,
  });
});

test("MCP connection tokens are returned only by an explicit private copy action", async () => {
  const account = findAccount("custom-example", "production")!;
  const route = "/api/cloud/accounts/custom-example/production";
  const copied = await request(route + "/mcp-token", {});
  assert.equal(((await copied.json()) as any).mcpToken, account.mcpToken);
  const rotated = await request(route + "/rotate", {});
  assert.deepEqual(await rotated.json(), { ok: true });
  assert.notEqual(
    findAccount("custom-example", "production")!.mcpToken,
    account.mcpToken,
  );
});

test("rotated and short opaque provider credentials are redacted immediately", async () => {
  const response = await request("/api/cloud/accounts", {
    provider: "custom-example",
    name: "production",
    token: "Q7!z",
  });
  assert.equal(response.status, 200);
  assert.equal(redactSecrets("echo Q7!z"), "echo [redacted:config-secret]");
});

test("credentials containing quotes or backslashes cannot leak as metadata or JSON-escaped output", async () => {
  const escaped = 'opaque-"quoted"-\\credential';
  const rejected = await request("/api/cloud/accounts", {
    provider: "custom-example",
    name: escaped,
    token: escaped,
  });
  assert.equal(rejected.status, 400);
  assert.ok(
    !(await rejected.text()).includes(JSON.stringify(escaped).slice(1, -1)),
  );
  const saved = await request("/api/cloud/accounts", {
    provider: "custom-example",
    name: "escaped",
    token: escaped,
  });
  assert.equal(saved.status, 200);
  const json = redactSecrets(JSON.stringify({ token: escaped }));
  assert.ok(!json.includes(JSON.stringify(escaped).slice(1, -1)));
  assert.equal(
    redactSecrets(encodeURIComponent(escaped)),
    "[redacted:config-secret]",
  );
});

test("stored credentials never reach MCP output even when heuristic redaction is disabled", () => {
  const previous = config.redactOutput;
  config.redactOutput = false;
  try {
    const account = findAccount("custom-example", "production")!;
    for (const render of [ok, fail]) {
      const output = JSON.stringify(
        render(`echo ${account.token} ${account.mcpToken}`),
      );
      assert.ok(!output.includes(account.token));
      assert.ok(!output.includes(account.mcpToken));
      assert.match(output, /redacted:config-secret/);
    }
  } finally {
    config.redactOutput = previous;
  }
});

test("verification errors cannot echo a not-yet-stored credential", async () => {
  const fresh = "fresh-credential-never-stored";
  globalThis.fetch = (async () => {
    throw new Error(`upstream echoed ${fresh}`);
  }) as typeof fetch;
  try {
    const r = await request("/api/cloud/accounts", {
      provider: "vercel",
      token: fresh,
    });
    assert.equal(r.status, 400);
    assert.ok(!(await r.text()).includes(fresh));
  } finally {
    globalThis.fetch = nativeFetch;
  }
  const r = await request("/api/cloud/accounts", {
    provider: fresh,
    token: fresh,
  });
  assert.ok(!(await r.text()).includes(fresh));
});

test("cloud API calls refuse redirects rather than forwarding custom authentication headers", async () => {
  const account = findAccount("custom-example", "production")!;
  const spec = providerSpec(account.provider);
  globalThis.fetch = (async (_input, options) => {
    assert.equal(options?.redirect, "error");
    assert.equal(
      (options?.headers as Record<string, string>).Authorization,
      `Bearer ${account.token}`,
    );
    return new Response('{"ok":true}', { status: 200 });
  }) as typeof fetch;
  try {
    assert.equal(
      (await cloudFetch(spec, account, { method: "GET", path: "/files" })).ok,
      true,
    );
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test("cloud panel script parses and contains no rendered connection-token values", () => {
  const html = cloudPageContent();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  assert.doesNotThrow(() => new Script(script));
  assert.match(html, /Custom API \(other provider\)/);
  assert.match(html, /type="password"/);
  assert.ok(!html.includes("a.mcpToken"));
  assert.ok(!html.includes(secret));
});
