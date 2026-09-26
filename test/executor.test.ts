import { describe, expect, it } from 'vitest';
import { createExecutor } from '../src/server/executor.js';
import { ConnectionSchema, ToolSchema } from '../src/shared/schema.js';
import { createFakeDriver } from './fake-driver.js';

const conn = ConnectionSchema.parse({ id: 'db', engine: 'postgres', host: 'h', database: 'd', user: 'u', password: 'p' });
const tool = ToolSchema.parse({
  name: 't',
  description: 'd',
  connection: 'db',
  mode: 'read',
  query: 'SELECT * FROM orders WHERE customer_id = :cid LIMIT :limit',
  parameters: [
    { name: 'cid', type: 'integer', required: true, description: 'c' },
    { name: 'limit', type: 'integer', default: 10, max: 100, description: 'l' },
  ],
  limits: { maxRows: 5, timeoutMs: 1000 },
});

function setup(driver = createFakeDriver()) {
  const exec = createExecutor({ getConnection: (id) => (id === 'db' ? conn : undefined), pools: { get: () => driver } });
  return { exec, driver };
}

describe('executor', () => {
  it('compiles the query for the engine and passes options', async () => {
    const { exec, driver } = setup();
    const res = await exec.run(tool, { cid: 3 });
    expect(res.isError).toBe(false);
    expect(driver.calls[0]).toEqual({
      sql: 'SELECT * FROM orders WHERE customer_id = $1 LIMIT $2',
      values: [3, 10],
      opts: { readOnly: true, timeoutMs: 1000, maxRows: 5 },
    });
    expect(JSON.parse(res.text)).toEqual({ columns: ['id'], rows: [{ id: 1 }], rowCount: 1, truncated: false });
    expect(res.structured).toEqual(JSON.parse(res.text));
  });

  it('uses readOnly false for write tools and returns affectedRows', async () => {
    const { exec, driver } = setup(createFakeDriver(() => ({ columns: [], rows: [], rowCount: 0, truncated: false, affectedRows: 2 })));
    const res = await exec.run({ ...tool, mode: 'write' }, { cid: 3 });
    expect(driver.calls[0].opts.readOnly).toBe(false);
    expect(JSON.parse(res.text)).toEqual({ affectedRows: 2 });
  });

  it('returns argument errors without touching the database', async () => {
    const { exec, driver } = setup();
    const res = await exec.run(tool, { cid: 3, limit: 1000 });
    expect(res).toMatchObject({ isError: true });
    expect(res.text).toContain('parameter `limit`');
    expect(driver.calls).toHaveLength(0);
  });

  it('wraps database errors', async () => {
    const { exec } = setup(createFakeDriver(() => { throw new Error('relation "orders" does not exist'); }));
    const res = await exec.run(tool, { cid: 3 });
    expect(res).toEqual({ isError: true, text: 'Query failed: relation "orders" does not exist' });
  });

  it('reports a missing connection', async () => {
    const { exec } = setup();
    const res = await exec.run({ ...tool, connection: 'gone' }, { cid: 3 });
    expect(res).toEqual({ isError: true, text: 'Connection "gone" not found' });
  });
});
