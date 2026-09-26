import { useMemo, useState } from 'react';
import CodeMirror, { EditorView } from '@uiw/react-codemirror';
import { sql, MySQL, PostgreSQL, MSSQL } from '@codemirror/lang-sql';
import { extractPlaceholders } from '../../src/shared/placeholders';
import { api, errorText, type Connection, type Parameter, type RunResult, type Tool } from './api';

const TYPES = ['string', 'integer', 'number', 'boolean', 'date', 'datetime'] as const;
const DIALECTS = { mysql: MySQL, postgres: PostgreSQL, mssql: MSSQL };

/** Editable parameter row: optional values are kept as strings until save. */
interface ParamRow {
  name: string;
  type: Parameter['type'];
  description: string;
  required: boolean;
  default: string;
  enum: string;
  min: string;
  max: string;
}

const isNumeric = (t: string) => t === 'integer' || t === 'number';
const prefersDark = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;

function parseValue(type: Parameter['type'], raw: string): unknown {
  if (isNumeric(type)) return Number(raw);
  if (type === 'boolean') return raw === 'true';
  return raw;
}

const toRow = (p: Parameter): ParamRow => ({
  name: p.name,
  type: p.type,
  description: p.description,
  required: p.required,
  default: p.default === undefined ? '' : String(p.default),
  enum: p.enum ? p.enum.map(String).join(', ') : '',
  min: p.min === undefined ? '' : String(p.min),
  max: p.max === undefined ? '' : String(p.max),
});

const fromRow = (r: ParamRow) => ({
  name: r.name,
  type: r.type,
  description: r.description || r.name,
  required: r.required,
  ...(r.default !== '' && { default: parseValue(r.type, r.default) }),
  ...(r.enum.trim() && { enum: r.enum.split(',').map((v) => parseValue(r.type, v.trim())) }),
  ...(isNumeric(r.type) && r.min !== '' && { min: Number(r.min) }),
  ...(isNumeric(r.type) && r.max !== '' && { max: Number(r.max) }),
});

interface Props {
  initial: Tool | null;
  connections: Connection[];
  onSaved(tool: Tool | null): void;
  onClose(): void;
}

