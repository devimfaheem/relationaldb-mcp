import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const PREFIX = 'enc:v1:';
const ENV_REF = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

export interface Secrets {
  encrypt(plain: string): string;
  decrypt(value: string): string;
  /** Turns a stored value (`enc:v1:…`, `${ENV}`, or plain text) into the real secret. */
  resolve(value: string): string;
}

export const isEncrypted = (v: string) => v.startsWith(PREFIX);
export const isEnvRef = (v: string) => ENV_REF.test(v);

export function createSecrets(secretKey: string): Secrets {
  const key = Buffer.from(hkdfSync('sha256', secretKey, '', 'sqlmcp-secrets', 32));

  const encrypt = (plain: string) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  };

  const decrypt = (value: string) => {
    const buf = Buffer.from(value.slice(PREFIX.length), 'base64');
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
      decipher.setAuthTag(buf.subarray(12, 28));
      return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('Could not decrypt secret (was SECRET_KEY changed?)');
    }
  };

  const resolve = (value: string) => {
    if (isEncrypted(value)) return decrypt(value);
    const ref = ENV_REF.exec(value);
    if (ref) {
      const v = process.env[ref[1]];
      if (v === undefined) throw new Error(`Environment variable ${ref[1]} is not set`);
      return v;
    }
    return value;
  };

  return { encrypt, decrypt, resolve };
}
