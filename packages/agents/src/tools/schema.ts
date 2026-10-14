/**
 * A small input-schema helper so every tool's JSON Schema (shown to the model) and its `parse` (enforced in code)
 * come from one definition: snake_case keys, `additionalProperties: false`, required unless `optional`.
 */
export type Field =
  | { type: 'string'; description?: string; enum?: readonly string[]; maxLength?: number; optional?: boolean; uuid?: boolean }
  | { type: 'integer' | 'number'; description?: string; minimum?: number; maximum?: number; optional?: boolean }
  | { type: 'boolean'; description?: string; optional?: boolean }
  | { type: 'object'; description?: string; optional?: boolean };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type FieldValue<F extends Field> = F extends { type: 'string' }
  ? string
  : F extends { type: 'integer' | 'number' }
    ? number
    : F extends { type: 'boolean' }
      ? boolean
      : Record<string, unknown>;

export type Parsed<S extends Record<string, Field>> = {
  [K in keyof S as S[K] extends { optional: true } ? never : K]: FieldValue<S[K]>;
} & {
  [K in keyof S as S[K] extends { optional: true } ? K : never]?: FieldValue<S[K]>;
};

export class ToolInputError extends Error {
  override readonly name = 'ToolInputError';
}

export function input<S extends Record<string, Field>>(fields: S): { schema: Record<string, unknown>; parse: (raw: unknown) => Parsed<S> } {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, f] of Object.entries(fields)) {
    const { optional, ...rest } = f as Field & { uuid?: boolean };
    const prop: Record<string, unknown> = { ...rest };
    if ('uuid' in prop) {
      delete prop.uuid;
      prop.format = 'uuid';
    }
    if (f.type === 'object') prop.additionalProperties = true;
    properties[key] = prop;
    if (!optional) required.push(key);
  }
  const schema = { type: 'object', properties, required, additionalProperties: false };
  const parse = (raw: unknown): Parsed<S> => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new ToolInputError('input must be an object');
    const r = raw as Record<string, unknown>;
    for (const k of Object.keys(r)) if (!(k in fields)) throw new ToolInputError(`unknown field: ${k}`);
    const out: Record<string, unknown> = {};
    for (const [key, f] of Object.entries(fields)) {
      const v = r[key];
      if (v === undefined || v === null) {
        if (!f.optional) throw new ToolInputError(`${key} is required`);
        continue;
      }
      switch (f.type) {
        case 'string': {
          if (typeof v !== 'string') throw new ToolInputError(`${key} must be a string`);
          const s = v.trim();
          if (!f.optional && !s) throw new ToolInputError(`${key} must not be empty`);
          if (f.enum && !f.enum.includes(s)) throw new ToolInputError(`${key} must be one of ${f.enum.join(', ')}`);
          if (f.maxLength && s.length > f.maxLength) throw new ToolInputError(`${key} is longer than ${f.maxLength} characters`);
          if (f.uuid && !UUID_RE.test(s)) throw new ToolInputError(`${key} must be a uuid`);
          out[key] = s;
          break;
        }
        case 'integer':
        case 'number': {
          const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
          if (typeof n !== 'number' || !Number.isFinite(n) || (f.type === 'integer' && !Number.isInteger(n))) {
            throw new ToolInputError(`${key} must be ${f.type === 'integer' ? 'an integer' : 'a number'}`);
          }
          if (f.minimum !== undefined && n < f.minimum) throw new ToolInputError(`${key} must be ≥ ${f.minimum}`);
          if (f.maximum !== undefined && n > f.maximum) throw new ToolInputError(`${key} must be ≤ ${f.maximum}`);
          out[key] = n;
          break;
        }
        case 'boolean':
          if (typeof v !== 'boolean') throw new ToolInputError(`${key} must be true or false`);
          out[key] = v;
          break;
        case 'object':
          if (typeof v !== 'object' || Array.isArray(v)) throw new ToolInputError(`${key} must be an object`);
          out[key] = v;
          break;
      }
    }
    return out as Parsed<S>;
  };
  return { schema, parse };
}

export const PERSONA_ID: { type: 'string'; uuid: true; description: string } = {
  type: 'string',
  uuid: true,
  description: 'The persona id (uuid). A persona manager may only pass its own.',
};
