import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  CALENDAR_ALERT_BEFORE_MINUTES,
  CLASSROOM_OVERDUE_DAYS,
  CLASSROOM_WINDOW_DAYS,
} from "@pocketed/shared";
import { api, ApiError, type ClassroomStatus } from "../api";
import {
  CLASSROOM_STATE_EVENT,
  classroomImportedCount,
  disconnectClassroomNow,
  importClassroomNow,
  loadClassroomState,
  noteClassroomConnected,
  type ClassroomImportCounts,
} from "../classroom-import";
import { takeGoogleReturn } from "../google-return";
import type { SyncManager } from "../store";

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function classroomChanges(counts: ClassroomImportCounts): string {
  const changes = [
    counts.added ? `${counts.added} added` : "",
    counts.updated ? `${counts.updated} updated` : "",
    counts.removed ? `${counts.removed} removed` : "",
  ].filter(Boolean);
  const notes = [
    counts.undated ? `${plural(counts.undated, "item")} without a due date left off the calendar.` : "",
    counts.invalid ? `${plural(counts.invalid, "deadline")} couldn't be read; any existing reminders were kept.` : "",
    counts.capped ? `${plural(counts.capped, "assignment")} left out by the import limit.` : "",
  ].filter(Boolean);
  return [changes.length ? changes.join(", ") + "." : "No changes.", ...notes].join(" ");
}

function checkedAgo(at: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return new Date(at).toLocaleString();
}

function explanation(e: unknown, fallback: string): string {
  return e instanceof ApiError && e.detail ? e.detail : e instanceof Error ? e.message : fallback;
}

