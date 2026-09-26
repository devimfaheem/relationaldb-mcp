import type { Connection, Tool } from '../../src/shared/schema';

export type { Connection, Tool };
export type Parameter = Tool['parameters'][number];

export interface Invalid {
  file: string;
  errors: string[];
}

export interface RunResult {
  isError: boolean;
  text: string;
  structured?: { columns?: string[]; rows?: Record<string, unknown>[]; truncated?: boolean; affectedRows?: number };
}

export const PASSWORD_MASK = '••••••';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public errors: string[] = [],
  ) {
    super(message);
  }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'x-requested-with': 'sqlmcp', ...(body !== undefined && { 'content-type': 'application/json' }) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errors: string[] = data.errors ?? [];
    throw new ApiError(res.status, data.error || errors.join('; ') || res.statusText, errors);
  }
  return data as T;
}

export const errorText = (e: unknown) =>
  e instanceof ApiError && e.errors.length ? e.errors.join('\n') : (e as Error).message;
