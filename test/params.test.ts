import { describe, expect, it } from 'vitest';
import { ParameterSchema, type Parameter } from '../src/shared/schema.js';
import { ArgsError, parseArgs, toJsonSchema } from '../src/server/params.js';

const params: Parameter[] = [
  { name: 'customer_id', type: 'integer', required: true, description: 'Customer' },
  { name: 'status', type: 'string', enum: ['pending', 'shipped'], description: 'Status' },
  { name: 'limit', type: 'integer', default: 50, min: 1, max: 500, description: 'Max rows' },
  { name: 'since', type: 'date', description: 'Since' },
].map((p) => ParameterSchema.parse(p));

describe('toJsonSchema', () => {
  it('maps parameters to JSON Schema', () => {
    expect(toJsonSchema(params)).toEqual({
      type: 'object',
      properties: {
        customer_id: { type: 'integer', description: 'Customer' },
        status: { type: 'string', description: 'Status', enum: ['pending', 'shipped'] },
        limit: { type: 'integer', description: 'Max rows', default: 50, minimum: 1, maximum: 500 },
        since: { type: 'string', description: 'Since', format: 'date' },
      },
      required: ['customer_id'],
      additionalProperties: false,
    });
  });
});

describe('parseArgs', () => {
  it('applies defaults and nulls missing optionals', () => {
    expect(parseArgs(params, { customer_id: 7 })).toEqual({ customer_id: 7, status: null, limit: 50, since: null });
  });

  it('rejects out-of-range values with the parameter name', () => {
    expect(() => parseArgs(params, { customer_id: 1, limit: 1000 })).toThrow(ArgsError);
    expect(() => parseArgs(params, { customer_id: 1, limit: 1000 })).toThrow('parameter `limit`');
  });

  it('rejects wrong types, bad dates, enum misses, unknown args and missing required', () => {
    expect(() => parseArgs(params, { customer_id: 1.5 })).toThrow('parameter `customer_id`');
    expect(() => parseArgs(params, { customer_id: 1, since: '2024-13-45' })).toThrow('parameter `since`');
    expect(() => parseArgs(params, { customer_id: 1, status: 'lost' })).toThrow('parameter `status`');
    expect(() => parseArgs(params, { customer_id: 1, extra: true })).toThrow('extra');
    expect(() => parseArgs(params, {})).toThrow('parameter `customer_id`');
  });

  it('treats undefined args as an empty object', () => {
    expect(parseArgs([], undefined)).toEqual({});
  });
});
