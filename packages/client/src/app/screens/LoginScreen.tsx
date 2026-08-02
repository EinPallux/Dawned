/**
 * Login / register — the first thing a player ever sees (docs/design/UI_UX.md §4).
 * Live 3D dawn vignette behind an angular card; client-side zod feedback before
 * the request even leaves.
 */

import { useEffect, useState } from 'react';
import { accountNameSchema, passwordSchema } from '@dawned/shared';
import { useApp } from '../store.js';
import { api } from '../../net/api.js';
import { Backdrop } from '../components/Backdrop.js';
import { Button, Checkbox, ErrorLine, TextField } from '../components/ui.js';

type Mode = 'login' | 'register';

export const LoginScreen = (): React.JSX.Element => {
  const { login, register, busy, error, clearError } = useApp();
  const [mode, setMode] = useState<Mode>('login');
  const [name, setName] = useState(localStorage.getItem('dawned.lastAccount') ?? '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [remember, setRemember] = useState(true);
  const [localError, setLocalError] = useState<string | null>(null);
  const [status, setStatus] = useState<{ players: number; maxPlayers: number } | null>(null);

  useEffect(() => {
    let alive = true;
    void api
      .serverStatus()
      .then((s) => {
        if (alive) setStatus(s);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const switchMode = (next: Mode): void => {
    setMode(next);
    setLocalError(null);
    clearError();
  };

  const submit = (): void => {
    setLocalError(null);
    if (mode === 'register') {
      const nameCheck = accountNameSchema.safeParse(name);
      if (!nameCheck.success) {
        setLocalError(nameCheck.error.issues[0]?.message ?? 'Invalid name.');
        return;
      }
      const passCheck = passwordSchema.safeParse(password);
      if (!passCheck.success) {
        setLocalError(passCheck.error.issues[0]?.message ?? 'Invalid password.');
        return;
      }
      if (password !== confirm) {
        setLocalError('Passwords do not match.');
        return;
      }
    } else if (!name || !password) {
      setLocalError('Enter your account name and password.');
      return;
    }
    localStorage.setItem('dawned.lastAccount', name);
    void (mode === 'login' ? login(name, password, remember) : register(name, password, remember));
  };

  return (
    <div className="screen">
      <Backdrop />
      <div className="screen__scrim" />
      <div className="login-layout">
        <div className="panel login-card" role="form">
          <h1 className="brand">DAWNED</h1>
          <p className="brand-sub">An open world, five isles, one sunrise.</p>

          <div className="tabs" role="tablist">
            <button
              role="tab"
              aria-selected={mode === 'login'}
              className={`tab${mode === 'login' ? ' is-active' : ''}`}
              onClick={() => {
                switchMode('login');
              }}
            >
              LOG IN
            </button>
            <button
              role="tab"
              aria-selected={mode === 'register'}
              className={`tab${mode === 'register' ? ' is-active' : ''}`}
              onClick={() => {
                switchMode('register');
              }}
            >
              NEW ACCOUNT
            </button>
          </div>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <TextField
              label="Account name"
              value={name}
              onChange={setName}
              maxLength={20}
              autoFocus
              hint={
                mode === 'register' ? '3–20 characters: letters, digits, underscore.' : undefined
              }
            />
            <TextField
              label="Password"
              type="password"
              value={password}
              onChange={setPassword}
              maxLength={128}
              hint={
                mode === 'register'
                  ? 'At least 8 characters. There is no email reset — remember it! An admin can reset it if lost.'
                  : undefined
              }
            />
            {mode === 'register' ? (
              <TextField
                label="Repeat password"
                type="password"
                value={confirm}
                onChange={setConfirm}
                maxLength={128}
              />
            ) : null}
            <Checkbox
              label="Stay signed in on this computer"
              checked={remember}
              onChange={setRemember}
            />
            <ErrorLine message={localError ?? error} />
            <Button type="submit" disabled={busy}>
              {busy ? 'WORKING…' : mode === 'login' ? 'ENTER THE DAWNLANDS' : 'CREATE ACCOUNT'}
            </Button>
          </form>

          <div className="login-footer">
            <span className={`status-pip${status ? ' is-online' : ''}`} />
            {status ? `Online — ${status.players} in the world` : 'Reaching the server…'}
            <span className="login-version">v0.1.0-dev · P1</span>
          </div>
        </div>
      </div>
    </div>
  );
};
