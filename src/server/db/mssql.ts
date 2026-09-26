import sql from 'mssql';
import { toResult, type Driver, type ResolvedConnection } from './types.js';

export function createMssqlDriver(c: ResolvedConnection): Driver {
  const pool = new sql.ConnectionPool({
    server: c.host,
    port: c.port,
    user: c.user,
    password: c.password,
    database: c.database,
    pool: { max: c.pool.max },
    options: {
      encrypt: c.ssl.enabled,
      trustServerCertificate: !c.ssl.rejectUnauthorized,
      ...(c.options as sql.config['options']),
    },
  });
  const ready = pool.connect();
  // Surface connection errors on first use instead of as an unhandled rejection.
  ready.catch(() => {});

  return {
    async query(text, values, { readOnly, timeoutMs, maxRows }) {
      await ready;
      const tx = new sql.Transaction(pool);
      await tx.begin();
      try {
        // The second constructor argument (per-request timeout) is supported but missing from the types.
        const req = new (sql.Request as unknown as new (p: sql.Transaction, o: { requestTimeout: number }) => sql.Request)(tx, {
          requestTimeout: timeoutMs,
        });
        for (const [name, value] of Object.entries(values as Record<string, unknown>)) req.input(name, value);
        const res = await req.query(text);
        // Read-only tools always roll back: SQL Server has no read-only transaction mode.
        if (readOnly) await tx.rollback();
        else await tx.commit();

        const recordset = res.recordset as (sql.IRecordSet<Record<string, unknown>> | undefined);
        if (!recordset) {
          return { columns: [], rows: [], rowCount: 0, truncated: false, affectedRows: res.rowsAffected.reduce((a, b) => a + b, 0) };
        }
        return toResult([...recordset], Object.keys(recordset.columns), maxRows);
      } catch (e) {
        await tx.rollback().catch(() => {});
        throw e;
      }
    },
    async testConnection() {
      await ready;
      await pool.request().query('SELECT 1');
    },
    async close() {
      await pool.close();
    },
  };
}
