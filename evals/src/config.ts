/**
 * The eval app's own config reader — this IS the seam.
 *
 * The benchmark app stands alone (it moves with the package to its own repo),
 * so it reads exactly the env it needs and owns its defaults. No imports from
 * the product; the only outside dependency is the package's own types.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { HeyoSandboxConfig } from "anchor-ai-sdk";
import type { HeyoSizeClass } from "anchor-ai-sdk/sandbox/heyo";

const SIZE_CLASSES: readonly HeyoSizeClass[] = [
  "micro",
  "mini",
  "small",
  "medium",
  "large",
  "xlarge",
];

/** Parse `.env` text: KEY=value lines, # comments, optional quotes. */
function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Nearest `.env`, cwd first then parents (monorepo-friendly). */
function findDotEnv(start: string): string | undefined {
  let dir = path.resolve(start);
  while (true) {
    const candidate = path.join(dir, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Fill `process.env` from a `.env` file without overwriting anything set. */
export function loadDotEnv(): void {
  const file = findDotEnv(process.cwd());
  if (!file) return; // no .env anywhere up the tree is fine — real env wins
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const [key, value] of Object.entries(parseEnvFile(text))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const optionalNumber = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

function sizeClass(value: string | undefined): HeyoSizeClass {
  const v = (value ?? "small") as HeyoSizeClass;
  if (!SIZE_CLASSES.includes(v)) {
    throw new Error(
      `HEYO_SIZE_CLASS must be one of ${SIZE_CLASSES.join(", ")} — got "${value}"`,
    );
  }
  return v;
}

export interface EvalsConfig {
  llm: {
    baseUrl: string;
    /** Required (may be undefined): matches `LLMOptions` exactly. */
    apiKey: string | undefined;
    model?: string;
    priceInPerMTok?: number;
    priceOutPerMTok?: number;
    priceCacheReadPerMTok?: number;
  };
  heyo: HeyoSandboxConfig;
}

export function evalsConfig(env: NodeJS.ProcessEnv = process.env): EvalsConfig {
  return {
    llm: {
      baseUrl: env.LLM_BASE_URL ?? "https://openrouter.ai/api/v1",
      apiKey: env.LLM_API_KEY || undefined,
      model: env.LLM_MODEL || undefined,
      priceInPerMTok: optionalNumber(env.LLM_PRICE_IN_PER_MTOK),
      priceOutPerMTok: optionalNumber(env.LLM_PRICE_OUT_PER_MTOK),
      priceCacheReadPerMTok: optionalNumber(env.LLM_PRICE_CACHE_READ),
    },
    heyo: {
      token: env.HEYO_TOKEN ?? "",
      server: env.HEYO_SERVER ?? "https://admin.us5.heyo.work",
      namespace: env.HEYO_NAMESPACE ?? "sailor",
      image: env.HEYO_IMAGE ?? "heyo/bun:latest",
      imageKind:
        env.HEYO_IMAGE_KIND === "git"
          ? "git"
          : env.HEYO_IMAGE_KIND === "dockerfile"
            ? "dockerfile"
            : "artifact",
      imageRepo: env.HEYO_IMAGE_GIT_REPO || undefined,
      imageRef: env.HEYO_IMAGE_GIT_REF || undefined,
      imageDockerfile: env.HEYO_IMAGE_GIT_DOCKERFILE || undefined,
      imageAuth: env.HEYO_IMAGE_GIT_SECRET
        ? {
            secret: env.HEYO_IMAGE_GIT_SECRET,
            ...(env.HEYO_IMAGE_GIT_SECRET_KEY
              ? { key: env.HEYO_IMAGE_GIT_SECRET_KEY }
              : {}),
          }
        : undefined,
      imageSizeMb: optionalNumber(env.HEYO_IMAGE_SIZE_MB),
      sizeClass: sizeClass(env.HEYO_SIZE_CLASS),
      diskSizeGb: Number(env.HEYO_DISK_GB ?? "4") || 4,
    },
  };
}
