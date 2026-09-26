# SQL MCP Server — Design Spec

**Date:** 2026-09-26
**Status:** Approved design, pending implementation plan
**License:** MIT (open source)

## 1. Summary

An open-source, self-hostable MCP server that exposes admin-defined SQL queries as MCP tools. An admin uses a web UI to register database connections (MySQL/MariaDB, Microsoft SQL Server, PostgreSQL) and to define tools — each a parameterized SQL query with typed parameters. Definitions are persisted as JSON files. Anyone can clone the repo or pull the Docker image, deploy it, and connect Claude to the server's URL using an API key.

## 2. Goals and non-goals

**Goals**
- Define MCP tools declaratively as JSON: query + parameters + metadata in one file.
- Web admin UI to manage connections and tools, and to test-run tools.
- Support MySQL/MariaDB, SQL Server, and PostgreSQL in v1; multiple connections per server.
- Per-tool read-only vs. read-write mode.
- Deploy as a single Docker image; MCP over Streamable HTTP; API-key authentication.
- Documented integration with Claude Code, Claude Desktop, and claude.ai custom connectors.

**Non-goals (v1)**
- OAuth, multi-user admin accounts, roles, per-tool scoped API keys.
- Raw/arbitrary SQL execution tools.
- Engines other than MySQL/MariaDB, SQL Server, PostgreSQL.

## 3. Tech stack

- **Language/runtime:** TypeScript, Node.js 22.
- **Server:** Fastify; `@modelcontextprotocol/sdk` (Streamable HTTP transport).
- **Validation:** Zod (shared between server and UI).
- **Drivers:** `mysql2`, `mssql` (tedious), `pg`.
- **UI:** React + Vite, CodeMirror for SQL editing; built to static assets served by Fastify.
- **Logging:** pino (structured JSON).
- **Tests:** Vitest, Testcontainers, Playwright.
- **Repo:** pnpm workspace — `packages/shared`, `packages/server`, `packages/ui`.

## 4. JSON formats

One file per connection and one file per tool, stored under `DATA_DIR` (default `/data`):
- `/data/connections/<id>.json`
- `/data/tools/<name>.json`

The file's basename must equal its `id` / `name`.

### 4.1 Connection

