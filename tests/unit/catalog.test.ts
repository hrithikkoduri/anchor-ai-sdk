/**
 * Provider model catalog — mocked fetch, no network. Every failure mode must
 * degrade to null so callers keep their fallback values.
 */
import { describe, expect, it } from "vitest";
import { fetchModelCatalog } from "../../src/llm/catalog.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** OpenRouter shape, with the deepseek-v4.1-flash numbers we verified. */
const MODELS = {
  data: [
    {
      id: "deepseek/deepseek-v4.1-flash",
      context_length: 1_048_576,
      pricing: {
        prompt: "0.00000004",
        completion: "0.000000144",
        input_cache_read: "0.0000000016",
      },
    },
  ],
};

describe("fetchModelCatalog", () => {
  it("reads the window and converts per-token prices to per-million", async () => {
    const entry = await fetchModelCatalog({
      baseUrl: "https://openrouter.ai/api/v1/",
      apiKey: "k",
      model: "deepseek/deepseek-v4.1-flash",
      fetchImpl: async (url) => {
        expect(String(url)).toBe("https://openrouter.ai/api/v1/models");
        return json(MODELS);
      },
    });
    expect(entry).toEqual({
      contextLength: 1_048_576,
      priceInPerMTok: 0.04,
      priceOutPerMTok: 0.144,
      priceCacheReadPerMTok: 0.0016,
    });
  });

  it("returns null for a missing model, a non-ok response, or a failure", async () => {
    const args = {
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      model: "ghost/model",
    };
    expect(
      await fetchModelCatalog({
        ...args,
        fetchImpl: async () => json({ data: [] }),
      }),
    ).toBeNull();
    expect(
      await fetchModelCatalog({
        ...args,
        fetchImpl: async () => json({ error: "nope" }, 404),
      }),
    ).toBeNull();
    expect(
      await fetchModelCatalog({
        ...args,
        fetchImpl: async () => {
          throw new Error("offline");
        },
      }),
    ).toBeNull();
  });
});
