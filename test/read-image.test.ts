import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerFileTools } from "../src/tools/files.js";
import { okImage, type ToolResult, type ImageContentBlock, type TextContentBlock } from "../src/result.js";
import { runShell, shq } from "../exec.js";

type ToolHandler = (args: any) => Promise<ToolResult>;

function getFileTools() {
  const tools = new Map<string, { config: any; handler: ToolHandler }>();
  const fakeServer = {
    registerTool(name: string, config: any, handler: ToolHandler) {
      tools.set(name, { config, handler });
    },
  };
  registerFileTools(fakeServer as any);
  return tools;
}

// Minimal valid 1x1 PNG bytes
const MINIMAL_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
  0x00, 0x00, 0x00, 0x0d, // IHDR chunk length (13)
  0x49, 0x48, 0x44, 0x52, // "IHDR"
  0x00, 0x00, 0x00, 0x01, // width: 1
  0x00, 0x00, 0x00, 0x01, // height: 1
  0x08, 0x06, 0x00, 0x00, 0x00, // 8-bit RGBA
  0x1f, 0x15, 0xc4, 0x89, // CRC
  0x00, 0x00, 0x00, 0x0a, // IDAT chunk length (10)
  0x49, 0x44, 0x41, 0x54, // "IDAT"
  0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, // compressed zlib stream
  0x0d, 0x0a, 0x2d, 0xb4, // CRC
  0x00, 0x00, 0x00, 0x00, // IEND chunk length (0)
  0x49, 0x45, 0x4e, 0x44, // "IEND"
  0xae, 0x42, 0x60, 0x82, // CRC
]);

// Minimal valid 1x1 GIF bytes
const MINIMAL_GIF = Buffer.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // GIF89a
  0x01, 0x00, 0x01, 0x00, // 1x1
  0x80, 0x00, 0x00, // color table
  0xff, 0xff, 0xff, 0x00, 0x00, 0x00,
  0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00,
  0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
]);

// Minimal valid 1x1 JPEG bytes
const MINIMAL_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48,
  0x00, 0x48, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08,
  0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
  0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20, 0x24, 0x2e, 0x27, 0x20,
  0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29, 0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27,
  0x39, 0x3d, 0x38, 0x32, 0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
  0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01,
  0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04,
  0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f,
  0x00, 0xbf, 0x00, 0xff, 0xd9,
]);

test("okImage builds correct ToolResult structure with and without note", () => {
  const resultWithNote = okImage("base64payload", "image/jpeg", "100x100 note");
  assert.equal(resultWithNote.content.length, 2);
  assert.equal(resultWithNote.content[0]?.type, "text");
  assert.match((resultWithNote.content[0] as TextContentBlock).text, /100x100 note/);
  assert.equal(resultWithNote.content[1]?.type, "image");
  assert.equal((resultWithNote.content[1] as ImageContentBlock).data, "base64payload");
  assert.equal((resultWithNote.content[1] as ImageContentBlock).mimeType, "image/jpeg");

  const resultNoNote = okImage("base64payload2", "image/png");
  assert.equal(resultNoNote.content.length, 1);
  assert.equal(resultNoNote.content[0]?.type, "image");
  assert.equal((resultNoNote.content[0] as ImageContentBlock).data, "base64payload2");
});

