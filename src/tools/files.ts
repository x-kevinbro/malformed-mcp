import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import fg from "fast-glob";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runShell, shq } from "../exec.js";
import { assertWritable, errorText, fail, fromExec, ok, okImage } from "../result.js";
import { audit } from "../logger.js";
import { config } from "../config.js";

type SupportedImageFormat = "jpeg" | "png" | "gif" | "webp" | "bmp" | "tiff" | "pdf";

function sniffFormat(buf: Buffer): { format: SupportedImageFormat; mimeType: string } | null {
  // JPEG: FF D8 FF
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { format: "jpeg", mimeType: "image/jpeg" };
  }
  // PNG: 89 50 4E 47
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { format: "png", mimeType: "image/png" };
  }
  // GIF: 47 49 46 38
  if (buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return { format: "gif", mimeType: "image/gif" };
  }
  // WEBP: "RIFF"..."WEBP"
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return { format: "webp", mimeType: "image/webp" };
  }
  // BMP: 42 4D
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) {
    return { format: "bmp", mimeType: "image/bmp" };
  }
  // TIFF: 49 49 2A 00 or 4D 4D 00 2A
  if (
    buf.length >= 4 &&
    ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) ||
      (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a))
  ) {
    return { format: "tiff", mimeType: "image/tiff" };
  }
  // PDF: 25 50 44 46
  if (buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) {
    return { format: "pdf", mimeType: "application/pdf" };
  }
  return null;
}

function parseDimensionsFromBuffer(
  buf: Buffer,
  format: SupportedImageFormat,
): { width: number; height: number } | null {
  try {
    if (format === "png" && buf.length >= 24) {
      const width = buf.readUInt32BE(16);
      const height = buf.readUInt32BE(20);
      if (width > 0 && height > 0) return { width, height };
    }
    if (format === "gif" && buf.length >= 10) {
      const width = buf.readUInt16LE(6);
      const height = buf.readUInt16LE(8);
      if (width > 0 && height > 0) return { width, height };
    }
    if (format === "bmp" && buf.length >= 26) {
      const width = buf.readInt32LE(18);
      const height = Math.abs(buf.readInt32LE(22));
      if (width > 0 && height > 0) return { width, height };
    }
    if (format === "jpeg" && buf.length > 4) {
      let offset = 2;
      while (offset < buf.length - 8) {
        if (buf[offset] !== 0xff) {
          offset++;
          continue;
        }
        const marker = buf[offset + 1];
        if (
          marker !== undefined &&
          marker >= 0xc0 &&
          marker <= 0xcf &&
          marker !== 0xc4 &&
          marker !== 0xc8 &&
          marker !== 0xcc
        ) {
          const height = buf.readUInt16BE(offset + 5);
          const width = buf.readUInt16BE(offset + 7);
          if (width > 0 && height > 0) return { width, height };
        }
        const len = buf.readUInt16BE(offset + 2);
        if (len < 2) break;
        offset += 2 + len;
      }
    }
  } catch {
    /* fallback to shell identify/convert */
  }
  return null;
}

async function getImageDimensions(
  filePath: string,
  buffer?: Buffer,
  format?: SupportedImageFormat,
): Promise<{ width: number; height: number }> {
  if (buffer && format) {
    const direct = parseDimensionsFromBuffer(buffer, format);
    if (direct) return direct;
  }
  const cmd = `identify -format "%w %h" ${shq(filePath)}[0] || convert ${shq(filePath)}[0] -ping -format "%w %h" info:`;
  const result = await runShell(cmd, { timeoutMs: 15_000 });
  if (result.exitCode === 0 && result.stdout.trim()) {
    const parts = result.stdout.trim().split(/\s+/);
    if (parts.length >= 2) {
      const width = Number.parseInt(parts[0] ?? "", 10);
      const height = Number.parseInt(parts[1] ?? "", 10);
      if (!Number.isNaN(width) && !Number.isNaN(height) && width > 0 && height > 0) {
        return { width, height };
      }
    }
  }
  return { width: 0, height: 0 };
}

