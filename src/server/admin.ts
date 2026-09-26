import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  ConnectionSchema,
  ToolSchema,
  formatZodError,
  validateToolRules,
  type Connection,
  type Tool,
} from '../shared/schema.js';
import type { PoolManager } from './db/pools.js';
import type { Env } from './env.js';
import type { Executor } from './executor.js';
import { clearSession, FailureLimiter, hasSession, safeEqual, setSession } from './auth.js';
import { isEncrypted, isEnvRef, type Secrets } from './secrets.js';
import { ConflictError, type ConfigStore } from './store.js';

export const PASSWORD_MASK = '••••••';

interface Deps {
  env: Env;
  store: ConfigStore;
  pools: PoolManager;
  secrets: Secrets;
  executor: Executor;
  version: string;
}

type Body = Record<string, unknown>;

export function registerAdmin(app: FastifyInstance, { env, store, pools, secrets, executor, version }: Deps): void {
  const limiter = new FailureLimiter();
  const PUBLIC = new Set(['/api/auth/login', '/api/auth/me']);

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    // CSRF: browsers can't send custom headers cross-site without a CORS preflight, which we never allow.
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'sqlmcp') {
      return reply.code(403).send({ error: 'Missing X-Requested-With header' });
    }
    const path = req.url.split('?')[0];
    if (!PUBLIC.has(path) && !hasSession(req)) return reply.code(401).send({ error: 'Not logged in' });
  });

  const invalid = (reply: FastifyReply, errors: string[]) => reply.code(400).send({ errors });

  // ---- auth ----
  app.post('/api/auth/login', async (req, reply) => {
    if (limiter.blocked(req.ip)) return reply.code(429).send({ error: 'Too many failed attempts, try again later' });
    const { username = '', password = '' } = (req.body ?? {}) as Body as { username?: string; password?: string };
    const ok = safeEqual(String(username), env.adminUsername) && safeEqual(String(password), env.adminPassword);
    if (!ok) {
      limiter.fail(req.ip);
      return reply.code(401).send({ error: 'Invalid username or password' });
    }
    setSession(req, reply);
    return { ok: true };
  });
  app.post('/api/auth/logout', async (_req, reply) => {
    clearSession(reply);
    return { ok: true };
  });
  app.get('/api/auth/me', async (req) => ({ authenticated: hasSession(req) }));

  app.get('/api/status', async () => ({ version, invalid: store.invalid() }));

  // ---- connections ----
  const mask = (c: Connection) => ({ ...c, password: PASSWORD_MASK });

  /** Validates a connection body, keeping/encrypting the password as needed. */
  const parseConnection = (id: string, body: Body): { conn?: Connection; errors?: string[] } => {
    let password = body.password;
    if (password === undefined || password === PASSWORD_MASK) {
      password = store.getConnection(id)?.password;
      if (password === undefined) return { errors: ['password: required'] };
    } else if (typeof password === 'string' && !isEncrypted(password) && !isEnvRef(password)) {
      password = secrets.encrypt(password);
    }
    const r = ConnectionSchema.safeParse({ ...body, id, password });
    return r.success ? { conn: r.data } : { errors: formatZodError(r.error) };
  };

  app.get('/api/connections', async () => store.connections().map(mask));

  app.get<{ Params: { id: string } }>('/api/connections/:id', async (req, reply) => {
    const c = store.getConnection(req.params.id);
    return c ? mask(c) : reply.code(404).send({ error: 'Not found' });
  });

  app.put<{ Params: { id: string } }>('/api/connections/:id', async (req, reply) => {
    const body = (req.body ?? {}) as Body;
    if (body.id !== undefined && body.id !== req.params.id) return invalid(reply, ['id: must match the URL']);
    const { conn, errors } = parseConnection(req.params.id, body);
    if (!conn) return invalid(reply, errors!);
    await store.saveConnection(conn);
    await pools.evict(conn.id);
    return mask(conn);
  });

  app.delete<{ Params: { id: string } }>('/api/connections/:id', async (req, reply) => {
    try {
      await store.deleteConnection(req.params.id);
      await pools.evict(req.params.id);
      return { ok: true };
    } catch (e) {
      if (e instanceof ConflictError) return reply.code(409).send({ error: e.message });
      throw e;
    }
  });

  app.post<{ Params: { id: string } }>('/api/connections/:id/test', async (req, reply) => {
    const body = req.body as Body | undefined;
    let conn = store.getConnection(req.params.id);
    if (body && Object.keys(body).length) {
      const parsed = parseConnection(req.params.id, body);
      if (!parsed.conn) return invalid(reply, parsed.errors!);
      conn = parsed.conn;
    }
    if (!conn) return reply.code(404).send({ error: 'Not found' });
    try {
      const driver = pools.create(conn);
      try {
        await driver.testConnection();
      } finally {
        await driver.close().catch(() => {});
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  // ---- tools ----
  const parseTool = (body: unknown): { tool?: Tool; errors?: string[] } => {
    const r = ToolSchema.safeParse(body);
    if (!r.success) return { errors: formatZodError(r.error) };
    const errors = validateToolRules(r.data, new Set(store.connections().map((c) => c.id)));
    return errors.length ? { errors } : { tool: r.data };
  };

  app.get('/api/tools', async () => store.tools());

  app.get<{ Params: { name: string } }>('/api/tools/:name', async (req, reply) => {
    return store.getTool(req.params.name) ?? reply.code(404).send({ error: 'Not found' });
  });

  app.put<{ Params: { name: string } }>('/api/tools/:name', async (req, reply) => {
    const { tool, errors } = parseTool(req.body);
    if (!tool) return invalid(reply, errors!);
    if (tool.name !== req.params.name) return invalid(reply, ['name: must match the URL']);
    await store.saveTool(tool);
    return tool;
  });

  app.delete<{ Params: { name: string } }>('/api/tools/:name', async (req) => {
    await store.deleteTool(req.params.name);
    return { ok: true };
  });

  app.post<{ Params: { name: string } }>('/api/tools/:name/run', async (req, reply) => {
    const body = (req.body ?? {}) as { tool?: unknown; args?: unknown; confirmWrite?: boolean };
    let tool = store.getTool(req.params.name);
    if (body.tool !== undefined) {
      const parsed = parseTool(body.tool);
      if (!parsed.tool) return invalid(reply, parsed.errors!);
      tool = parsed.tool;
    }
    if (!tool) return reply.code(404).send({ error: 'Not found' });
    if (tool.mode === 'write' && body.confirmWrite !== true) {
      return invalid(reply, ['This is a write tool: set confirmWrite to run it']);
    }
    return executor.run(tool, body.args ?? {});
  });
}
