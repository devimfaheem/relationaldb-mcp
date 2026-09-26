import pg from 'pg';
import { toResult, type Driver, type ResolvedConnection } from './types.js';

export function createPostgresDriver(c: ResolvedConnection): Driver {
  const pool = new pg.Pool({
    host: c.host,
    port: c.port,
    user: c.user,
    password: c.password,
    database: c.database,
    max: c.pool.max,
    ssl: c.ssl.enabled ? { rejectUnauthorized: c.ssl.rejectUnauthorized } : undefined,
    ...(c.options as pg.PoolConfig),
  });

  return {
    async query(sql, values, { readOnly, timeoutMs, maxRows }) {
      const client = await pool.connect();
      try {
        await client.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
        try {
          // timeoutMs is a validated integer, so inlining it here is safe.
          await client.query(`SET LOCAL statement_timeout = ${Math.trunc(timeoutMs)}`);
          const res = await client.query(sql, values as unknown[]);
          await client.query('COMMIT');
          if (res.command !== 'SELECT' && res.fields.length === 0) {
            return { columns: [], rows: [], rowCount: 0, truncated: false, affectedRows: res.rowCount ?? 0 };
          }
          return toResult(res.rows, res.fields.map((f) => f.name), maxRows);
        } catch (e) {
          await client.query('ROLLBACK').catch(() => {});
          throw e;
        }
      } finally {
        client.release();
      }
    },
    async testConnection() {
      await pool.query('SELECT 1');
    },
    async close() {
      await pool.end();
    },
  };
}
