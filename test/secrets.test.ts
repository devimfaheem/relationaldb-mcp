import { describe, expect, it } from 'vitest';
import { createSecrets } from '../src/server/secrets.js';
import { loadEnv } from '../src/server/env.js';

const KEY = 'k'.repeat(32);

describe('secrets', () => {
  const s = createSecrets(KEY);

  it('round-trips', () => {
    const enc = s.encrypt('hunter2');
    expect(enc.startsWith('enc:v1:')).toBe(true);
    expect(enc).not.toContain('hunter2');
    expect(s.decrypt(enc)).toBe('hunter2');
  });

  it('rejects tampered ciphertext', () => {
    const enc = s.encrypt('hunter2');
    const tampered = enc.slice(0, -4) + (enc.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(() => s.decrypt(tampered)).toThrow();
  });

  it('rejects a different key', () => {
    const enc = s.encrypt('hunter2');
    expect(() => createSecrets('x'.repeat(32)).decrypt(enc)).toThrow(/SECRET_KEY/);
  });

  it('resolves ${ENV} references and plain values', () => {
    process.env.SQLMCP_TEST_PW = 'from-env';
    expect(s.resolve('${SQLMCP_TEST_PW}')).toBe('from-env');
    expect(s.resolve('plain')).toBe('plain');
    expect(s.resolve(s.encrypt('x'))).toBe('x');
    expect(() => s.resolve('${SQLMCP_DOES_NOT_EXIST}')).toThrow(/SQLMCP_DOES_NOT_EXIST/);
  });
});

describe('loadEnv', () => {
  const good = { API_KEY: 'a'.repeat(32), SECRET_KEY: KEY };

  it('applies defaults', () => {
    expect(loadEnv(good)).toMatchObject({
      port: 3000,
      dataDir: '/data',
      allowQueryKey: false,
      trustProxy: false,
    });
  });

  it('names the variable that is too short or missing', () => {
    expect(() => loadEnv({ ...good, API_KEY: 'short' })).toThrow('API_KEY must be at least 32 characters');
    expect(() => loadEnv({ ...good, SECRET_KEY: undefined })).toThrow('SECRET_KEY must be at least 32 characters');
  });

  it('parses booleans and port', () => {
    expect(loadEnv({ ...good, ALLOW_QUERY_KEY: 'true', PORT: '8080' })).toMatchObject({
      allowQueryKey: true,
      port: 8080,
    });
  });
});
