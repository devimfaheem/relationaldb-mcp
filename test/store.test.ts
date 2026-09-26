import { mkdtemp, mkdir, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigStore } from '../src/server/store.js';

const conn = { id: 'sales', engine: 'postgres', host: 'h', database: 'd', user: 'u', password: 'p' };
const tool = {
  name: 'list_orders',
  description: 'List orders',
  connection: 'sales',
  mode: 'read',
  query: 'SELECT * FROM orders',
};

let dir: string;
let store: ConfigStore;

async function put(sub: string, file: string, body: unknown) {
  await mkdir(join(dir, sub), { recursive: true });
  await writeFile(join(dir, sub, file), typeof body === 'string' ? body : JSON.stringify(body));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sqlmcp-'));
  store = new ConfigStore(dir);
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

describe('ConfigStore', () => {
  it('loads valid files', async () => {
    await put('connections', 'sales.json', conn);
    await put('tools', 'list_orders.json', tool);
    await store.load();
    expect(store.getConnection('sales')?.port).toBe(5432);
    expect(store.tools().map((t) => t.name)).toEqual(['list_orders']);
    expect(store.invalid()).toEqual([]);
  });

  it('reports invalid JSON, mismatched filenames and unknown connections', async () => {
    await put('connections', 'broken.json', '{nope');
    await put('connections', 'other.json', conn);
    await put('tools', 'list_orders.json', tool);
    await store.load();
    expect(store.connections()).toEqual([]);
    expect(store.tools()).toEqual([]);
    const files = store.invalid().map((i) => i.file).sort();
    expect(files).toEqual(['connections/broken.json', 'connections/other.json', 'tools/list_orders.json']);
    const toolErr = store.invalid().find((i) => i.file === 'tools/list_orders.json')!;
    expect(toolErr.errors).toContain('Connection "sales" does not exist');
  });

  it('saves and deletes', async () => {
    await store.load();
    await store.saveConnection({ ...conn, port: 5432, ssl: { enabled: false, rejectUnauthorized: true }, pool: { max: 10 }, options: {} } as never);
    await store.saveTool({ ...tool, enabled: true, parameters: [], limits: { maxRows: 1000, timeoutMs: 30000 } } as never);
    await access(join(dir, 'tools', 'list_orders.json'));
    expect(store.getTool('list_orders')).toBeDefined();

    await expect(store.deleteConnection('sales')).rejects.toThrow(/used by/);
    await store.deleteTool('list_orders');
    await store.deleteConnection('sales');
    expect(store.connections()).toEqual([]);
  });

  it('emits change when a file is edited externally', async () => {
    await store.load();
    store.watch(50);
    const changed = new Promise<void>((resolve, reject) => {
      store.once('change', () => resolve());
      setTimeout(() => reject(new Error('no change event')), 3000);
    });
    await put('connections', 'sales.json', conn);
    await changed;
    expect(store.getConnection('sales')).toBeDefined();
  });
});