export function GoogleClassroom({ manager }: { manager: SyncManager }) {
  useSyncExternalStore(manager.subscribe, () => manager.version, () => manager.version);
  const cfg = manager.cfg;
  const [status, setStatus] = useState<ClassroomStatus | null>(null);
  const [local, setLocal] = useState(() => loadClassroomState());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Retain the outcome across React StrictMode's effect setup/cleanup replay.
  const googleReturn = useRef<ReturnType<typeof takeGoogleReturn>>(null);

  useEffect(() => {
    let alive = true;
    api.classroomStatus(cfg).then(
      (value) => alive && setStatus(value),
      (e) => alive && setLoadError(e instanceof ApiError && e.status === 404
        ? "The sync server needs updating before Classroom works (merge to main to redeploy)."
        : explanation(e, "Couldn't load Classroom settings. Are you online?")),
    );
    return () => { alive = false; };
  }, [cfg]);

  useEffect(() => {
    const refresh = () => {
      const next = loadClassroomState();
      setLocal(next);
      void api.classroomStatus(cfg).then((value) => !manager.isStopped && setStatus(value), () => {});
    };
    window.addEventListener(CLASSROOM_STATE_EVENT, refresh);
    // Automatic checks in another tab should also update these settings.
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(CLASSROOM_STATE_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [manager, cfg]);

  useEffect(() => {
    googleReturn.current ??= takeGoogleReturn("classroom");
    const result = googleReturn.current;
    if (!result) return;
    if (!result.ok) {
      setError(result.message);
      googleReturn.current = null;
      return;
    }
    let alive = true;
    noteClassroomConnected(result.accountId);
    setBusy("check");
    setMessage("Connected to Google Classroom. Importing assignment deadlines…");
    void (async () => {
      try {
        const counts = await importClassroomNow(manager, result.accountId);
        if (alive) setMessage(`Connected. ${classroomChanges(counts)}`);
      } catch (e) {
        if (alive) {
          setMessage(null);
          setError(explanation(e, "Connected, but the first assignment check failed."));
        }
      }
      if (!alive) return;
      googleReturn.current = null;
      setLocal(loadClassroomState());
      setBusy(null);
      api.classroomStatus(cfg).then((value) => alive && setStatus(value), () => {});
    })();
    return () => { alive = false; };
  }, [manager, cfg]);

  async function connect() {
    setError(null);
    setMessage(null);
    setBusy("connect");
    try {
      const returnUrl = window.location.origin + window.location.pathname;
      const { url } = await api.startClassroomSignIn(cfg, returnUrl);
      if (!manager.isStopped) window.location.assign(url);
    } catch (e) {
      setError(explanation(e, "Couldn't start the Classroom connection. Are you online?"));
      setBusy(null);
    }
  }

  async function checkNow(accountId: string) {
    setError(null);
    setMessage(null);
    setBusy(accountId);
    try {
      setMessage(`Checked. ${classroomChanges(await importClassroomNow(manager, accountId))}`);
    } catch (e) {
      setError(explanation(e, "Couldn't check Classroom."));
    }
    setLocal(loadClassroomState());
    await api.classroomStatus(cfg).then((value) => !manager.isStopped && setStatus(value), () => {});
    setBusy(null);
  }

  async function disconnect(accountId: string, email: string | null) {
    if (!confirm(`Disconnect Classroom for ${email ?? "this account"}? Only this account's Classroom reminders will be removed from all devices. Other accounts, notes and Calendar events stay.`)) return;
    setError(null);
    setMessage(null);
    setBusy(accountId);
    try {
      const result = await disconnectClassroomNow(manager, accountId);
      setStatus(result);
      setMessage(`Disconnected. ${plural(result.removed, "imported reminder")} removed.`);
    } catch (e) {
      setError(explanation(e, "Couldn't disconnect Classroom. Are you online?"));
    }
    setLocal(loadClassroomState());
    await api.classroomStatus(cfg).then((value) => !manager.isStopped && setStatus(value), () => {});
    setBusy(null);
  }

  const accounts = status?.accounts ?? [];
  return (
    <section aria-labelledby="classroom-heading">
      <h3 id="classroom-heading">Google Classroom</h3>
      <p className="muted small">
        Adds published assignment and question deadlines from your active student classes to Pocketed's calendar.
        Connect multiple student accounts without replacing one another. Separate from Google Calendar — hiding school Calendar events never hides Classroom assignments.
      </p>
      <p className="muted small">
        New assignments for the next {CLASSROOM_WINDOW_DAYS} days, plus work due in the last {CLASSROOM_OVERDUE_DAYS} days.
        Default alerts are {CALENDAR_ALERT_BEFORE_MINUTES} min before and when due. Checks every 15 minutes while the app is open.
      </p>
      <p className="muted small">
        Read-only: Pocketed never submits work or changes Classroom. Submission status and grades aren't imported;
        mark reminders done in Pocketed yourself. Items without a due date cannot appear on the calendar.
      </p>

      {!status && !loadError && <p className="muted small" role="status">Loading Classroom connection…</p>}
      {loadError && <p className="err small" role="alert">{loadError}</p>}

      {accounts.map((account) => {
        const accountLocal = loadClassroomState(account.id);
        const problem = account.problem || accountLocal.lastError;
        return (
          <div className="account-card" key={account.id}>
            <p className="ok small"><strong>✓ Connected as {account.email ?? "your Google account"}</strong></p>
            <p className="muted small">
              {plural(classroomImportedCount(manager.state, account.id, account.legacyNotes), "scheduled assignment")} ·{" "}
              {accountLocal.lastCheck ? `checked ${checkedAgo(accountLocal.lastCheck)}` : "not checked on this device yet"}
            </p>
            {accountLocal.lastCounts && <p className="muted small">Last check: {classroomChanges(accountLocal.lastCounts)}</p>}
            {problem && <p className="err small" role="alert">{problem}</p>}
            <div className="row-buttons">
              <button type="button" onClick={() => void checkNow(account.id)} disabled={busy !== null}>
                {busy === account.id ? "Working…" : "Check now"}
              </button>
              {status?.googleAvailable && <button type="button" onClick={connect} disabled={busy !== null}>Reconnect</button>}
              <button type="button" className="danger" onClick={() => void disconnect(account.id, account.email)} disabled={busy !== null}>
                Disconnect Classroom
              </button>
            </div>
          </div>
        );
      })}
      {status?.googleAvailable && <button type="button" className="primary" onClick={connect} disabled={busy !== null}>
        {busy === "connect" ? "Opening Google…" : accounts.length ? "Add Classroom account" : "Connect Google Classroom"}
      </button>}
      {status && !status.googleAvailable && <p className="muted small">The server owner needs to configure Google OAuth first (see SETUP.md, Classroom setup).</p>}
      {status?.connected && !status.accounts && <p className="err small">Update the sync server to enable multiple Classroom accounts.</p>}
      {local.lastError && <p className="err small" role="alert">Last check: {local.lastError}</p>}
      <p className="muted small">
        The Google Classroom API must be enabled in the server owner's Google Cloud project. Your school may need to approve Pocketed.
        A parent's guardian account cannot read the student's assignments; connect the student's own account.
      </p>
      {error && <p className="err small" role="alert">{error}</p>}
      {message && <p className="ok small" role="status">{message}</p>}
    </section>
  );
}
