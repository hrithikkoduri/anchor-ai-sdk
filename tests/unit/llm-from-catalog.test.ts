/**
 * One call wires model → catalog → prices → compaction window. The precedence
 * rule (explicit overrides win; catalog next; degrade silently to fallbacks)
 * is exactly what two consumers drifted apart on — a stale-.env mispricing
 * that took a whole eval round to notice — so it is pinned here.
 */
import { describe, expect, it } from "vitest";
import { compactionForContextWindow } from "../../src/engine/compaction.js";
import { llmFromCatalog } from "../../src/llm/from-catalog.js";

/** The catalog answered with our model (OpenRouter-shaped, per-token strings). */
function fetchResponding(body: unknown): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  })) as unknown as typeof fetch;
}

function fetchThrowing(): typeof fetch {
  return (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;
}

const MODEL = "test/model";

describe("llmFromCatalog", () => {
  it("prices from the catalog and derives compaction from the real window", async () => {
    const built = await llmFromCatalog({
      baseUrl: "https://provider.test/api/v1",
      apiKey: "test-key",
      model: MODEL,
      fetchImpl: fetchResponding({
        data: [
          {
            id: MODEL,
            context_length: 400_000,
            pricing: { prompt: "0.000002", completion: "0.00001" },
          },
        ],
      }),
    });
    expect(built.pricedFromCatalog).toBe(true);
    expect(built.catalog?.contextLength).toBe(400_000);
    expect(built.catalog?.priceInPerMTok).toBe(2); // per-token → per-million
    expect(built.catalog?.priceOutPerMTok).toBe(10);
    expect(built.compaction).toEqual(compactionForContextWindow(400_000));
    expect(built.llm.complete).toBeTypeOf("function");
  });

  it("degrades to the explicit fallback when the catalog is unreachable", async () => {
    const fallbackCompaction = {
      maxEstimatedTokens: 256_000,
      keepRecentTokens: 64_000,
    };
    const built = await llmFromCatalog({
      baseUrl: "https://provider.test/api/v1",
      apiKey: "test-key",
      model: MODEL,
      fetchImpl: fetchThrowing(),
      fallbackCompaction,
    });
    expect(built.pricedFromCatalog).toBe(false);
    expect(built.catalog).toBeNull();
    expect(built.compaction).toEqual(fallbackCompaction);
  });

  it("leaves compaction undefined when neither catalog nor fallback is known", async () => {
    const built = await llmFromCatalog({
      baseUrl: "https://provider.test/api/v1",
      apiKey: "test-key",
      model: MODEL,
      fetchImpl: fetchThrowing(),
    });
    expect(built.compaction).toBeUndefined();
  });

  it("still surfaces the package's clear error when the key is missing", async () => {
    await expect(
      llmFromCatalog({
        baseUrl: "https://provider.test/api/v1",
        apiKey: undefined,
        model: MODEL,
        fetchImpl: fetchThrowing(),
      }),
    ).rejects.toThrow(/LLM_API_KEY/);
  });
});
