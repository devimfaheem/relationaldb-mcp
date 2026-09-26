import { useEffect, useState } from 'react';
import { api, type Connection, type Tool } from './api';
import { ToolEditor } from './ToolEditor';

export function Tools({ onChange }: { onChange: () => void }) {
  const [tools, setTools] = useState<Tool[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  // undefined = nothing open, null = new tool
  const [editing, setEditing] = useState<Tool | null | undefined>(undefined);

  const load = async () => {
    const [t, c] = await Promise.all([api<Tool[]>('GET', '/api/tools'), api<Connection[]>('GET', '/api/connections')]);
    setTools(t);
    setConnections(c);
  };
  useEffect(() => {
    load();
  }, []);

  const saved = async (tool: Tool | null) => {
    await load();
    onChange();
    setEditing(tool ?? undefined);
  };

  return (
    <div className="split">
      <section className="list">
        <div className="list-header">
          <h2>Tools</h2>
          <button className="primary" onClick={() => setEditing(null)} disabled={connections.length === 0}>
            + New
          </button>
        </div>
        {connections.length === 0 && <p className="muted">Add a connection first.</p>}
        {connections.length > 0 && tools.length === 0 && <p className="muted">No tools yet.</p>}
        {tools.map((t) => (
          <button
            key={t.name}
            className={`list-item ${editing?.name === t.name ? 'selected' : ''}`}
            onClick={() => setEditing(t)}
          >
            <strong>
              {t.name} {!t.enabled && <span className="pill">disabled</span>}
              <span className={`pill ${t.mode}`}>{t.mode}</span>
            </strong>
            <span className="muted">{t.description}</span>
          </button>
        ))}
      </section>

      {editing !== undefined && (
        <ToolEditor
          key={editing?.name ?? '__new__'}
          initial={editing}
          connections={connections}
          onSaved={saved}
          onClose={() => setEditing(undefined)}
        />
      )}
    </div>
  );
}
