# SQL MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Dockerized MCP server that exposes admin-defined, parameterized SQL queries (MySQL/MariaDB, SQL Server, PostgreSQL) as MCP tools, with a React admin UI and API-key auth.

**Architecture:** One Node process (Fastify) serving `/mcp` (MCP Streamable HTTP via the low-level SDK `Server`, tools read dynamically from a config store), `/api/*` (admin REST), and the built React UI. Connections and tools are JSON files under `DATA_DIR`, watched and reloaded on change. A pure placeholder compiler turns `:name` into each engine's native bound parameters.

**Tech Stack:** Node 22+, TypeScript, Fastify 5, `@modelcontextprotocol/sdk`, Zod 4, mysql2, mssql, pg, pino, Vitest, React 19 + Vite, CodeMirror.

**Spec:** `docs/superpowers/specs/2026-09-26-sql-mcp-server-design.md`

## Simplifications vs. spec (user asked "keep it simple")

- **Single npm package** (no pnpm workspace): `src/shared`, `src/server`, `ui/`. The UI imports shared code via relative path.
- **CSRF:** relies on `SameSite=Strict` session cookie + required `Content-Type: application/json` on mutating routes (no separate CSRF token).
- **Tests:** Vitest unit tests + in-process e2e (Fastify `inject` and MCP SDK client over real HTTP) using a **fake driver**. Testcontainers and Playwright are deferred; `docker-compose.yml` with sample DBs is provided for manual testing.
- **CI:** single GitHub Actions workflow (test on PR, build+push multi-arch image to GHCR on tag).

## Global Constraints

- Names: connection `id` and tool `name` match `^[a-z][a-z0-9_]{0,63}$`; parameter names `^[a-zA-Z_][a-zA-Z0-9_]*$`.
- Engines: `mysql | mssql | postgres`. Default ports 3306 / 1433 / 5432.
- Parameter types: `string | integer | number | boolean | date | datetime`.
- Defaults: `enabled: true`, `limits.maxRows: 1000` (1–10000), `limits.timeoutMs: 30000` (100–300000), `pool.max: 10`.
- Env: `API_KEY` (≥32), `ADMIN_PASSWORD` (≥8), `SECRET_KEY` (≥32) required; `ADMIN_USERNAME=admin`, `PORT=3000`, `DATA_DIR=/data`, `ALLOW_QUERY_KEY=false`, `LOG_LEVEL=info`, `TRUST_PROXY=false`.
- Secrets: `enc:v1:<base64(iv|tag|ciphertext)>` AES-256-GCM, key = HKDF-SHA256(SECRET_KEY, info "sqlmcp-secrets"); `${ENV_VAR}` references resolved at use time.
- Argument values are NEVER interpolated into SQL text.
- Tool error output never contains stack traces, hosts, or credentials.

---

## File Structure

```
package.json, tsconfig.json, vitest.config.ts, .gitignore, .dockerignore, .env.example
src/shared/schema.ts           Zod schemas + types (Connection, Tool, Parameter) + validateToolRules()
src/shared/placeholders.ts     extractPlaceholders(), compile()
src/server/env.ts              loadEnv() — validated env config
src/server/secrets.ts          createSecrets(secretKey) → { encrypt, decrypt, resolve }
src/server/store.ts            ConfigStore — load/validate/write/watch JSON files
src/server/params.ts           toJsonSchema(params), buildArgsSchema(params)
src/server/db/types.ts         Driver, QueryOptions, QueryResult
src/server/db/mysql.ts         createMysqlDriver(conn)
src/server/db/postgres.ts      createPostgresDriver(conn)
src/server/db/mssql.ts         createMssqlDriver(conn)
src/server/db/pools.ts         PoolManager
src/server/executor.ts         createExecutor({ getConnection, pools }) → { run(tool, args) }
src/server/auth.ts             checkApiKey(), session helpers, requireAdmin hook
src/server/mcp.ts              registerMcp(app, deps)
src/server/admin.ts            registerAdmin(app, deps)
src/server/app.ts              buildApp(deps) — wires everything, serves UI
src/server/index.ts            entrypoint
test/*.test.ts                 unit + e2e tests
ui/                            Vite React app (index.html, src/*.tsx) → dist/ui
Dockerfile, docker-compose.yml, examples/data/**, README.md, LICENSE, .github/workflows/ci.yml
```

