/**
 * The bridge to @playwright/mcp.
 *
 * Upstream exposes exactly one entry point - `createConnection`, which returns a
 * low-level SDK `Server`, not a client. Linking it to a `Client` over an
 * in-memory transport pair puts its tools in *this* process and therefore in the
 * same session as every other tool here, which is the whole point: a second
 * container would be a second MCP endpoint, and the agent could not hold the
 * host and the browser in one conversation.
 *
 * Everything else in this file exists because Chromium is 400-600 MB resident,
 * is launched in-process, and therefore shares a cgroup with the server. If the
 * kernel starts killing, it picks the largest victim in the group and takes the
 * whole server down with it. So: one browser, one tab, one lock, a bounded
 * wait, a watchdog, an idle close, and a process-group kill on the way out - or
 * the moment a call fails or strands the lock, because a browser in an unknown
 * state is worse than no browser: the next call inherits the mess.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { killBrowserProcesses, sweepOrphans } from "./process.js";
import type { JsonSchema } from "./schema.js";
import { isFatalBrowserError, parseOpenTabs, tabsToClose } from "./tabs.js";

export type BrowserToolDef = {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema | undefined;
  readOnly: boolean;
};

export type BrowserContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: string; [key: string]: unknown };

export type BrowserCallResult = {
  content: BrowserContentBlock[];
  isError: boolean;
};

/** Upstream tools that only look at the page. Everything else may change it. */
const READ_ONLY_TOOLS = new Set([
  "browser_snapshot",
  "browser_take_screenshot",
  "browser_console_messages",
  "browser_network_requests",
  "browser_pdf_save",
]);

let client: Client | null = null;
let tools: BrowserToolDef[] = [];
let startupError: string | null = null;

/**
 * Whether Chromium is believed to be running for this client.
 *
 * Upstream launches lazily on the first navigation and relaunches after a close,
 * so this is what lets the bridge sweep a stray browser *before* a new one
 * starts. Without it "one browser" is aspirational: the sweep only ever ran at
 * startup, and this box was running two.
 */
let launched = false;

/**
 * Serialises every call. Playwright is not safe to drive concurrently against
 * one context, so this fixes correctness and memory together.
 *
 * A chain of promises rather than a boolean: with a boolean, every waiter is
 * parked on the same promise and they all wake in the same tick, which is
 * concurrency wearing a lock's clothing. The tail of this chain is the turn of
 * the caller that most recently joined the queue.
 */
let lock: Promise<void> = Promise.resolve();

let idleTimer: NodeJS.Timeout | null = null;

/**
 * Tab count. Advisory, and reconciled after every call from the tab listing
 * upstream prints, because a page can open a tab without asking and a count
 * kept only by bookkeeping drifts away from what is actually open.
 */
let openTabs = 1;

/** The upstream Config shape, kept loose so a version bump cannot break the build. */
function browserConfig(): Record<string, unknown> {
  return {
    browser: {
      browserName: "chromium",
      isolated: true,
      launchOptions: {
        headless: config.browser.headless,
        // Required when running as root, which also removes Chromium's own
        // sandbox. Running this service as a non-root user is the real fix.
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      },
      contextOptions: { viewport: config.browser.viewport },
    },
    capabilities: ["core", "core-navigation", "core-input", "core-tabs", ...config.browser.caps],
    outputDir: config.browser.outputDir,
    console: { level: "warning" },
    timeouts: { action: 5_000, navigation: 60_000 },
    saveSession: false,
    saveTrace: false,
    sharedBrowserContext: true,
  };
}

/**
 * Handshake once at process start and cache the tool definitions, because
 * registration has to be synchronous. This does not launch Chromium - upstream
 * starts the browser on the first navigation - so an eager handshake is cheap
 * and a lazy one would buy nothing.
 *
 * A failure here must never stop the server booting. Zero browser tools is a
 * degraded server; no server is an outage.
 */
export async function initBrowserBridge(): Promise<void> {
  if (!config.browser.enabled) return;

  // A page can ask the browser for 127.0.0.1:5432 or the cloud metadata
  // endpoint, and unlike http_request that request never passes the net guard.
  // Refusing here is the only place the two settings can be kept honest, and a
  // documented prerequisite nobody enforces is not a prerequisite.
  if (!config.net.blockPrivate && !config.browser.allowPrivateNet) {
    startupError =
      "refused to start: browser.enabled=true needs net.blockPrivate=true, " +
      "or browser.allowPrivateNet=true to accept the SSRF exposure deliberately.";
    tools = [];
    client = null;
    logger.warn({ err: startupError }, "browser bridge refused to start");
    return;
  }

  try {
    sweepOrphans();

    const { createConnection } = (await import("@playwright/mcp")) as {
      createConnection: (cfg?: unknown) => Promise<{ connect: (t: unknown) => Promise<void> }>;
    };

    const server = await createConnection(browserConfig());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const c = new Client({ name: `${config.serverName}-browser`, version: config.version });
    await c.connect(clientTransport);

    const listed = await c.listTools();
    tools = listed.tools.map((tool) => ({
      name: tool.name,
      title: (tool.annotations?.title as string | undefined) ?? tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema as JsonSchema | undefined,
      readOnly: READ_ONLY_TOOLS.has(tool.name),
    }));
    client = c;

    logger.info({ tools: tools.length }, "browser bridge ready");
  } catch (error) {
    startupError = error instanceof Error ? error.message : String(error);
    tools = [];
    client = null;
    logger.warn({ err: startupError }, "browser bridge unavailable - continuing without it");
  }
}

