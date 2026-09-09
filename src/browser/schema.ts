/**
 * JSON Schema to zod raw shape.
 *
 * `McpServer.registerTool` wants a zod raw shape; `client.listTools()` hands
 * back JSON Schema. Upstream's browser tools use a small, predictable subset of
 * it, so this covers that subset rather than pulling in a general converter.
 *
 * The alternative - registering a permissive `z.record(z.unknown())` - would
 * throw away every parameter description and leave the model guessing at
 * argument names. The descriptions are the API, so they are worth 80 lines.
 */
import { z } from "zod";

type JsonSchema = {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
};

/** The first concrete type, ignoring a "null" member of a union. */
function primaryType(type: string | string[] | undefined): string | undefined {
  if (typeof type === "string") return type;
  if (Array.isArray(type)) return type.find((t) => t !== "null");
  return undefined;
}

function convert(schema: JsonSchema): z.ZodTypeAny {
  if (Array.isArray(schema.enum) && schema.enum.length) {
    const values = schema.enum.filter((v): v is string => typeof v === "string");
    if (values.length === schema.enum.length && values.length > 0) {
      // z.enum needs a non-empty tuple; the runtime array is the same thing.
      return z.enum(values as [string, ...string[]]);
    }
  }

  switch (primaryType(schema.type)) {
    case "string":
      return z.string();
    case "number":
    case "integer": {
      let value = schema.type === "integer" ? z.number().int() : z.number();
      if (typeof schema.minimum === "number") value = value.min(schema.minimum);
      if (typeof schema.maximum === "number") value = value.max(schema.maximum);
      return value;
    }
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(schema.items ? convert(schema.items) : z.unknown());
    case "object": {
      const shape = toShape(schema);
      // passthrough: upstream occasionally nests free-form option bags, and
      // silently dropping unknown keys would be worse than forwarding them.
      return Object.keys(shape).length ? z.object(shape).passthrough() : z.record(z.string(), z.unknown());
    }
    default:
      return z.unknown();
  }
}

/** Convert an object schema's properties into a zod raw shape. */
export function toShape(schema: JsonSchema | undefined): z.ZodRawShape {
  // Built as a mutable record: zod 4's ZodRawShape has a readonly index
  // signature, and a readonly target cannot be filled in a loop.
  const shape: Record<string, z.ZodTypeAny> = {};
  if (!schema?.properties) return shape;

  const required = new Set(schema.required ?? []);

  for (const [key, property] of Object.entries(schema.properties)) {
    let field = convert(property);
    if (property.description) field = field.describe(property.description);
    if (!required.has(key)) field = field.optional();
    shape[key] = field;
  }

  return shape;
}

export type { JsonSchema };
