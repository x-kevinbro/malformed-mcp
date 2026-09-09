import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { ALWAYS_ON, createCategoryRegistry, describeParams, parseToolArgs } from "../src/categories.js";

/** A stand-in for the SDK's RegisteredTool, recording what was done to it. */
function fakeHandle() {
  const state = { enabled: true };
  return {
    state,
    handle: {
      enable() {
        state.enabled = true;
      },
      disable() {
        state.enabled = false;
      },
    },
  };
}

function registryWith(entries: Array<[string, string]>) {
  const registry = createCategoryRegistry();
  const handles = new Map<string, { enabled: boolean }>();
  for (const [category, name] of entries) {
    const { state, handle } = fakeHandle();
    handles.set(name, state);
    registry.record({
      name,
      category,
      title: `title of ${name}`,
      description: `description of ${name}`,
      params: ["path"],
      handle,
      handler: async () => ({ content: [{ type: "text", text: `ran ${name}` }] }),
    });
  }
  return { registry, handles };
}

const sample: Array<[string, string]> = [
  ["files", "read_file"],
  ["files", "write_file"],
  ["github", "gh_status"],
  ["github", "gh_repo"],
  ["shell", "run_command"],
];

test("starting on demand hides everything except the always-on tools", () => {
  const { registry, handles } = registryWith(sample);
  const hidden = registry.start({ onDemand: true, preload: [] });

  assert.equal(hidden, 4, "read_file is always on, the other four are hidden");
  assert.equal(handles.get("read_file")?.enabled, true);
  assert.equal(handles.get("gh_status")?.enabled, false);
  assert.equal(handles.get("run_command")?.enabled, false);
});

test("the always-on set is actually reachable, not just declared", () => {
  // A session that cannot read or orient itself cannot decide what to load.
  const { registry, handles } = registryWith(ALWAYS_ON.map((name) => ["output", name] as [string, string]));
  assert.equal(registry.start({ onDemand: true, preload: [] }), 0);
  for (const name of ALWAYS_ON) assert.equal(handles.get(name)?.enabled, true, `${name} must stay`);
});

test("preloaded categories are not hidden in the first place", () => {
  const { registry, handles } = registryWith(sample);
  registry.start({ onDemand: true, preload: ["github"] });

  assert.equal(handles.get("gh_repo")?.enabled, true);
  assert.equal(handles.get("run_command")?.enabled, false);
  assert.deepEqual(registry.loadedCategories(), ["github"]);
});

test("loading a category reveals exactly that category", () => {
  const { registry, handles } = registryWith(sample);
  registry.start({ onDemand: true, preload: [] });

  const result = registry.load(["github"]);
  assert.deepEqual(result.loaded, ["github"]);
  assert.equal(result.revealed, 2);
  assert.equal(handles.get("gh_status")?.enabled, true);
  assert.equal(handles.get("run_command")?.enabled, false, "other categories stay hidden");
});

test("an unknown category is reported rather than silently ignored", () => {
  const { registry } = registryWith(sample);
  registry.start({ onDemand: true, preload: [] });

  const result = registry.load(["guthub", "shell"]);
  assert.deepEqual(result.unknown, ["guthub"]);
  assert.deepEqual(result.loaded, ["shell"]);

  const again = registry.load(["shell"]);
  assert.deepEqual(again.already, ["shell"]);
  assert.equal(again.revealed, 0);
});

test('"all" loads everything', () => {
  const { registry, handles } = registryWith(sample);
  registry.start({ onDemand: true, preload: [] });
  registry.load(["all"]);
  for (const [, name] of sample) assert.equal(handles.get(name)?.enabled, true, name);
});

test("calling a hidden tool loads the category that owns it", () => {
  const { registry, handles } = registryWith(sample);
  registry.start({ onDemand: true, preload: [] });

  assert.equal(registry.ensureLoadedFor("gh_repo"), true);
  assert.equal(handles.get("gh_status")?.enabled, true, "its whole category comes with it");
  assert.equal(registry.ensureLoadedFor("gh_repo"), false, "second call changes nothing");
  assert.equal(registry.ensureLoadedFor("no_such_tool"), false);
});

