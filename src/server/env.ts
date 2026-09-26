export interface Env {
  apiKey: string;
  secretKey: string;
  port: number;
  dataDir: string;
  allowQueryKey: boolean;
  logLevel: string;
  trustProxy: boolean;
}

function required(source: NodeJS.ProcessEnv, name: string, minLength: number): string {
  const v = source[name];
  if (!v || v.length < minLength) throw new Error(`${name} must be at least ${minLength} characters`);
  return v;
}

const bool = (v: string | undefined) => v === 'true' || v === '1';

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const port = Number(source.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid port number');
  return {
    apiKey: required(source, 'API_KEY', 32),
    secretKey: required(source, 'SECRET_KEY', 32),
    port,
    dataDir: source.DATA_DIR || '/data',
    allowQueryKey: bool(source.ALLOW_QUERY_KEY),
    logLevel: source.LOG_LEVEL || 'info',
    trustProxy: bool(source.TRUST_PROXY),
  };
}
