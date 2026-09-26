import { existsSync, readFileSync } from 'node:fs';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { registerAdmin } from './admin.js';
import type { PoolManager } from './db/pools.js';
import type { Env } from './env.js';
import { createExecutor } from './executor.js';
import { registerMcp } from './mcp.js';
import type { Secrets } from './secrets.js';
import type { ConfigStore } from './store.js';
import type { Users } from './users.js';

export interface AppDeps {
  env: Env;
  store: ConfigStore;
  pools: PoolManager;
  secrets: Secrets;
  users: Users;
  /** Directory containing the built admin UI; skipped if missing. */
  uiDir?: string;
  logger?: FastifyBaseLogger;
}

// Resolves to the repo's package.json from both src/server and dist/server.
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { env, store, pools } = deps;
  const app = Fastify({ ...(deps.logger ? { loggerInstance: deps.logger } : { logger: false }), trustProxy: env.trustProxy, bodyLimit: 1024 * 1024 });
  await app.register(cookie, { secret: env.secretKey });

  const executor = createExecutor({ getConnection: store.getConnection, pools, log: app.log });

  app.get('/healthz', async () => ({ ok: true }));
  registerMcp(app, { env, store, executor, version: pkg.version });
  registerAdmin(app, { env, store, pools, secrets: deps.secrets, users: deps.users, executor, version: pkg.version });

  if (deps.uiDir && existsSync(deps.uiDir)) {
    await app.register(fastifyStatic, { root: deps.uiDir });
    // Single-page app: unknown GETs outside the API fall back to index.html.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api') && !req.url.startsWith('/mcp')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'Not found' });
    });
  }

  return app;
}