/** Cached definitions. Empty when disabled or when the handshake failed. */
export function browserTools(): BrowserToolDef[] {
  return tools;
}

export function browserStatus(): string {
  if (!config.browser.enabled) return "disabled (browser.enabled=false)";
  if (startupError) return `failed: ${startupError}`;
  return `ready, ${tools.length} tools`;
}

/**
 * Take the single lock, or refuse. A queue that grows without bound converts a
 * crash into a hang, and an agent retries into either one - so refusing after a
 * bounded wait is the kinder failure, and it says so in words the model can act
 * on.
 */
async function withLock<T>(run: () => Promise<T>): Promise<T> {
  // Join the queue synchronously, before the first await: two callers in the
  // same tick would otherwise both find the lock free.
  const ahead = lock;
  let release!: () => void;
  lock = new Promise<void>((resolve) => {
    release = resolve;
  });

  let timer: NodeJS.Timeout | undefined;
  const myTurn = await Promise.race([
    ahead.then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), config.browser.lockWaitMs);
      timer.unref();
    }),
  ]);
  if (timer) clearTimeout(timer);

  if (!myTurn) {
    // Give up our place, but only once the caller ahead has actually finished -
    // releasing now would hand the browser to the next in line while the
    // current action is still driving the page.
    void ahead.then(release, release);

    // Stranded. Something took the browser and never gave it back, and nothing
    // else will ever clear it: the holder is stuck inside a call that will not
    // return, so the lock stays held and every later call refuses forever.
    // Terminating the process is what breaks that - the stuck action dies with
    // the browser it was waiting on, which is the point.
    if (config.browser.killOnError) {
      killBrowserProcesses("a browser action stranded the lock");
      launched = false;
      openTabs = 1;
    }

    throw new Error(
      `A browser action is already running and did not finish within ${Math.round(
        config.browser.lockWaitMs / 1000,
      )}s. ` +
        (config.browser.killOnError
          ? "The stranded browser process has been terminated - retry now and it will start from a clean browser."
          : "There is one browser for the whole server; retry when it finishes."),
    );
  }

  try {
    return await run();
  } finally {
    release();
  }
}

/**
 * The tab policy, refused up front rather than counted after the fact.
 *
 * At a cap of 1 a second tab is not a limit to negotiate, so say so in words the
 * model can act on: navigate the tab it already has, which is what it meant.
 */
function checkTabs(name: string, args: Record<string, unknown>): void {
  if (name !== "browser_tabs") return;
  const action = typeof args.action === "string" ? args.action : undefined;
  const cap = Math.max(1, config.browser.maxTabs);

  if (action === "new") {
    if (cap === 1) {
      throw new Error(
        "This server runs one browser with one tab, so a second tab cannot be opened. " +
          "Navigate the tab you already have with browser_navigate, or close it first with " +
          'browser_tabs action="close". Raise browser.maxTabs if a second tab is genuinely required.',
      );
    }
    if (openTabs >= cap) {
      throw new Error(
        `Tab limit reached (${cap}). Close one with browser_tabs action="close" ` +
          `before opening another, or raise browser.maxTabs.`,
      );
    }
    openTabs += 1;
  }

  if (action === "close") openTabs = Math.max(1, openTabs - 1);
}

function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    void closeBrowser("idle");
  }, config.browser.idleMs);
  idleTimer.unref();
}

/**
 * Run one upstream call under a watchdog.
 *
 * Upstream's action and navigation timeouts cover a page that misbehaves. They
 * do not cover a Chromium that has wedged or lost its pipe: then the promise
 * never settles, the lock is held for the life of the process, and every later
 * call refuses. This is the outer bound that turns a permanent failure into a
 * single failed call.
 */
async function callWithWatchdog(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content?: BrowserContentBlock[]; isError?: boolean }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      client!.callTool({ name, arguments: args }) as Promise<{
        content?: BrowserContentBlock[];
        isError?: boolean;
      }>,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `${name} did not return within ${Math.round(
                config.browser.callTimeoutMs / 1000,
              )}s - the browser was stranded.`,
            ),
          );
        }, config.browser.callTimeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Text of every text block - where upstream reports both tabs and errors. */
