import { compile } from '../shared/placeholders.js';
import type { Connection, Tool } from '../shared/schema.js';
import type { Driver } from './db/types.js';
import { ArgsError, parseArgs } from './params.js';

export interface ToolResult {
  isError: boolean;
  text: string;
  structured?: Record<string, unknown>;
}

export interface ExecutorDeps {
  getConnection(id: string): Connection | undefined;
  pools: { get(conn: Connection): Driver };
  log?: { error(obj: unknown, msg?: string): void };
}

export type Executor = ReturnType<typeof createExecutor>;

/** Runs a tool: validates args, compiles placeholders, executes, and formats the result. */
export function createExecutor({ getConnection, pools, log }: ExecutorDeps) {
  const fail = (text: string): ToolResult => ({ isError: true, text });

  return {
    async run(tool: Tool, rawArgs: unknown): Promise<ToolResult> {
      let args: Record<string, unknown>;
      try {
        args = parseArgs(tool.parameters, rawArgs);
      } catch (e) {
        if (e instanceof ArgsError) return fail(e.message);
        throw e;
      }

      const conn = getConnection(tool.connection);
      if (!conn) return fail(`Connection "${tool.connection}" not found`);

      const { sql, values } = compile(tool.query, conn.engine, args);
      try {
        const res = await pools.get(conn).query(sql, values, {
          readOnly: tool.mode === 'read',
          timeoutMs: tool.limits.timeoutMs,
          maxRows: tool.limits.maxRows,
        });
        const structured: Record<string, unknown> =
          res.affectedRows !== undefined
            ? { affectedRows: res.affectedRows }
            : { columns: res.columns, rows: res.rows, rowCount: res.rowCount, truncated: res.truncated };
        const text = JSON.stringify(structured, jsonReplacer);
        return { isError: false, text, structured: JSON.parse(text) };
      } catch (e) {
        log?.error({ err: e, tool: tool.name }, 'tool query failed');
        return fail(`Query failed: ${(e as Error).message}`);
      }
    },
  };
}

/** Makes driver values JSON-safe (BigInt → string, Buffer → base64). */
function jsonReplacer(_key: string, value: unknown) {
  if (typeof value === 'bigint') return value.toString();
  if (value && typeof value === 'object' && (value as { type?: string }).type === 'Buffer' && Array.isArray((value as { data?: unknown }).data)) {
    return Buffer.from((value as { data: number[] }).data).toString('base64');
  }
  return value;
}
