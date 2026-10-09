import { useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import {
  addNote,
  deleteNote,
  editNote,
  genRecovery,
  passwordError,
  shortAgo,
  type Note,
} from "@pocketed/shared";
import { api, ApiError } from "./api";
import { clearAll, DEFAULT_SERVER_URL, loadCfg, saveCfg, type Config } from "./config";
import { SyncManager } from "./store";
import {
  REMINDER_CHOICES,
  reminderAtFor,
  reminderMeta,
  rowsFor,
  syncStatus,
} from "./view-model";

export default function App() {
  const [cfg, setCfg] = useState<Config | null>(() => loadCfg());
  const [manager, setManager] = useState<SyncManager | null>(null);

  useEffect(() => {
    if (!cfg) {
      setManager(null);
      return;
    }
    const m = new SyncManager(cfg);
    m.start();
    setManager(m);
    return () => m.stop();
  }, [cfg]);

  if (!cfg || !manager) {
    return (
      <Setup
        onConnect={(c) => {
          saveCfg(c);
          setCfg(c);
        }}
      />
    );
  }
  return (
    <Main
      manager={manager}
      onNewCfg={(c) => {
        if (c) saveCfg(c);
        else clearAll();
        setCfg(c);
      }}
    />
  );
}

type SetupMode = "loading" | "login" | "create" | "recover" | "showKey";

function Setup({ onConnect }: { onConnect: (c: Config) => void }) {
  const [mode, setMode] = useState<SetupMode>("loading");
  const [url, setUrl] = useState(DEFAULT_SERVER_URL);
  const [editUrl, setEditUrl] = useState(!DEFAULT_SERVER_URL);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [recovery, setRecovery] = useState("");
  const [recoveryInput, setRecoveryInput] = useState("");
  const [pendingKey, setPendingKey] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!url) return;
    api
      .health(url)
      .then((h) => setMode(h.initialized ? "login" : "create"))
      .catch(() => setMode("login"));
  }, [url]);

  const serverUrl = url.trim();

  async function login(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.pull({ serverUrl, token: password }, 0);
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

  return (
    <div className="center">
      <form
        className="card"
        onSubmit={mode === "login" ? login : mode === "create" ? create : mode === "recover" ? recover : (e) => e.preventDefault()}
      >
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

        {mode === "loading" && <p className="muted">Contacting your server…</p>}

        {mode === "login" && (
          <>
            <p className="muted">Your notes, on every device.</p>
            <label className="field">
              <span>Password</span>
              <input
                type="password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            {err && <p className="err">{err}</p>}
            <button className="primary big" disabled={busy || !password}>
              {busy ? "Checking…" : "Open my notes"}
            </button>
            <button type="button" className="linklike" onClick={() => { setErr(null); setMode("recover"); }}>
              Forgot password? Use your recovery key
            </button>
          </>
        )}

        {mode === "create" && (
          <>
            <p className="muted">First time here — choose your password.</p>
            <label className="field">
              <span>Password (8+ characters)</span>
              <input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <label className="field">
              <span>Repeat it</span>
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
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
              <input autoFocus value={recoveryInput} onChange={(e) => setRecoveryInput(e.target.value)} placeholder="xxxx-xxxx-xxxx" />
            </label>
            <label className="field">
              <span>New password (8+ characters)</span>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <label className="field">
              <span>Repeat it</span>
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </label>
            {err && <p className="err">{err}</p>}
            <button className="primary big" disabled={busy || !password || !recoveryInput}>
              {busy ? "Resetting…" : "Reset password"}
            </button>
            <button type="button" className="linklike" onClick={() => { setErr(null); setMode("login"); }}>
              Back to login
            </button>
          </>
        )}

        {mode === "showKey" && (
          <>
            <p className="muted">
              Almost done. This <b>recovery key</b> is the only way back in if you
              ever forget your password. Write it down somewhere safe.
            </p>
            <div className="keybox">{pendingKey}</div>
            <button
              className="primary big"
              onClick={() => onConnect({ serverUrl, token: password })}
            >
              I've saved it — open my notes
            </button>
          </>
        )}
      </form>
    </div>
  );
}

