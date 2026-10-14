import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { CALENDAR_ALERT_BEFORE_MINUTES, CALENDAR_WINDOW_DAYS } from "@pocketed/shared";
import { api, ApiError, type CalendarStatus } from "../api";
import {
  CALENDAR_STATE_EVENT, disconnectCalendarNow, importCalendarNow, importedCount,
  loadCalendarState, noteCalendarConnected, type ImportCounts,
} from "../calendar-import";
import { takeGoogleReturn } from "../google-return";
import type { SyncManager } from "../store";
import { CalendarAccounts } from "./CalendarAccounts";

function changes(c: ImportCounts): string {
  const parts = [c.added ? `${c.added} added` : "", c.updated ? `${c.updated} updated` : "",
    c.removed ? `${c.removed} removed` : "", c.restored ? `${c.restored} brought back` : ""].filter(Boolean);
  return (parts.length ? parts.join(", ") + "." : "No changes.") +
    (c.kept ? ` ${c.kept} reminders kept because this check couldn't vouch for the whole calendar.` : "");
}

function checked(at: number | null): string {
  if (!at) return "not checked on this device yet";
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  return minutes < 1 ? "checked just now" : minutes < 60 ? `checked ${minutes} min ago` : `checked ${new Date(at).toLocaleString()}`;
}

function explanation(e: unknown): string {
  return e instanceof ApiError && e.detail ? e.detail : e instanceof Error ? e.message : "Couldn't reach Google Calendar. Are you online?";
}

