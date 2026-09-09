import assert from "node:assert/strict";
import test from "node:test";
import { isFatalBrowserError, parseOpenTabs, tabsToClose } from "../src/browser/tabs.js";

const SNAPSHOT = `### Ran Playwright code
\`\`\`js
await page.goto('https://example.com');
\`\`\`

### Open tabs
- 0: (current) [Example Domain] (https://example.com/)
- 1: [Popup] (https://ads.example.net/popup)

### Page state
- Page URL: https://example.com/
`;

test("tabs are read out of the section upstream already prints", () => {
  const tabs = parseOpenTabs(SNAPSHOT);
  assert.equal(tabs.length, 2);
  assert.deepEqual(
    tabs.map((tab) => tab.index),
    [0, 1],
  );
  assert.equal(tabs[0]?.current, true);
  assert.equal(tabs[1]?.current, false);
});

test("no tab section means unknown, not zero tabs", () => {
  assert.deepEqual(parseOpenTabs("### Page state\n- Page URL: https://example.com/"), []);
  assert.deepEqual(parseOpenTabs(""), []);
});

test("a single tab is left alone at a cap of one", () => {
  const tabs = parseOpenTabs("### Open tabs\n- 0: (current) [Only] (https://example.com/)\n");
  assert.deepEqual(tabsToClose(tabs, 1), []);
});

test("the extra tab is closed and the current one survives", () => {
  const doomed = tabsToClose(parseOpenTabs(SNAPSHOT), 1);
  assert.deepEqual(
    doomed.map((tab) => tab.index),
    [1],
  );
});

test("extras are closed highest index first, because closing renumbers the rest", () => {
  const tabs = parseOpenTabs(
    "### Open tabs\n" +
      "- 0: [One] (https://a.example)\n" +
      "- 1: (current) [Two] (https://b.example)\n" +
      "- 2: [Three] (https://c.example)\n" +
      "- 3: [Four] (https://d.example)\n",
  );
  assert.deepEqual(
    tabsToClose(tabs, 1).map((tab) => tab.index),
    [3, 2, 0],
    "descending, and never the current tab",
  );
});

test("a cap above one keeps that many tabs", () => {
  const tabs = parseOpenTabs(
    "### Open tabs\n" +
      "- 0: (current) [One] (https://a.example)\n" +
      "- 1: [Two] (https://b.example)\n" +
      "- 2: [Three] (https://c.example)\n",
  );
  assert.equal(tabsToClose(tabs, 2).length, 1);
  assert.equal(tabsToClose(tabs, 3).length, 0);
  assert.equal(tabsToClose(tabs, 0).length, 2, "a nonsense cap still means one tab, not none");
});

test("a dead browser is fatal, a disagreeable page is not", () => {
  for (const message of [
    "Error: Target page, context or browser has been closed",
    "browser has disconnected",
    "Protocol error (Page.navigate): Target closed",
    "Page crashed",
    "Error: Failed to launch chromium",
    "read ECONNRESET",
    "spawn ENOMEM",
  ]) {
    assert.equal(isFatalBrowserError(message), true, message);
  }

  for (const message of [
    'Error: element not found for selector "#submit"',
    "Timeout 5000ms exceeded waiting for locator",
    "net::ERR_NAME_NOT_RESOLVED at https://nope.example/",
    "Refused: this server runs one browser with one tab",
    "expect(locator).toBeVisible() failed",
  ]) {
    assert.equal(isFatalBrowserError(message), false, message);
  }
});
