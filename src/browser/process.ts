/**
 * Making the browser actually go away.
 *
 * Chromium is launched in-process but does not die with its parent, so a crash,
 * a swap, a kill or a failed call all leave 400-600 MB of browser and renderers
 * running and a profile directory behind. Nothing in the SDK covers that, so it
 * is done here at the process level: TERM, then KILL, then the temp profiles.
 *
 * Separate from bridge.ts so the bridge stays inside the repo's file-size limit,
 * and because this half talks to the OS rather than to upstream.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "../logger.js";

/**
 * Every Playwright-launched Chromium on this box, parents and children alike.
 *
 * Deliberately broader than the pattern this replaces, which required
 * `--remote-debugging-pipe` and a path spelled `chromium`: the headless shell
 * carries neither, so the exact processes that were leaking survived the sweep.
 * Anchored on the ms-playwright cache path, so nothing outside this server's own
 * browsers can match.
 */
const CHROMIUM_MATCH = "ms-playwright/.*(chrome-headless-shell|chromium|headless_shell)";

/**
 * Terminate the browser, for real.
 *
 * TERM first, so Chromium can unlink its own profile, then KILL for whatever
 * ignored it. Both in one shell, because the second has to wait for the first
 * and blocking the event loop for that second would be worse than spawning a
 * shell. `pkill` exits 1 when nothing matched, which is the ordinary case here
 * and not a failure.
 */
export function killBrowserProcesses(reason: string): void {
  try {
    const script =
      `if pkill -TERM -f '${CHROMIUM_MATCH}'; then ` +
      `echo terminated; sleep 1; ` +
      `pkill -KILL -f '${CHROMIUM_MATCH}' >/dev/null 2>&1 || true; ` +
      `fi; exit 0`;
    const result = spawnSync("bash", ["-c", script], { timeout: 8_000, encoding: "utf8" });
    if (typeof result.stdout === "string" && result.stdout.includes("terminated")) {
      logger.warn({ reason }, "terminated the browser process group");
    }
  } catch {
    // Best effort. Housekeeping must never take the server down with it.
  }

  sweepProfileDirs();
}

/**
 * Playwright gives each isolated browser a fresh profile under the temp dir and
 * relies on a clean exit to remove it. A killed browser never gets the chance,
 * and they are hundreds of megabytes each - this box had twenty-odd of them.
 * Only safe once nothing is left running, since a live browser is still using
 * its own.
 */
function sweepProfileDirs(): void {
  try {
    const alive = spawnSync("pgrep", ["-f", CHROMIUM_MATCH], { timeout: 5_000 });
    if (alive.status === 0) return;

    const tmp = os.tmpdir();
    let removed = 0;
    for (const entry of fs.readdirSync(tmp)) {
      if (!/^playwright_.*profile-/.test(entry)) continue;
      fs.rmSync(path.join(tmp, entry), { recursive: true, force: true });
      removed += 1;
    }
    if (removed > 0) logger.info({ removed }, "removed abandoned playwright profile directories");
  } catch {
    // Best effort.
  }
}

/**
 * Chromium does not die with its parent. A crash, a swap or a kill leaves the
 * browser and its renderers running and holding their memory, and repeated swaps
 * are how a box quietly fills up. Run at startup and again before any launch,
 * because a crash never gets to run its own cleanup.
 */
export function sweepOrphans(): void {
  killBrowserProcesses("sweeping orphaned browsers");
}
