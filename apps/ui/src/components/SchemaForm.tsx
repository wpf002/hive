'use client';
/**
 * SchemaForm — render a JSON Schema (template.configSchema) as a real form.
 *
 * Handles the shapes Hive templates actually use:
 *   string + enum                → <select>
 *   string + format:'password'   → password input (or x-secret: true)
 *   string (long-ish)            → textarea (if description hints at it)
 *   string                       → text input
 *   integer / number             → number input (respects min/max)
 *   boolean                      → checkbox
 *   array of string enum         → checkbox group
 *   array of string              → comma-separated text
 *   object (with properties)     → recursive sub-form
 *   anything else                → JSON textarea fallback
 *
 * Out of scope (intentionally — falls back to JSON):
 *   - oneOf / anyOf
 *   - patternProperties
 *   - arrays of objects (template uses these for assertions / form steps —
 *     they're easier to author as JSON for now)
 */
import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';

interface SchemaProp {
  type?: string | string[];
  description?: string;
  default?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  minLength?: number;
  maxLength?: number;
  format?: string;
  properties?: Record<string, SchemaProp>;
  items?: SchemaProp;
  required?: string[];
  additionalProperties?: boolean | SchemaProp;
  // Hive conventions
  ['x-secret']?: boolean;
}

interface Schema extends SchemaProp {
  type?: 'object';
  properties?: Record<string, SchemaProp>;
  required?: string[];
}

type Value = Record<string, unknown>;

function isObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function typeOf(p: SchemaProp): string {
  if (Array.isArray(p.type)) return p.type[0] ?? 'string';
  return p.type ?? 'string';
}

function isSecret(p: SchemaProp): boolean {
  return p['x-secret'] === true || p.format === 'password';
}

function isLongText(p: SchemaProp): boolean {
  // Heuristic — descriptions that name code/markdown/templates, or long
  // maxLength, get a textarea. The "Python Script Runner" and
  // long-running listener templates both benefit.
  if ((p.maxLength ?? 0) >= 1000) return true;
  const d = (p.description ?? '').toLowerCase();
  return /\b(source|code|template|markdown|html|json|body|prompt)\b/.test(d);
}

function Label({ name, prop, required }: { name: string; prop: SchemaProp; required: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="font-mono text-[11px] uppercase text-hive-subtle">
        {name}
        {required && <span className="ml-1 text-red-400">*</span>}
      </span>
      {prop['x-secret'] && (
        <span className="font-mono text-[9px] uppercase text-hive-subtle/70">encrypted at rest</span>
      )}
    </div>
  );
}

function HelpText({ text }: { text?: string }) {
  if (!text) return null;
  return <div className="mt-1 text-[11px] leading-snug text-hive-subtle/80">{text}</div>;
}

interface FieldProps {
  name: string;
  prop: SchemaProp;
  value: unknown;
  onChange: (v: unknown) => void;
  required: boolean;
  path: string; // dot-path for keys
}

