import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { API_KEY, demoConnection, demoTool, setupApp } from './helpers.js';

type Setup = Awaited<ReturnType<typeof setupApp>>;
let ctx: Setup;
let client: Client | undefined;

afterEach(async () => {
  await client?.close();
  client = undefined;
  await ctx?.cleanup();
});

const files = {
  'connections/shop.json': demoConnection,
  'tools/get_orders.json': demoTool,
  'tools/hidden.json': { ...demoTool, name: 'hidden', enabled: false },
};

async function start(env = {}) {
  ctx = await setupApp({ files, env });
  const address = await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  return address;
}

async function connect(url: string, headers: Record<string, string> = { Authorization: `Bearer ${API_KEY}` }) {
  const c = new Client({ name: 'test', version: '1.0.0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  client = c;
  return c;
}

describe('MCP endpoint', () => {
  it('lists enabled tools with their input schema', async () => {
    const c = await connect(`${await start()}/mcp`);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(['get_orders']);
    expect(tools[0].inputSchema).toMatchObject({
      type: 'object',
      properties: { customer_id: { type: 'integer', description: 'Customer id' } },
      required: ['customer_id'],
    });
  });

  it('calls a tool and returns rows', async () => {
    const c = await connect(`${await start()}/mcp`);
    const res = await c.callTool({ name: 'get_orders', arguments: { customer_id: 42 } });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual({ columns: ['id'], rows: [{ id: 1 }], rowCount: 1, truncated: false });
    expect(ctx.driver.calls[0]).toMatchObject({ sql: 'SELECT id FROM orders WHERE customer_id = $1', values: [42] });
  });

  it('returns validation errors as tool errors', async () => {
    const c = await connect(`${await start()}/mcp`);
    const res = await c.callTool({ name: 'get_orders', arguments: {} });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('parameter `customer_id` is required');
  });

  it('rejects a wrong or missing key', async () => {
    const url = `${await start()}/mcp`;
    await expect(connect(url, { Authorization: 'Bearer wrong' })).rejects.toThrow();
    const res = await fetch(url, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(401);
  });

  it('accepts ?key= only when enabled', async () => {
    const off = await start();
    await expect(connect(`${off}/mcp?key=${API_KEY}`, {})).rejects.toThrow();
    await ctx.cleanup();

    const on = await start({ allowQueryKey: true });
    const c = await connect(`${on}/mcp?key=${API_KEY}`, {});
    expect((await c.listTools()).tools).toHaveLength(1);
  });

  it('notifies clients when tools change', async () => {
    const c = await connect(`${await start()}/mcp`);
    await c.listTools(); // ensure the session is fully established
    const notified = new Promise<void>((resolve) => c.setNotificationHandler(ToolListChangedNotificationSchema, () => resolve()));
    const tool = ctx.store.getTool('get_orders')!;
    await ctx.store.saveTool({ ...tool, name: 'get_orders_2' });
    await notified;
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual(['get_orders', 'get_orders_2']);
  });
});
