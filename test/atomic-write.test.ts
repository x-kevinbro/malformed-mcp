import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeAtomicPreservingMode } from "../src/atomic-write.js";

async function tempFile(contents: string, mode: number): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atomic-write-"));
  const file = path.join(dir, "script.sh");
  await fs.writeFile(file, contents, "utf8");
  await fs.chmod(file, mode);
  return file;
}

test("the new contents replace the old", async () => {
  const file = await tempFile("old", 0o644);
  await writeAtomicPreservingMode(file, "new");
  assert.equal(await fs.readFile(file, "utf8"), "new");
});

/**
 * The regression. Patching swap.sh through the rename path left it at 0644,
 * and systemd-run then refused to execute it.
 */
test("an executable file is still executable afterwards", async () => {
  const file = await tempFile("#!/bin/sh\necho hi\n", 0o755);
  await writeAtomicPreservingMode(file, "#!/bin/sh\necho bye\n");
  const { mode } = await fs.stat(file);
  assert.equal(mode & 0o777, 0o755);
});

/** The same bug in the other direction: a 0600 file must not be widened. */
test("a restrictive mode is not widened", async () => {
  const file = await tempFile("secret", 0o600);
  await writeAtomicPreservingMode(file, "still secret");
  const { mode } = await fs.stat(file);
  assert.equal(mode & 0o777, 0o600);
});

test("the temporary sibling does not survive", async () => {
  const file = await tempFile("x", 0o644);
  await writeAtomicPreservingMode(file, "y");
  await assert.rejects(() => fs.stat(`${file}.mcp-tmp`));
});
