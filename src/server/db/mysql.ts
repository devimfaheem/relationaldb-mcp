import mysql from 'mysql2/promise';
import { toResult, type Driver, type ResolvedConnection } from './types.js';

export function createMysqlDriver(c: ResolvedConnection): Driver {
  const pool = mysql.createPool({
    host: c.host,
    port: c.port,
    user: c.user,
    password: c.password,
    database: c.database,
    connectionLimit: c.pool.max,
    ssl: c.ssl.enabled ? { rejectUnauthorized: c.ssl.rejectUnauthorized } : undefined,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    ...(c.options as mysql.PoolOptions),
  });

  return {
    async query(sql, values, { readOnly, timeoutMs, maxRows }) {
      const conn = await pool.getConnection();
      try {
        await conn.query(readOnly ? 'START TRANSACTION READ ONLY' : 'START TRANSACTION');
        try {
          const [res, fields] = await conn.query({ sql, timeout: timeoutMs }, values as unknown[]);
          await conn.query('COMMIT');
          if (!Array.isArray(res)) {
            return { columns: [], rows: [], rowCount: 0, truncated: false, affectedRows: (res as mysql.ResultSetHeader).affectedRows };
          }
          return toResult(res as Record<string, unknown>[], (fields ?? []).map((f) => f.name), maxRows);
        } catch (e) {
          await conn.query('ROLLBACK').catch(() => {});
          throw e;
        }
      } finally {
        conn.release();
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
