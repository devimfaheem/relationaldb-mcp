import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/server/app.js';
import { PoolManager } from '../src/server/db/pools.js';
import { loadEnv, type Env } from '../src/server/env.js';
import { createSecrets } from '../src/server/secrets.js';
import { ConfigStore } from '../src/server/store.js';
import { createFakeDriver, type FakeDriver } from './fake-driver.js';

export const API_KEY = 'test-api-key-'.padEnd(40, 'x');
export const ADMIN_PASSWORD = 'correct-horse';

export const demoConnection = { id: 'shop', engine: 'postgres', host: 'db', database: 'shop', user: 'u', password: 'p' };
export const demoTool = {
  name: 'get_orders',
  description: 'Orders for a customer',
  connection: 'shop',
  mode: 'read',
  query: 'SELECT id FROM orders WHERE customer_id = :customer_id',
  parameters: [{ name: 'customer_id', type: 'integer', required: true, description: 'Customer id' }],
};

/** Builds an app over a temp data dir, with every engine backed by one fake driver. */
export async function setupApp(opts: { env?: Partial<Env>; files?: Record<string, unknown> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'sqlmcp-app-'));
  for (const [path, body] of Object.entries(opts.files ?? {})) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), JSON.stringify(body));
  }
  const env = {
    ...loadEnv({ API_KEY, ADMIN_PASSWORD, SECRET_KEY: 's'.repeat(32), DATA_DIR: dir }),
    ...opts.env,
  };
  const driver: FakeDriver = createFakeDriver();
  const secrets = createSecrets(env.secretKey);
  const factory = () => driver;
  const pools = new PoolManager({ secrets, factories: { mysql: factory, postgres: factory, mssql: factory } });
  const store = new ConfigStore(dir);
  await store.load();
  const app = await buildApp({ env, store, pools, secrets });
  return {
    app,
    dir,
    driver,
    store,
    secrets,
    async cleanup() {
      store.close();
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
