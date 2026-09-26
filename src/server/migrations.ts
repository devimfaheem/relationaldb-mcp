import type { DatabaseSync } from 'node:sqlite';
import { hashPassword } from './users.js';

export interface Migration {
  version: number;
  name: string;
  up(db: DatabaseSync): void;
}

/** Append-only: never edit a migration after it has shipped, add a new one instead. */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'create_users',
    up: (db) =>
      db.exec(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          must_change_password INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `),
  },
  {
    version: 2,
    name: 'seed_admin',
    up: (db) => {
      const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
      if (n === 0) {
        db.prepare('INSERT INTO users (username, password_hash, must_change_password) VALUES (?, ?, 1)').run(
          'admin',
          hashPassword('admin'),
        );
      }
    },
  },
];

/** Runs every migration not yet recorded in schema_migrations, each in its own transaction. */
export function migrate(db: DatabaseSync, migrations = MIGRATIONS): number[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  const done = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version),
  );
  const applied: number[] = [];
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (done.has(m.version)) continue;
    db.exec('BEGIN');
    try {
      m.up(db);
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(m.version, m.name);
      db.exec('COMMIT');
      applied.push(m.version);
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${m.version}_${m.name} failed: ${(e as Error).message}`);
    }
  }
  return applied;
}
