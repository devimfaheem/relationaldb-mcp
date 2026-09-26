import { z } from 'zod';
import { extractPlaceholders } from './placeholders.js';

export const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const PARAM_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const ENGINES = ['mysql', 'mssql', 'postgres'] as const;
export const DEFAULT_PORTS = { mysql: 3306, mssql: 1433, postgres: 5432 } as const;
export const PARAM_TYPES = ['string', 'integer', 'number', 'boolean', 'date', 'datetime'] as const;

export type Engine = (typeof ENGINES)[number];
export type ParamType = (typeof PARAM_TYPES)[number];

const name = z.string().regex(NAME_RE, 'must be lowercase letters, digits and underscores, starting with a letter');

export const ConnectionSchema = z
  .object({
    id: name,
    engine: z.enum(ENGINES),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).optional(),
    database: z.string().min(1),
    user: z.string().min(1),
    password: z.string(),
    ssl: z
      .object({ enabled: z.boolean().default(false), rejectUnauthorized: z.boolean().default(true) })
      .default({ enabled: false, rejectUnauthorized: true }),
    pool: z.object({ max: z.number().int().min(1).max(100).default(10) }).default({ max: 10 }),
    options: z.record(z.string(), z.unknown()).default({}),
  })
  .transform((c) => ({ ...c, port: c.port ?? DEFAULT_PORTS[c.engine] }));

/** True if `v` is an acceptable value for a parameter of type `type`. */
export function matchesType(type: ParamType, v: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof v === 'string';
    case 'integer':
      return Number.isInteger(v);
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'date':
      return typeof v === 'string' && DATE_RE.test(v) && !Number.isNaN(Date.parse(v));
    case 'datetime':
      return typeof v === 'string' && !DATE_RE.test(v) && !Number.isNaN(Date.parse(v));
  }
}

export const ParameterSchema = z
  .object({
    name: z.string().regex(PARAM_NAME_RE, 'must be a valid identifier'),
    type: z.enum(PARAM_TYPES),
    description: z.string().min(1),
    required: z.boolean().default(false),
    default: z.unknown().optional(),
    enum: z.array(z.unknown()).min(1).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    pattern: z.string().optional(),
    maxLength: z.number().int().min(1).optional(),
  })
  .superRefine((p, ctx) => {
    const numeric = p.type === 'integer' || p.type === 'number';
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message: `parameter "${p.name}": ${message}` });

    if (!numeric && (p.min !== undefined || p.max !== undefined)) issue('min/max only apply to integer and number');
    if (p.type !== 'string' && (p.pattern !== undefined || p.maxLength !== undefined))
      issue('pattern/maxLength only apply to string');
    if (p.pattern !== undefined) {
      try {
        new RegExp(p.pattern);
      } catch {
        issue('pattern is not a valid regular expression');
      }
    }
    for (const v of p.enum ?? []) if (!matchesType(p.type, v)) issue(`enum value ${JSON.stringify(v)} is not a ${p.type}`);
    if (p.default !== undefined) {
      if (!matchesType(p.type, p.default)) issue(`default is not a ${p.type}`);
      else if (p.enum && !p.enum.includes(p.default)) issue('default is not one of the enum values');
    }
  });

export const ToolSchema = z.object({
  name,
  description: z.string().min(1).max(1024),
  connection: z.string().min(1),
  mode: z.enum(['read', 'write']),
  enabled: z.boolean().default(true),
  query: z.string().min(1),
  parameters: z.array(ParameterSchema).default([]),
  limits: z
    .object({
      maxRows: z.number().int().min(1).max(10000).default(1000),
      timeoutMs: z.number().int().min(100).max(300000).default(30000),
    })
    .default({ maxRows: 1000, timeoutMs: 30000 }),
});

export type Connection = z.output<typeof ConnectionSchema>;
export type ConnectionInput = z.input<typeof ConnectionSchema>;
export type Parameter = z.output<typeof ParameterSchema>;
export type Tool = z.output<typeof ToolSchema>;
export type ToolInput = z.input<typeof ToolSchema>;

/** Cross-field checks that need the query text and the set of known connections. */
export function validateToolRules(tool: Tool, connectionIds: Set<string>): string[] {
  const errors: string[] = [];
  if (!connectionIds.has(tool.connection)) errors.push(`Connection "${tool.connection}" does not exist`);

  const declared = new Set<string>();
  for (const p of tool.parameters) {
    if (declared.has(p.name)) errors.push(`Parameter "${p.name}" is declared more than once`);
    declared.add(p.name);
  }

  const used = new Set(extractPlaceholders(tool.query));
  for (const n of used) if (!declared.has(n)) errors.push(`Placeholder :${n} has no matching parameter`);
  for (const n of declared) if (!used.has(n)) errors.push(`Parameter "${n}" is not used in the query`);
  return errors;
}

/** Flattens a ZodError into readable "path: message" strings. */
export function formatZodError(err: z.ZodError): string[] {
  return err.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message));
}
