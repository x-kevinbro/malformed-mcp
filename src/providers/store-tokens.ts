/**
 * Token list for redaction only.
 *
 * Same leaf-module trick as github/store-tokens.ts: redact.ts is imported by
 * almost everything, so it cannot pull in accounts.ts and the AsyncLocalStorage
 * machinery behind it without risking an import cycle. This is the narrow view:
 * every cloud credential the store holds, with no notion of which one is active.
 */
import { allAccounts } from "./store.js";

export function allTokens(): string[] {
  try {
    return allAccounts()
      .flatMap((a) => [a.token, a.mcpToken])
      .filter(Boolean);
  } catch {
    return [];
  }
}