function ScalarField({ name, prop, value, onChange, required }: FieldProps) {
  const t = typeOf(prop);
  const baseInput =
    'mt-1 w-full rounded border border-hive-border bg-hive-bg px-2 py-1.5 text-sm focus:border-honey-500 focus:outline-none';

  // Enums → <select>
  if (prop.enum && prop.enum.length > 0 && (t === 'string' || t === 'integer' || t === 'number')) {
    return (
      <label className="block">
        <Label name={name} prop={prop} required={required} />
        <select
          value={String(value ?? '')}
          onChange={(e) => {
            const raw = e.target.value;
            onChange(t === 'string' ? raw : Number(raw));
          }}
          className={baseInput}
        >
          {!required && <option value="">— none —</option>}
          {prop.enum.map((v) => (
            <option key={String(v)} value={String(v)}>{String(v)}</option>
          ))}
        </select>
        <HelpText text={prop.description} />
      </label>
    );
  }

  if (t === 'boolean') {
    return (
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={!!value}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-hive-border bg-hive-bg accent-honey-500"
        />
        <div className="flex-1">
          <Label name={name} prop={prop} required={required} />
          <HelpText text={prop.description} />
        </div>
      </label>
    );
  }

  if (t === 'integer' || t === 'number') {
    return (
      <label className="block">
        <Label name={name} prop={prop} required={required} />
        <input
          type="number"
          step={t === 'integer' ? 1 : 'any'}
          min={prop.minimum ?? prop.exclusiveMinimum}
          max={prop.maximum}
          value={value == null || value === '' ? '' : String(value)}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === '') return onChange(undefined);
            const n = t === 'integer' ? parseInt(raw, 10) : parseFloat(raw);
            onChange(Number.isFinite(n) ? n : undefined);
          }}
          className={baseInput}
        />
        <HelpText text={prop.description} />
      </label>
    );
  }

  // string (with subtypes)
  const stringValue = typeof value === 'string' ? value : value == null ? '' : String(value);
  if (isSecret(prop)) {
    return (
      <label className="block">
        <Label name={name} prop={prop} required={required} />
        <input
          type="password"
          autoComplete="new-password"
          value={stringValue}
          onChange={(e) => onChange(e.target.value)}
          className={cn(baseInput, 'font-mono')}
          placeholder={stringValue.startsWith('****') ? '(unchanged — fill to overwrite)' : ''}
        />
        <HelpText text={prop.description} />
      </label>
    );
  }
  if (isLongText(prop)) {
    return (
      <label className="block">
        <Label name={name} prop={prop} required={required} />
        <textarea
          value={stringValue}
          onChange={(e) => onChange(e.target.value)}
          rows={6}
          className={cn(baseInput, 'font-mono text-xs')}
        />
        <HelpText text={prop.description} />
      </label>
    );
  }
  return (
    <label className="block">
      <Label name={name} prop={prop} required={required} />
      <input
        type="text"
        value={stringValue}
        onChange={(e) => onChange(e.target.value)}
        className={baseInput}
      />
      <HelpText text={prop.description} />
    </label>
  );
}

function ArrayField({ name, prop, value, onChange, required }: FieldProps) {
  const items = prop.items;
  // string-enum array → checkbox group (e.g. Sportsbook markets)
  if (items && typeOf(items) === 'string' && items.enum && items.enum.length > 0) {
    const arr = Array.isArray(value) ? (value as string[]) : [];
    return (
      <div>
        <Label name={name} prop={prop} required={required} />
        <div className="mt-1 flex flex-wrap gap-2">
          {items.enum.map((opt) => {
            const s = String(opt);
            const on = arr.includes(s);
            return (
              <button
                type="button"
                key={s}
                onClick={() => {
                  const next = on ? arr.filter((v) => v !== s) : [...arr, s];
                  onChange(next);
                }}
                className={cn(
                  'rounded border px-2 py-1 font-mono text-[11px] uppercase',
                  on
                    ? 'border-honey-500 bg-honey-500/10 text-honey-500'
                    : 'border-hive-border text-hive-subtle hover:bg-hive-muted',
                )}
              >
                {s}
              </button>
            );
          })}
        </div>
        <HelpText text={prop.description} />
      </div>
    );
  }
  // Plain string array → comma-separated text
  if (items && typeOf(items) === 'string') {
    const arr = Array.isArray(value) ? (value as string[]).join(', ') : '';
    return (
      <label className="block">
        <Label name={name} prop={prop} required={required} />
        <input
          type="text"
          value={arr}
          onChange={(e) => {
            const parts = e.target.value.split(',').map((p) => p.trim()).filter(Boolean);
            onChange(parts);
          }}
          placeholder="comma-separated"
          className="mt-1 w-full rounded border border-hive-border bg-hive-bg px-2 py-1.5 text-sm"
        />
        <HelpText text={prop.description ?? 'Comma-separated values.'} />
      </label>
    );
  }
  // Anything more complex (array of object) — JSON fallback.
  return <JsonFallbackField name={name} prop={prop} value={value} onChange={onChange} required={required} path={name} />;
}

