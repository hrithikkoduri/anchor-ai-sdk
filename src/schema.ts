/**
 * Structured-output schemas — validated, not suggested.
 *
 * A workflow's `output` is either a JSON-schema object (the shape tools
 * already declare) or a zod schema. The package has no runtime dependency on
 * zod, so zod is recognised structurally: anything with `safeParse` is
 * validated by it, and its JSON-schema rendering (for the model) comes from
 * `toJSONSchema()` when the instance has one, or from an explicit
 * `jsonSchema` the caller supplies.
 *
 * The JSON-schema validator is a deliberate subset — the keywords a tool
 * parameter schema actually uses. Unknown keywords are ignored, never
 * guessed at; `$ref` is unsupported and rejected so a schema that relies on
 * it fails loudly instead of validating nothing.
 */

/** A JSON-schema object, the same shape tool parameters use. */
export type JSONSchema = Record<string, unknown>;

/** A single validation issue as zod reports it. */
interface ZodLikeIssue {
  path?: ReadonlyArray<PropertyKey>;
  message: string;
}

/** The structural slice of a zod schema the engine relies on. */
export interface ZodLike<T = unknown> {
  safeParse(
    value: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: { issues?: ZodLikeIssue[]; message?: string } };
  /** Present on zod 4 instances; used to describe the shape to the model. */
  toJSONSchema?: () => JSONSchema;
}

/** Either schema kind a workflow output may declare. */
export type OutputSchema = JSONSchema | ZodLike;

export type SchemaVerdict =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export function isZodLike(schema: unknown): schema is ZodLike {
  return (
    typeof schema === "object" &&
    schema !== null &&
    typeof (schema as { safeParse?: unknown }).safeParse === "function"
  );
}

/**
 * The JSON schema shown to the model. For zod: the instance's own rendering,
 * else the caller's `fallback`, else an unconstrained object (validation
 * still runs through `safeParse`).
 */
export function jsonSchemaOf(
  schema: OutputSchema,
  fallback?: JSONSchema,
): JSONSchema {
  if (!isZodLike(schema)) return schema;
  if (typeof schema.toJSONSchema === "function") {
    const rendered = { ...schema.toJSONSchema() };
    delete rendered.$schema;
    return rendered;
  }
  return fallback ?? { type: "object" };
}

/** Validate a value; the parsed value is zod's output (transforms applied). */
export function validateOutput(
  schema: OutputSchema,
  value: unknown,
): SchemaVerdict {
  if (isZodLike(schema)) {
    const parsed = schema.safeParse(value);
    if (parsed.success) return { ok: true, value: parsed.data };
    const issues = parsed.error.issues ?? [];
    const error = issues.length
      ? issues
          .map((issue) => `${pathText(issue.path ?? [])}: ${issue.message}`)
          .join("; ")
      : (parsed.error.message ?? "invalid value");
    return { ok: false, error };
  }
  const errors = validateJsonSchema(schema, value);
  return errors.length
    ? { ok: false, error: errors.join("; ") }
    : { ok: true, value };
}

function pathText(path: ReadonlyArray<PropertyKey>): string {
  if (path.length === 0) return "$";
  return (
    "$" +
    path
      .map((part) =>
        typeof part === "number" ? `[${part}]` : `.${String(part)}`,
      )
      .join("")
  );
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number")
    return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  const actual = typeOf(value);
  if (type === "number") return actual === "number" || actual === "integer";
  return actual === type;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Every violation of `schema` by `value`, as "$.path: message" lines. Empty
 * means valid. Supported: type, enum, const, properties, required,
 * additionalProperties, items, minItems, maxItems, minLength, maxLength,
 * pattern, minimum, maximum, anyOf, oneOf, allOf.
 */
export function validateJsonSchema(
  schema: JSONSchema,
  value: unknown,
  path: ReadonlyArray<PropertyKey> = [],
): string[] {
  const at = pathText(path);
  if ("$ref" in schema) return [`${at}: $ref is not supported in output schemas`];
  const errors: string[] = [];

  const type = schema.type;
  if (typeof type === "string" || Array.isArray(type)) {
    const types = (Array.isArray(type) ? type : [type]).filter(
      (item): item is string => typeof item === "string",
    );
    if (!types.some((item) => matchesType(value, item))) {
      return [`${at}: expected ${types.join(" | ")}, got ${typeOf(value)}`];
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => deepEqual(item, value)))
    errors.push(`${at}: must be one of ${JSON.stringify(schema.enum)}`);
  if ("const" in schema && !deepEqual(schema.const, value))
    errors.push(`${at}: must equal ${JSON.stringify(schema.const)}`);

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength)
      errors.push(`${at}: shorter than ${schema.minLength} characters`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength)
      errors.push(`${at}: longer than ${schema.maxLength} characters`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value))
      errors.push(`${at}: does not match /${schema.pattern}/`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum)
      errors.push(`${at}: less than ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum)
      errors.push(`${at}: greater than ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems)
      errors.push(`${at}: fewer than ${schema.minItems} items`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems)
      errors.push(`${at}: more than ${schema.maxItems} items`);
    if (isRecord(schema.items)) {
      const items = schema.items;
      value.forEach((item, index) =>
        errors.push(...validateJsonSchema(items, item, [...path, index])),
      );
    }
  }
  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === "string" && value[key] === undefined)
          errors.push(`${pathText([...path, key])}: is required`);
      }
    }
    for (const [key, item] of Object.entries(value)) {
      const sub = properties[key];
      if (isRecord(sub)) {
        if (item !== undefined)
          errors.push(...validateJsonSchema(sub, item, [...path, key]));
      } else if (schema.additionalProperties === false) {
        errors.push(`${pathText([...path, key])}: is not an allowed property`);
      } else if (isRecord(schema.additionalProperties)) {
        errors.push(
          ...validateJsonSchema(schema.additionalProperties, item, [...path, key]),
        );
      }
    }
  }

  const branches = (key: "anyOf" | "oneOf" | "allOf"): JSONSchema[] =>
    Array.isArray(schema[key]) ? (schema[key] as unknown[]).filter(isRecord) : [];
  for (const sub of branches("allOf")) errors.push(...validateJsonSchema(sub, value, path));
  const anyOf = branches("anyOf");
  if (anyOf.length && !anyOf.some((sub) => validateJsonSchema(sub, value, path).length === 0))
    errors.push(`${at}: matches none of the allowed shapes (anyOf)`);
  const oneOf = branches("oneOf");
  if (oneOf.length) {
    const matched = oneOf.filter((sub) => validateJsonSchema(sub, value, path).length === 0).length;
    if (matched !== 1)
      errors.push(`${at}: must match exactly one allowed shape (oneOf), matched ${matched}`);
  }
  return errors;
}
