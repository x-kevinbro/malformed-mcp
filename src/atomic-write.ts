import fs from "node:fs/promises";

/**
 * Replace a file's contents without ever leaving it half-written.
 *
 * The write goes to a sibling which is then renamed over the original, because
 * rename is atomic within a filesystem: an interrupted write cannot truncate a
 * file that something else is about to read.
 *
 * The subtlety, and the reason this is its own module rather than four lines
 * inside patch_file: a freshly created sibling gets the default mode, so the
 * rename silently replaces the original's permissions. Patching a shell script
 * in place therefore removed its execute bit, and the next release died with
 * "Permission denied" before it did anything. The mode of the file being
 * replaced is carried across.
 *
 * This file imports nothing but node:fs/promises - no config, no logger - so
 * it can be tested without a configured environment.
 */
export async function writeAtomicPreservingMode(filePath: string, contents: string): Promise<void> {
  const temp = `${filePath}.mcp-tmp`;
  const { mode } = await fs.stat(filePath);
  await fs.writeFile(temp, contents, "utf8");
  await fs.chmod(temp, mode);
  await fs.rename(temp, filePath);
}
