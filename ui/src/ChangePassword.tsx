import { useState, type FormEvent } from 'react';
import { api, errorText } from './api';

interface Props {
  /** First-login mode: explains why and offers no way to cancel. */
  forced: boolean;
  onDone(): void;
  onCancel?(): void;
}

export function ChangePassword({ forced, onDone, onCancel }: Props) {
  const [currentPassword, setCurrent] = useState(forced ? 'admin' : '');
  const [newPassword, setNew] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirm) return setError('The new passwords do not match');
    setBusy(true);
    setError('');
    try {
      await api('POST', '/api/auth/password', { currentPassword, newPassword });
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <h1>{forced ? 'Set a new password' : 'Change password'}</h1>
        {forced && (
          <p className="muted">
            You signed in with the default <code>admin</code> / <code>admin</code> login. Choose a new password to continue.
          </p>
        )}
        {!forced && (
          <label>
            Current password
            <input type="password" value={currentPassword} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" autoFocus />
          </label>
        )}
        <label>
          New password <span className="muted">(at least 8 characters)</span>
          <input type="password" value={newPassword} onChange={(e) => setNew(e.target.value)} autoComplete="new-password" autoFocus={forced} />
        </label>
        <label>
          Confirm new password
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        </label>
        {error && <div className="error-text">{error}</div>}
        <button className="primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save password'}
        </button>
        {onCancel && (
          <button type="button" className="ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
      </form>
    </div>
  );
}
