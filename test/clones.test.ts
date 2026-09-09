import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { listClonesIn, parseHeadRef } from "../src/github/store.js";

/** A fake profile folder: <repo>_work directories, each with a .git/HEAD. */
function profileFolder(clones: Record<string, string | null>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "malformed-mcp-clones-"));
  for (const [name, head] of Object.entries(clones)) {
    const work = path.join(dir, name);
    if (head === null) {
      mkdirSync(work, { recursive: true }); // present, but not a checkout
      continue;
    }
    mkdirSync(path.join(work, ".git"), { recursive: true });
    writeFileSync(path.join(work, ".git", "HEAD"), head);
  }
  return dir;
}

test("a missing profile folder lists nothing rather than throwing", () => {
  // A profile that has never cloned anything has no folder at all, and that is
  // an ordinary state, not an error.
  assert.deepEqual(listClonesIn(path.join(tmpdir(), "malformed-mcp-does-not-exist")), []);
});

test("clones are listed by repo name with the _work suffix stripped", () => {
  const dir = profileFolder({
    "BugSniffer-X_work": "ref: refs/heads/main\n",
    ByteLink_work: "ref: refs/heads/develop\n",
  });
  try {
    const clones = listClonesIn(dir);
    assert.deepEqual(
      clones.map((c) => c.repo),
      ["BugSniffer-X", "ByteLink"],
    );
    assert.deepEqual(
      clones.map((c) => c.branch),
      ["main", "develop"],
    );
    assert.equal(clones[0]!.path, path.join(dir, "BugSniffer-X_work"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only _work directories count, so the folder can hold other things", () => {
  const dir = profileFolder({ Real_work: "ref: refs/heads/main\n", notes: null });
  try {
    assert.deepEqual(
      listClonesIn(dir).map((c) => c.repo),
      ["Real"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a directory without .git reports an unknown branch instead of failing", () => {
  const dir = profileFolder({ Empty_work: null });
  try {
    const clones = listClonesIn(dir);
    assert.equal(clones.length, 1, "the folder is still worth reporting");
    assert.equal(clones[0]!.branch, "?");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listing is sorted, so repeated calls read the same way", () => {
  const dir = profileFolder({
    zeta_work: "ref: refs/heads/main\n",
    alpha_work: "ref: refs/heads/main\n",
    Mid_work: "ref: refs/heads/main\n",
  });
  try {
    const names = listClonesIn(dir).map((c) => c.repo);
    assert.deepEqual(
      names,
      [...names].sort((a, b) => a.localeCompare(b)),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseHeadRef reads a branch, a detached HEAD and an empty file", () => {
  assert.equal(parseHeadRef("ref: refs/heads/main\n"), "main");
  // Slashes are legal in branch names and must survive intact.
  assert.equal(parseHeadRef("ref: refs/heads/feature/clone-listing\n"), "feature/clone-listing");
  assert.equal(parseHeadRef("d39f1d4c8a2b1e0f9a7c6d5e4b3a2918f7e6d5c4\n"), "detached d39f1d4c");
  assert.equal(parseHeadRef("   "), "?");
});