---

### Task 1: Scaffold + shared schemas

**Files:** Create `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/shared/schema.ts`, `test/schema.test.ts`

**Interfaces — Produces:**
- `ConnectionSchema`, `ToolSchema`, `ParameterSchema` (Zod); types `Connection`, `Tool`, `Parameter`, `Engine`, `ParamType`.
- `validateToolRules(tool: Tool, connectionIds: Set<string>): string[]` — returns error messages (empty = valid). Uses `extractPlaceholders` from Task 2 (Task 2 lands first in practice; do them together).

- [ ] Step 1: `npm init`, install deps (runtime: fastify, @fastify/static, @fastify/cookie, @fastify/rate-limit, @modelcontextprotocol/sdk, zod, mysql2, mssql, pg, pino; dev: typescript, tsx, vitest, @types/node, @types/pg, @types/mssql, vite, @vitejs/plugin-react, react, react-dom, @types/react, @types/react-dom, @uiw/react-codemirror, @codemirror/lang-sql). Scripts: `dev`, `build` (`tsc -p . && vite build`), `start` (`node dist/server/index.js`), `test` (`vitest run`), `typecheck`.
- [ ] Step 2: Write failing tests: valid tool/connection parse with defaults applied; bad name rejected; `default` not in `enum` rejected; `min` on string rejected; `validateToolRules` reports undeclared placeholder, unused parameter, unknown connection, duplicate parameter.
- [ ] Step 3: Implement schemas with `.superRefine` for per-parameter type checks.
- [ ] Step 4: `npx vitest run test/schema.test.ts` → PASS. Commit.

### Task 2: Placeholder compiler

**Files:** Create `src/shared/placeholders.ts`, `test/placeholders.test.ts`

**Interfaces — Produces:**
```ts
export type Dialect = 'mysql' | 'postgres' | 'mssql';
export function extractPlaceholders(query: string): string[]; // unique names, in first-seen order
export function compile(query: string, dialect: Dialect, args: Record<string, unknown>):
  { sql: string; values: unknown[] | Record<string, unknown> };
// mysql → '?' + positional array (repeats duplicated)
// postgres → '$n' + positional array (repeated name reuses index)
// mssql → '@name' + named map
```

- [ ] Step 1: Failing tests:
  - `compile('SELECT * FROM t WHERE a = :a AND b = :b OR a2 = :a', 'mysql', {a:1,b:2})` → `sql 'SELECT * FROM t WHERE a = ? AND b = ? OR a2 = ?'`, `values [1,2,1]`
  - same with postgres → `$1 … $2 … $1`, values `[1,2]`
  - mssql → `@a … @b … @a`, values `{a:1,b:2}`
  - `SELECT x::int, ':nope', "col:x", \`c:y\`, [d:z] -- :c\n /* :d */ FROM t WHERE id = :id` → only `id` extracted; literals/comments untouched
  - `'it''s :x'` (escaped quote) → no placeholder
  - missing arg compiles to `null`
- [ ] Step 2: Run → FAIL.
- [ ] Step 3: Implement a single-pass scanner with states: normal, single-quote (handle `''`), double-quote, backtick, bracket, line comment, block comment. In normal state, `::` → emit both chars; `:` followed by `[A-Za-z_]` → read identifier → placeholder.
- [ ] Step 4: Run → PASS. Commit.

### Task 3: Env + secrets

**Files:** Create `src/server/env.ts`, `src/server/secrets.ts`, `test/secrets.test.ts`, `test/env.test.ts`

**Interfaces — Produces:**
```ts
export interface Env { apiKey: string; adminUsername: string; adminPassword: string; secretKey: string;
  port: number; dataDir: string; allowQueryKey: boolean; logLevel: string; trustProxy: boolean }
export function loadEnv(source?: NodeJS.ProcessEnv): Env; // throws Error naming the bad variable
export interface Secrets { encrypt(p: string): string; decrypt(v: string): string; resolve(v: string): string }
export function createSecrets(secretKey: string): Secrets;
// resolve: 'enc:v1:…' → decrypt; '${NAME}' → process.env.NAME (throws if unset); otherwise returns as-is
```