export function GoogleCalendar({ manager }: { manager: SyncManager }) {
  useSyncExternalStore(manager.subscribe, () => manager.version, () => manager.version);
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [local, setLocal] = useState(() => loadCalendarState());
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [showLink, setShowLink] = useState(false);
  const googleReturn = useRef<ReturnType<typeof takeGoogleReturn>>(null);

  async function refresh() {
    const value = await api.calendarStatus(manager.cfg);
    if (manager.isStopped) return;
    if (value.accounts) manager.setCalendarAccounts(value.accounts, value.accountsRevision);
    setStatus(value);
  }

  useEffect(() => {
    let alive = true;
    api.calendarStatus(manager.cfg).then((value) => {
      if (!alive || manager.isStopped) return;
      if (value.accounts) manager.setCalendarAccounts(value.accounts, value.accountsRevision);
      setStatus(value);
    }, (e) => alive && setError(e instanceof ApiError && e.status === 404
      ? "The sync server needs updating before calendar connections work."
      : explanation(e)));
    return () => { alive = false; };
  }, [manager]);

  useEffect(() => {
    const update = () => setLocal(loadCalendarState());
    window.addEventListener(CALENDAR_STATE_EVENT, update);
    window.addEventListener("storage", update);
    return () => { window.removeEventListener(CALENDAR_STATE_EVENT, update); window.removeEventListener("storage", update); };
  }, []);

  useEffect(() => {
    googleReturn.current ??= takeGoogleReturn();
    const result = googleReturn.current;
    if (!result) return;
    if (!result.ok) { setError(result.message); googleReturn.current = null; return; }
    let alive = true;
    noteCalendarConnected(result.accountId);
    setBusy("callback");
    setMessage("Connected to Google Calendar. Importing events…");
    void (async () => {
      try {
        const counts = await importCalendarNow(manager, result.accountId);
        if (alive) setMessage(`Connected. ${changes(counts)}`);
      } catch (e) {
        if (alive) { setMessage(null); setError(explanation(e)); }
      }
      if (!alive) return;
      googleReturn.current = null;
      setBusy(null);
      setLocal(loadCalendarState());
      await refresh().catch(() => {});
    })();
    return () => { alive = false; };
  }, [manager]);

  async function signIn() {
    setBusy("signin"); setError(null); setMessage(null);
    try {
      const { url: consent } = await api.startGoogleSignIn(manager.cfg, window.location.origin + window.location.pathname);
      if (!manager.isStopped) window.location.assign(consent);
    } catch (e) { setError(explanation(e)); setBusy(null); }
  }

  async function checkNow(accountId?: string) {
    setBusy(accountId ?? "link"); setError(null); setMessage(null);
    try { setMessage(`Checked. ${changes(await importCalendarNow(manager, accountId))}`); }
    catch (e) { setError(explanation(e)); }
    setLocal(loadCalendarState());
    await refresh().catch(() => {});
    setBusy(null);
  }

  async function disconnect(accountId?: string, email?: string | null) {
    if (!confirm(`Disconnect ${email ?? "this calendar link"}? Only its Calendar event reminders will be removed from all devices. Classroom assignments and other accounts will stay.`)) return;
    setBusy(accountId ?? "link"); setError(null); setMessage(null);
    try { setStatus(await disconnectCalendarNow(manager, accountId)); setMessage("Disconnected this calendar. Other accounts and Classroom were kept."); }
    catch (e) { setError(explanation(e)); }
    setLocal(loadCalendarState());
    setBusy(null);
  }

  async function connectLink(event: FormEvent) {
    event.preventDefault();
    const replacing = !!(manager.state.calendarAccounts?.length);
    if (replacing && !confirm("A secret calendar link replaces ALL connected Google Calendar accounts and removes their imported events. Classroom assignments and handmade notes stay. Continue?")) return;
    setBusy("link"); setError(null); setMessage(null);
    try {
      const value = await api.connectCalendar(manager.cfg, url.trim(), replacing);
      if (manager.isStopped) return;
      if (value.accounts) manager.setCalendarAccounts(value.accounts, value.accountsRevision);
      setStatus(value); setUrl(""); setShowLink(false); noteCalendarConnected();
      setMessage(`Connected the calendar link. ${changes(await importCalendarNow(manager))}`);
    } catch (e) { setError(explanation(e)); }
    setLocal(loadCalendarState());
    setBusy(null);
  }

  const accounts = manager.state.calendarAccounts ?? status?.accounts ?? [];
  const link = status?.mode === "ical" && !accounts.length;

  return (
    <section aria-labelledby="google-calendar-heading">
      <h3 id="google-calendar-heading">Google Calendar</h3>
      <p className="muted small">
        Connect school and home accounts together. Each imports its readable calendars, including shared and subscribed calendars,
        with their colours. Adding an account never replaces another; choosing an existing account reconnects just that account.
      </p>
      <p className="muted small">
        Read-only. Events for the next {CALENDAR_WINDOW_DAYS} days, with alerts {CALENDAR_ALERT_BEFORE_MINUTES} min before and at the start.
        All-day events alert at 9:00. Checks every 15 minutes while Pocketed is open.
      </p>
      {!status && !error && <p className="muted small" role="status">Loading calendar connections…</p>}
      <CalendarAccounts manager={manager} />
      {accounts.map((account) => {
        const state = loadCalendarState(account.id);
        return (
          <div className="account-card" key={account.id}>
            <p className="ok small"><strong>✓ {account.email ?? "Google account"}</strong></p>
            <p className="muted small">{importedCount(manager.state, account.id, account.legacyIds)} upcoming events · {checked(state.lastCheck)}</p>
            {(account.problem || state.lastError) && <p className="err small" role="alert">{account.problem || state.lastError}</p>}
            <div className="row-buttons">
              <button type="button" disabled={busy !== null} onClick={() => void checkNow(account.id)}>{busy === account.id ? "Working…" : "Check now"}</button>
              {status?.googleAvailable && <button type="button" disabled={busy !== null} onClick={() => void signIn()}>Reconnect</button>}
              <button type="button" className="danger" disabled={busy !== null} onClick={() => void disconnect(account.id, account.email)}>Disconnect account</button>
            </div>
          </div>
        );
      })}
      {status?.googleAvailable && <button type="button" className="primary" disabled={busy !== null} onClick={() => void signIn()}>
        {busy === "signin" ? "Opening Google…" : accounts.length ? "Add Google Calendar account" : "Sign in with Google"}
      </button>}
      {status?.mode === "google" && !status.accounts && <p className="err small">Update the sync server to enable multiple accounts and calendar switches.</p>}
      {link && <div className="account-card">
        <p className="ok small">✓ Calendar link connected · {status?.feed}</p>
        <p className="muted small">{checked(local.lastCheck)}</p>
        <div className="row-buttons">
          <button type="button" disabled={busy !== null} onClick={() => void checkNow()}>Check now</button>
          <button type="button" className="danger" disabled={busy !== null} onClick={() => void disconnect()}>Disconnect calendar link</button>
        </div>
      </div>}
      {status && <>
        <button type="button" className="linklike" disabled={busy !== null} aria-expanded={showLink} onClick={() => setShowLink((v) => !v)}>
          {showLink ? "Hide secret link settings" : "Use a secret link instead (one calendar, no colours)"}
        </button>
        {(showLink || (!status.googleAvailable && !status.connected)) && <form onSubmit={connectLink}>
          <p className="muted small">In Google Calendar on a computer: Settings → your calendar → Integrate calendar → Secret address in iCal format. Treat the link like a password.</p>
          {accounts.length > 0 && <p className="err small">Connecting a secret link replaces all Calendar accounts, not Classroom.</p>}
          <label className="field"><span>Secret address in iCal format</span>
            <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} autoComplete="off" spellCheck={false}
              placeholder="https://calendar.google.com/calendar/ical/…/private-…/basic.ics" />
          </label>
          <button type="submit" className="primary" disabled={!url.trim() || busy !== null}>Connect calendar link</button>
        </form>}
      </>}
      {local.lastError && <p className="err small" role="alert">Last check: {local.lastError}</p>}
      {error && <p className="err small" role="alert">{error}</p>}
      {message && <p className="ok small" role="status">{message}</p>}
    </section>
  );
}
