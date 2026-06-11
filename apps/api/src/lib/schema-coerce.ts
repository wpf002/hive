/**
 * Light coercion + validation of an AI-proposed config against a template's
 * JSON Schema. This is NOT a full JSON Schema validator (the bot-builder is the
 * only caller and templates use a small, known subset of schema features); it
 * exists to turn a plausible-but-loose LLM output into something that will pass
 * the real `POST /api/bots` path, and to surface human-readable warnings for the
 * bits it can't fix.
 *
 * What it does, per top-level property:
 *   - drops keys not in the schema when additionalProperties === false
 *   - coerces "12"→12, "true"→true etc. for integer/number/boolean fields
 *   - fills missing properties from the schema's `default`
 *   - warns (does not throw) on: missing required keys, enum violations,
 *     out-of-range numbers
 *
 * Returns the cleaned config plus a list of warnings to show the operator.
 */

interface SchemaProp {
  type?: string | string[];
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  properties?: Record<string, SchemaProp>;
  required?: string[];
  additionalProperties?: boolean | SchemaProp;
}

interface ObjectSchema extends SchemaProp {
  properties?: Record<string, SchemaProp>;
  required?: string[];
}

function typeOf(p: SchemaProp): string {
  if (Array.isArray(p.type)) return p.type[0] ?? 'string';
  return p.type ?? 'string';
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function coerceScalar(prop: SchemaProp, value: unknown, key: string, warnings: string[]): unknown {
  const t = typeOf(prop);
  if (t === 'integer' || t === 'number') {
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      value = t === 'integer' ? parseInt(value, 10) : Number(value);
    }
    if (typeof value === 'number') {
      if (prop.minimum !== undefined && value < prop.minimum) {
        warnings.push(`"${key}" (${value}) is below the minimum of ${prop.minimum}.`);
      }
      if (prop.maximum !== undefined && value > prop.maximum) {
        warnings.push(`"${key}" (${value}) is above the maximum of ${prop.maximum}.`);
      }
    }
    return value;
  }
  if (t === 'boolean') {
    if (typeof value === 'string') {
      if (value.toLowerCase() === 'true') return true;
      if (value.toLowerCase() === 'false') return false;
    }
    return value;
  }
  return value;
}

/**
 * Coerce + validate `config` against a template `configSchema`.
 * Only the top level is processed (Hive's templates are flat enough that this
 * covers the real cases; nested objects pass through untouched).
 */
export function coerceConfigToSchema(
  schema: unknown,
  config: unknown,
): { config: Record<string, unknown>; warnings: string[] } {
  const warnings: string[] = [];
  const input: Record<string, unknown> = isObject(config) ? { ...config } : {};
  if (!isObject(schema)) return { config: input, warnings };

  const s = schema as ObjectSchema;
  const props = s.properties ?? {};
  const required = new Set(s.required ?? []);
  const allowsExtra = s.additionalProperties !== false;
  const out: Record<string, unknown> = {};

  // Carry over / coerce known properties.
  for (const [key, prop] of Object.entries(props)) {
    let value = input[key];
    if (value === undefined && prop.default !== undefined) value = prop.default;
    if (value === undefined) {
      if (required.has(key)) warnings.push(`Missing required field "${key}".`);
      continue;
    }
    value = coerceScalar(prop, value, key, warnings);
    if (prop.enum && prop.enum.length > 0 && !prop.enum.some((e) => e === value)) {
      warnings.push(
        `"${key}" = ${JSON.stringify(value)} is not one of: ${prop.enum.map((e) => JSON.stringify(e)).join(', ')}.`,
      );
    }
    out[key] = value;
  }

  // Unknown keys: keep them if the schema allows extras, otherwise drop + warn.
  for (const [key, value] of Object.entries(input)) {
    if (key in props) continue;
    if (allowsExtra) {
      out[key] = value;
    } else {
      warnings.push(`Dropped unknown field "${key}" (not in the template schema).`);
    }
  }

  return { config: out, warnings };
}
