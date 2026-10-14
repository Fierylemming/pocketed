import { useState, useSyncExternalStore } from "react";
import { api, ApiError } from "../api";
import type { SyncManager } from "../store";

/** Shared by Settings and the calendar; preferences live on the server. */
export function CalendarAccounts({ manager }: { manager: SyncManager }) {
  useSyncExternalStore(manager.subscribe, () => manager.version, () => manager.version);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const accounts = manager.state.calendarAccounts ?? [];
  if (!accounts.length) return null;

  async function toggle(id: string, visible: boolean) {
    setBusy(id);
    setError(null);
    try {
      const status = await api.setCalendarVisibility(manager.cfg, id, visible);
      if (status.accounts) manager.setCalendarAccounts(status.accounts, status.accountsRevision);
    } catch (e) {
      setError(e instanceof ApiError && e.detail ? e.detail : "Couldn't save the calendar choice. Connect to the internet and try again.");
    } finally { setBusy(null); }
  }

  return (
    <div className="account-filter" role="group" aria-label="Google Calendar account visibility">
      <p className="small"><strong>Show Calendar events from</strong></p>
      <div className="account-switches">
        {accounts.map((account) => (
          <label className={"account-switch" + (account.visible ? "" : " is-hidden")} key={account.id}>
            <input type="checkbox" checked={account.visible} disabled={busy !== null}
              onChange={(e) => void toggle(account.id, e.target.checked)} />
            <span>{account.email ?? "Google account"}</span>
            <span className="muted small">{busy === account.id ? "Saving…" : account.visible ? "On" : "Off"}</span>
          </label>
        ))}
      </div>
      <p className="muted small">
        Calendar view only, across all your devices. Classroom assignments always stay visible.
        Hidden events keep syncing; reminder lists and alerts are unchanged. Nothing is deleted.
      </p>
      {error && <p className="err small" role="alert">{error}</p>}
    </div>
  );
}
