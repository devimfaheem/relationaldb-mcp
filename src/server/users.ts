import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export class PasswordError extends Error {}

export interface User {
  username: string;
  mustChangePassword: boolean;
}

const KEY_LEN = 64;

/** `scrypt$<salt b64>$<hash b64>` */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LEN);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = scryptSync(password, Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

export function validateNewPassword(password: string): void {
  if (password.length < 8) throw new PasswordError('Password must be at least 8 characters');
  if (password === 'admin') throw new PasswordError('Choose a password other than the default');
}

// Hash of a random string, compared against when the user doesn't exist so timing doesn't reveal usernames.
const DUMMY_HASH = hashPassword(randomBytes(16).toString('hex'));

interface Row {
  username: string;
  password_hash: string;
  must_change_password: number;
}

const toUser = (r: Row): User => ({ username: r.username, mustChangePassword: r.must_change_password === 1 });

export type Users = ReturnType<typeof createUsers>;

export function createUsers(db: DatabaseSync) {
  const find = (username: string) =>
    db.prepare('SELECT username, password_hash, must_change_password FROM users WHERE username = ?').get(username) as
      | Row
      | undefined;

  return {
    get(username: string): User | undefined {
      const row = find(username);
      return row && toUser(row);
    },

    /** Returns the user if the password matches, otherwise undefined. */
    verify(username: string, password: string): User | undefined {
      const row = find(username);
      const ok = verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
      return ok && row ? toUser(row) : undefined;
    },

    changePassword(username: string, newPassword: string): void {
      validateNewPassword(newPassword);
      db.prepare(
        "UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = datetime('now') WHERE username = ?",
      ).run(hashPassword(newPassword), username);
    },

    /** Recovery: sets admin/admin (creating the user if needed) and forces a password change. */
    resetAdmin(): void {
      db.prepare(
        `INSERT INTO users (username, password_hash, must_change_password) VALUES ('admin', ?, 1)
         ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash, must_change_password = 1,
           updated_at = datetime('now')`,
      ).run(hashPassword('admin'));
    },
  };
}
