import type { Connection, Engine } from '../../shared/schema.js';
import type { Secrets } from '../secrets.js';
import { createMssqlDriver } from './mssql.js';
import { createMysqlDriver } from './mysql.js';
import { createPostgresDriver } from './postgres.js';
import type { Driver, DriverFactory } from './types.js';

const DEFAULT_FACTORIES: Record<Engine, DriverFactory> = {
  mysql: createMysqlDriver,
  postgres: createPostgresDriver,
  mssql: createMssqlDriver,
};

/** One driver (connection pool) per connection id, created lazily and replaced when the definition changes. */
export class PoolManager {
  private drivers = new Map<string, { key: string; driver: Driver }>();
  private factories: Record<Engine, DriverFactory>;

  constructor(private opts: { secrets: Secrets; factories?: Partial<Record<Engine, DriverFactory>> }) {
    this.factories = { ...DEFAULT_FACTORIES, ...opts.factories };
  }

  /** Creates a driver without caching it — used for "test connection" on unsaved definitions. */
  create(conn: Connection): Driver {
    const { secrets } = this.opts;
    return this.factories[conn.engine]({ ...conn, user: secrets.resolve(conn.user), password: secrets.resolve(conn.password) });
  }

  get(conn: Connection): Driver {
    const key = JSON.stringify(conn);
    const cached = this.drivers.get(conn.id);
    if (cached?.key === key) return cached.driver;
    if (cached) cached.driver.close().catch(() => {});
    const driver = this.create(conn);
    this.drivers.set(conn.id, { key, driver });
    return driver;
  }

  async evict(id: string): Promise<void> {
    const cached = this.drivers.get(id);
    this.drivers.delete(id);
    await cached?.driver.close().catch(() => {});
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.drivers.keys()].map((id) => this.evict(id)));
  }
}
