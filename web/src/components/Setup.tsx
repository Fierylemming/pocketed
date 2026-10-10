import { useEffect, useState, type FormEvent } from "react";
import { genRecovery, passwordError } from "@pocketed/shared";
import { api, ApiError } from "../api";
import type { Config } from "../config";

type SetupMode = "loading" | "login" | "create" | "recover" | "showKey";

export function Setup({
  defaultServerUrl,
  onConnect,
}: {
  defaultServerUrl: string;
  onConnect: (c: Config) => void;
}) {
  const [mode, setMode] = useState<SetupMode>("loading");
  const [url, setUrl] = useState(defaultServerUrl);
  const [editUrl, setEditUrl] = useState(!defaultServerUrl);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [recoveryInput, setRecoveryInput] = useState("");
  const [pendingKey, setPendingKey] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const serverUrl = url.trim();

  // Wait for the user to stop typing before probing the server address.
  useEffect(() => {
    if (!serverUrl) {
      setMode("loading");
      return;
    }
    setMode("loading");
    const t = setTimeout(() => {
      api
        .health(serverUrl)
        .then((h) => setMode(h.initialized ? "login" : "create"))
        .catch(() => setMode("login"));
    }, 400);
    return () => clearTimeout(t);
  }, [serverUrl]);

  async function login(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      // limit=1 keeps the password check cheap; the real sync happens after.
      await api.pull({ serverUrl, token: password }, 0, 1);
      onConnect({ serverUrl, token: password });
    } catch (e2) {
      setErr(
        e2 instanceof ApiError && e2.status === 401
          ? "Wrong password."
          : "Can't reach that server address.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    const perr = passwordError(password);
    if (perr) return setErr(perr);
    if (password !== confirm) return setErr("Passwords don't match.");
    setBusy(true);
    setErr(null);
    const key = genRecovery();
    try {
      await api.init(serverUrl, password, key);
      setPendingKey(key);
      setMode("showKey");
    } catch (e2) {
      setErr(
        e2 instanceof ApiError && e2.status === 409
          ? "This server already has a password — use the login tab."
          : "Can't reach that server address.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function recover(e: FormEvent) {
    e.preventDefault();
    const perr = passwordError(password);
    if (perr) return setErr(perr);
    if (password !== confirm) return setErr("Passwords don't match.");
    setBusy(true);
    setErr(null);
    try {
      await api.recover(serverUrl, recoveryInput.trim(), password);
      onConnect({ serverUrl, token: password });
    } catch (e2) {
      setErr(
        e2 instanceof ApiError && e2.status === 401
          ? "That recovery key doesn't match."
          : "Can't reach that server address.",
      );
    } finally {
      setBusy(false);
    }
  }

  const onSubmit =
    mode === "login"
      ? login
      : mode === "create"
        ? create
        : mode === "recover"
          ? recover
          : (e: FormEvent) => e.preventDefault();

  return (
    <div className="center">
      <form className="card" onSubmit={onSubmit}>
        <div className="logo">🗒️</div>
        <h1>Pocketed</h1>

        {editUrl ? (
          <label className="field">
            <span>Server address</span>
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
          </label>
        ) : (
          <button type="button" className="linklike" onClick={() => setEditUrl(true)}>
            advanced: custom server address
          </button>
        )}

        {mode === "loading" && (
          <p className="muted">
            {serverUrl ? "Contacting your server…" : "Enter your server address to continue."}
          </p>
        )}

        {mode === "login" && (
          <>
            <p className="muted">Your notes, on every device.</p>
            <label className="field">
              <span>Password</span>
              <input
                type="password"
                autoFocus
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            {err && <p className="err">{err}</p>}
            <button className="primary big" disabled={busy || !password}>
              {busy ? "Checking…" : "Open my notes"}
            </button>
            <button
              type="button"
              className="linklike"
              onClick={() => {
                setErr(null);
                setMode("recover");
              }}
            >
              Forgot password? Use your recovery key
            </button>
          </>
        )}

        {mode === "create" && (
          <>
            <p className="muted">First time here — choose your password.</p>
            <label className="field">
              <span>Password (8+ characters)</span>
              <input
                type="password"
                autoFocus
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <label className="field">
              <span>Repeat it</span>
              <input
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </label>
            {err && <p className="err">{err}</p>}
            <button className="primary big" disabled={busy || !password}>
              {busy ? "Creating…" : "Create my notes space"}
            </button>
          </>
        )}

        {mode === "recover" && (
          <>
            <p className="muted">Type your recovery key and choose a new password.</p>
            <label className="field">
              <span>Recovery key</span>
              <input
                autoFocus
                value={recoveryInput}
                onChange={(e) => setRecoveryInput(e.target.value)}
                placeholder="xxxx-xxxx-xxxx"
              />
            </label>
            <label className="field">
              <span>New password (8+ characters)</span>
              <input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <label className="field">
              <span>Repeat it</span>
              <input
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </label>
            {err && <p className="err">{err}</p>}
            <button className="primary big" disabled={busy || !password || !recoveryInput}>
              {busy ? "Resetting…" : "Reset password"}
            </button>
            <button
              type="button"
              className="linklike"
              onClick={() => {
                setErr(null);
                setMode("login");
              }}
            >
              Back to login
            </button>
          </>
        )}

        {mode === "showKey" && (
          <>
            <p className="muted">
              This <b>recovery key</b> is the only way back in if you ever forget your password.
              Write it down somewhere safe.
            </p>
            <div className="keybox">{pendingKey}</div>
            <button className="primary big" onClick={() => onConnect({ serverUrl, token: password })}>
              I've saved it — open my notes
            </button>
          </>
        )}
      </form>
    </div>
  );
}
