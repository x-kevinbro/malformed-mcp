import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../src/config.js";

// The store reads config.providerStore on every call, so pointing it at a
// temp file here gives each run a clean store without touching the real one.
const dir = mkdtempSync(path.join(tmpdir(), "cloud-store-test-"));
config.providerStore = path.join(dir, "providers.json");

const store = await import("../src/providers/store.js");

test.after(() => rmSync(dir, { recursive: true, force: true }));

const input = {
  provider: "vercel",
  name: "ops@example.com",
  token: "vercel-token-0123456789abcdef",
  readOnly: false,
  verified: true,
};

test("upsert creates an account with a derived id and an MCP token", () => {
  const account = store.upsertAccount(input);
  assert.equal(account.id, "vercel/ops-example.com");
  assert.match(account.mcpToken, /^bm_[0-9a-f]{48}$/);
  assert.equal(store.allAccounts().length, 1);
});

test("re-adding the same provider+name updates in place and keeps the MCP token", () => {
  const before = store.findAccount("vercel", "ops@example.com")!;
  const again = store.upsertAccount({
    ...input,
    token: "rotated-provider-token-9876543210",
  });
  assert.equal(again.id, before.id);
  assert.equal(
    again.mcpToken,
    before.mcpToken,
    "MCP token survives a credential rotation",
  );
  assert.equal(again.token, "rotated-provider-token-9876543210");
  assert.equal(store.allAccounts().length, 1);
});

test("findAccount resolves by name, slug and id, case-insensitively", () => {
  for (const key of [
    "OPS@example.com",
    "ops-example.com",
    "vercel/ops-example.com",
  ]) {
    assert.equal(
      store.findAccount("vercel", key)?.name,
      "ops@example.com",
      key,
    );
  }
  assert.equal(store.findAccount("cloudflare", "ops@example.com"), undefined);
});

test("the first account becomes the provider default; another can be set", () => {
  assert.equal(store.defaultAccountId("vercel"), "vercel/ops-example.com");
  store.upsertAccount({ ...input, name: "backup" });
  store.setDefaultAccount("vercel", "backup");
  assert.equal(store.defaultAccountId("vercel"), "vercel/backup");
  // Removing the default falls back to the remaining account.
  store.removeAccount("vercel", "backup");
  assert.equal(store.defaultAccountId("vercel"), "vercel/ops-example.com");
});

test("per-account read-only flag round-trips", () => {
  store.setAccountReadOnly("vercel", "ops-example.com", true);
  assert.equal(store.findAccount("vercel", "ops-example.com")!.readOnly, true);
  store.setAccountReadOnly("vercel", "ops-example.com", false);
  assert.equal(store.findAccount("vercel", "ops-example.com")!.readOnly, false);
});

test("MCP token rotation invalidates the old token", () => {
  const before = store.findAccount("vercel", "ops@example.com")!;
  const rotated = store.rotateMcpToken("vercel", "ops-example.com");
  assert.notEqual(rotated, before.mcpToken);
  assert.equal(store.findCloudByMcpToken(before.mcpToken), undefined);
  assert.equal(store.findCloudByMcpToken(rotated)?.id, before.id);
});

test("slug rejects names that cannot be routed safely", () => {
  assert.equal(store.slug("Prod (EU) #1"), "prod-eu-1");
  assert.throws(() => store.slug("..."), /Unusable/);
  assert.throws(() => store.slug("   "), /Unusable/);
});
