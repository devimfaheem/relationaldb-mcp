import { useEffect, useState } from 'react';
import { api, errorText, PASSWORD_MASK, type Connection } from './api';

const DEFAULT_PORTS = { mysql: 3306, mssql: 1433, postgres: 5432 } as const;
const ENGINE_LABELS = { mysql: 'MySQL / MariaDB', postgres: 'PostgreSQL', mssql: 'SQL Server' } as const;

type Engine = keyof typeof DEFAULT_PORTS;

interface Form {
  id: string;
  engine: Engine;
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
  sslEnabled: boolean;
  rejectUnauthorized: boolean;
  poolMax: string;
  options: string;
}

const blank: Form = {
  id: '',
  engine: 'postgres',
  host: '',
  port: '5432',
  database: '',
  user: '',
  password: '',
  sslEnabled: false,
  rejectUnauthorized: true,
  poolMax: '10',
  options: '{}',
};

const toForm = (c: Connection): Form => ({
  id: c.id,
  engine: c.engine,
  host: c.host,
  port: String(c.port),
  database: c.database,
  user: c.user,
  password: PASSWORD_MASK,
  sslEnabled: c.ssl.enabled,
  rejectUnauthorized: c.ssl.rejectUnauthorized,
  poolMax: String(c.pool.max),
  options: JSON.stringify(c.options, null, 2),
});

function toBody(f: Form) {
  return {
    id: f.id,
    engine: f.engine,
    host: f.host,
    port: Number(f.port),
    database: f.database,
    user: f.user,
    password: f.password,
    ssl: { enabled: f.sslEnabled, rejectUnauthorized: f.rejectUnauthorized },
    pool: { max: Number(f.poolMax) },
    options: JSON.parse(f.options || '{}'),
  };
}

export function Connections({ onChange }: { onChange: () => void }) {
  const [list, setList] = useState<Connection[]>([]);
  const [form, setForm] = useState<Form | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api<Connection[]>('GET', '/api/connections').then(setList);
  useEffect(() => {
    load();
  }, []);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  const open = (c?: Connection) => {
    setMessage(null);
    setIsNew(!c);
    setForm(c ? toForm(c) : { ...blank });
  };

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
      await api('PUT', `/api/connections/${encodeURIComponent(form!.id)}`, toBody(form!));
      await load();
      onChange();
      setIsNew(false);
      set('password', PASSWORD_MASK);
      setMessage({ kind: 'ok', text: 'Saved.' });
    });

  const test = () =>
    run(async () => {
      const r = await api<{ ok: boolean; error?: string }>(
        'POST',
        `/api/connections/${encodeURIComponent(form!.id || 'new')}/test`,
        toBody({ ...form!, id: form!.id || 'new' }),
      );
      setMessage(r.ok ? { kind: 'ok', text: 'Connection succeeded.' } : { kind: 'error', text: `Connection failed: ${r.error}` });
    });

  const remove = () =>
    run(async () => {
      if (!confirm(`Delete connection "${form!.id}"?`)) return;
      await api('DELETE', `/api/connections/${encodeURIComponent(form!.id)}`);
      await load();
      onChange();
      setForm(null);
    });

  return (
    <div className="split">
      <section className="list">
        <div className="list-header">
          <h2>Connections</h2>
          <button className="primary" onClick={() => open()}>
            + New
          </button>
        </div>
        {list.length === 0 && <p className="muted">No connections yet.</p>}
        {list.map((c) => (
          <button key={c.id} className={`list-item ${form?.id === c.id && !isNew ? 'selected' : ''}`} onClick={() => open(c)}>
            <strong>{c.id}</strong>
            <span className="muted">
              {ENGINE_LABELS[c.engine]} · {c.host}/{c.database}
            </span>
          </button>
        ))}
      </section>

      {form && (
        <section className="card editor">
          <h2>{isNew ? 'New connection' : form.id}</h2>
          <div className="grid">
            <label>
              ID
              <input value={form.id} disabled={!isNew} onChange={(e) => set('id', e.target.value)} placeholder="sales_db" />
            </label>
            <label>
              Engine
              <select
                value={form.engine}
                onChange={(e) => {
                  const engine = e.target.value as Engine;
                  setForm((f) => f && { ...f, engine, port: String(DEFAULT_PORTS[engine]) });
                }}
              >
                {Object.entries(ENGINE_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Host
              <input value={form.host} onChange={(e) => set('host', e.target.value)} />
            </label>
            <label>
              Port
              <input value={form.port} onChange={(e) => set('port', e.target.value)} inputMode="numeric" />
            </label>
            <label>
              Database
              <input value={form.database} onChange={(e) => set('database', e.target.value)} />
            </label>
            <label>
              User
              <input value={form.user} onChange={(e) => set('user', e.target.value)} />
            </label>
            <label>
              Password
              <input
                type="password"
                value={form.password}
                onFocus={() => form.password === PASSWORD_MASK && set('password', '')}
                onBlur={() => !isNew && form.password === '' && set('password', PASSWORD_MASK)}
                onChange={(e) => set('password', e.target.value)}
                placeholder="or ${ENV_VAR}"
              />
            </label>
            <label>
              Pool size
              <input value={form.poolMax} onChange={(e) => set('poolMax', e.target.value)} inputMode="numeric" />
            </label>
          </div>
          <div className="row">
            <label className="check">
              <input type="checkbox" checked={form.sslEnabled} onChange={(e) => set('sslEnabled', e.target.checked)} />
              Use SSL/TLS
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={form.rejectUnauthorized}
                onChange={(e) => set('rejectUnauthorized', e.target.checked)}
              />
              Verify server certificate
            </label>
          </div>
          <label>
            Driver options (JSON)
            <textarea rows={3} value={form.options} onChange={(e) => set('options', e.target.value)} className="mono" />
          </label>

          {message && <div className={message.kind === 'ok' ? 'ok-text' : 'error-text'}>{message.text}</div>}

          <div className="actions">
            <button className="primary" onClick={save} disabled={busy}>
              Save
            </button>
            <button onClick={test} disabled={busy}>
              Test connection
            </button>
            {!isNew && (
              <button className="danger" onClick={remove} disabled={busy}>
                Delete
              </button>
            )}
            <button className="ghost" onClick={() => setForm(null)}>
              Close
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
