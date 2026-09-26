import { useCallback, useEffect, useState } from 'react';
import { api, type Invalid } from './api';
import { Connections } from './Connections';
import { Login } from './Login';
import { Tools } from './Tools';

type Tab = 'tools' | 'connections';

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [tab, setTab] = useState<Tab>('tools');
  const [invalid, setInvalid] = useState<Invalid[]>([]);
  const [version, setVersion] = useState('');

  const refreshStatus = useCallback(() => {
    api<{ version: string; invalid: Invalid[] }>('GET', '/api/status')
      .then((s) => {
        setInvalid(s.invalid);
        setVersion(s.version);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    api<{ authenticated: boolean }>('GET', '/api/auth/me')
      .then((r) => setAuthed(r.authenticated))
      .catch(() => setAuthed(false));
  }, []);

  useEffect(() => {
    if (authed) refreshStatus();
  }, [authed, refreshStatus]);

  if (authed === null) return null;
  if (!authed) return <Login onLogin={() => setAuthed(true)} />;

  const logout = async () => {
    await api('POST', '/api/auth/logout');
    setAuthed(false);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          SQL MCP <span className="muted">{version && `v${version}`}</span>
        </div>
        <nav className="tabs">
          <button className={tab === 'tools' ? 'active' : ''} onClick={() => setTab('tools')}>
            Tools
          </button>
          <button className={tab === 'connections' ? 'active' : ''} onClick={() => setTab('connections')}>
            Connections
          </button>
        </nav>
        <button className="ghost" onClick={logout}>
          Log out
        </button>
      </header>

      {invalid.length > 0 && (
        <div className="banner error">
          <strong>{invalid.length} config file(s) have errors and are ignored:</strong>
          <ul>
            {invalid.map((i) => (
              <li key={i.file}>
                <code>{i.file}</code>: {i.errors.join('; ')}
              </li>
            ))}
          </ul>
        </div>
      )}

      <main>
        {tab === 'tools' ? <Tools onChange={refreshStatus} /> : <Connections onChange={refreshStatus} />}
      </main>
    </div>
  );
}
