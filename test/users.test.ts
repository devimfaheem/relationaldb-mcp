import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openAppDb } from '../src/server/appdb.js';
import { MIGRATIONS } from '../src/server/migrations.js';
import { createUsers, hashPassword, verifyPassword, PasswordError } from '../src/server/users.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sqlmcp-db-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('migrations', () => {
  it('creates the schema and seeds admin/admin on a fresh database', () => {
    const db = openAppDb(join(dir, 'app.db'));
    const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version);
    expect(versions).toEqual(MIGRATIONS.map((m) => m.version));
    const users = createUsers(db);
    expect(users.verify('admin', 'admin')).toMatchObject({ username: 'admin', mustChangePassword: true });
    db.close();
  });

  it('is safe to re-run and never re-seeds', () => {
    const path = join(dir, 'app.db');
    const db1 = openAppDb(path);
    createUsers(db1).changePassword('admin', 'a-much-better-password');
    db1.close();

    const db2 = openAppDb(path);
    const users = createUsers(db2);
    expect(db2.prepare('SELECT COUNT(*) AS n FROM users').get()!.n).toBe(1);
    expect(users.verify('admin', 'admin')).toBeUndefined();
    expect(users.verify('admin', 'a-much-better-password')).toMatchObject({ mustChangePassword: false });
    db2.close();
  });
});

describe('password hashing', () => {
  it('round-trips and uses a random salt', () => {
    const a = hashPassword('secret-pass');
    expect(a).toMatch(/^scrypt\$/);
    expect(a).not.toBe(hashPassword('secret-pass'));
    expect(verifyPassword('secret-pass', a)).toBe(true);
    expect(verifyPassword('wrong', a)).toBe(false);
    expect(verifyPassword('x', 'garbage')).toBe(false);
  });
});

describe('users', () => {
  it('rejects weak new passwords', () => {
    const db = openAppDb(join(dir, 'app.db'));
    const users = createUsers(db);
    expect(() => users.changePassword('admin', 'short')).toThrow(PasswordError);
    expect(() => users.changePassword('admin', 'admin')).toThrow(PasswordError);
    db.close();
  });

  it('resetAdmin restores admin/admin with a forced change', () => {
    const db = openAppDb(join(dir, 'app.db'));
    const users = createUsers(db);
    users.changePassword('admin', 'a-much-better-password');
    users.resetAdmin();
    expect(users.verify('admin', 'admin')).toMatchObject({ mustChangePassword: true });
    db.close();
  });

  it('returns undefined for unknown users', () => {
    const db = openAppDb(join(dir, 'app.db'));
    expect(createUsers(db).verify('nobody', 'admin')).toBeUndefined();
    expect(createUsers(db).get('nobody')).toBeUndefined();
    db.close();
  });
});
