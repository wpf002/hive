/**
 * Field-level secret handling for Bot.config values.
 *
 * Convention: a template's configSchema may mark any string property with
 * `"x-secret": true`. The API:
 *   • encrypts those fields before INSERT/UPDATE  (encryptBotConfig)
 *   • decrypts them just before XADD-ing to hive:dispatch  (decryptBotConfig)
 *   • masks them on outbound GETs                   (maskBotConfig)
 *
 * Phase 5a: writes emit v2 envelopes (KMS-wrapped DEK). Reads transparently
 * accept v1 ciphertext too so existing rows keep working. v1→v2 migration is
 * a one-shot script (apps/api/src/scripts/upgrade-envelope-v1-to-v2.ts).
 */
import { PREFIX as PREFIX_V1 } from '@hive/crypto';
import { encryptValue, decryptValue, isEnvelope, PREFIX_V2 } from './envelope.js';

type Json = unknown;
type JsonObj = Record<string, Json>;

interface SchemaNode {
  type?: string | string[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  // Our convention — JSON Schema's `format: 'password'` is documentation-only.
  // `x-secret: true` is what `secrets.ts` actually keys off.
  ['x-secret']?: boolean;
}

interface Template {
  configSchema: Json;
}

function asObject(v: Json): JsonObj | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as JsonObj;
  return null;
}

/** Collect property paths within a JSON Schema whose nodes carry x-secret: true.
 * Returns dot-paths like `apiKey` or `nested.apiKey`. Arrays are traversed via
 * the items schema but path notation stays simple — we don't currently use
 * secret fields inside arrays. */
export function collectSecretPaths(schema: Json): string[] {
  const out: string[] = [];
  const root = asObject(schema);
  if (!root) return out;
  function walk(node: SchemaNode, prefix: string): void {
    if (node['x-secret'] === true) {
      out.push(prefix);
      return;
    }
    if (node.properties) {
      for (const [k, child] of Object.entries(node.properties)) {
        const path = prefix ? `${prefix}.${k}` : k;
        walk(child, path);
      }
    }
    if (node.items) walk(node.items, prefix);
  }
  walk(root as SchemaNode, '');
  return out;
}

function getAt(obj: JsonObj, path: string): { parent: JsonObj | null; key: string } {
  const parts = path.split('.');
  let cursor: JsonObj | null = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!cursor) return { parent: null, key: parts[parts.length - 1] };
    const next = cursor[parts[i]];
    cursor = asObject(next);
  }
  return { parent: cursor, key: parts[parts.length - 1] };
}

/** Encrypt every x-secret field in `config` that isn't already encrypted.
 * Idempotent — re-running on an already-encrypted config is a no-op. */
export async function encryptBotConfig(template: Template, config: Json): Promise<JsonObj> {
  const out = structuredClone(asObject(config) ?? {}) as JsonObj;
  for (const path of collectSecretPaths(template.configSchema)) {
    const { parent, key } = getAt(out, path);
    if (!parent) continue;
    const v = parent[key];
    if (typeof v !== 'string' || v === '') continue;
    if (isEnvelope(v)) continue;
    parent[key] = await encryptValue(v);
  }
  return out;
}

/** Decrypt every x-secret field in `config`. Throws on tamper.
 * Non-encrypted strings pass through (legacy rows before the migration). */
export async function decryptBotConfig(template: Template, config: Json): Promise<JsonObj> {
  const out = structuredClone(asObject(config) ?? {}) as JsonObj;
  for (const path of collectSecretPaths(template.configSchema)) {
    const { parent, key } = getAt(out, path);
    if (!parent) continue;
    const v = parent[key];
    if (typeof v !== 'string') continue;
    if (!isEnvelope(v)) continue;
    parent[key] = await decryptValue(v);
  }
  return out;
}

function maskOne(v: string): string {
  if (v.startsWith(PREFIX_V2) || v.startsWith(PREFIX_V1)) return '****encrypted';
  if (v.length === 0) return v;
  if (v.length <= 4) return '****';
  return '****' + v.slice(-4);
}

/** Returned over HTTP — never reveals plaintext OR raw ciphertext.
 * Encrypted values render as `****encrypted`; legacy plaintext (pre-migration)
 * renders as `****last4` so we can still tell them apart in the UI. */
export function maskBotConfig(template: Template, config: Json): JsonObj {
  const out = structuredClone(asObject(config) ?? {}) as JsonObj;
  for (const path of collectSecretPaths(template.configSchema)) {
    const { parent, key } = getAt(out, path);
    if (!parent) continue;
    const v = parent[key];
    if (typeof v !== 'string' || v === '') continue;
    parent[key] = maskOne(v);
  }
  return out;
}
