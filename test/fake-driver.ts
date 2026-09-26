import type { Driver, QueryOptions, QueryResult } from '../src/server/db/types.js';

export interface FakeCall {
  sql: string;
  values: unknown[] | Record<string, unknown>;
  opts: QueryOptions;
}

export type FakeDriver = Driver & { calls: FakeCall[]; closed: boolean };

const DEFAULT: QueryResult = { columns: ['id'], rows: [{ id: 1 }], rowCount: 1, truncated: false };

export function createFakeDriver(handler: (call: FakeCall) => QueryResult = () => DEFAULT): FakeDriver {
  const d: FakeDriver = {
    calls: [],
    closed: false,
    async query(sql, values, opts) {
      const call = { sql, values, opts };
      d.calls.push(call);
      return handler(call);
    },
    async testConnection() {},
    async close() {
      d.closed = true;
    },
  };
  return d;
}