async function processSingleImage(
  filePath: string,
  options: {
    max_bytes: number;
    max_dimension: number;
    quality: number;
    page?: number;
    tempDir: string;
    index?: number;
  },
): Promise<{ data: string; mimeType: string; note: string }> {
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(filePath);
  } catch (error) {
    throw new Error(`cannot read file: ${errorText(error)}`);
  }

  const sniffed = sniffFormat(buffer);
  if (!sniffed) {
    throw new Error(
      `"${filePath}" is not a recognized image or PDF format (unsupported magic bytes). ` +
        `Use read_file with encoding="base64" to read arbitrary binary files.`,
    );
  }

  let sourceFile = filePath;
  const isPdf = sniffed.format === "pdf";
  let isRasterised = false;

  if (isPdf) {
    const targetPage = options.page ?? 1;
    const prefix = path.join(options.tempDir, `page-${options.index ?? 0}`);
    const cmd = `pdftoppm -r 110 -f ${targetPage} -l ${targetPage} -jpeg ${shq(filePath)} ${shq(prefix)}`;
    const result = await runShell(cmd, { timeoutMs: 30_000 });
    if (result.exitCode !== 0) {
      throw new Error(
        `pdftoppm failed on page ${targetPage}: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    const files = await fs.readdir(options.tempDir);
    const jpgFile = files.find(
      (f) => f.startsWith(`page-${options.index ?? 0}`) && (f.endsWith(".jpg") || f.endsWith(".jpeg")),
    );
    if (!jpgFile) {
      throw new Error(`pdftoppm did not produce a page image for page ${targetPage}.`);
    }
    sourceFile = path.join(options.tempDir, jpgFile);
    buffer = await fs.readFile(sourceFile);
    isRasterised = true;
  }

  const currentFormat: SupportedImageFormat = isRasterised ? "jpeg" : sniffed.format;
  const currentMimeType = isRasterised ? "image/jpeg" : sniffed.mimeType;
  const dims = await getImageDimensions(sourceFile, buffer, currentFormat);
  const longEdge = Math.max(dims.width, dims.height);

  // If not a PDF and within budget and dimensions, return unmodified original
  if (!isPdf && buffer.length <= options.max_bytes && longEdge <= options.max_dimension) {
    const note = `${dims.width}x${dims.height} ${currentMimeType}, ${buffer.length.toLocaleString()} bytes`;
    audit("read_image", {
      path: filePath,
      bytes: buffer.length,
      mimeType: currentMimeType,
      downscaled: false,
    });
    return { data: buffer.toString("base64"), mimeType: currentMimeType, note };
  }

  // Re-encode with ImageMagick bounded to 4 attempts
  let targetDimension = Math.min(longEdge || options.max_dimension, options.max_dimension);
  let targetQuality = options.quality;
  let lastOutputPath = "";
  let finalBuffer: Buffer = buffer;
  let finalWidth = dims.width;
  let finalHeight = dims.height;

  for (let attempt = 1; attempt <= 4; attempt++) {
    lastOutputPath = path.join(options.tempDir, `out-${options.index ?? 0}-${attempt}.jpg`);
    const convertCmd = `convert ${shq(sourceFile)} -auto-orient -resize ${targetDimension}x${targetDimension}\\> -quality ${targetQuality} ${shq(lastOutputPath)}`;
    const res = await runShell(convertCmd, { timeoutMs: 30_000 });
    if (res.exitCode !== 0) {
      throw new Error(`convert failed with exit code ${res.exitCode}: ${res.stderr.trim()}`);
    }
    finalBuffer = await fs.readFile(lastOutputPath);
    const outDims = await getImageDimensions(lastOutputPath, finalBuffer, "jpeg");
    finalWidth = outDims.width;
    finalHeight = outDims.height;

    if (finalBuffer.length <= options.max_bytes || attempt === 4) {
      break;
    }
    targetQuality = Math.max(40, targetQuality - 10);
    targetDimension = Math.max(100, Math.round(targetDimension * 0.8));
  }

  const finalMimeType = "image/jpeg";
  const note = `${finalWidth}x${finalHeight} ${finalMimeType}, ${finalBuffer.length.toLocaleString()} bytes [downscaled]`;
  audit("read_image", {
    path: filePath,
    bytes: finalBuffer.length,
    mimeType: finalMimeType,
    downscaled: true,
  });
  return { data: finalBuffer.toString("base64"), mimeType: finalMimeType, note };
}

export function registerFileTools(server: McpServer): void {
  server.registerTool(
    "read_file",
    {
      title: "Read a file",
      description:
        "Read a file from the VPS. Returns UTF-8 text by default; set encoding to base64 for binary files. " +
        "Use offset and limit (1-based line numbers) to page through large files.",
      inputSchema: {
        path: z.string().min(1).describe("Absolute path to the file."),
        offset: z.number().int().positive().optional().describe("First line to return (1-based)."),
        limit: z.number().int().positive().optional().describe("Maximum number of lines to return."),
        encoding: z.enum(["text", "base64"]).default("text").describe("Output encoding."),
        line_numbers: z.boolean().default(false).describe("Prefix each line with its line number."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ path: filePath, offset, limit, encoding, line_numbers }) => {
      try {
        if (encoding === "base64") {
          const buffer = await fs.readFile(filePath);
          return ok(buffer.toString("base64"));
        }
        const raw = await fs.readFile(filePath, "utf8");
        if (!offset && !limit && !line_numbers) return ok(raw);

        const lines = raw.split("\n");
        const start = Math.max(0, (offset ?? 1) - 1);
        const end = limit ? start + limit : lines.length;
        const slice = lines.slice(start, end);
        const body = line_numbers
          ? slice.map((line, index) => `${start + index + 1}\t${line}`).join("\n")
          : slice.join("\n");
        return ok(
          `# ${filePath} — lines ${start + 1}–${Math.min(end, lines.length)} of ${lines.length}\n${body}`,
        );
      } catch (error) {
        return fail(`read_file failed: ${errorText(error)}`);
      }
    },
  );

  server.registerTool(
    "read_image",
    {
      title: "Read image(s)",
      description:
        "Read one or more images or PDF files from the VPS and return their actual pixels as image blocks. " +
        "Pass either `path` for a single file or `paths` for multiple files (up to 20). Supports JPEG, PNG, " +
        "GIF, WEBP, BMP, TIFF, and PDF (rasterises requested page). Images exceeding max_bytes or max_dimension " +
        "are automatically resized and re-encoded as JPEG.",
      inputSchema: {
        path: z
          .string()
          .min(1)
          .optional()
          .describe("Absolute path to an image or PDF file (or pass `paths` for multiple files)."),
        paths: z
          .array(z.string().min(1))
          .max(20)
          .optional()
          .describe("List of absolute paths to images or PDF files (up to 20 files)."),
        max_bytes: z
          .number()
          .int()
          .positive()
          .max(5_000_000)
          .default(750_000)
          .describe("Maximum byte size per returned image payload (default: 750 KB)."),
        max_dimension: z
          .number()
          .int()
          .positive()
          .max(4000)
          .default(1400)
          .describe("Maximum pixel dimension on the long edge (default: 1400 px)."),
        quality: z
          .number()
          .int()
          .min(40)
          .max(95)
          .default(82)
          .describe("JPEG compression quality (40-95, default: 82)."),
        page: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-based page number to rasterise for PDF files (default: 1)."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ path: filePath, paths: filePaths, max_bytes, max_dimension, quality, page }) => {
      const targetPaths: string[] = [];
      if (filePath) targetPaths.push(filePath);
      if (filePaths) {
        for (const p of filePaths) {
          if (!targetPaths.includes(p)) targetPaths.push(p);
        }
      }

      if (targetPaths.length === 0) {
        return fail("read_image failed: either `path` or `paths` must be provided.");
      }

      let tempDir: string | undefined;
      try {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-read-image-"));

        // Single file mode
        if (targetPaths.length === 1) {
          const target = targetPaths[0]!;
          try {
            const img = await processSingleImage(target, {
              max_bytes,
              max_dimension,
              quality,
              page,
              tempDir,
            });
            return okImage(img.data, img.mimeType, img.note);
          } catch (error) {
            return fail(`read_image failed: ${errorText(error)}`);
          }
        }

        // Multiple files mode
        const images: Array<{ data: string; mimeType: string; note?: string }> = [];
        const errorBlocks: Array<{ type: "text"; text: string }> = [];

        for (let i = 0; i < targetPaths.length; i++) {
          const target = targetPaths[i]!;
          try {
            const img = await processSingleImage(target, {
              max_bytes,
              max_dimension,
              quality,
              page,
              tempDir,
              index: i,
            });
            images.push({
              data: img.data,
              mimeType: img.mimeType,
              note: `=== ${target} ===\n${img.note}`,
            });
          } catch (error) {
            errorBlocks.push({
              type: "text",
              text: `=== ${target} ===\n(unreadable: ${errorText(error)})`,
            });
          }
        }

        const result = okImage(images);
        if (errorBlocks.length > 0) {
          result.content.unshift(...errorBlocks);
        }
        return result;
      } catch (error) {
        return fail(`read_image failed: ${errorText(error)}`);
      } finally {
        if (tempDir) {
          await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    },
  );

  server.registerTool(
    "write_file",
    {
      title: "Write a file",
      description:
        "Create or overwrite a file. Parent directories are created automatically. Use encoding base64 for binary, " +
        "append to add to the end, and backup to keep a .bak copy of the previous contents.",
      inputSchema: {
        path: z.string().min(1).describe("Absolute path to write."),
        content: z.string().describe("File contents."),
        encoding: z.enum(["text", "base64"]).default("text").describe("Encoding of `content`."),
        append: z.boolean().default(false).describe("Append instead of overwriting."),
        mode: z
          .string()
          .regex(/^[0-7]{3,4}$/)
          .optional()
          .describe('Octal permissions, e.g. "600" or "755".'),
        backup: z.boolean().default(false).describe("Copy any existing file to <path>.bak first."),
      },
      annotations: { destructiveHint: true },
    },
    async ({ path: filePath, content, encoding, append, mode, backup }) => {
      try {
        assertWritable("write_file");
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        let backedUp = false;
        if (backup) {
          try {
            await fs.copyFile(filePath, `${filePath}.bak`);
            backedUp = true;
          } catch {
            /* nothing to back up */
          }
        }
        const data = encoding === "base64" ? Buffer.from(content, "base64") : content;
        if (append) await fs.appendFile(filePath, data);
        else await fs.writeFile(filePath, data);
        if (mode) await fs.chmod(filePath, Number.parseInt(mode, 8));

        const stat = await fs.stat(filePath);
        audit("write_file", { path: filePath, bytes: stat.size, append, mode });
        return ok(
          `Wrote ${filePath} (${stat.size} bytes)${append ? " [appended]" : ""}${
            backedUp ? `\nBackup: ${filePath}.bak` : ""
          }`,
        );
      } catch (error) {
        return fail(`write_file failed: ${errorText(error)}`);
      }
    },
  );

  server.registerTool(
    "edit_file",
    {
      title: "Find and replace in a file",
      description:
        "Exact string replacement inside an existing file. old_string must occur exactly once unless replace_all " +
        "is set. Prefer this over write_file for surgical edits to config and source files.",
      inputSchema: {
        path: z.string().min(1).describe("Absolute path to the file."),
        old_string: z.string().min(1).describe("Exact text to find, including whitespace."),
        new_string: z.string().describe("Replacement text. Empty string deletes the match."),
        replace_all: z.boolean().default(false).describe("Replace every occurrence."),
        backup: z
          .boolean()
          .default(false)
          .describe(
            "Copy the original to <path>.bak first. Off by default because these accumulate " +
              "and get committed by accident; git already is the backup in a repository.",
          ),
      },
      annotations: { destructiveHint: true },
    },
    async ({ path: filePath, old_string, new_string, replace_all, backup }) => {
      try {
        assertWritable("edit_file");
        const raw = await fs.readFile(filePath, "utf8");
        const occurrences = raw.split(old_string).length - 1;
        if (occurrences === 0) return fail(`No match for old_string in ${filePath}.`);
        if (occurrences > 1 && !replace_all) {
          return fail(
            `old_string occurs ${occurrences} times in ${filePath}. Pass replace_all, or extend old_string until it is unique.`,
          );
        }
        if (backup) await fs.copyFile(filePath, `${filePath}.bak`);
        const updated = replace_all
          ? raw.split(old_string).join(new_string)
          : raw.replace(old_string, new_string);
        await fs.writeFile(filePath, updated, "utf8");
        const changed = replace_all ? occurrences : 1;
        audit("edit_file", { path: filePath, replacements: changed });
        return ok(
          `Replaced ${changed} occurrence(s) in ${filePath}.${backup ? ` Backup: ${filePath}.bak` : ""}`,
        );
      } catch (error) {
        return fail(`edit_file failed: ${errorText(error)}`);
      }
    },
  );

  server.registerTool(
    "list_dir",
    {
      title: "List a directory",
      description:
        "List directory contents with permissions, sizes and timestamps. Can recurse to a given depth.",
      inputSchema: {
        path: z.string().min(1).describe("Absolute directory path."),
        depth: z
          .number()
          .int()
          .min(1)
          .max(6)
          .default(1)
          .describe("Recursion depth. 1 = this directory only."),
        all: z.boolean().default(false).describe("Include dotfiles."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ path: dirPath, depth, all }) => {
      const command =
        depth === 1
          ? `ls -lh${all ? "A" : ""} --time-style=long-iso ${shq(dirPath)}`
          : `find ${shq(dirPath)} -maxdepth ${depth} ${all ? "" : "-not -path '*/.*'"} -printf '%M %8s %TY-%Tm-%Td %TH:%TM %p\\n' | sort -k5`;
      const result = await runShell(command, { timeoutMs: 30_000 });
      return fromExec(result);
    },
  );

  server.registerTool(
    "find_files",
    {
      title: "Find files by glob",
      description:
        "Find files matching a glob pattern, e.g. **/*.ts or nginx/vhosts/*.conf. Fast and gitignore-aware.",
      inputSchema: {
        pattern: z.string().min(1).describe("Glob pattern relative to `cwd`."),
        cwd: z.string().optional().describe(`Directory to search from. Defaults to ${config.defaultCwd}.`),
        limit: z.number().int().positive().max(2000).default(300).describe("Maximum results."),
        include_hidden: z.boolean().default(false).describe("Include dotfiles."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ pattern, cwd, limit, include_hidden }) => {
      try {
        const root = cwd ?? config.defaultCwd;
        const matches = await fg(pattern, {
          cwd: root,
          absolute: true,
          dot: include_hidden,
          onlyFiles: false,
          followSymbolicLinks: false,
          suppressErrors: true,
          ignore: ["**/node_modules/**", "**/.git/**"],
        });
        if (matches.length === 0) return ok(`No files match ${pattern} under ${root}.`);
        const shown = matches.slice(0, limit);
        return ok(
          `${matches.length} match(es) for ${pattern} under ${root}` +
            (matches.length > shown.length ? ` (showing ${shown.length})` : "") +
            `\n\n${shown.join("\n")}`,
        );
      } catch (error) {
        return fail(`find_files failed: ${errorText(error)}`);
      }
    },
  );

  server.registerTool(
    "search_files",
    {
      title: "Search file contents",
      description:
        "Recursively grep file contents for a pattern. Uses ripgrep when installed, otherwise grep -rn.",
      inputSchema: {
        pattern: z.string().min(1).describe("Text or regular expression to search for."),
        path: z.string().optional().describe(`Directory to search. Defaults to ${config.defaultCwd}.`),
        glob: z.string().optional().describe('Filename filter, e.g. "*.ts".'),
        max_results: z.number().int().positive().max(2000).default(200).describe("Maximum matching lines."),
        ignore_case: z.boolean().default(false).describe("Case-insensitive search."),
        literal: z
          .boolean()
          .default(false)
          .describe("Treat `pattern` as a literal string rather than a regular expression."),
        context: z
          .number()
          .int()
          .min(0)
          .max(20)
          .default(0)
          .describe("Lines of surrounding context to include with each match."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ pattern, path: root, glob, max_results, ignore_case, literal, context: contextLines }) => {
      const target = root ?? config.defaultCwd;

      // A missing path used to look identical to "no matches". Distinguish them.
      let isDirectory: boolean;
      try {
        isDirectory = (await fs.stat(target)).isDirectory();
      } catch (error) {
        return fail(`search_files: cannot access ${target}: ${errorText(error)}`);
      }

      // -E, not the default BRE. Plain `grep` treats | ( ) + ? as literal characters,
      // so an alternation like `foo|bar` silently matched nothing and looked like a
      // clean "not found". That produced false negatives for a long time.
      const flags = [
        "-n",
        "-H",
        isDirectory ? "-r" : "",
        literal ? "-F" : "-E",
        ignore_case ? "-i" : "",
        contextLines > 0 ? `-C ${contextLines}` : "",
        glob && isDirectory ? `--include=${shq(glob)}` : "",
        "--binary-files=without-match",
        "--exclude-dir=.git",
        "--exclude-dir=node_modules",
        "--exclude-dir=.next",
        "--exclude-dir=dist",
      ]
        .filter(Boolean)
        .join(" ");

      const command = `grep ${flags} -e ${shq(pattern)} ${shq(target)} | head -n ${max_results}`;
      const result = await runShell(command, { timeoutMs: 60_000 });
      const hits = result.stdout.trimEnd();
      const mode = literal ? "fixed string" : "extended regex";
      const header =
        `$ ${command}\n` +
        `engine=grep · ${mode} · ${isDirectory ? "recursive" : "single file"} · target=${target}`;

      if (!hits) {
        return ok(
          `${header}\n\nNo matches.\n\n` +
            `Searched as ${mode}. .git, node_modules, dist, .next and binary files are skipped` +
            `${glob ? `, and only files matching ${glob} were considered` : ""}. ` +
            `${literal ? "" : "If the pattern contains . * + ? ( ) | [ ] { } ^ $ they are regex operators — pass literal:true to match them exactly. "}` +
            `${result.stderr.trim() ? `\n\nstderr: ${result.stderr.trim()}` : ""}`,
        );
      }

      const lineCount = hits.split("\n").length;
      const truncated = lineCount >= max_results;
      return ok(
        `${header} · ${lineCount} line(s)${truncated ? ` · TRUNCATED at max_results=${max_results}` : ""}\n\n${hits}`,
      );
    },
  );

  server.registerTool(
    "manage_path",
    {
      title: "Move, copy, delete, chmod or chown",
      description: "Filesystem housekeeping operations on a path.",
      inputSchema: {
        action: z
          .enum(["move", "copy", "delete", "mkdir", "chmod", "chown", "touch"])
          .describe("Operation to perform."),
        path: z.string().min(1).describe("Target path."),
        dest: z.string().optional().describe("Destination path, required for move and copy."),
        recursive: z.boolean().default(false).describe("Recurse for delete, copy, chmod and chown."),
        value: z
          .string()
          .optional()
          .describe('Mode for chmod (e.g. "640") or owner for chown (e.g. "www-data:www-data").'),
      },
      annotations: { destructiveHint: true },
    },
    async ({ action, path: target, dest, recursive, value }) => {
      assertWritable("manage_path");
      const R = recursive ? "-r" : "";
      let command: string;
      switch (action) {
        case "move":
          if (!dest) return fail("dest is required for move.");
          command = `mv -v ${shq(target)} ${shq(dest)}`;
          break;
        case "copy":
          if (!dest) return fail("dest is required for copy.");
          command = `cp -v ${R} ${shq(target)} ${shq(dest)}`;
          break;
        case "delete":
          // The flags are one token: `-v ${R}f` renders as `rm -v f <path>` when R is
          // empty, so rm takes "f" for a filename and exits 1 on a delete that worked.
          command = `rm -v${recursive ? "r" : ""}f ${shq(target)}`;
          break;
        case "mkdir":
          command = `mkdir -pv ${shq(target)}`;
          break;
        case "touch":
          command = `touch ${shq(target)} && ls -l ${shq(target)}`;
          break;
        case "chmod":
          if (!value) return fail("value is required for chmod.");
          command = `chmod ${R} ${shq(value)} ${shq(target)}`;
          break;
        case "chown":
          if (!value) return fail("value is required for chown.");
          command = `chown ${R} ${shq(value)} ${shq(target)}`;
          break;
      }
      audit("manage_path", { action, path: target, dest, value });
      const result = await runShell(command, { timeoutMs: 120_000 });
      return fromExec(result, `$ ${command}`);
    },
  );
}