function JsonFallbackField({ name, prop, value, onChange, required }: FieldProps) {
  const [text, setText] = useState(() => JSON.stringify(value ?? null, null, 2));
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setText(JSON.stringify(value ?? null, null, 2));
  }, [value]);
  return (
    <label className="block">
      <Label name={name} prop={prop} required={required} />
      <textarea
        value={text}
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          try {
            const parsed = next.trim() === '' ? null : JSON.parse(next);
            setErr(null);
            onChange(parsed);
          } catch (e) {
            setErr((e as Error).message);
          }
        }}
        rows={6}
        spellCheck={false}
        className="mt-1 w-full rounded border border-hive-border bg-black/40 px-2 py-1.5 font-mono text-xs"
      />
      {err && <div className="mt-1 font-mono text-[10px] text-red-400">{err}</div>}
      <HelpText text={prop.description ?? 'Free-form JSON (no form builder for this shape yet).'} />
    </label>
  );
}

/** Sort properties: required (in declared order) → optional scalars (alpha)
 * → optional complex (alpha). Postgres jsonb does NOT preserve insertion
 * order, so without this every template renders its fields in a different
 * scrambled order on every reload. */
function sortedPropertyEntries(
  props: Record<string, SchemaProp>,
  required: string[],
): Array<[string, SchemaProp]> {
  const requiredOrder = new Map(required.map((k, i) => [k, i]));
  const entries = Object.entries(props);
  const isComplex = (p: SchemaProp): boolean => {
    const t = typeOf(p);
    return t === 'object' || t === 'array';
  };
  return entries.sort(([ak, ap], [bk, bp]) => {
    const aReq = requiredOrder.get(ak);
    const bReq = requiredOrder.get(bk);
    if (aReq !== undefined && bReq !== undefined) return aReq - bReq;
    if (aReq !== undefined) return -1;
    if (bReq !== undefined) return 1;
    const aC = isComplex(ap) ? 1 : 0;
    const bC = isComplex(bp) ? 1 : 0;
    if (aC !== bC) return aC - bC; // scalars first
    return ak.localeCompare(bk);
  });
}

function ObjectField({ name, path: _path, prop, value, onChange }: FieldProps) {
  void _path;
  const props = prop.properties ?? {};
  const required = prop.required ?? [];
  const requiredSet = new Set(required);
  const v: Value = isObject(value) ? (value as Value) : {};
  const ordered = sortedPropertyEntries(props, required);
  return (
    <div className="space-y-3 rounded border border-hive-border bg-hive-bg/40 p-3">
      {name && (
        <div className="font-mono text-[11px] uppercase text-hive-subtle/70">
          {name} (object)
        </div>
      )}
      {ordered.map(([k, sub]) => (
        <FormField
          key={k}
          name={k}
          prop={sub}
          value={v[k]}
          onChange={(nv) => onChange({ ...v, [k]: nv })}
          required={requiredSet.has(k)}
          path={`${_path}.${k}`}
        />
      ))}
    </div>
  );
}

function FormField(props: FieldProps) {
  const t = typeOf(props.prop);
  if (t === 'object' && props.prop.properties) return <ObjectField {...props} />;
  if (t === 'array') return <ArrayField {...props} />;
  if (t === 'string' || t === 'integer' || t === 'number' || t === 'boolean') return <ScalarField {...props} />;
  return <JsonFallbackField {...props} />;
}

export interface SchemaFormProps {
  schema: unknown;
  value: Value;
  onChange: (v: Value) => void;
}

export function SchemaForm({ schema, value, onChange }: SchemaFormProps) {
  if (!isObject(schema)) {
    return (
      <div className="rounded border border-hive-border bg-hive-bg/40 p-3 text-xs text-hive-subtle">
        Template has no usable schema — paste JSON config directly.
      </div>
    );
  }
  const s = schema as Schema;
  const props = s.properties ?? {};
  const required = s.required ?? [];
  const requiredSet = new Set(required);
  const ordered = sortedPropertyEntries(props, required);
  return (
    <div className="space-y-3">
      {ordered.map(([k, sub]) => (
        <FormField
          key={k}
          name={k}
          prop={sub}
          value={value[k]}
          onChange={(nv) => onChange({ ...value, [k]: nv })}
          required={requiredSet.has(k)}
          path={k}
        />
      ))}
    </div>
  );
}

/** Strip undefined values; helps keep the persisted config tidy. */
export function pruneUndefined(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(pruneUndefined);
  if (isObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      const cleaned = pruneUndefined(val);
      if (cleaned !== undefined) out[k] = cleaned;
    }
    return out;
  }
  return v;
}
