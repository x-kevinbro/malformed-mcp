/**
 * Pure helpers for the one-browser, one-tab policy.
 *
 * They live apart from `bridge.ts` deliberately. `bridge.ts` imports `config` at
 * module load and therefore needs the server's whole environment before it can
 * be loaded at all, and a policy this load-bearing should be testable without
 * one - and without a real Chromium.
 */

export type OpenTab = { index: number; current: boolean; label: string };

/**
 * Upstream reports tabs as a markdown section inside its ordinary text output:
 *
 *   ### Open tabs
 *   - 0: (current) [Title] (https://example.com)
 *   - 1: [Other] (https://example.org)
 *
 * Reading that is how the tab count is discovered without spending an extra
 * round trip on `browser_tabs` after every call. No section is not the same as
 * "there are no tabs": it means upstream said nothing this time, so the caller
 * treats an empty result as "unknown, leave it alone".
 */
export function parseOpenTabs(text: string): OpenTab[] {
  const heading = /###\s*Open tabs\s*\r?\n/i.exec(text);
  if (!heading) return [];

  const body = text.slice(heading.index + heading[0].length);
  const tabs: OpenTab[] = [];

  for (const line of body.split(/\r?\n/)) {
    // A blank line, the next section, or any non-list line ends the list.
    if (/^\s*$/.test(line) || /^\s*###/.test(line)) break;
    const match = /^\s*-\s*(\d+):\s*(.*)$/.exec(line);
    if (!match?.[1]) break;
    tabs.push({
      index: Number(match[1]),
      current: /\(current\)/i.test(match[2] ?? ""),
      label: (match[2] ?? "").trim(),
    });
  }

  return tabs;
}

/**
 * Which tabs to close to get back under the cap, highest index first.
 *
 * Highest first because closing a tab renumbers every tab above it, so a
 * descending walk leaves the remaining indices valid. The current tab is never
 * a candidate: it is the one the caller is working in, and closing it would
 * turn a tidy-up into lost work.
 */
export function tabsToClose(tabs: OpenTab[], cap: number): OpenTab[] {
  const limit = Math.max(1, Math.floor(cap));
  if (tabs.length <= limit) return [];

  return tabs
    .filter((tab) => !tab.current)
    .sort((a, b) => b.index - a.index)
    .slice(0, tabs.length - limit);
}

/**
 * Errors that mean the browser itself is gone or wedged, rather than the page
 * merely disagreeing with the request.
 *
 * The distinction is the whole point. "Element not found" and "Timeout 5000ms
 * exceeded" are ordinary answers about a page, and killing Chromium over one
 * would throw away a session the agent is halfway through. "Target page,
 * context or browser has been closed" is different: every later call fails the
 * same way until something restarts, so the honest move is to terminate the
 * process and let the next call launch a clean one.
 *
 * Set browser.killOnAnyError=true to stop drawing the distinction and
 * terminate on every failed call.
 */
const FATAL: RegExp[] = [
  /target (?:page|context)?,? ?(?:context |or )?(?:or )?browser has been closed/i,
  /target closed/i,
  /browser (?:has been closed|has disconnected|closed unexpectedly|is not running)/i,
  /(?:browsercontext|session|websocket) (?:has been )?closed/i,
  /(?:page|renderer|browser|tab) crashed/i,
  /protocol error/i,
  /connection closed|econnreset|epipe/i,
  /out of memory|enomem|enospc|cannot allocate memory/i,
  /failed to launch|browser closed while/i,
];

export function isFatalBrowserError(text: string): boolean {
  return FATAL.some((pattern) => pattern.test(text));
}