function textOf(content: BrowserContentBlock[]): string {
  return content
    .map((block) => {
      const text = (block as { text?: unknown }).text;
      return block.type === "text" && typeof text === "string" ? text : "";
    })
    .join("\n");
}

/**
 * Put the browser back into the one state that is known: gone.
 *
 * Graceful close first, but bounded - a stranded browser is exactly the case
 * where browser_close also never returns, and waiting on it would strand this
 * path too. The kill is the guarantee, because Chromium does not die with its
 * parent. The client stays connected on purpose: upstream launches a fresh
 * browser on the next navigation, so the agent loses the page, not its tools.
 */
async function hardReset(reason: string): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  openTabs = 1;
  launched = false;

  if (client) {
    try {
      await Promise.race([
        client.callTool({ name: "browser_close", arguments: {} }),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 5_000);
          timer.unref();
        }),
      ]);
    } catch {
      // Expected when the browser is already broken. The kill below is the part
      // that actually holds.
    }
  }

  killBrowserProcesses(reason);
}

/**
 * Hold the tab cap against tabs nobody asked for.
 *
 * Refusing browser_tabs action="new" only covers tabs the agent opens. A
 * target=_blank link, a window.open, an OAuth popup - those arrive regardless,
 * and each one costs another snapshot and a few hundred more megabytes. Upstream
 * already lists the open tabs in its output, so the extras can be closed from
 * what it said rather than by polling for tabs after every call.
 *
 * Runs inside the held lock and talks to the client directly: going back through
 * callBrowserTool would deadlock on the lock it is already holding.
 */
async function reconcileTabs(content: BrowserContentBlock[]): Promise<void> {
  const tabs = parseOpenTabs(textOf(content));
  if (tabs.length === 0) return; // Upstream said nothing about tabs this time.

  openTabs = tabs.length;
  const cap = Math.max(1, config.browser.maxTabs);

  for (const tab of tabsToClose(tabs, cap)) {
    try {
      await client!.callTool({
        name: "browser_tabs",
        arguments: { action: "close", index: tab.index },
      });
      openTabs = Math.max(1, openTabs - 1);
      logger.warn({ index: tab.index, cap }, "closed a tab that was opened outside the tab cap");
    } catch (error) {
      logger.warn({ index: tab.index, err: String(error) }, "could not close an extra tab");
    }
  }
}

/** Call an upstream tool. Content blocks come back untouched apart from the
 *  safety pipeline the caller applies - images must survive. */
export async function callBrowserTool(
  name: string,
  args: Record<string, unknown>,
): Promise<BrowserCallResult> {
  if (!client) {
    throw new Error(`Browser tools are not available: ${browserStatus()}.`);
  }

  return withLock(async () => {
    checkTabs(name, args);

    // Nothing of ours is running, so anything still alive is a leftover from a
    // crash or a kill. Sweeping here, and not only at startup, is what keeps one
    // browser to one server across a process that lives for weeks.
    if (!launched) sweepOrphans();

    let result: { content?: BrowserContentBlock[]; isError?: boolean };
    try {
      result = await callWithWatchdog(name, args);
    } catch (error) {
      // A throw means the transport or the browser failed rather than the page:
      // there is no result, and no way to know what state was left behind.
      const message = error instanceof Error ? error.message : String(error);
      if (config.browser.killOnError) await hardReset(`${name} failed: ${message}`);
      throw error;
    }

    launched = true;
    const content = result.content ?? [];
    const isError = Boolean(result.isError);

    // A reported error is usually about the page - a missing element, an action
    // timeout - and killing Chromium over one would throw away a session the
    // agent is halfway through. Only a browser that is actually gone or wedged
    // earns the kill, unless browser.killOnAnyError says otherwise.
    if (
      isError &&
      config.browser.killOnError &&
      (config.browser.killOnAnyError || isFatalBrowserError(textOf(content)))
    ) {
      await hardReset(`${name} failed and left the browser unusable`);
      return { content, isError };
    }

    await reconcileTabs(content);
    resetIdleTimer();
    return { content, isError };
  });
}

/** Ask upstream to close the browser, then make sure it is actually gone. */
export async function closeBrowser(reason: string): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  if (client) {
    try {
      await client.callTool({ name: "browser_close", arguments: {} });
      logger.info({ reason }, "browser closed");
    } catch (error) {
      logger.warn({ reason, err: String(error) }, "browser close failed");
    }
  }

  openTabs = 1;
  launched = false;

  // A close upstream calls successful can still leave the process behind, and an
  // idle close that leaks is how a box fills up overnight. Verifying costs one
  // pkill; assuming costs half a gigabyte.
  killBrowserProcesses(reason);
}

/** Called from the server's SIGTERM/SIGINT path so a swap does not orphan a browser. */
export async function shutdownBrowser(): Promise<void> {
  await closeBrowser("shutdown");
  client = null;
}