export function ToolEditor({ initial, connections, onSaved, onClose }: Props) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [connection, setConnection] = useState(initial?.connection ?? connections[0]?.id ?? '');
  const [mode, setMode] = useState<'read' | 'write'>(initial?.mode ?? 'read');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [query, setQuery] = useState(initial?.query ?? 'SELECT * FROM my_table WHERE id = :id');
  const [params, setParams] = useState<ParamRow[]>(initial?.parameters.map(toRow) ?? []);
  const [maxRows, setMaxRows] = useState(String(initial?.limits.maxRows ?? 1000));
  const [timeoutMs, setTimeoutMs] = useState(String(initial?.limits.timeoutMs ?? 30000));

  const [args, setArgs] = useState<Record<string, string>>({});
  const [result, setResult] = useState<RunResult | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const engine = connections.find((c) => c.id === connection)?.engine ?? 'postgres';
  const extensions = useMemo(() => [sql({ dialect: DIALECTS[engine] }), EditorView.lineWrapping], [engine]);

  const body = () => ({
    name,
    description,
    connection,
    mode,
    enabled,
    query,
    parameters: params.map(fromRow),
    limits: { maxRows: Number(maxRows), timeoutMs: Number(timeoutMs) },
  });

  const detect = () => {
    const found = extractPlaceholders(query);
    const kept = params.filter((p) => found.includes(p.name));
    const added = found
      .filter((n) => !params.some((p) => p.name === n))
      .map((n): ParamRow => ({ name: n, type: 'string', description: '', required: true, default: '', enum: '', min: '', max: '' }));
    setParams([...kept, ...added]);
  };

  const updateParam = (i: number, patch: Partial<ParamRow>) =>
    setParams((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      setMessage({ kind: 'error', text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      const tool = await api<Tool>('PUT', `/api/tools/${encodeURIComponent(name)}`, body());
      if (initial && initial.name !== name) await api('DELETE', `/api/tools/${encodeURIComponent(initial.name)}`);
      onSaved(tool);
    });

  const remove = () =>
    run(async () => {
      if (!initial || !confirm(`Delete tool "${initial.name}"?`)) return;
      await api('DELETE', `/api/tools/${encodeURIComponent(initial.name)}`);
      onSaved(null);
    });

  const test = () =>
    run(async () => {
      if (mode === 'write' && !confirm('This is a write tool. Running it will change data. Continue?')) return;
      const typedArgs: Record<string, unknown> = {};
      for (const p of params) {
        const raw = args[p.name];
        if (raw !== undefined && raw !== '') typedArgs[p.name] = parseValue(p.type, raw);
      }
      setResult(null);
      const r = await api<RunResult>('POST', `/api/tools/${encodeURIComponent(name || 'draft')}/run`, {
        tool: { ...body(), name: name || 'draft' },
        args: typedArgs,
        confirmWrite: mode === 'write',
      });
      setResult(r);
    });

  return (
    <section className="card editor">
      <h2>{initial ? initial.name : 'New tool'}</h2>
      <div className="grid">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="get_customer_orders" />
        </label>
        <label>
          Connection
          <select value={connection} onChange={(e) => setConnection(e.target.value)}>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.id} ({c.engine})
              </option>
            ))}
          </select>
        </label>
        <label className="span2">
          <span>
            Description <span className="muted">(shown to Claude, so explain when to use it)</span>
          </span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label>
          Mode
          <select value={mode} onChange={(e) => setMode(e.target.value as 'read' | 'write')}>
            <option value="read">read (read-only transaction)</option>
            <option value="write">write (can modify data)</option>
          </select>
        </label>
        <div className="row">
          <label>
            Max rows
            <input value={maxRows} onChange={(e) => setMaxRows(e.target.value)} inputMode="numeric" />
          </label>
          <label>
            Timeout (ms)
            <input value={timeoutMs} onChange={(e) => setTimeoutMs(e.target.value)} inputMode="numeric" />
          </label>
        </div>
      </div>
      <label className="check">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Enabled (visible to Claude)
      </label>

      <div className="section-head">
        <h3>Query</h3>
        <span className="muted">
          Use <code>:name</code> placeholders. Values are always sent as bound parameters.
        </span>
      </div>
      <div className="sql-editor">
        <CodeMirror
          value={query}
          onChange={setQuery}
          extensions={extensions}
          theme={prefersDark() ? 'dark' : 'light'}
          minHeight="120px"
          basicSetup={{ lineNumbers: true }}
        />
      </div>

      <div className="section-head">
        <h3>Parameters</h3>
        <button onClick={detect}>Detect from query</button>
      </div>
      {params.length === 0 && <p className="muted">No parameters.</p>}
      {params.length > 0 && (
        <div className="table-wrap">
          <table className="params">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Required</th>
                <th>Description</th>
                <th>Default</th>
                <th>Allowed values</th>
                <th>Min</th>
                <th>Max</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {params.map((p, i) => (
                <tr key={i}>
                  <td>
                    <input value={p.name} onChange={(e) => updateParam(i, { name: e.target.value })} />
                  </td>
                  <td>
                    <select value={p.type} onChange={(e) => updateParam(i, { type: e.target.value as ParamRow['type'] })}>
                      {TYPES.map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </select>
                  </td>
                  <td className="center">
                    <input type="checkbox" checked={p.required} onChange={(e) => updateParam(i, { required: e.target.checked })} />
                  </td>
                  <td>
                    <input value={p.description} onChange={(e) => updateParam(i, { description: e.target.value })} />
                  </td>
                  <td>
                    <input value={p.default} onChange={(e) => updateParam(i, { default: e.target.value })} />
                  </td>
                  <td>
                    <input value={p.enum} onChange={(e) => updateParam(i, { enum: e.target.value })} placeholder="a, b, c" />
                  </td>
                  <td>
                    <input value={p.min} disabled={!isNumeric(p.type)} onChange={(e) => updateParam(i, { min: e.target.value })} />
                  </td>
                  <td>
                    <input value={p.max} disabled={!isNumeric(p.type)} onChange={(e) => updateParam(i, { max: e.target.value })} />
                  </td>
                  <td>
                    <button className="ghost" onClick={() => setParams((ps) => ps.filter((_, j) => j !== i))} aria-label="Remove">
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {message && <pre className={message.kind === 'ok' ? 'ok-text' : 'error-text'}>{message.text}</pre>}

      <div className="actions">
        <button className="primary" onClick={save} disabled={busy}>
          Save
        </button>
        {initial && (
          <button className="danger" onClick={remove} disabled={busy}>
            Delete
          </button>
        )}
        <button className="ghost" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="section-head">
        <h3>Test run</h3>
      </div>
      <div className="grid">
        {params.map((p) => (
          <label key={p.name}>
            <span>
              {p.name} <span className="muted">({p.type})</span>
            </span>
            <input value={args[p.name] ?? ''} onChange={(e) => setArgs((a) => ({ ...a, [p.name]: e.target.value }))} />
          </label>
        ))}
      </div>
      <div className="actions">
        <button onClick={test} disabled={busy}>
          {busy ? 'Running…' : 'Run'}
        </button>
      </div>
      {result && <Result result={result} />}
    </section>
  );
}

function Result({ result }: { result: RunResult }) {
  if (result.isError) return <pre className="error-text">{result.text}</pre>;
  const s = result.structured ?? {};
  if (s.affectedRows !== undefined) return <p className="ok-text">{s.affectedRows} row(s) affected.</p>;
  const columns = s.columns ?? [];
  const rows = s.rows ?? [];
  return (
    <div>
      <p className="muted">
        {rows.length} row(s){s.truncated && ' (truncated at max rows)'}
      </p>
      <div className="table-wrap">
        <table className="results">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c}>{r[c] === null ? <span className="muted">NULL</span> : String(r[c])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
