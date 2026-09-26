import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** Constant-time string comparison (hashing first makes lengths equal). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function extractApiKey(req: FastifyRequest, allowQuery: boolean): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  if (allowQuery) {
    const key = (req.query as Record<string, unknown> | undefined)?.key;
    if (typeof key === 'string') return key;
  }
  return undefined;
}

/** Counts failed attempts per IP in a fixed window. */
export class FailureLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private max = 10,
    private windowMs = 60_000,
  ) {}

  blocked(ip: string): boolean {
    const h = this.hits.get(ip);
    if (!h) return false;
    if (Date.now() > h.resetAt) {
      this.hits.delete(ip);
      return false;
    }
    return h.count >= this.max;
  }

  fail(ip: string): void {
    const now = Date.now();
    const h = this.hits.get(ip);
    if (!h || now > h.resetAt) this.hits.set(ip, { count: 1, resetAt: now + this.windowMs });
    else h.count++;
  }
}

export const SESSION_COOKIE = 'sqlmcp_session';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** Cookie value is `<username>|<expiry ms>`, signed with SECRET_KEY. */
export function setSession(req: FastifyRequest, reply: FastifyReply, username: string): void {
  reply.setCookie(SESSION_COOKIE, `${username}|${Date.now() + SESSION_TTL_MS}`, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: req.protocol === 'https',
    signed: true,
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function clearSession(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** Returns the logged-in username, or undefined if there is no valid session. */
export function sessionUser(req: FastifyRequest): string | undefined {
  const raw = req.cookies[SESSION_COOKIE];
  if (!raw) return undefined;
  const { valid, value } = req.unsignCookie(raw);
  if (!valid || !value) return undefined;
  const sep = value.lastIndexOf('|');
  const username = value.slice(0, sep);
  return sep > 0 && Number(value.slice(sep + 1)) > Date.now() ? username : undefined;
}
