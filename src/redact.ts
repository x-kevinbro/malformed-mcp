/**
 * Last-line-of-defence secret scrubbing.
 *
 * The GitHub client already redacts its own token from its own errors, but that
 * only covers one secret on one path. These tools read .env files, dump
 * container logs, run arbitrary shell and print database rows - every one of
 * which can carry a credential out. This module runs over EVERY tool result, so
 * the protection does not depend on each tool remembering.
 *
 * It is deliberately pattern-based rather than a list of known variables: the
 * dangerous secret is the one nobody registered. Application logs routinely leak
 * tokens in plain text, which is exactly the case a known-values list would
 * miss.
 */

import { config } from "./config.js";
import { allTokens } from "./github/store-tokens.js";

type Rule = { pattern: RegExp; replacement: string };

/**
 * Recognisable credential formats. Ordered longest/most-specific first so a
 * broad rule cannot eat the prefix of a narrower one.
 */
const RULES: Rule[] = [
  {
    pattern: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g,
    replacement: "[redacted:private-key]",
  },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replacement: "[redacted:github-pat]" },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, replacement: "[redacted:github-token]" },
  { pattern: /\bxox[baprse]-[A-Za-z0-9-]{10,}/g, replacement: "[redacted:slack-token]" },
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replacement: "[redacted:aws-key-id]" },
  { pattern: /\bsk-[A-Za-z0-9]{20,}/g, replacement: "[redacted:api-key]" },
  { pattern: /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}/g, replacement: "[redacted:telegram-token]" },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replacement: "[redacted:jwt]",
  },
  // Credentials embedded in a connection string.
  {
    pattern: /\b([a-z][a-z0-9+.-]*):\/\/([^:/\s@]+):([^@\s]{3,})@/gi,
    replacement: "$1://$2:[redacted]@",
  },
  // KEY=value / "key": "value" where the key name says secret and the value is
  // long and unbroken enough to be one. The length floor keeps prose such as
  // 'token scopes: fine-grained' intact.
  {
    pattern:
      /\b([A-Za-z_][A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|ENCRYPTION_KEY|SALT|_PW))\b(\s*[:=]\s*)(["']?)([A-Za-z0-9_\-+/=.~]{16,})\3/gi,
    replacement: "$1$2$3[redacted]$3",
  },
];

/** Escape a literal so it can be embedded in a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Exact values this process knows are secret. Cheap, and catches high-entropy
 * secrets that match no recognisable format. Configuration lives in
 * src/config.ts now, so the bearer token is the one literal worth knowing.
 */
function literalSecrets(): string[] {
  return [config.token, ...allTokens()]
    .filter((value) => value.length >= 12)
    .sort((a, b) => b.length - a.length);
}

let literals: RegExp[] | undefined;

function literalRules(): RegExp[] {
  literals ??= literalSecrets().map((value) => new RegExp(escapeRegExp(value), "g"));
  return literals;
}

/** Recompute the known-literal list, for tests and after a credential changes. */
export function resetRedactionCache(): void {
  literals = undefined;
}

/**
 * Scrub secrets from text on its way out. Safe to call on anything; it only
 * rewrites what matches.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;

  let out = text;
  for (const rule of RULES) out = out.replace(rule.pattern, rule.replacement);
  for (const literal of literalRules()) out = out.replace(literal, "[redacted:config-secret]");
  return out;
}

/** True when scrubbing would change the text. Used to annotate results. */
export function containsSecret(text: string): boolean {
  return redactSecrets(text) !== text;
}