test("a tool the profile filtered out cannot be loaded back", () => {
  // Filtered tools are never recorded, so the registry has no way to reach them.
  const { registry } = registryWith([["github", "gh_status"]]);
  registry.start({ onDemand: true, preload: [] });
  registry.load(["all"]);
  assert.equal(registry.get("deploy"), undefined);
});

test("with on-demand off nothing is hidden and everything counts as loaded", () => {
  const { registry, handles } = registryWith(sample);
  assert.equal(registry.start({ onDemand: false, preload: [] }), 0);
  assert.equal(registry.onDemand(), false);
  assert.equal(handles.get("gh_status")?.enabled, true);
  assert.deepEqual(registry.loadedCategories(), ["files", "github", "shell"]);
});

test("the catalogue names every category and marks the loaded ones", () => {
  const { registry } = registryWith(sample);
  registry.start({ onDemand: true, preload: ["files"] });

  const text = registry.catalogue();
  for (const name of ["files", "github", "shell"]) assert.match(text, new RegExp(name));
  assert.match(text, /^\* files/m, "a loaded category is marked");
  assert.match(text, /^ {2}github/m, "an unloaded one is not");

  const counts = registry.categories();
  assert.equal(counts.find((c) => c.name === "github")?.count, 2);
});

test("the listing shows names and parameters, and titles until asked for more", () => {
  const { registry } = registryWith(sample);
  registry.start({ onDemand: true, preload: [] });

  const brief = registry.listing(["github"], false);
  assert.match(brief, /gh_status\(path\)/);
  assert.match(brief, /title of gh_status/);
  assert.doesNotMatch(brief, /description of gh_status/);
  assert.match(registry.listing(["github"], true), /description of gh_status/);
});

test("optional parameters are marked, required ones are not", () => {
  // This is all the model gets before a schema arrives, so it has to be right.
  const params = describeParams({
    path: z.string(),
    tail: z.number().optional(),
    verbose: z.boolean().default(false),
  });
  assert.deepEqual(params, ["path", "tail?", "verbose?"]);
  assert.deepEqual(describeParams(undefined), []);
});

test("an omitted parameter gets the default the SDK would have applied", () => {
  // The bug this covers, found the first time call_tool was used in anger:
  // commit_push declares attempts as .default(3). Called indirectly without it,
  // attempts arrived undefined and reached the shell as `seq 1 undefined`.
  const check = parseToolArgs(
    {
      message: z.string(),
      attempts: z.number().int().default(3),
      paths: z.array(z.string()).optional(),
    },
    { message: "docs: something" },
  );

  if (!check.ok) return assert.fail(`unexpected problems: ${check.problems.join("; ")}`);
  assert.equal(check.value.attempts, 3, "the default is filled in");
  assert.equal(check.value.message, "docs: something");
  assert.ok(!("paths" in check.value), "an absent optional stays absent");
});

test("a supplied value is never overwritten by the default", () => {
  const check = parseToolArgs({ attempts: z.number().default(3) }, { attempts: 7 });
  if (!check.ok) return assert.fail(check.problems.join("; "));
  assert.equal(check.value.attempts, 7);
});

test("bad arguments are named rather than passed to the tool", () => {
  const check = parseToolArgs({ message: z.string(), attempts: z.number().default(3) }, { attempts: "lots" });

  if (check.ok) return assert.fail("invalid arguments should not have been accepted");
  const why = check.problems.join("; ");
  assert.match(why, /message/, "the missing required one is reported");
  assert.match(why, /attempts/, "and so is the wrongly typed one");
});

test("a tool with no schema is passed through untouched", () => {
  const args = { anything: 1 };
  const check = parseToolArgs(undefined, args);
  if (!check.ok) return assert.fail(check.problems.join("; "));
  assert.deepEqual(check.value, args);
});

test('preload ["all"] is the same as not loading on demand', () => {
  const { registry, handles } = registryWith(sample);
  const hidden = registry.start({ onDemand: true, preload: ["all"] });

  assert.equal(hidden, 0, "asking for every category hides nothing");
  assert.equal(registry.onDemand(), false, "a session with nothing hidden is not on demand");
  for (const [, name] of sample) {
    assert.equal(handles.get(name)?.enabled, true, `${name} should stay visible`);
  }
  assert.deepEqual(registry.loadedCategories(), ["files", "github", "shell"]);
});
