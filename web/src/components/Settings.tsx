import { useEffect, useState, type FormEvent } from "react";
import { genRecovery, passwordError } from "@pocketed/shared";
import { api } from "../api";
import type { Config } from "../config";
import { alertState, requestAlerts, type AlertState } from "../alerts";
import { getTextSize, setTextSize, type TextSize } from "../scale";
import {
  canPromptInstall,
  isInstalled,
  isIosSafari,
  onInstallChange,
  promptInstall,
} from "../install";

export function Settings({
  cfg,
  onClose,
  onNewCfg,
}: {
  cfg: Config;
  onClose: () => void;
  onNewCfg: (c: Config | null) => void;
}) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="card modal" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>

        <TextSizePicker />
        <hr />
        <Alerts />
        <hr />
        <InstallApp />
        <hr />
        <ChangePassword cfg={cfg} onNewCfg={onNewCfg} />
        <hr />
        <RecoveryKey cfg={cfg} />
        <hr />

        <button
          className="danger"
          onClick={() => {
            if (confirm("Sign out and remove notes from this device?")) onNewCfg(null);
          }}
        >
          Sign out & erase this device
        </button>
        <button className="linklike done" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

function TextSizePicker() {
  const [size, setSize] = useState<TextSize>(() => getTextSize());
  const options: { id: TextSize; label: string }[] = [
    { id: "small", label: "Smaller" },
    { id: "default", label: "Standard" },
    { id: "large", label: "Larger" },
  ];
  return (
    <section>
      <h3>Text size</h3>
      <p className="muted small">Scales the whole app. Phones also fit themselves automatically.</p>
      <div className="segmented" role="radiogroup" aria-label="Text size">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={size === o.id}
            className={size === o.id ? "active" : ""}
            onClick={() => {
              setSize(o.id);
              setTextSize(o.id);
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
    </section>
  );
}

function Alerts() {
  const [state, setState] = useState<AlertState>(() => alertState());
  const [busy, setBusy] = useState(false);

  async function turnOn() {
    setBusy(true);
    setState(await requestAlerts());
    setBusy(false);
  }

  return (
    <section>
      <h3>Reminder alerts</h3>
      {state === "granted" && (
        <p className="ok small">On. You'll get a notification when a reminder is due.</p>
      )}
      {state === "default" && (
        <>
          <p className="muted small">
            Get a notification when a reminder is due. Works while the app is open or in the
            background.
          </p>
          <button className="primary" onClick={turnOn} disabled={busy}>
            {busy ? "Asking…" : "Turn on alerts"}
          </button>
        </>
      )}
      {state === "denied" && (
        <p className="err small">
          Blocked in your browser. Allow notifications for this site in the browser's site settings,
          then reload.
        </p>
      )}
      {state === "unsupported" && (
        <p className="muted small">This browser can't show notifications.</p>
      )}
    </section>
  );
}

function InstallApp() {
  const [, bump] = useState(0);
  useEffect(() => onInstallChange(() => bump((n) => n + 1)), []);

  if (isInstalled()) {
    return (
      <section>
        <h3>Install the app</h3>
        <p className="ok small">✓ Installed. Open Pocketed from your home screen.</p>
      </section>
    );
  }
  return (
    <section>
      <h3>Install the app</h3>
      {canPromptInstall() ? (
        <>
          <p className="muted small">Add Pocketed to your home screen — it opens full-screen like an app.</p>
          <button className="primary" onClick={() => void promptInstall()}>
            Install Pocketed
          </button>
        </>
      ) : isIosSafari() ? (
        <p className="muted small">
          Tap the Share button, then <b>Add to Home Screen</b>.
        </p>
      ) : (
        <p className="muted small">
          Open your browser menu and choose <b>Install app</b> or <b>Add to Home screen</b>.
        </p>
      )}
    </section>
  );
}

function ChangePassword({ cfg, onNewCfg }: { cfg: Config; onNewCfg: (c: Config | null) => void }) {
  const [pw1, setPw1] = useState("");
  const [pw2, setPw2] = useState("");
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  const [pwErr, setPwErr] = useState<string | null>(null);

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

  return (
    <section>
      <h3>Password</h3>
      <form onSubmit={changePw}>
        <label className="field">
          <span>New password (8+ characters)</span>
          <input type="password" autoComplete="new-password" value={pw1} onChange={(e) => setPw1(e.target.value)} />
        </label>
        <label className="field">
          <span>Repeat it</span>
          <input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
        </label>
        {pwErr && <p className="err">{pwErr}</p>}
        {pwMsg && <p className="ok">{pwMsg}</p>}
        <button className="primary" disabled={!pw1}>
          Change password
        </button>
      </form>
    </section>
  );
}

function RecoveryKey({ cfg }: { cfg: Config }) {
  const [newKey, setNewKey] = useState<string | null>(null);
  const [keyErr, setKeyErr] = useState<string | null>(null);

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
    <section>
      <h3>Recovery key</h3>
      <p className="muted small">
        Your only reset if the password is forgotten. Generating a new one invalidates the old one.
      </p>
      {newKey && (
        <>
          <div className="keybox">{newKey}</div>
          <p className="ok small">Write it down now — it won't be shown again.</p>
        </>
      )}
      {keyErr && <p className="err">{keyErr}</p>}
      <button onClick={rotateKey}>New recovery key</button>
    </section>
  );
}
