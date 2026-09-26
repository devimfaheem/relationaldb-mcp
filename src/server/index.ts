import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { buildApp } from './app.js';
import { PoolManager } from './db/pools.js';
import { loadEnv, type Env } from './env.js';
import { createSecrets } from './secrets.js';
import { ConfigStore } from './store.js';

let env: Env;
try {
  env = loadEnv();
} catch (e) {
  console.error(`Configuration error: ${(e as Error).message}`);
  process.exit(1);
}

const logger = pino({ level: env.logLevel });
const secrets = createSecrets(env.secretKey);
const pools = new PoolManager({ secrets });
const store = new ConfigStore(env.dataDir, logger);
await store.load();
store.watch();

const app = await buildApp({
  env,
  secrets,
  pools,
  store,
  logger,
  uiDir: fileURLToPath(new URL('../ui', import.meta.url)),
});

const shutdown = async () => {
  logger.info('shutting down');
  store.close();
  await app.close();
  await pools.closeAll();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ host: '0.0.0.0', port: env.port });
logger.info({ tools: store.tools().length, connections: store.connections().length }, 'sql-mcp ready');