- [ ] Step 1: Failing tests: round-trip; tampered ciphertext throws; wrong key throws; `${FOO}` resolves; missing env var throws; `loadEnv` throws `API_KEY must be at least 32 characters` when short; defaults applied.
- [ ] Step 2: Implement with `node:crypto` (`hkdfSync`, `createCipheriv('aes-256-gcm')`, 12-byte IV).
- [ ] Step 3: Run → PASS. Commit.

### Task 4: Config store

**Files:** Create `src/server/store.ts`, `test/store.test.ts`

**Interfaces — Produces:**
```ts
export interface Invalid { file: string; errors: string[] }
export class ConfigStore extends EventEmitter { // emits 'change'
  constructor(dataDir: string, log?: { warn(o: unknown, m?: string): void });
  load(): Promise<void>;                 // mkdir -p connections/ tools/, read all
  watch(): void; close(): void;          // fs.watch both dirs, debounce 100ms → load() → emit 'change'
  connections(): Connection[]; tools(): Tool[];
  getConnection(id: string): Connection | undefined; getTool(name: string): Tool | undefined;
  invalid(): Invalid[];
  saveConnection(c: Connection): Promise<void>; deleteConnection(id: string): Promise<void>;
  saveTool(t: Tool): Promise<void>; deleteTool(name: string): Promise<void>;
}
```
Rules: filename basename must equal id/name; tools failing `validateToolRules` go to `invalid()` and are excluded from `tools()`. Writes are atomic (`.tmp` + rename) and call `load()` + emit `'change'` immediately. `deleteConnection` throws if any tool (valid or invalid-but-parsed) references it.

- [ ] Step 1: Failing tests (temp dir): loads valid files; invalid JSON listed in `invalid()`; mismatched filename invalid; tool with unknown connection invalid; save → file exists and `getTool` returns it; delete connection referenced by tool throws; `'change'` fires on external file write (await event with 2s timeout).
- [ ] Step 2: Implement. Step 3: PASS. Commit.

### Task 5: Parameters → JSON Schema and argument validation

**Files:** Create `src/server/params.ts`, `test/params.test.ts`

**Interfaces — Produces:**
```ts
export function toJsonSchema(params: Parameter[]): { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
export function parseArgs(params: Parameter[], args: unknown): Record<string, unknown>;
// applies defaults, missing optional → null, throws ArgsError with message like "parameter `limit` must be ≤ 500"
export class ArgsError extends Error {}
```
Mapping: integer→`integer`, number→`number`, boolean→`boolean`, string→`string`, date→`string`+`format:date`, datetime→`string`+`format:date-time`; plus `enum`, `minimum`, `maximum`, `pattern`, `maxLength`, `default`, `description`.

- [ ] Step 1: Failing tests: schema shape for sample tool; `parseArgs` applies default; rejects `limit: 1000` with max 500 (message contains ``parameter `limit` ``); rejects bad date; rejects unknown extra arg; optional missing → `null`; integer rejects `1.5`.
- [ ] Step 2: Implement by building a Zod object from params. Step 3: PASS. Commit.

### Task 6: Drivers + pool manager

**Files:** Create `src/server/db/types.ts`, `mysql.ts`, `postgres.ts`, `mssql.ts`, `pools.ts`, `test/pools.test.ts`

**Interfaces — Produces:**
```ts
export interface QueryOptions { readOnly: boolean; timeoutMs: number; maxRows: number }
export interface QueryResult { columns: string[]; rows: Record<string, unknown>[]; rowCount: number; truncated: boolean; affectedRows?: number }
export interface Driver { query(sql: string, values: unknown[] | Record<string, unknown>, opts: QueryOptions): Promise<QueryResult>; testConnection(): Promise<void>; close(): Promise<void> }
export interface ResolvedConnection extends Connection { user: string; password: string } // secrets resolved
export type DriverFactory = (c: ResolvedConnection) => Driver;
export class PoolManager {
  constructor(opts: { secrets: Secrets; factories?: Partial<Record<Engine, DriverFactory>> });
  get(conn: Connection): Driver;   // cached by id + JSON hash; recreated (old closed) when definition changes
  evict(id: string): Promise<void>; closeAll(): Promise<void>;
  static create(conn: ResolvedConnection): Driver; // default factory by engine
}
```
Driver behavior (spec §6.3): read → MySQL `START TRANSACTION READ ONLY`, Postgres `BEGIN READ ONLY` + `SET LOCAL statement_timeout`, MSSQL `BEGIN TRAN … ROLLBACK`; write → transaction + commit, rollback on error. MSSQL values bound with `request.input(name, value)`. Rows sliced to `maxRows`, `truncated = rows.length > maxRows`. Write results set `affectedRows`.

