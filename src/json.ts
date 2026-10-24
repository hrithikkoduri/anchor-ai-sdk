/**
 * Plain JSON — the only shape that may cross a persistence boundary.
 *
 * Tool results, evidence, and trace events are stored by consumers in
 * databases and files; a value that is not plain JSON (a class instance, a
 * cycle, a BigInt, a function) must never reach them. `JsonValue` makes that a
 * compile-time rule for tool authors; `toPlainJson` makes it a runtime
 * guarantee at the boundaries the engine owns.
 */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
/** `undefined` is tolerated so optional spreads (`...(x ? {k} : {})`) type-check; it is dropped on copy. */
export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

export type JsonRepair = "circular" | "bigint" | "function" | "depth";

export interface ToPlainJsonOptions {
  /** Called for every repaired path; absent means repair silently. */
  onRepair?: (path: string, reason: JsonRepair) => void;
  /** Nesting beyond this becomes "[truncated]". Default 64. */
  maxDepth?: number;
}

/**
 * Deep-copy a value into plain JSON. Cycles become "[circular]", BigInt a
 * decimal string, Errors keep name and message, Map/Set become object/array,
 * Dates keep their ISO form via toJSON, functions and symbols are dropped.
 * Shared (acyclic) references are copied twice, not marked.
 */
export function toPlainJson(value: unknown, opts: ToPlainJsonOptions = {}): JsonValue | undefined {
  const maxDepth = opts.maxDepth ?? 64;
  const seen = new WeakSet<object>();
  const walk = (input: unknown, path: string, depth: number): JsonValue | undefined => {
    if (input === undefined) return undefined;
    if (input === null) return null;
    switch (typeof input) {
      case "string":
      case "boolean":
        return input;
      case "number":
        return Number.isFinite(input) ? input : null;
      case "bigint":
        opts.onRepair?.(path, "bigint");
        return String(input);
      case "function":
      case "symbol":
        opts.onRepair?.(path, "function");
        return undefined;
      default:
        break;
    }
    const obj = input as object;
    if (depth > maxDepth) {
      opts.onRepair?.(path, "depth");
      return "[truncated]";
    }
    if (seen.has(obj)) {
      opts.onRepair?.(path, "circular");
      return "[circular]";
    }
    if (obj instanceof Error) return { name: obj.name, message: obj.message };
    if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? null : obj.toISOString();
    seen.add(obj);
    try {
      if (Array.isArray(obj)) {
        return obj.map((item, index) => walk(item, `${path}[${index}]`, depth + 1) ?? null);
      }
      if (obj instanceof Map) return walk(Object.fromEntries(obj), path, depth);
      if (obj instanceof Set) return walk([...obj], path, depth);
      const custom = (obj as { toJSON?: unknown }).toJSON;
      if (typeof custom === "function") {
        return walk((custom as () => unknown).call(obj), path, depth + 1);
      }
      const out: JsonObject = {};
      for (const [key, item] of Object.entries(obj as Record<string, unknown>)) {
        const plain = walk(item, path ? `${path}.${key}` : key, depth + 1);
        if (plain !== undefined) out[key] = plain;
      }
      return out;
    } finally {
      seen.delete(obj);
    }
  };
  return walk(value, "", 0);
}

/**
 * `toPlainJson` for an object. Accepts any object (interfaces included, which
 * TypeScript will not assign to an index signature) and returns a detached
 * `JsonObject`, so a tool can hand its domain types to `meta` in one call.
 */
export function toPlainJsonObject(
  value: object | undefined,
  opts: ToPlainJsonOptions = {},
): JsonObject | undefined {
  if (value === undefined) return undefined;
  const plain = toPlainJson(value, opts);
  return plain && typeof plain === "object" && !Array.isArray(plain) ? plain : {};
}
