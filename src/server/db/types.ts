import type { Connection } from '../../shared/schema.js';

export interface QueryOptions {
  readOnly: boolean;
  timeoutMs: number;
  maxRows: number;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  affectedRows?: number;
}

export interface Driver {
  query(sql: string, values: unknown[] | Record<string, unknown>, opts: QueryOptions): Promise<QueryResult>;
  testConnection(): Promise<void>;
  close(): Promise<void>;
}

/** A connection whose `user` and `password` have been resolved to real values. */
export type ResolvedConnection = Connection;

export type DriverFactory = (conn: ResolvedConnection) => Driver;

/** Caps rows at maxRows and builds a QueryResult. */
export function toResult(rows: Record<string, unknown>[], columns: string[], maxRows: number): QueryResult {
  const truncated = rows.length > maxRows;
  const kept = truncated ? rows.slice(0, maxRows) : rows;
  return { columns, rows: kept, rowCount: kept.length, truncated };
}
