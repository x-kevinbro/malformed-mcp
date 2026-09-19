import test from "node:test";
import assert from "node:assert/strict";
import {
  PROVIDERS,
  effectiveAuth,
  providerSpec,
} from "../src/providers/spec.js";
import { authHeaders, resolveTarget } from "../src/providers/request.js";
import { dig } from "../src/panel/cloud.js";
import type { StoredCloudAccount } from "../src/providers/store.js";

const account: StoredCloudAccount = {
  id: "vercel/test",
  provider: "vercel",
  name: "test",
  token: "test-token-0123456789abcdef",
  readOnly: false,
  verified: true,
  mcpToken: "bm_test",
  createdAt: new Date().toISOString(),
};

test("every provider spec is internally consistent", () => {
  const ids = new Set<string>();
  for (const spec of PROVIDERS) {
    assert.equal(ids.has(spec.id), false, `duplicate provider id ${spec.id}`);
    ids.add(spec.id);
    assert.match(
      spec.baseUrl,
      /^https:\/\//,
      `${spec.id}: credentials need an https base URL`,
    );
    assert.ok(
      spec.hosts.length > 0,
      `${spec.id}: a hosts list is the credential boundary`,
    );
    assert.ok(spec.auth.length > 0, `${spec.id}: at least one auth style`);
    for (const check of spec.verify ?? [])
      assert.match(check.path, /^\//, `${spec.id}: verify path`);
  }
  // The providers this feature was requested for are all present.
  for (const id of [
    "vercel",
    "heroku",
    "render",
    "digitalocean",
    "linode",
    "fastly",
    "cloudflare",
    "firebase",
    "turso",
  ]) {
    assert.ok(providerSpec(id), id);
  }
});

test("resolveTarget joins bare paths onto the base URL", () => {
  const spec = providerSpec("vercel");
  assert.equal(
    resolveTarget(spec, "/v9/projects"),
    "https://api.vercel.com/v9/projects",
  );
  assert.equal(
    resolveTarget(spec, "v9/projects"),
    "https://api.vercel.com/v9/projects",
  );
});

test("resolveTarget honours full URLs on the provider's own hosts only", () => {
  const turso = providerSpec("turso");
  assert.equal(
    resolveTarget(turso, "https://my-db-org.turso.io/v2/pipeline"),
    "https://my-db-org.turso.io/v2/pipeline",
  );
  const vercel = providerSpec("vercel");
  assert.throws(
    () => resolveTarget(vercel, "https://evil.example.com/v9/projects"),
    /not a Vercel API host/,
  );
  assert.throws(
    () => resolveTarget(vercel, "https://api.vercel.com.evil.com/"),
    /not a Vercel API host/,
  );
  assert.throws(
    () => resolveTarget(vercel, "http://api.vercel.com/v9/projects"),
    /https only/,
  );
});

test("authHeaders maps each auth style to the provider's header shape", async () => {
  const bearer = await authHeaders(providerSpec("vercel"), account);
  assert.equal(bearer.Authorization, `Bearer ${account.token}`);

  const fastly = await authHeaders(providerSpec("fastly"), account);
  assert.equal(fastly["Fastly-Key"], account.token);
  assert.equal(fastly.Authorization, undefined);

  const keyed = { ...account, extra: { email: "ops@example.com" } };
  const cloudflare = await authHeaders(providerSpec("cloudflare"), keyed);
  assert.equal(cloudflare["X-Auth-Key"], account.token);
  assert.equal(cloudflare["X-Auth-Email"], "ops@example.com");
});

test("effectiveAuth prefers a scoped token unless the account carries an email", () => {
  const spec = providerSpec("cloudflare");
  assert.equal(effectiveAuth(spec).type, "bearer");
  assert.equal(
    effectiveAuth(spec, { email: "ops@example.com" }).type,
    "email_key",
  );
  assert.equal(effectiveAuth(providerSpec("vercel")).type, "bearer");
});

test("dig walks dotted paths, including array indexes", () => {
  const body = { result: { email: "ops@example.com" } };
  assert.equal(dig(body, "result.email"), "ops@example.com");
  assert.equal(dig([{ owner: { email: "a@b.c" } }], "0.owner.email"), "a@b.c");
  assert.equal(dig(body, "result.missing.deeper"), undefined);
  assert.equal(dig(null, "anything"), undefined);
});

test("unknown provider errors name the ones that exist", () => {
  assert.throws(
    () => providerSpec("azure"),
    /Unknown provider "azure".*vercel/s,
  );
});