test("non-image file is rejected with a pointer to read_file base64", async () => {
  const tools = getFileTools();
  const readImage = tools.get("read_image")?.handler;
  assert.ok(readImage, "read_image tool must be registered");

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-test-"));
  try {
    const textFile = path.join(tmpDir, "plain.txt");
    await fs.writeFile(textFile, "Hello world, this is not an image.", "utf8");

    const result = await readImage({
      path: textFile,
      max_bytes: 750000,
      max_dimension: 1400,
      quality: 82,
    });

    assert.equal(result.isError, true);
    assert.equal(result.content[0]?.type, "text");
    const text = (result.content[0] as TextContentBlock).text;
    assert.match(text, /read_file/);
    assert.match(text, /base64/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("magic-byte sniffing identifies format even with mislabelled extension", async () => {
  const tools = getFileTools();
  const readImage = tools.get("read_image")?.handler;
  assert.ok(readImage);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-test-"));
  try {
    // PNG data in a file named something.txt
    const mislabelled = path.join(tmpDir, "photo.txt");
    await fs.writeFile(mislabelled, MINIMAL_PNG);

    const result = await readImage({
      path: mislabelled,
      max_bytes: 750000,
      max_dimension: 1400,
      quality: 82,
    });

    assert.equal(result.isError, undefined);
    const img = result.content.find((b): b is ImageContentBlock => b.type === "image");
    assert.ok(img, "Must contain an image block");
    assert.equal(img.mimeType, "image/png");
    assert.equal(img.data, MINIMAL_PNG.toString("base64"));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("unmodified image returns byte-identical base64 without going through render", async () => {
  const tools = getFileTools();
  const readImage = tools.get("read_image")?.handler;
  assert.ok(readImage);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-test-"));
  try {
    const jpegFile = path.join(tmpDir, "test.jpg");
    await fs.writeFile(jpegFile, MINIMAL_JPEG);

    const result = await readImage({
      path: jpegFile,
      max_bytes: 750000,
      max_dimension: 1400,
      quality: 82,
    });

    assert.equal(result.isError, undefined);
    const img = result.content.find((b): b is ImageContentBlock => b.type === "image");
    assert.ok(img);
    assert.equal(img.mimeType, "image/jpeg");
    // Byte identical to on-disk buffer
    assert.equal(img.data, MINIMAL_JPEG.toString("base64"));

    const txt = result.content.find((b): b is TextContentBlock => b.type === "text");
    assert.ok(txt);
    assert.doesNotMatch(txt.text, /\[downscaled\]/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("large image is re-encoded under max_bytes and max_dimension", async () => {
  const tools = getFileTools();
  const readImage = tools.get("read_image")?.handler;
  assert.ok(readImage);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-test-"));
  try {
    const largeFile = path.join(tmpDir, "large.jpg");
    // Try to generate 4160x3120 test image with convert
    const gen = await runShell(`convert -size 4160x3120 plasma:fractal -quality 95 ${shq(largeFile)}`, {
      timeoutMs: 30_000,
    });

    if (gen.exitCode !== 0) {
      // If convert cannot generate plasma, create a simple colored canvas
      await runShell(`convert -size 4160x3120 xc:blue -quality 95 ${shq(largeFile)}`, { timeoutMs: 30_000 });
    }

    const stat = await fs.stat(largeFile).catch(() => null);
    if (!stat) {
      // If ImageMagick is not available in test runner, skip execution
      return;
    }

    const result = await readImage({
      path: largeFile,
      max_bytes: 750000,
      max_dimension: 1400,
      quality: 82,
    });

    assert.equal(result.isError, undefined);
    const img = result.content.find((b): b is ImageContentBlock => b.type === "image");
    assert.ok(img);
    assert.equal(img.mimeType, "image/jpeg");

    const decoded = Buffer.from(img.data, "base64");
    assert.ok(decoded.length <= 750000, `Output bytes ${decoded.length} must be <= 750000`);

    const txt = result.content.find((b): b is TextContentBlock => b.type === "text");
    assert.ok(txt);
    assert.match(txt.text, /\[downscaled\]/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("multiple images can be read in one call via paths", async () => {
  const tools = getFileTools();
  const readImage = tools.get("read_image")?.handler;
  assert.ok(readImage);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-test-"));
  try {
    const pngFile = path.join(tmpDir, "img1.png");
    const gifFile = path.join(tmpDir, "img2.gif");
    const badFile = path.join(tmpDir, "bad.txt");

    await fs.writeFile(pngFile, MINIMAL_PNG);
    await fs.writeFile(gifFile, MINIMAL_GIF);
    await fs.writeFile(badFile, "not an image");

    const result = await readImage({
      paths: [pngFile, gifFile, badFile],
      max_bytes: 750000,
      max_dimension: 1400,
      quality: 82,
    });

    const imageBlocks = result.content.filter((b): b is ImageContentBlock => b.type === "image");
    assert.equal(imageBlocks.length, 2, "Expected 2 valid image blocks");
    assert.equal(imageBlocks[0]?.mimeType, "image/png");
    assert.equal(imageBlocks[1]?.mimeType, "image/gif");

    const textBlocks = result.content.filter((b): b is TextContentBlock => b.type === "text");
    const badReport = textBlocks.find((b) => b.text.includes("bad.txt"));
    assert.ok(badReport, "Unreadable/invalid file must be reported in a text block");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
