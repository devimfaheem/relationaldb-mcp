import { matchesType, type Parameter } from '../shared/schema.js';

export class ArgsError extends Error {}

export interface JsonSchemaObject {
  type: 'object';
  properties: Record<string, Record<string, unknown>>;
  required: string[];
  additionalProperties: false;
}

const JSON_TYPES: Record<Parameter['type'], { type: string; format?: string }> = {
  string: { type: 'string' },
  integer: { type: 'integer' },
  number: { type: 'number' },
  boolean: { type: 'boolean' },
  date: { type: 'string', format: 'date' },
  datetime: { type: 'string', format: 'date-time' },
};

/** Builds the MCP `inputSchema` Claude sees for a tool. */
export function toJsonSchema(params: Parameter[]): JsonSchemaObject {
  const properties: JsonSchemaObject['properties'] = {};
  for (const p of params) {
    const { type, format } = JSON_TYPES[p.type];
    properties[p.name] = {
      type,
      description: p.description,
      ...(format && { format }),
      ...(p.enum && { enum: p.enum }),
      ...(p.default !== undefined && { default: p.default }),
      ...(p.min !== undefined && { minimum: p.min }),
      ...(p.max !== undefined && { maximum: p.max }),
      ...(p.pattern !== undefined && { pattern: p.pattern }),
      ...(p.maxLength !== undefined && { maxLength: p.maxLength }),
    };
  }
  return {
    type: 'object',
    properties,
    required: params.filter((p) => p.required).map((p) => p.name),
    additionalProperties: false,
  };
}

function check(p: Parameter, v: unknown): string | undefined {
  if (!matchesType(p.type, v)) return `must be a ${p.type}`;
  if (p.enum && !p.enum.includes(v)) return `must be one of ${p.enum.map((e) => JSON.stringify(e)).join(', ')}`;
  if (typeof v === 'number') {
    if (p.min !== undefined && v < p.min) return `must be ≥ ${p.min}`;
    if (p.max !== undefined && v > p.max) return `must be ≤ ${p.max}`;
  }
  if (typeof v === 'string') {
    if (p.maxLength !== undefined && v.length > p.maxLength) return `must be at most ${p.maxLength} characters`;
    if (p.pattern !== undefined && !new RegExp(p.pattern).test(v)) return `must match pattern ${p.pattern}`;
  }
  return undefined;
}

/**
 * Validates tool arguments against the declared parameters. Applies defaults and
 * binds omitted optional parameters as NULL. Throws ArgsError with a readable message.
 */
export function parseArgs(params: Parameter[], args: unknown): Record<string, unknown> {
  const input = (args ?? {}) as Record<string, unknown>;
  if (typeof input !== 'object' || Array.isArray(input)) throw new ArgsError('arguments must be an object');

  const known = new Set(params.map((p) => p.name));
  const unknown = Object.keys(input).filter((k) => !known.has(k));
  if (unknown.length) throw new ArgsError(`unknown parameter(s): ${unknown.join(', ')}`);

  const out: Record<string, unknown> = {};
  for (const p of params) {
    const v = input[p.name];
    if (v === undefined || v === null) {
      if (p.required) throw new ArgsError(`parameter \`${p.name}\` is required`);
      out[p.name] = p.default ?? null;
      continue;
    }
    const problem = check(p, v);
    if (problem) throw new ArgsError(`parameter \`${p.name}\` ${problem}`);
    out[p.name] = v;
  }
  return out;
}