```json
{
  "id": "sales_db",
  "engine": "mysql",
  "host": "db.example.com",
  "port": 3306,
  "database": "sales",
  "user": "readonly_user",
  "password": "enc:v1:9f2a...",
  "ssl": { "enabled": true, "rejectUnauthorized": true },
  "pool": { "max": 10 },
  "options": {}
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string `^[a-z][a-z0-9_]{0,63}$` | yes | Unique |
| `engine` | `"mysql" \| "mssql" \| "postgres"` | yes | `mysql` covers MariaDB |
| `host` | string | yes | |
| `port` | integer 1–65535 | no | Defaults: 3306 / 1433 / 5432 |
| `database` | string | yes | |
| `user` | string | yes | May be a `${ENV_VAR}` reference |
| `password` | string | yes | `enc:v1:<base64>` or `${ENV_VAR}`; plaintext is rejected on save via the UI (UI always encrypts) but accepted in hand-edited files with a warning in logs |
| `ssl.enabled` | boolean | no | Default `false` |
| `ssl.rejectUnauthorized` | boolean | no | Default `true` |
| `pool.max` | integer 1–100 | no | Default 10 |
| `options` | object | no | Driver-specific passthrough (e.g. MSSQL `encrypt`, `trustServerCertificate`, `instanceName`) |

### 4.2 Tool

```json
{
  "name": "get_customer_orders",
  "description": "Returns recent orders for a customer, optionally filtered by status.",
  "connection": "sales_db",
  "mode": "read",
  "enabled": true,
  "query": "SELECT id, total, status, created_at FROM orders WHERE customer_id = :customer_id AND (:status IS NULL OR status = :status) ORDER BY created_at DESC LIMIT :limit",
  "parameters": [
    { "name": "customer_id", "type": "integer", "required": true, "description": "Customer ID" },
    { "name": "status", "type": "string", "required": false, "enum": ["pending", "shipped", "cancelled"], "description": "Filter by status" },
    { "name": "limit", "type": "integer", "default": 50, "min": 1, "max": 500, "description": "Max rows" }
  ],
  "limits": { "maxRows": 500, "timeoutMs": 15000 }
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string `^[a-z][a-z0-9_]{0,63}$` | yes | Unique; the MCP tool name |
| `description` | string, 1–1024 chars | yes | Shown to Claude |
| `connection` | string | yes | Must reference an existing connection `id` |
| `mode` | `"read" \| "write"` | yes | See §6.3 |
| `enabled` | boolean | no | Default `true` |
| `query` | string | yes | Uses `:name` placeholders |
| `parameters` | array | no | Default `[]` |
| `limits.maxRows` | integer 1–10000 | no | Default 1000 |
| `limits.timeoutMs` | integer 100–300000 | no | Default 30000 |

**Parameter object**

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string `^[a-zA-Z_][a-zA-Z0-9_]*$` | yes | Unique within tool |
| `type` | `string \| integer \| number \| boolean \| date \| datetime` | yes | `date` = `YYYY-MM-DD`; `datetime` = ISO 8601 |
| `description` | string | yes | Shown to Claude |
| `required` | boolean | no | Default `false` |
| `default` | value matching `type` | no | Applied when argument omitted |
| `enum` | array of values matching `type` | no | |
| `min` / `max` | number | no | Numeric types only |
| `pattern` | regex string | no | `string` only |
| `maxLength` | integer | no | `string` only |

**Tool validation rules (enforced on save and on load)**
- Every `:name` placeholder in `query` has a matching parameter.
- Every declared parameter is used at least once in `query`.
- A placeholder may appear multiple times.
- `connection` exists.
- `default` and `enum` values satisfy the parameter's type and constraints.

## 5. Architecture

Single Node process, single port (default `3000`), single Docker image.

```
┌──────────────────────── container ────────────────────────┐
│  Fastify                                                   │
│   ├─ /mcp        MCP Streamable HTTP  ← API key            │
│   ├─ /api/*      Admin REST API       ← session cookie     │
│   ├─ /           React admin UI (static)                   │
│   └─ /healthz    health check (unauthenticated)            │
│                                                            │
│  ConfigStore ──watch──► /data/{connections,tools}/*.json   │
│  PoolManager  (one pool per connection, lazy)              │
│  Drivers: mysql2 | mssql | pg  (common interface)          │
└────────────────────────────────────────────────────────────┘
```

### 5.1 Units

| Unit | Location | Responsibility | Depends on |
|---|---|---|---|
| Schemas | `packages/shared/src/schema` | Zod schemas + TS types for connection, tool, parameter | zod |
| Placeholder compiler | `packages/shared/src/sql/placeholders.ts` | `compile(query, dialect, args) → { sql, values }`; also `extractPlaceholders(query)` for validation. Pure function. | — |
| Secrets | `packages/server/src/config/secrets.ts` | AES-256-GCM encrypt/decrypt `enc:v1:`; resolve `${ENV}` | `SECRET_KEY` |
| Config store | `packages/server/src/config/store.ts` | Load/validate/write JSON files atomically; watch directory; emit change events; track invalid files with errors | schemas, fs |
| Driver adapters | `packages/server/src/db/drivers/{mysql,mssql,postgres}.ts` | Implement `Driver` interface (below) | drivers |
| Pool manager | `packages/server/src/db/pools.ts` | Lazily create pools per connection; recreate on connection change; close on delete/shutdown | drivers, secrets |
| Executor | `packages/server/src/exec/executor.ts` | Validate args, apply defaults, compile placeholders, run query, format result | schemas, compiler, pools |
| MCP server | `packages/server/src/mcp/server.ts` | Register enabled+valid tools; params → JSON Schema; emit `tools/list_changed` on change | MCP SDK, store, executor |
| Auth | `packages/server/src/auth/` | API key check (constant-time); admin login + session; rate limiting; CSRF | env |
| Admin API | `packages/server/src/admin/routes.ts` | Login/logout, CRUD connections & tools, test connection, run tool | store, pools, executor, auth |
| UI | `packages/ui` | Login, Connections list/form, Tools list, Tool editor (SQL editor, parameter builder, test-run panel) | shared schemas |

### 5.2 Driver interface

```ts
interface QueryOptions { readOnly: boolean; timeoutMs: number; maxRows: number }
interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;       // rows returned (after truncation)
  truncated: boolean;
  affectedRows?: number;  // write mode
}
interface Driver {
  query(sql: string, values: unknown[] | Record<string, unknown>, opts: QueryOptions): Promise<QueryResult>;
  testConnection(): Promise<void>;
  close(): Promise<void>;
}
```

### 5.3 Placeholder dialects

| Engine | Output form | Values |
|---|---|---|
| mysql | `?` | positional array (repeated names produce repeated values) |
| postgres | `$1, $2…` | positional array; a repeated name reuses the same index |
| mssql | `@name` | named map via `request.input(name, type, value)` |

The compiler ignores `:name` tokens inside single-quoted strings, double-quoted identifiers, backtick identifiers, bracketed identifiers, `--` line comments and `/* */` block comments, and does not treat `::` (Postgres cast) as a placeholder.

### 5.4 Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `API_KEY` | yes | — | ≥ 32 chars; MCP endpoint key |
| `ADMIN_USERNAME` | no | `admin` | |
| `ADMIN_PASSWORD` | yes | — | ≥ 8 chars |
| `SECRET_KEY` | yes | — | ≥ 32 chars; derives AES key (HKDF-SHA256) for secrets and session signing |
| `PORT` | no | `3000` | |
| `DATA_DIR` | no | `/data` | |
| `ALLOW_QUERY_KEY` | no | `false` | Accept `?key=` on `/mcp` (for claude.ai connectors) |
| `LOG_LEVEL` | no | `info` | |
| `TRUST_PROXY` | no | `false` | For correct client IP / `Secure` cookies behind a reverse proxy |

## 6. Data flow

### 6.1 Claude calls a tool
1. `POST /mcp`. Auth checks `Authorization: Bearer <key>` (or `?key=` if `ALLOW_QUERY_KEY=true`) against `API_KEY` using constant-time comparison → 401 on mismatch.
2. MCP SDK handles the session (Streamable HTTP, stateful sessions with `Mcp-Session-Id`).
3. `tools/list` returns every tool that is `enabled`, valid, and whose connection is valid. Input schema is JSON Schema generated from `parameters` (types, `enum`, `minimum`/`maximum`, `pattern`, `maxLength`, `default`, `required`, `description`; `date`/`datetime` map to `string` with `format`).
4. `tools/call`: executor validates args with a Zod schema derived from `parameters`; applies defaults; omitted optional params with no default bind as `NULL`.
5. Placeholder compiler produces dialect SQL + values.
6. Pool manager supplies the pool; driver executes with `{ readOnly, timeoutMs, maxRows }`.
7. Result returned as MCP content: a `text` item containing JSON `{ columns, rows, rowCount, truncated }` (or `{ affectedRows }` for write mode), plus `structuredContent` with the same object.

### 6.2 Admin edits a tool
1. UI → `PUT /api/tools/:name` with session cookie + CSRF token.
2. Server validates with the shared schema and the rules in §4.2.
3. Atomic write: write to `<name>.json.tmp`, `fsync`, rename.
4. File watcher reloads the store → MCP server re-registers tools → `notifications/tools/list_changed` sent to connected sessions.

Hand edits to files on the volume follow step 4 as well.

### 6.3 Read vs. write mode
- **read**:
  - MySQL: `START TRANSACTION READ ONLY` … `COMMIT`.
  - Postgres: `BEGIN READ ONLY` … `COMMIT`.
  - SQL Server: `BEGIN TRANSACTION` … always `ROLLBACK`. Docs recommend a least-privilege DB user.
- **write**: run in a transaction, commit on success, roll back on error; return `affectedRows`.
- Timeouts: MySQL `timeout` query option; Postgres `SET LOCAL statement_timeout`; SQL Server `requestTimeout`.
- Row cap: fetch at most `maxRows + 1` rows where the driver allows streaming/cursor; otherwise slice. `truncated` is `true` if more than `maxRows` rows existed.

### 6.4 Test run
`POST /api/tools/:name/run` with sample args runs the same executor path. Accepts an unsaved tool definition in the body so the editor can test before saving. Write-mode test runs require an explicit `confirmWrite: true` flag (UI shows a confirmation dialog).

### 6.5 Admin API surface

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/login` | Username/password → session cookie + CSRF token |
| POST | `/api/auth/logout` | |
| GET | `/api/auth/me` | Session check |
| GET | `/api/connections` | List (passwords masked), with validity status |
| GET/PUT/DELETE | `/api/connections/:id` | Read / create-or-replace / delete (delete blocked if tools reference it) |
| POST | `/api/connections/:id/test` | Test connectivity (accepts unsaved body) |
| GET | `/api/tools` | List with validity status and errors |
| GET/PUT/DELETE | `/api/tools/:name` | Read / create-or-replace / delete |
| POST | `/api/tools/:name/run` | Test run (§6.4) |
| GET | `/api/status` | Invalid-file errors, server info |

When a connection is saved with the password field omitted or equal to the mask sentinel, the existing stored password is retained.

## 7. Error handling

- Tool errors (validation, timeout, DB error, unknown connection) return MCP results with `isError: true` and a human-readable message, e.g. ``parameter `limit` must be ≤ 500``, `query timed out after 15000 ms`, or the DB engine's error message with connection details stripped. No stack traces, hostnames, or credentials in tool output.
- Full error details logged via pino with a request ID.
- Startup: missing/weak `API_KEY`, `ADMIN_PASSWORD`, or `SECRET_KEY` → exit non-zero with a message naming the variable.
- Invalid JSON files do not crash the server; they are excluded from MCP, and the error is surfaced in the UI (`/api/status`, tool/connection list).
- A `enc:v1:` value that fails to decrypt (e.g. `SECRET_KEY` changed) marks the connection invalid with a clear message.
- Graceful shutdown on SIGTERM: stop accepting requests, close pools.

## 8. Security

- API key compared in constant time; failed auth attempts rate-limited per IP (e.g. 10/min) on both `/mcp` and `/api/auth/login`.
- Admin session: signed cookie, `HttpOnly`, `SameSite=Strict`, `Secure` when served over HTTPS / `TRUST_PROXY`; 12-hour expiry. CSRF token required on mutating admin routes.
- Passwords never returned by the admin API.
- Values only ever bound via driver parameters; no string interpolation of arguments into SQL.
- No raw-SQL MCP tool; Claude can only call admin-defined queries.
- Read-only enforced at transaction level; docs recommend least-privilege DB users.
- Container runs as non-root user; only `DATA_DIR` is writable.
- `?key=` query auth is off by default; docs warn it may appear in proxy/access logs.
- Docs recommend TLS termination via reverse proxy (Caddy/Traefik examples).

## 9. Testing

- **Unit (Vitest):** placeholder compiler (all dialects, repeated names, `::` casts, strings/comments/quoted identifiers), schema validation and tool rules, secret encrypt/decrypt round-trip and `${ENV}` resolution, params → JSON Schema, params → Zod arg validation.
- **Integration (Testcontainers):** real MySQL, Postgres, SQL Server — read/write per driver, read-only mode rejects writes (MySQL/Postgres) and rolls back (SQL Server), timeout enforcement, `maxRows` truncation, config store watch/reload.
- **End-to-end:** start server, connect with MCP SDK client over Streamable HTTP; bad key → 401; `tools/list` matches definitions; `tools/call` returns expected rows; editing a tool file triggers `list_changed`.
- **UI smoke (Playwright):** login → create connection → test connection → create tool → test run.
- **CI (GitHub Actions):** lint, typecheck, unit + integration tests on PRs; on tag, build multi-arch image (amd64/arm64) and publish to GHCR.

## 10. Packaging and deployment

- Multi-stage `Dockerfile` → `node:22-alpine` runtime, non-root, `HEALTHCHECK` on `/healthz`, `VOLUME /data`, `EXPOSE 3000`.
- `docker-compose.yml`: the server plus sample MySQL, Postgres, and SQL Server containers seeded with demo data, and `examples/data/` containing example connections and tools.
- `.env.example` listing all variables.

## 11. Documentation

`README.md` covers:
- Quick start: `docker run -p 3000:3000 -v ./data:/data -e API_KEY=... -e ADMIN_PASSWORD=... -e SECRET_KEY=... ghcr.io/<owner>/sql-mcp`
- docker-compose demo.
- Tool and connection JSON reference.
- Claude integration:
  - Claude Code: `claude mcp add --transport http sql https://<host>/mcp --header "Authorization: Bearer <API_KEY>"`
  - Claude Desktop: `mcp-remote` config with `--header`.
  - claude.ai custom connector: `https://<host>/mcp?key=<API_KEY>` with `ALLOW_QUERY_KEY=true` and the logging caveat.
- Security recommendations (least-privilege DB users, TLS, key rotation).
- `CONTRIBUTING.md`, `LICENSE` (MIT).

## 12. Future work (out of scope for v1)

OAuth 2.1 for claude.ai connectors; multiple scoped API keys; multi-user admin with roles; additional engines (SQLite, Oracle, Snowflake); query result pagination; audit log of tool calls.
