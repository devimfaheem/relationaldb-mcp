import { describe, expect, it } from 'vitest';
import { ConnectionSchema, ToolSchema, validateToolRules } from '../src/shared/schema.js';

const tool = {
  name: 'get_orders',
  description: 'Orders for a customer',
  connection: 'sales',
  mode: 'read',
  query: 'SELECT * FROM orders WHERE customer_id = :customer_id LIMIT :limit',
  parameters: [
    { name: 'customer_id', type: 'integer', required: true, description: 'Customer' },
    { name: 'limit', type: 'integer', default: 50, min: 1, max: 500, description: 'Max rows' },
  ],
};

describe('ToolSchema', () => {
  it('parses and applies defaults', () => {
    const t = ToolSchema.parse(tool);
    expect(t.enabled).toBe(true);
    expect(t.limits).toEqual({ maxRows: 1000, timeoutMs: 30000 });
    expect(t.parameters[0].required).toBe(true);
    expect(t.parameters[1].required).toBe(false);
  });

  it('rejects bad names', () => {
    expect(ToolSchema.safeParse({ ...tool, name: 'Bad-Name' }).success).toBe(false);
  });

  it('rejects a default outside the enum', () => {
    const bad = {
      ...tool,
      parameters: [{ name: 's', type: 'string', description: 'x', enum: ['a', 'b'], default: 'c' }],
    };
    expect(ToolSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects min on a string parameter', () => {
    const bad = { ...tool, parameters: [{ name: 's', type: 'string', description: 'x', min: 1 }] };
    expect(ToolSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a default of the wrong type', () => {
    const bad = { ...tool, parameters: [{ name: 'n', type: 'integer', description: 'x', default: 'a' }] };
    expect(ToolSchema.safeParse(bad).success).toBe(false);
  });
});

describe('ConnectionSchema', () => {
  it('fills the default port per engine', () => {
    const base = { id: 'c', host: 'h', database: 'd', user: 'u', password: 'p' };
    expect(ConnectionSchema.parse({ ...base, engine: 'mysql' }).port).toBe(3306);
    expect(ConnectionSchema.parse({ ...base, engine: 'mssql' }).port).toBe(1433);
    expect(ConnectionSchema.parse({ ...base, engine: 'postgres' }).port).toBe(5432);
    expect(ConnectionSchema.parse({ ...base, engine: 'postgres', port: 6543 }).port).toBe(6543);
  });
});

describe('validateToolRules', () => {
  const conns = new Set(['sales']);

  it('accepts a valid tool', () => {
    expect(validateToolRules(ToolSchema.parse(tool), conns)).toEqual([]);
  });

  it('reports undeclared placeholders, unused and duplicate parameters, unknown connection', () => {
    const t = ToolSchema.parse({
      ...tool,
      connection: 'nope',
      query: 'SELECT :customer_id, :missing',
      parameters: [
        { name: 'customer_id', type: 'integer', description: 'x' },
        { name: 'customer_id', type: 'integer', description: 'x' },
        { name: 'unused', type: 'string', description: 'x' },
      ],
    });
    const errors = validateToolRules(t, conns);
    expect(errors).toContain('Connection "nope" does not exist');
    expect(errors).toContain('Placeholder :missing has no matching parameter');
    expect(errors).toContain('Parameter "unused" is not used in the query');
    expect(errors).toContain('Parameter "customer_id" is declared more than once');
  });
});
