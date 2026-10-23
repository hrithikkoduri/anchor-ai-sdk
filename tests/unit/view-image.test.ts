import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { local } from "../../src/sandbox/local/index.js";
import { createViewImageTool, type ViewImageInput } from "../../src/tools/index.js";
import type { Sandbox } from "../../src/sandbox/types.js";

const roots: string[] = [];
async function sandbox(): Promise<Sandbox> {
  const root = await mkdtemp(path.join(os.tmpdir(), "anchor-view-image-"));
  roots.push(root);
  const box = local({ rootDir: root, quiet: true }).create({});
  await box.start();
  return box;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("view_image", () => {
  it("passes image bytes to the consumer vision function", async () => {
    const box = await sandbox();
    try {
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
      await writeFile(path.join(box.workspace, "tiny.png"), bytes);
      let seen: ViewImageInput | undefined;
      const tool = createViewImageTool({
        describe: async (input) => {
          seen = input;
          return "a tiny image";
        },
      });
      const result = await tool.run(
        { path: "tiny.png", prompt: "what is this?" },
        { sandbox: box },
      );
      expect(result.ok).toBe(true);
      expect(result.content).toContain("a tiny image");
      expect(seen).toMatchObject({
        path: "tiny.png",
        mime: "image/png",
        sizeBytes: bytes.length,
        prompt: "what is this?",
      });
      expect(seen!.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    } finally {
      await box.destroy();
    }
  });

  it("rejects unsupported extensions before calling the vision function", async () => {
    const box = await sandbox();
    try {
      const tool = createViewImageTool({ describe: () => "unused" });
      const result = await tool.run({ path: "notes.txt" }, { sandbox: box });
      expect(result.ok).toBe(false);
      expect(result.content).toContain("unsupported image extension");
    } finally {
      await box.destroy();
    }
  });
});
