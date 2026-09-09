/**
 * Token list for redaction only.
 *
 * redact.ts is imported by almost everything, so it cannot pull in accounts.ts
 * and the AsyncLocalStorage machinery behind it without risking an import
 * cycle. This is the narrow leaf view: every credential the store holds, with
 * no notion of which one is active.
 */
import { allProfiles } from "./store.js";

export function allTokens(): string[] {
  try {
    return allProfiles()
      .flatMap((p) => [p.token, p.mcpToken])
      .filter(Boolean);
  } catch {
    return [];
  }
}
