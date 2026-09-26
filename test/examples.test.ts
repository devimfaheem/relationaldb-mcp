import { describe, expect, it } from 'vitest';
import { ConfigStore } from '../src/server/store.js';

describe('examples/data', () => {
  it('contains only valid connections and tools', async () => {
    const store = new ConfigStore(new URL('../examples/data', import.meta.url).pathname);
    await store.load();
    expect(store.invalid()).toEqual([]);
    expect(store.connections().map((c) => c.id).sort()).toEqual(['demo_mssql', 'demo_mysql', 'demo_postgres']);
    expect(store.tools()).toHaveLength(4);
  });
});