function Main({
  manager,
  onNewCfg,
}: {
  manager: SyncManager;
  onNewCfg: (c: Config | null) => void;
}) {
  useSyncExternalStore(manager.subscribe, () => manager.version);
  const [text, setText] = useState("");
  const [rem, setRem] = useState<string>("none");
  const [settings, setSettings] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const now = Date.now();
  const rows = rowsFor(manager);
  const status = syncStatus(manager.phase, manager.lastSync, now, manager.lastError);

  function submit(e: FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    const at = reminderAtFor(rem, Date.now());
    manager.mutate((s) => addNote(s, t, at, Date.now()).state);
    setText("");
    setRem("none");
  }

  return (
    <div className="app">
      <header>
        <h1>Pocketed</h1>
        <span className={"pill " + manager.phase}>{status}</span>
        <button className="icon" aria-label="Settings" onClick={() => setSettings(true)}>
          ⚙️
        </button>
      </header>

      <form className="composer" onSubmit={submit}>
        <input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="What should I remember?"
          maxLength={4000}
        />
        <select value={rem} onChange={(e) => setRem(e.target.value)} aria-label="Reminder">
          {REMINDER_CHOICES.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <button className="primary" disabled={!text.trim()}>
          Add
        </button>
      </form>

      <ul className="notes">
        {rows.length === 0 && (
          <li className="empty">
            Nothing yet.
            <br />
            Type something above and press Add — it appears on your phone too.
          </li>
        )}
        {rows.map((n) =>
          editing === n.id ? (
            <EditRow key={n.id} note={n} manager={manager} done={() => setEditing(null)} />
          ) : (
            <li key={n.id} className="note">
              <div className="text">{n.text}</div>
              <div className="meta">
                {shortAgo(n.updatedAt, now)}
                {reminderMeta(n, now) ? " · " + reminderMeta(n, now) : ""}
              </div>
              <div className="actions">
                <button className="icon" aria-label="Edit" onClick={() => setEditing(n.id)}>
                  ✏️
                </button>
                <button
                  className="icon"
                  aria-label="Delete"
                  onClick={() => {
                    if (confirm("Delete this note everywhere?")) {
                      manager.mutate((s) => deleteNote(s, n.id, Date.now()));
                    }
                  }}
                >
                  🗑️
                </button>
              </div>
            </li>
          ),
        )}
      </ul>

      {settings && (
        <Settings cfg={manager.cfg} onClose={() => setSettings(false)} onNewCfg={onNewCfg} />
      )}
    </div>
  );
}

function EditRow({
  note,
  manager,
  done,
}: {
  note: Note;
  manager: SyncManager;
  done: () => void;
}) {
  const [text, setText] = useState(note.text);
  return (
    <li className="note editing">
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} />
      <div className="row">
        <button
          className="primary"
          onClick={() => {
            manager.mutate((s) => editNote(s, note.id, text, note.reminderAt, Date.now()));
            done();
          }}
        >
          Save
        </button>
        <button onClick={done}>Cancel</button>
      </div>
    </li>
  );
}

function Settings({
  cfg,
  onClose,
  onNewCfg,
}: {
  cfg: Config;
  onClose: () => void;
  onNewCfg: (c: Config | null) => void;
}) {
  const [pw1, setPw1] = useState("");
  const [pw2, setPw2] = useState("");
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  const [pwErr, setPwErr] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [keyErr, setKeyErr] = useState<string | null>(null);

  async function changePw(e: FormEvent) {
    e.preventDefault();
    setPwErr(null);
    setPwMsg(null);
    const perr = passwordError(pw1);
    if (perr) return setPwErr(perr);
    if (pw1 !== pw2) return setPwErr("Passwords don't match.");
    try {
      await api.changePassword(cfg, pw1);
      setPwMsg("Password changed.");
      setPw1("");
      setPw2("");
      onNewCfg({ ...cfg, token: pw1 });
    } catch {
      setPwErr("Couldn't change it — are you still signed in?");
    }
  }

  async function rotateKey() {
    setKeyErr(null);
    const key = genRecovery();
    try {
      await api.rotateRecovery(cfg, key);
      setNewKey(key);
    } catch {
      setKeyErr("Couldn't update the recovery key.");
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="card modal" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>

        <form onSubmit={changePw}>
          <label className="field">
            <span>New password (8+ characters)</span>
            <input type="password" value={pw1} onChange={(e) => setPw1(e.target.value)} />
          </label>
          <label className="field">
            <span>Repeat it</span>
            <input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
          </label>
          {pwErr && <p className="err">{pwErr}</p>}
          {pwMsg && <p className="ok">{pwMsg}</p>}
          <button className="primary" disabled={!pw1}>
            Change password
          </button>
        </form>

        <hr />
        <p className="muted small">
          Recovery key — your only reset if the password is forgotten. Generating a
          new one invalidates the old one.
        </p>
        {newKey && (
          <>
            <div className="keybox">{newKey}</div>
            <p className="ok small">Write it down now — it won't be shown again.</p>
          </>
        )}
        {keyErr && <p className="err">{keyErr}</p>}
        <button onClick={rotateKey}>New recovery key</button>

        <hr />
        <button
          className="danger"
          onClick={() => {
            if (confirm("Sign out and remove notes from this device?")) onNewCfg(null);
          }}
        >
          Sign out & erase this device
        </button>
      </div>
    </div>
  );
}
