import test from "node:test";
import assert from "node:assert/strict";
import { containsSecret, redactSecrets, resetRedactionCache } from "../src/redact.js";

test("redacts a fine-grained GitHub PAT", () => {
  const text = "token is github_pat_11ABCDEFG0abcdefghij_KLMNOPqrstuvwxyz0123456789ABCDefgh here";
  const out = redactSecrets(text);
  assert.match(out, /\[redacted:github-pat\]/);
  assert.doesNotMatch(out, /github_pat_11ABCDEFG/);
});

test("redacts classic GitHub tokens", () => {
  assert.match(redactSecrets("ghp_abcdefghijklmnopqrstuvwxyz0123456789"), /\[redacted:github-token\]/);
  assert.match(redactSecrets("ghs_abcdefghijklmnopqrstuvwxyz0123456789"), /\[redacted:github-token\]/);
});

test("redacts a JWT", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  assert.equal(redactSecrets(jwt), "[redacted:jwt]");
});

test("redacts credentials inside a connection string but keeps the host", () => {
  const out = redactSecrets("postgres://appuser:hunter2pass@db.internal:5432/appuser");
  assert.match(out, /postgres:\/\/appuser:\[redacted\]@db\.internal:5432/);
});

test("redacts KEY=value for secret-shaped names", () => {
  const out = redactSecrets("JWT_ACCESS_SECRET=s3cr3tvalue_thatislong123\nDB_HOST=postgres");
  assert.match(out, /JWT_ACCESS_SECRET=\[redacted\]/);
  assert.match(out, /DB_HOST=postgres/, "non-secret keys must survive");
});

test("redacts a private key block", () => {
  const key =
    "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----";
  assert.equal(redactSecrets(key), "[redacted:private-key]");
});

test("leaves ordinary prose alone", () => {
  const prose = [
    "token scopes     : fine-grained token - the API does not report its permissions",
    "token expires    : 2026-09-01 (29 day(s))",
    "rate limit       : 4998/5000 left",
    "default branch   : main",
  ].join("\n");
  assert.equal(redactSecrets(prose), prose);
});

test("short values are not mistaken for secrets", () => {
  assert.equal(redactSecrets("API_KEY=short"), "API_KEY=short");
});

test("containsSecret agrees with redactSecrets", () => {
  assert.equal(containsSecret("nothing to see here"), false);
  assert.equal(containsSecret("ghp_abcdefghijklmnopqrstuvwxyz0123456789"), true);
});

test("empty input is returned untouched", () => {
  assert.equal(redactSecrets(""), "");
});