- [ ] Step 1: Failing test for `PoolManager` with a fake factory: same connection → same driver; changed host → old driver closed, new driver returned; `evict` closes.
- [ ] Step 2: Implement drivers and manager. Step 3: `npm run typecheck` + test PASS. Commit.

### Task 7: Executor

**Files:** Create `src/server/executor.ts`, `test/executor.test.ts`, `test/fake-driver.ts`

**Interfaces — Produces:**
```ts
export interface ToolResult { isError: boolean; text: string; structured?: Record<string, unknown> }
export function createExecutor(deps: { getConnection(id: string): Connection | undefined; pools: Pick<PoolManager, 'get'>; log?: pino.Logger }): {
  run(tool: Tool, args: unknown): Promise<ToolResult>;
};
```
Flow: `parseArgs` → `getConnection` → `compile(query, conn.engine, args)` → `driver.query(sql, values, { readOnly: tool.mode === 'read', timeoutMs, maxRows })` → JSON text. Errors: `ArgsError` → message as-is; DB errors → `Query failed: <err.message>` (log full error); unknown connection → `Connection "<id>" not found`.

`test/fake-driver.ts` exports `createFakeDriver(handler?: (sql, values, opts) => QueryResult)` recording calls.

- [ ] Step 1: Failing tests: passes compiled SQL/values/opts to driver; read mode sets `readOnly: true`; invalid args → `isError` with no driver call; driver throw → `isError`, text starts `Query failed:`; result text is JSON with rows.
- [ ] Step 2: Implement. Step 3: PASS. Commit.

### Task 8: App, auth, MCP endpoint

**Files:** Create `src/server/auth.ts`, `src/server/mcp.ts`, `src/server/app.ts`, `src/server/index.ts`, `test/mcp.e2e.test.ts`

**Interfaces — Produces:**
```ts
// auth.ts
export function safeEqual(a: string, b: string): boolean;
export function extractApiKey(req: FastifyRequest, allowQuery: boolean): string | undefined;
// app.ts
export interface AppDeps { env: Env; store: ConfigStore; pools: PoolManager; secrets: Secrets; uiDir?: string }
export async function buildApp(deps: AppDeps): Promise<FastifyInstance>;
```
MCP: stateful sessions map `sessionId → { server, transport }`. Each session gets a low-level `Server` (`capabilities: { tools: { listChanged: true } }`) with handlers for `ListToolsRequestSchema` (from `store.tools()` filtered by enabled + connection exists, `inputSchema: toJsonSchema`) and `CallToolRequestSchema` (executor). On `store` `'change'` → call `server.sendToolListChanged()` on every session. Routes `POST|GET|DELETE /mcp` hand `req.raw`/`reply.raw` to `StreamableHTTPServerTransport` (`reply.hijack()`). Auth preHandler: missing/bad key → 401 JSON; failures rate-limited per IP (10/min → 429). `/healthz` → `{ ok: true }`.

- [ ] Step 1: Failing e2e test: temp data dir with a connection + tool; `buildApp` with fake driver factory; `app.listen({ port: 0 })`; MCP SDK `Client` + `StreamableHTTPClientTransport` with Bearer header → `listTools` contains the tool with correct `inputSchema`; `callTool` returns rows; wrong key → connect rejects (401); disabled tool not listed; `?key=` rejected unless `allowQueryKey`.
- [ ] Step 2: Implement. Step 3: PASS. Commit.

### Task 9: Admin API

**Files:** Modify `src/server/auth.ts` (session helpers), create `src/server/admin.ts`, `test/admin.test.ts`

