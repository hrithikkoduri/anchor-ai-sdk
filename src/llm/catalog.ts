/**
 * Provider model catalog — the metadata behind smart defaults: how big the
 * context window really is, and what a token costs. Read from the
 * OpenAI-compatible `/models` endpoint (OpenRouter, vLLM, …).
 *
 * Every failure is a `null`, never an error: callers keep their fallback
 * values, so an offline or exotic endpoint degrades instead of breaking.
 */

export interface ModelCatalogEntry {
  /** Total context window, in tokens. */
  contextLength?: number;
  /** USD per million tokens, when the catalog prices the model. */
  priceInPerMTok?: number;
  priceOutPerMTok?: number;
  priceCacheReadPerMTok?: number;
}

export async function fetchModelCatalog(args: {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ModelCatalogEntry | null> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? 5000);
  try {
    const res = await fetchImpl(`${args.baseUrl.replace(/\/+$/, "")}/models`, {
      headers: { authorization: `Bearer ${args.apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      data?: Array<Record<string, unknown>>;
    };
    const entry = body.data?.find((item) => item.id === args.model);
    if (!entry) return null;

    // Catalogs price per token as strings ("0.00000004"); budgets think in
    // USD per million. Anything unparseable stays absent.
    const perMTok = (value: unknown): number | undefined => {
      const n =
        typeof value === "string"
          ? Number(value)
          : typeof value === "number"
            ? value
            : NaN;
      return Number.isFinite(n) && n > 0 ? n * 1_000_000 : undefined;
    };
    const pricing = (entry.pricing ?? {}) as Record<string, unknown>;
    const priceIn = perMTok(pricing.prompt);
    const priceOut = perMTok(pricing.completion);
    const priceCache = perMTok(pricing.input_cache_read);
    const contextLength =
      typeof entry.context_length === "number" && entry.context_length > 0
        ? entry.context_length
        : undefined;
    return {
      ...(contextLength !== undefined ? { contextLength } : {}),
      ...(priceIn !== undefined ? { priceInPerMTok: priceIn } : {}),
      ...(priceOut !== undefined ? { priceOutPerMTok: priceOut } : {}),
      ...(priceCache !== undefined
        ? { priceCacheReadPerMTok: priceCache }
        : {}),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
