/**
 * The catalog-auto LLM factory — one call that wires everything that should
 * follow from "which model":
 *
 *   fetch the provider catalog → price the client from it (live provider
 *   rates) → derive the compaction budget from the REAL context window.
 *
 * Consumers stop hand-rolling catalog→prices→compaction (that duplication
 * caused a real mispricing bug: a whole eval round billed at stale .env
 * prices), and both ends stay correct by construction. Every failure
 * degrades: no catalog → explicit overrides or fallbacks; nothing here
 * throws for metadata reasons.
 */
import {
  compactionForContextWindow,
  type CompactionConfig,
} from "../engine/compaction.js";
import { fetchModelCatalog, type ModelCatalogEntry } from "./catalog.js";
import { createLLMClient, type LLMOptions } from "./index.js";
import type { LLMClient } from "./types.js";

export interface CatalogLLMOptions {
  /** Explicit price overrides: when set, they WIN over catalog values. */
  priceInPerMTok?: number;
  priceOutPerMTok?: number;
  priceCacheReadPerMTok?: number;
  /** Opt-in provider prompt caching; see docs/prompt-caching.md. */
  promptCache?: LLMOptions["promptCache"];
  /** Extra client options passed through (e.g. includeUsageCost, timeouts). */
  extra?: Omit<Partial<LLMOptions>, "baseUrl" | "apiKey" | "model">;
  /** Compaction to use when the catalog has no window (unreachable/exotic). */
  fallbackCompaction?: CompactionConfig;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Catalog request timeout in ms. Default 5000. */
  timeoutMs?: number;
}

export interface CatalogLLM {
  llm: LLMClient;
  /** Null when the catalog was unreachable — fallbacks were used. */
  catalog: ModelCatalogEntry | null;
  /** Derived from the model's real window when known, else fallbackCompaction. */
  compaction?: CompactionConfig;
  /** True when the catalog answered: prices and window are provider-live. */
  pricedFromCatalog: boolean;
}

export async function llmFromCatalog(
  args: {
    baseUrl: string;
    apiKey: string | undefined;
    model: string;
  } & CatalogLLMOptions,
): Promise<CatalogLLM> {
  const catalog = await fetchModelCatalog({
    baseUrl: args.baseUrl,
    apiKey: args.apiKey ?? "",
    model: args.model,
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
  }).catch(() => null);

  const llm = createLLMClient({
    ...(args.extra ?? {}),
    ...(args.promptCache !== undefined
      ? { promptCache: args.promptCache }
      : {}),
    baseUrl: args.baseUrl,
    apiKey: args.apiKey,
    model: args.model,
    priceInPerMTok: args.priceInPerMTok ?? catalog?.priceInPerMTok,
    priceOutPerMTok: args.priceOutPerMTok ?? catalog?.priceOutPerMTok,
    priceCacheReadPerMTok:
      args.priceCacheReadPerMTok ?? catalog?.priceCacheReadPerMTok,
  });

  const compaction =
    catalog?.contextLength !== undefined
      ? compactionForContextWindow(catalog.contextLength)
      : args.fallbackCompaction;

  return {
    llm,
    catalog,
    ...(compaction ? { compaction } : {}),
    pricedFromCatalog: catalog !== null,
  };
}
