import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Env } from './env.js';
import type { Executor } from './executor.js';
import { extractApiKey, FailureLimiter, safeEqual } from './auth.js';
import { toJsonSchema } from './params.js';
import type { ConfigStore } from './store.js';

interface Deps {
  env: Env;
  store: ConfigStore;
  executor: Executor;
  version: string;
}

/** Tools Claude can see: enabled, valid, and pointing at a loaded connection. */
function visibleTools(store: ConfigStore) {
  return store.tools().filter((t) => t.enabled && store.getConnection(t.connection));
}

function createMcpServer({ store, executor, version }: Deps): Server {
  const server = new Server({ name: 'sql-mcp', version }, { capabilities: { tools: { listChanged: true } } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: visibleTools(store).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: toJsonSchema(t.parameters),
      annotations: { readOnlyHint: t.mode === 'read' },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = visibleTools(store).find((t) => t.name === req.params.name);
    if (!tool) return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }] };
    const res = await executor.run(tool, req.params.arguments);
    return {
      isError: res.isError,
      content: [{ type: 'text', text: res.text }],
      ...(res.structured && { structuredContent: res.structured }),
    };
  });

  return server;
}

const rpcError = (reply: FastifyReply, status: number, message: string) =>
  reply.code(status).send({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });

export function registerMcp(app: FastifyInstance, deps: Deps): void {
  const sessions = new Map<string, { server: Server; transport: StreamableHTTPServerTransport }>();
  const limiter = new FailureLimiter();

  deps.store.on('change', () => {
    for (const { server } of sessions.values()) server.sendToolListChanged().catch(() => {});
  });

  app.addHook('onClose', async () => {
    await Promise.all([...sessions.values()].map((s) => s.transport.close().catch(() => {})));
  });

  const authenticate = async (req: FastifyRequest, reply: FastifyReply) => {
    if (limiter.blocked(req.ip)) return reply.code(429).send({ error: 'Too many failed attempts' });
    const key = extractApiKey(req, deps.env.allowQueryKey);
    if (!key || !safeEqual(key, deps.env.apiKey)) {
      limiter.fail(req.ip);
      return reply.code(401).header('www-authenticate', 'Bearer').send({ error: 'Invalid or missing API key' });
    }
  };

  const handle = async (req: FastifyRequest, reply: FastifyReply) => {
    const sessionId = req.headers['mcp-session-id'];
    let entry = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;

    if (!entry) {
      if (sessionId) return rpcError(reply, 404, 'Session not found');
      if (req.method !== 'POST' || !isInitializeRequest(req.body)) return rpcError(reply, 400, 'No valid session ID provided');

      const server = createMcpServer(deps);
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { server, transport });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await server.connect(transport);
      entry = { server, transport };
    }

    reply.hijack();
    await entry.transport.handleRequest(req.raw, reply.raw, req.body);
  };

  for (const method of ['GET', 'POST', 'DELETE'] as const) {
    app.route({ method, url: '/mcp', preHandler: authenticate, handler: handle });
  }
}
