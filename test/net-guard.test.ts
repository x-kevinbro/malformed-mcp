import test from "node:test";
import assert from "node:assert/strict";
import { hostMatches, isPrivateAddress } from "../src/net-guard.js";

test("hostMatches handles exact, wildcard and apex", () => {
  assert.equal(hostMatches("api.github.com", "api.github.com"), true);
  assert.equal(hostMatches("API.GitHub.com", "api.github.com"), true);
  assert.equal(hostMatches("api.github.com", "*.github.com"), true);
  assert.equal(hostMatches("github.com", "*.github.com"), true, "apex should match its own wildcard");
  assert.equal(hostMatches("evilgithub.com", "*.github.com"), false);
  assert.equal(hostMatches("anything.at.all", "*"), true);
});

test("isPrivateAddress covers the ranges that matter for SSRF", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "0.0.0.0",
    "::1",
    "fd00::1",
    "fe80::1",
  ]) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be private`);
  }
});

test("isPrivateAddress lets public addresses through", () => {
  for (const ip of ["8.8.8.8", "140.82.121.4", "172.32.0.1", "192.169.0.1", "2606:4700::1111"]) {
    assert.equal(isPrivateAddress(ip), false, `${ip} should be public`);
  }
});

test("IPv4-mapped IPv6 loopback is still loopback", () => {
  assert.equal(isPrivateAddress("::ffff:127.0.0.1"), true);
});