Routes per spec §6.5. Session: signed cookie `sqlmcp_session` = `<expiryMs>` signed via `@fastify/cookie` with `SECRET_KEY`; 12h; `HttpOnly`, `SameSite=Strict`, `Secure` when `trustProxy` + `x-forwarded-proto=https` or `req.protocol==='https'`. Login rate-limited (10/min/IP). Mutating routes require `content-type: application/json`. Connection responses replace `password` with `"••••••"`; PUT with password missing or equal to that mask keeps the stored value; otherwise plaintext is encrypted with `secrets.encrypt` unless it's already `enc:v1:` or `${…}`. PUT validates body with schema (+ `validateToolRules` for tools) → 400 `{ errors: string[] }`. `POST /api/tools/:name/run` body `{ tool?: Tool, args: object, confirmWrite?: boolean }` — uses `tool` from body if given, else stored; write-mode without `confirmWrite` → 400. `POST /api/connections/:id/test` body optional unsaved connection → `{ ok: true }` or `{ ok: false, error }`. Connection saves call `pools.evict(id)`.

- [ ] Step 1: Failing tests via `app.inject`: unauthenticated `/api/tools` → 401; login wrong password → 401; login ok → cookie; create connection → stored file password starts `enc:v1:`, GET shows mask; PUT with mask keeps password; create tool with undeclared placeholder → 400; run tool returns rows (fake driver); write tool run without confirm → 400; delete referenced connection → 409.
- [ ] Step 2: Implement. Step 3: PASS. Commit.

### Task 10: Admin UI

**Files:** Create `vite.config.ts`, `ui/index.html`, `ui/src/main.tsx`, `ui/src/api.ts`, `ui/src/App.tsx`, `ui/src/Login.tsx`, `ui/src/Connections.tsx`, `ui/src/Tools.tsx`, `ui/src/ToolEditor.tsx`, `ui/src/styles.css`

Pages: Login; header tabs Connections / Tools / Logout; invalid-file banner from `/api/status`. Connections: list + form (engine select sets default port, SSL toggle, password field shows mask, "Test connection"). Tools: list with enabled/mode/validity; editor with name, description, connection select, mode, enabled, limits, CodeMirror SQL editor, parameter rows (name/type/required/default/description/enum/min/max), "Detect parameters" button (adds rows for placeholders via `extractPlaceholders`), test-run panel (arg inputs → results table; confirm dialog for write). Vite: `root: 'ui'`, `build.outDir: '../dist/ui'`, dev proxy `/api` → `http://localhost:3000`.

- [ ] Step 1: Build UI. Step 2: `npm run build` succeeds; run server locally with example data and manually verify login → create connection → create tool → test run (fake-free: verify against a local DB if available, else verify API error surfaces cleanly). Commit.

### Task 11: Packaging, examples, docs, CI

**Files:** Create `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `examples/data/connections/*.json`, `examples/data/tools/*.json`, `examples/sql/{mysql,postgres,mssql}-init.sql`, `.env.example`, `README.md`, `LICENSE`, `.github/workflows/ci.yml`

- Dockerfile: stage `build` (`node:22-alpine`, `npm ci`, `npm run build`, `npm prune --omit=dev`); stage `runtime` copies `dist`, `node_modules`, `package.json`; `USER node`; `ENV DATA_DIR=/data`; `VOLUME /data`; `EXPOSE 3000`; `HEALTHCHECK` via `wget -qO- localhost:3000/healthz`; `CMD ["node","dist/server/index.js"]`. Create `/data` owned by `node`.
- Compose: `sqlmcp` (build `.`, env from `.env`, `./examples/data:/data`), `mysql:8`, `postgres:16`, `mcr.microsoft.com/mssql/server:2022-latest` with init scripts (demo `customers`/`orders` tables).
- Examples: connections `demo_mysql`, `demo_postgres`, `demo_mssql` using `${…}` env passwords; tools `list_customers` (read), `get_customer_orders` (read, uses params), `update_order_status` (write).
- README: overview, quick start (`docker run`), compose demo, JSON reference, Claude Code / Desktop / claude.ai setup, security notes.
- CI: on PR/push → `npm ci`, `npm run typecheck`, `npm test`, `npm run build`; on tag `v*` → `docker/build-push-action` multi-arch to `ghcr.io/${{ github.repository }}`.

- [ ] Step 1: Write files. Step 2: `npm test && npm run build` PASS; `docker build .` if the daemon is available. Commit.
