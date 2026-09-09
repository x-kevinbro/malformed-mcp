import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { extractHost, assertTargetAllowed, SecurityTargetError } from "../src/sec-guard.js";

/**
 * The shipped default is ["*"] - every target permitted, deliberately. These
 * tests are about the guard's logic rather than that policy, so each one states
 * the allowlist it means and puts the real one back afterwards. Reading the
 * global default instead is what made this file fail the moment the default
 * changed, while the guard itself was working exactly as written.
 */
function withAllowTargets<T>(allow: string[], run: () => T): T {
  const previous = config.sec.allowTargets;
  config.sec.allowTargets = allow;
  try {
    return run();
  } finally {
    config.sec.allowTargets = previous;
  }
}

test("extractHost reads a hostname from every accepted form", () => {
  assert.equal(extractHost("dark-byte.org"), "dark-byte.org");
  assert.equal(extractHost("https://dark-byte.org/login?x=1"), "dark-byte.org");
  assert.equal(extractHost("DARK-BYTE.ORG:443"), "dark-byte.org");
  assert.equal(extractHost("127.0.0.1:4000"), "127.0.0.1");
  assert.equal(extractHost("[::1]:8080"), "::1");
  assert.equal(extractHost("  "), null);
});

test("assertTargetAllowed accepts an allowlisted host and returns it", () => {
  withAllowTargets(["dark-byte.org", "127.0.0.1"], () => {
    assert.equal(assertTargetAllowed("https://dark-byte.org/api"), "dark-byte.org");
    assert.equal(assertTargetAllowed("127.0.0.1:4000"), "127.0.0.1");
  });
});

test("assertTargetAllowed refuses a host outside the allowlist", () => {
  withAllowTargets(["dark-byte.org", "127.0.0.1"], () => {
    assert.throws(() => assertTargetAllowed("https://example.com"), SecurityTargetError);
    assert.throws(() => assertTargetAllowed("attacker.test"), SecurityTargetError);
  });
});

test("a wildcard allowlist permits anything, which is what this server ships", () => {
  withAllowTargets(["*"], () => {
    assert.equal(assertTargetAllowed("https://example.com"), "example.com");
    assert.equal(assertTargetAllowed("attacker.test"), "attacker.test");
  });
});

test("an empty allowlist refuses everything rather than allowing everything", () => {
  withAllowTargets([], () => {
    assert.throws(() => assertTargetAllowed("dark-byte.org"), SecurityTargetError);
  });
});

test("a target with no readable hostname is refused", () => {
  withAllowTargets(["*"], () => {
    assert.throws(() => assertTargetAllowed("   "), SecurityTargetError);
  });
});
