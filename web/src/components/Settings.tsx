import { useEffect, useState, type FormEvent } from "react";
import {
  CALENDAR_ALERT_BEFORE_MINUTES,
  CALENDAR_WINDOW_DAYS,
  genRecovery,
  passwordError,
} from "@pocketed/shared";
import { api, ApiError, type CalendarStatus } from "../api";
import {
  importCalendarNow,
  importedCount,
  loadCalendarState,
  noteCalendarConnected,
  NotConnectedError,
  removeImported,
  type ImportCounts,
  type LocalCalendarState,
} from "../calendar-import";
import { takeGoogleReturn } from "../google-return";
import type { SyncManager } from "../store";
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
  manager,
  onClose,
  onNewCfg,
}: {
  cfg: Config;
  manager: SyncManager;
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
        <GoogleCalendar manager={manager} />
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

function ago(ts: number, now = Date.now()): string {
  const m = Math.max(0, Math.round((now - ts) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  return new Date(ts).toLocaleString();
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function changes(r: ImportCounts): string {
  const parts = [
    r.added ? `${r.added} added` : "",
    r.updated ? `${r.updated} updated` : "",
    r.removed ? `${r.removed} removed` : "",
    r.restored ? `${r.restored} brought back` : "",
  ].filter(Boolean);
  // A check that couldn't see the whole calendar says so, rather than looking
  // as if events had merely been deleted.
  const kept = r.kept
    ? ` ${plural(r.kept, "reminder")} left as ${r.kept === 1 ? "it was" : "they were"} — this check couldn't see the whole calendar.`
    : "";
  return (parts.length ? parts.join(", ") + "." : "No changes.") + kept;
}

function GoogleCalendar({ manager }: { manager: SyncManager }) {
  const cfg = manager.cfg;
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [local, setLocal] = useState<LocalCalendarState>(() => loadCalendarState());
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<null | "connect" | "google" | "sync" | "disconnect">(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [showLink, setShowLink] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .calendarStatus(cfg)
      .then((s) => alive && setStatus(s))
      .catch((e) => {
        if (!alive) return;
        setLoadErr(
          e instanceof ApiError && e.status === 404
            ? "The sync server needs updating before this works (merge to main to redeploy)."
            : "Couldn't load the calendar settings. Are you online?",
        );
      });
    return () => {
      alive = false;
    };
  }, [cfg]);

  // Back from Google's sign-in page: report, then import straight away.
  useEffect(() => {
    const ret = takeGoogleReturn();
    if (!ret) return;
    if (!ret.ok) {
      setErr(ret.message);
      return;
    }
    noteCalendarConnected();
    setBusy("google");
    setMsg("Signed in with Google. Importing your events…");
    void (async () => {
      try {
        const r = await importCalendarNow(manager);
        const restored = r.restored ? ` ${plural(r.restored, "reminder")} brought back.` : "";
        setMsg(
          `Signed in with Google. ${plural(r.added + r.updated, "event")} imported with their colours.${restored}`,
        );
      } catch (e2) {
        setMsg(null);
        setErr(e2 instanceof Error ? e2.message : "Signed in, but the first import failed.");
      }
      setLocal(loadCalendarState());
      setBusy(null);
      api.calendarStatus(cfg).then(setStatus, () => {});
    })();
  }, [manager, cfg]);

  const refreshLocal = () => setLocal(loadCalendarState());

  async function connect(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setMsg(null);
    setBusy("connect");
    try {
      setStatus(await api.connectCalendar(cfg, url.trim()));
      noteCalendarConnected();
      setUrl("");
      setReplacing(false);
      setShowLink(false);
      try {
        const r = await importCalendarNow(manager);
        const restored = r.restored ? ` ${plural(r.restored, "reminder")} brought back.` : "";
        setMsg(`Connected. ${plural(r.added + r.updated, "event")} imported.${restored}`);
      } catch (e2) {
        setErr(e2 instanceof Error ? e2.message : "Connected, but the first import failed.");
      }
    } catch (e2) {
      setErr(e2 instanceof ApiError && e2.detail ? e2.detail : "Couldn't connect. Are you online?");
    }
    refreshLocal();
    setBusy(null);
  }

  /** Leaves Pocketed for Google's consent page; Google sends the browser back here. */
  async function signInWithGoogle() {
    setErr(null);
    setMsg(null);
    setBusy("google");
    try {
      const returnUrl = window.location.origin + window.location.pathname;
      const { url: googleUrl } = await api.startGoogleSignIn(cfg, returnUrl);
      window.location.assign(googleUrl);
    } catch (e2) {
      setErr(
        e2 instanceof ApiError && e2.detail ? e2.detail : "Couldn't start Google sign-in. Are you online?",
      );
      setBusy(null);
    }
  }

  async function checkNow() {
    setErr(null);
    setMsg(null);
    setBusy("sync");
    try {
      setMsg(`Checked. ${changes(await importCalendarNow(manager))}`);
    } catch (e2) {
      if (e2 instanceof NotConnectedError) setStatus((s) => (s ? { ...s, connected: false } : s));
      else setErr(e2 instanceof Error ? e2.message : "Couldn't check the calendar.");
    }
    refreshLocal();
    setBusy(null);
  }

  async function disconnect() {
    if (
      !confirm(
        "Disconnect Google Calendar? Reminders imported from it will be removed from all devices.",
      )
    ) {
      return;
    }
    setErr(null);
    setMsg(null);
    setBusy("disconnect");
    try {
      setStatus(await api.disconnectCalendar(cfg));
      const removed = removeImported(manager);
      setMsg(`Disconnected. ${plural(removed, "reminder")} removed.`);
    } catch {
      setErr("Couldn't disconnect. Are you online?");
    }
    refreshLocal();
    setBusy(null);
  }

  const lead = CALENDAR_ALERT_BEFORE_MINUTES;
  const days = CALENDAR_WINDOW_DAYS;
  const imported = importedCount(manager.state);
  const googleAvailable = !!status?.googleAvailable;

  const googleButton = (label: string, primary = true) => (
    <button
      type="button"
      className={primary ? "primary" : undefined}
      onClick={signInWithGoogle}
      disabled={busy !== null}
    >
      {busy === "google" ? "Opening Google…" : label}
    </button>
  );

  const form = (
    <form onSubmit={connect}>
      <label className="field">
        <span>Secret address in iCal format</span>
        <input
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://calendar.google.com/calendar/ical/…/private-…/basic.ics"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>
      <button
        type="button"
        className="linklike"
        onClick={() => setShowHelp((v) => !v)}
        aria-expanded={showHelp}
      >
        {showHelp ? "Hide steps" : "Where do I find this?"}
      </button>
      {showHelp && (
        <ol className="muted small calendar-steps">
          <li>
            Open <b>calendar.google.com</b> on a computer (the phone app doesn't show it).
          </li>
          <li>
            ⚙️ <b>Settings</b> → under <b>Settings for my calendars</b>, click your calendar.
          </li>
          <li>
            Scroll to <b>Integrate calendar</b> and copy <b>Secret address in iCal format</b>.
          </li>
          <li>Paste it here. Treat it like a password: anyone with it can read that calendar.</li>
        </ol>
      )}
      <div className="row-buttons">
        <button className="primary" disabled={!url.trim() || busy !== null}>
          {busy === "connect" ? "Connecting…" : "Connect"}
        </button>
        {(replacing || showLink) && (
          <button
            type="button"
            onClick={() => {
              setReplacing(false);
              setShowLink(false);
            }}
            disabled={busy !== null}
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );

  return (
    <section>
      <h3>Google Calendar</h3>
      {loadErr && <p className="err small">{loadErr}</p>}
      {!status && !loadErr && <p className="muted small">Loading…</p>}

      {status && !status.connected && (
        <>
          <p className="muted small">
            Adds your events for the next {days} days as reminders, with an alert {lead} minutes
            before and another when they start. All-day events alert at 9:00. Pocketed checks for
            changes every 15 minutes while it's open.
          </p>
          {googleAvailable ? (
            <>
              <p className="muted small">
                Signing in with Google imports all calendars on your account that you can read,
                including shared and subscribed calendars, with their colours. Pocketed can only
                read your calendars, never change them.
              </p>
              {showLink ? (
                form
              ) : (
                <div className="row-buttons">
                  {googleButton("Sign in with Google")}
                  <button
                    type="button"
                    className="linklike"
                    onClick={() => setShowLink(true)}
                    disabled={busy !== null}
                  >
                    Use a secret link instead (no colours)
                  </button>
                </div>
              )}
            </>
          ) : (
            <>
              {form}
              <p className="muted small">
                Event colours need “Sign in with Google”, which the server owner can turn on (see
                SETUP.md).
              </p>
            </>
          )}
        </>
      )}

      {status?.connected && (
        <>
          <p className="ok small">
            ✓ Connected
            {status.mode === "google"
              ? ` as ${status.feed ?? "your Google account"} · colours from Google`
              : status.feed
                ? ` · ${status.feed}`
                : ""}
          </p>
          {status.mode === "google" && (
            <p className="muted small">
              Importing all readable calendars, including shared, subscribed and hidden calendars.
              Events without their own colour use their calendar's colour.
            </p>
          )}
          <p className="muted small">
            {plural(imported, "upcoming event")} · alerts {lead} min before and at the start ·{" "}
            {local.lastCheck ? `checked ${ago(local.lastCheck)}` : "not checked on this device yet"}
          </p>
          <p className="muted small">
            A check only ever removes a reminder for an event the calendar reports as cancelled, or
            one that has already started and is no longer on the calendar. If it can't see the whole
            calendar, it changes nothing.
          </p>
          {status.problem ? (
            <>
              <p className="err small">{status.problem}</p>
              <div className="row-buttons">{googleButton("Sign in with Google again")}</div>
            </>
          ) : (
            local.lastError && <p className="err small">Last check failed: {local.lastError}</p>
          )}
          {status.mode !== "google" && googleAvailable && !replacing && (
            <p className="muted small">
              Want all your calendars and their colours? Sign in with Google instead.
              Existing reminders from your primary calendar are kept and recoloured.
            </p>
          )}
          {replacing ? (
            form
          ) : (
            <div className="row-buttons">
              <button onClick={checkNow} disabled={busy !== null}>
                {busy === "sync" ? "Checking…" : "Check now"}
              </button>
              {status.mode === "google" ? null : (
                <>
                  {googleAvailable && googleButton("Sign in with Google", false)}
                  <button onClick={() => setReplacing(true)} disabled={busy !== null}>
                    Change link
                  </button>
                </>
              )}
              <button className="danger" onClick={disconnect} disabled={busy !== null}>
                {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
              </button>
            </div>
          )}
        </>
      )}

      {err && <p className="err small">{err}</p>}
      {msg && <p className="ok small">{msg}</p>}
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
