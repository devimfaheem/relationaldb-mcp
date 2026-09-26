import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_PASSWORD, demoConnection, demoTool, setupApp } from './helpers.js';

type Setup = Awaited<ReturnType<typeof setupApp>>;
let ctx: Setup;
let cookie = '';

const MASK = '••••••';

async function req(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  return ctx.app.inject({
    method: method as 'GET',
    url,
    payload: body as object,
    headers: { cookie, 'x-requested-with': 'sqlmcp', ...headers },
  });
}

async function login() {
  const res = await req('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PASSWORD });
  expect(res.statusCode).toBe(200);
  cookie = String(res.headers['set-cookie']).split(';')[0];
}

beforeEach(async () => {
  cookie = '';
  ctx = await setupApp();
});
afterEach(() => ctx.cleanup());

describe('admin auth', () => {
  it('requires a session', async () => {
    expect((await req('GET', '/api/tools')).statusCode).toBe(401);
    expect((await req('GET', '/api/auth/me')).json()).toEqual({ authenticated: false });
  });

  it('rejects wrong credentials and accepts correct ones', async () => {
    const bad = await req('POST', '/api/auth/login', { username: 'admin', password: 'nope' });
    expect(bad.statusCode).toBe(401);
    await login();
    expect((await req('GET', '/api/auth/me')).json()).toEqual({ authenticated: true });
    expect((await req('GET', '/api/tools')).statusCode).toBe(200);
  });

  it('requires the X-Requested-With header on mutations', async () => {
    await login();
    const res = await req('PUT', '/api/connections/shop', demoConnection, { 'x-requested-with': '' });
    expect(res.statusCode).toBe(403);
  });

  it('logout clears the session', async () => {
    await login();
    const res = await req('POST', '/api/auth/logout');
    expect(String(res.headers['set-cookie'])).toContain('sqlmcp_session=;');
  });
});

describe('connections', () => {
  beforeEach(login);

  it('encrypts passwords on save and masks them on read', async () => {
    expect((await req('PUT', '/api/connections/shop', demoConnection)).statusCode).toBe(200);
    const onDisk = JSON.parse(await readFile(join(ctx.dir, 'connections/shop.json'), 'utf8'));
    expect(onDisk.password).toMatch(/^enc:v1:/);
    expect(ctx.secrets.decrypt(onDisk.password)).toBe('p');

    const list = (await req('GET', '/api/connections')).json();
    expect(list[0]).toMatchObject({ id: 'shop', password: MASK, port: 5432 });
  });

  it('keeps the stored password when the mask is sent back', async () => {
    await req('PUT', '/api/connections/shop', demoConnection);
    await req('PUT', '/api/connections/shop', { ...demoConnection, host: 'db2', password: MASK });
    const onDisk = JSON.parse(await readFile(join(ctx.dir, 'connections/shop.json'), 'utf8'));
    expect(onDisk.host).toBe('db2');
    expect(ctx.secrets.decrypt(onDisk.password)).toBe('p');
  });

  it('keeps ${ENV} references as-is', async () => {
    await req('PUT', '/api/connections/shop', { ...demoConnection, password: '${SHOP_PW}' });
    const onDisk = JSON.parse(await readFile(join(ctx.dir, 'connections/shop.json'), 'utf8'));
    expect(onDisk.password).toBe('${SHOP_PW}');
  });

  it('validates input', async () => {
    const res = await req('PUT', '/api/connections/shop', { ...demoConnection, engine: 'oracle' });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0]).toContain('engine');
  });

  it('refuses to delete a connection used by a tool', async () => {
    await req('PUT', '/api/connections/shop', demoConnection);
    await req('PUT', '/api/tools/get_orders', demoTool);
    expect((await req('DELETE', '/api/connections/shop')).statusCode).toBe(409);
  });

  it('tests a connection', async () => {
    const res = await req('POST', '/api/connections/shop/test', demoConnection);
    expect(res.json()).toEqual({ ok: true });
  });
});

describe('tools', () => {
  beforeEach(async () => {
    await login();
    await req('PUT', '/api/connections/shop', demoConnection);
  });

  it('creates, lists and deletes tools', async () => {
    expect((await req('PUT', '/api/tools/get_orders', demoTool)).statusCode).toBe(200);
    expect((await req('GET', '/api/tools')).json().map((t: { name: string }) => t.name)).toEqual(['get_orders']);
    expect((await req('DELETE', '/api/tools/get_orders')).statusCode).toBe(200);
    expect((await req('GET', '/api/tools')).json()).toEqual([]);
  });

  it('rejects undeclared placeholders and name mismatches', async () => {
    const res = await req('PUT', '/api/tools/get_orders', { ...demoTool, query: 'SELECT :customer_id, :other' });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors).toContain('Placeholder :other has no matching parameter');
    expect((await req('PUT', '/api/tools/other_name', demoTool)).statusCode).toBe(400);
  });

  it('runs saved and unsaved tools', async () => {
    await req('PUT', '/api/tools/get_orders', demoTool);
    const saved = await req('POST', '/api/tools/get_orders/run', { args: { customer_id: 1 } });
    expect(saved.json()).toMatchObject({ isError: false, structured: { rows: [{ id: 1 }] } });

    const unsaved = await req('POST', '/api/tools/draft/run', { tool: { ...demoTool, name: 'draft' }, args: { customer_id: 2 } });
    expect(unsaved.json().isError).toBe(false);
    expect(ctx.driver.calls.at(-1)?.values).toEqual([2]);
  });

  it('requires confirmation for write tools', async () => {
    const tool = { ...demoTool, mode: 'write' };
    const res = await req('POST', '/api/tools/get_orders/run', { tool, args: { customer_id: 1 } });
    expect(res.statusCode).toBe(400);
    const ok = await req('POST', '/api/tools/get_orders/run', { tool, args: { customer_id: 1 }, confirmWrite: true });
    expect(ok.statusCode).toBe(200);
  });

  it('reports invalid files in status', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(ctx.dir, 'tools/broken.json'), '{nope');
    await ctx.store.load();
    const status = (await req('GET', '/api/status')).json();
    expect(status.invalid[0].file).toBe('tools/broken.json');
  });
});
