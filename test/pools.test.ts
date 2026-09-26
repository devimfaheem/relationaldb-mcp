import { describe, expect, it } from 'vitest';
import { PoolManager } from '../src/server/db/pools.js';
import { createSecrets } from '../src/server/secrets.js';
import { ConnectionSchema } from '../src/shared/schema.js';
import { createFakeDriver, type FakeDriver } from './fake-driver.js';

const secrets = createSecrets('k'.repeat(32));
const conn = ConnectionSchema.parse({
  id: 'c', engine: 'postgres', host: 'h', database: 'd', user: 'u', password: secrets.encrypt('pw'),
});

function manager() {
  const created: { driver: FakeDriver; password: string }[] = [];
  const pools = new PoolManager({
    secrets,
    factories: {
      postgres: (c) => {
        const driver = createFakeDriver();
        created.push({ driver, password: c.password });
        return driver;
      },
    },
  });
  return { pools, created };
}

describe('PoolManager', () => {
  it('reuses the driver for an unchanged connection and resolves secrets', () => {
    const { pools, created } = manager();
    expect(pools.get(conn)).toBe(pools.get(conn));
    expect(created).toHaveLength(1);
    expect(created[0].password).toBe('pw');
  });

  it('replaces and closes the driver when the connection changes', () => {
    const { pools, created } = manager();
    pools.get(conn);
    pools.get({ ...conn, host: 'other' });
    expect(created).toHaveLength(2);
    expect(created[0].driver.closed).toBe(true);
  });

  it('evict closes the driver', async () => {
    const { pools, created } = manager();
    pools.get(conn);
    await pools.evict('c');
    expect(created[0].driver.closed).toBe(true);
  });
});
