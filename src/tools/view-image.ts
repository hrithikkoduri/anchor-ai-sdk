/**
 * view_image — bridge an image in the sandbox to a text-only agent through a
 * consumer-supplied vision function. Anchor does not upload, store, or choose
 * a vision model; it reads the bytes and hands the consumer a data URL.
 */
import path from "node:path";
import { shq } from "../sandbox/types.js";
import { spillOrTruncate } from "./truncate.js";
import {
  defineTool,
  optionalString,
  requireSandbox,
  requireString,
} from "./types.js";
import type { Tool } from "./types.js";

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export interface ViewImageInput {
  path: string;
  mime: string;
  sizeBytes: number;
  base64: string;
  dataUrl: string;
  prompt?: string;
}

export interface ViewImageOptions {
  /**
   * Consumer-owned vision step. Usually calls a vision-capable model or an
   * OCR service and returns the text to show the agent.
   */
  describe: (input: ViewImageInput) => Promise<string> | string;
  /** Refuse larger files. Default 8 MiB. */
  maxBytes?: number;
}

export function createViewImageTool(options: ViewImageOptions): Tool {
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  return defineTool(
    {
      name: "view_image",
      description:
        "Inspect an image in the sandbox and return a textual description. " +
        "Use this when the model cannot receive image parts directly.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Image path relative to the repo root, or absolute.",
          },
          prompt: {
            type: "string",
            description: "Optional question about the image.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    async (input, ctx) => {
      const file = requireString(input, "path");
      const prompt = optionalString(input, "prompt");
      const sandbox = requireSandbox(ctx);
      const extension = path.extname(file).toLowerCase();
      const mime = MIME_BY_EXTENSION[extension];
      if (!mime) {
        return {
          ok: false,
          content: `unsupported image extension ${extension || "(none)"}; expected ${Object.keys(MIME_BY_EXTENSION).join(", ")}`,
          meta: { path: file },
        };
      }

      const stat = await sandbox.exec(`wc -c < ${shq(file)}`, {
        timeoutSecs: 30,
        concurrent: true,
      });
      if (stat.exitCode !== 0) {
        return {
          ok: false,
          content: `cannot stat ${file}: ${(stat.stderr || stat.output).trim()}`,
          meta: { path: file },
        };
      }
      const sizeBytes = Number(stat.stdout.trim());
      if (!Number.isFinite(sizeBytes) || sizeBytes < 1) {
        return {
          ok: false,
          content: `cannot read ${file}: empty or unreadable`,
          meta: { path: file },
        };
      }
      if (sizeBytes > maxBytes) {
        return {
          ok: false,
          content: `image is ${sizeBytes} bytes; limit is ${maxBytes} bytes`,
          meta: { path: file, sizeBytes },
        };
      }

      const encoded = await sandbox.exec(
        `base64 < ${shq(file)} | tr -d '\\n'`,
        { timeoutSecs: 60, concurrent: true },
      );
      if (encoded.exitCode !== 0) {
        return {
          ok: false,
          content: `cannot encode ${file}: ${(encoded.stderr || encoded.output).trim()}`,
          meta: { path: file, sizeBytes },
        };
      }
      const base64 = encoded.stdout.trim();
      if (!base64) {
        return {
          ok: false,
          content: `cannot encode ${file}: empty image data`,
          meta: { path: file, sizeBytes },
        };
      }

      const description = await options.describe({
        path: file,
        mime,
        sizeBytes,
        base64,
        dataUrl: `data:${mime};base64,${base64}`,
        ...(prompt ? { prompt } : {}),
      });
      return {
        ok: true,
        content: await spillOrTruncate(description, {
          sandbox,
          label: "view_image",
        }),
        meta: { path: file, mime, sizeBytes },
      };
    },
    { readOnly: true, verb: "Inspecting an image" },
  );
}
