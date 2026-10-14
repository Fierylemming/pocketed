// Each Calendar account imports independently. Hidden accounts still sync;
// visibility is a separate, server-owned view preference, never a deletion.

import {
  CALENDAR_WINDOW_DAYS,
  calendarAccountOwns,
  googleCancelledKeys,
  googleFeedToCalendarEvents,
  MAX_IMPORTED_EVENTS,
  reconcileCalendar,
  removeImportedReminders,
  type CalendarAccountSummary,
  type CalendarEvent,
  type ReconcileOptions,
  type SyncState,
} from "@pocketed/shared";
import { api, ApiError, type CalendarStatus } from "./api";
import { AccountImportQueue, assertImportActive, syncBeforeImport } from "./account-import-queue";
import type { SyncManager } from "./store";

const KEY = "pocketed.v2.calendar";
export const CALENDAR_STATE_EVENT = "pocketed:calendar-state";
const MIN = 60_000;
const EVERY_VISIBLE = 15 * MIN;
const EVERY_HIDDEN = 60 * MIN;

export interface ImportCounts {
  added: number;
  updated: number;
  removed: number;
  restored: number;
  kept: number;
}

export interface LocalCalendarState {
  connected: boolean | null;
  lastCheck: number | null;
  lastError: string | null;
  lastCounts: ImportCounts | null;
  source: "google" | "link" | null;
  accounts?: Record<string, LocalCalendarState>;
}

const empty: LocalCalendarState = { connected: null, lastCheck: null, lastError: null, lastCounts: null, source: null };
const noChanges = (): ImportCounts => ({ added: 0, updated: 0, removed: 0, restored: 0, kept: 0 });

export function loadCalendarState(accountId?: string): LocalCalendarState {
  try {
    const raw = localStorage.getItem(KEY);
    const root = raw ? JSON.parse(raw) as LocalCalendarState : { ...empty };
    return { ...empty, ...(accountId === undefined ? root : root.accounts?.[accountId]) };
  } catch { return { ...empty }; }
}

function saveState(patch: Partial<LocalCalendarState>, accountId?: string): void {
  const root = loadCalendarState();
  const next = accountId === undefined ? { ...root, ...patch }
    : { ...root, accounts: { ...root.accounts, [accountId]: { ...loadCalendarState(accountId), ...patch } } };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage blocked/full */ }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CALENDAR_STATE_EVENT));
}

export function deviceTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

export function importedCount(state: SyncState, accountId?: string, legacyIds = false): number {
  return Object.values(state.notes).filter((n) => calendarAccountOwns(n, { accountId, legacyIds }) && !n.deleted && n.reminderAt != null).length;
}

export class NotConnectedError extends Error {}
const queue = new AccountImportQueue<ImportCounts, CalendarStatus>();

export function importCalendarNow(manager: SyncManager, accountId?: string): Promise<ImportCounts> {
  return queue.check(manager, accountId, () => run(manager, accountId), new NotConnectedError("Disconnecting Calendar."));
}

function messageFor(e: unknown): string {
  return e instanceof ApiError ? e.detail ?? "The calendar check failed."
    : e instanceof Error && e.message && !/fetch|network/i.test(e.message) ? e.message
      : "Couldn't reach the calendar. Are you online?";
}

async function run(manager: SyncManager, accountId?: string): Promise<ImportCounts> {
  const startedAt = Date.now();
  try {
    await syncBeforeImport(manager);
    const status = await api.calendarStatus(manager.cfg);
    assertImportActive(manager);
    if (status.accounts) manager.setCalendarAccounts(status.accounts, status.accountsRevision);
    const accounts = status.accounts ?? [];
    const target = accountId === undefined ? undefined : accounts.find((a) => a.id === accountId);
    if (!status.connected || (accountId !== undefined && !target)) throw new NotConnectedError("No calendar connected.");
    const targets: (CalendarAccountSummary | undefined)[] = accountId !== undefined ? [target]
      : accounts.length ? accounts : [undefined]; // iCal, or an older single-account server
    const counts = noChanges();
    const failures: string[] = [];
    let succeeded = 0;
    for (const row of targets) {
      try {
        const result = await checkOne(manager, row, startedAt);
        for (const key of Object.keys(counts) as (keyof ImportCounts)[]) counts[key] += result[key];
        succeeded++;
      } catch (e) {
        if (manager.isStopped) throw e;
        if (targets.length === 1) throw e;
        failures.push(`${row?.email ?? "Calendar"}: ${messageFor(e)}`);
      }
    }
    const lastError = failures.length ? failures.join(" ") : null;
    if (!succeeded) throw new Error(lastError ?? "The calendar check failed.");
    saveState({ connected: true, lastCheck: startedAt, lastCounts: counts, lastError, source: status.mode === "ical" ? "link" : "google" });
    return counts;
  } catch (e) {
    if (manager.isStopped) throw e;
    if (e instanceof NotConnectedError || (e instanceof ApiError && e.status === 409)) {
      // A single-account failure must not mark other connections disconnected.
      saveState({ connected: accountId ? (manager.state.calendarAccounts?.some((a) => a.id !== accountId) ?? false) : false, lastCheck: startedAt, lastError: null });
      throw new NotConnectedError("No calendar connected.");
    }
    const message = messageFor(e);
    saveState({ lastCheck: startedAt, lastError: message });
    throw new Error(message);
  }
}

async function checkOne(manager: SyncManager, account: CalendarAccountSummary | undefined, startedAt: number): Promise<ImportCounts> {
  try {
    const data = await api.calendarFeed(manager.cfg, account?.id);
    assertImportActive(manager);
    let events: CalendarEvent[];
    let cancelledKeys: string[];
    if (data.kind === "google") {
      if (account && data.feed.accountId !== account.id) throw new Error("Google returned a different Calendar account. Existing reminders were kept.");
      const options = { timeZone: deviceTimeZone(), maxEvents: MAX_IMPORTED_EVENTS };
      events = googleFeedToCalendarEvents(data.feed, options);
      cancelledKeys = googleCancelledKeys(data.feed, options);
    } else {
      if (account) throw new Error("Google returned a secret link instead of this account. Existing reminders were kept.");
      const { parseCalendarDetailed, CalendarParseError } = await import("./ical");
      assertImportActive(manager);
      try {
        const from = Date.now();
        const parsed = parseCalendarDetailed(data.text, {
          from, to: from + CALENDAR_WINDOW_DAYS * 86_400_000, timeZone: deviceTimeZone(), maxEvents: MAX_IMPORTED_EVENTS,
        });
        events = parsed.events;
        cancelledKeys = parsed.cancelledKeys;
      } catch (e) { throw new Error(e instanceof CalendarParseError ? e.message : "The calendar couldn't be read."); }
    }
    const source = data.kind === "google" ? "google" : "link";
    const trust = events.length > 0 && events.length < MAX_IMPORTED_EVENTS && loadCalendarState(account?.id).source === source;
    const options: ReconcileOptions = { sweep: trust, cancelledKeys, accountId: account?.id, legacyIds: account?.legacyIds };
    const now = Date.now();
    const { state: _state, ...counts } = reconcileCalendar(manager.state, events, now, options);
    if (counts.added || counts.updated || counts.removed || counts.restored) {
      manager.mutate((s) => reconcileCalendar(s, events, now, options).state);
    }
    saveState({ connected: true, lastCheck: startedAt, lastError: null, lastCounts: counts, source }, account?.id);
    return counts;
  } catch (e) {
    if (manager.isStopped) throw e;
    saveState({ connected: !(e instanceof ApiError && e.status === 409), lastCheck: startedAt, lastError: messageFor(e) }, account?.id);
    throw e;
  }
}

/** Server cleanup reaches every device; the queue prevents late feeds restoring it locally. */
export function disconnectCalendarNow(manager: SyncManager, accountId?: string): Promise<CalendarStatus> {
  return queue.disconnect(manager, accountId, async () => {
    await syncBeforeImport(manager);
    const status = await api.calendarStatus(manager.cfg);
    assertImportActive(manager);
    if (accountId === undefined && (status.accounts?.length ?? 0) > 1) throw new Error("Choose a Calendar account to disconnect.");
    const row = accountId === undefined ? status.accounts?.[0] : status.accounts?.find((a) => a.id === accountId);
    const targetId = accountId ?? row?.id;
    if (accountId && !row) throw new NotConnectedError("That Calendar account is no longer connected.");
    const result = await api.disconnectCalendar(manager.cfg, targetId);
    assertImportActive(manager);
    const options = { accountId: targetId, legacyIds: row?.legacyIds };
    const now = Date.now();
    const removed = removeImportedReminders(manager.state, now, options);
    if (removed.removed) manager.mutate((s) => removeImportedReminders(s, now, options).state);
    if (result.accounts) manager.setCalendarAccounts(result.accounts, result.accountsRevision);
    await manager.syncOnce();
    assertImportActive(manager);
    saveState({ connected: false, lastCheck: now, lastError: null, lastCounts: null, source: null }, targetId);
    saveState({ connected: result.connected, lastError: null, lastCounts: null, source: result.mode === "ical" ? "link" : result.connected ? "google" : null });
    return result;
  });
}

/** Kept for older callers; use disconnectCalendarNow for coordinated cleanup. */
export function removeImported(manager: SyncManager): number {
  assertImportActive(manager);
  const now = Date.now();
  const result = removeImportedReminders(manager.state, now);
  if (result.removed) manager.mutate((s) => removeImportedReminders(s, now).state);
  saveState({ connected: false, lastError: null, lastCounts: null, source: null });
  return result.removed;
}

export function noteCalendarConnected(accountId?: string): void {
  saveState({ connected: true, lastCheck: null, lastError: null }, accountId);
}

export class CalendarAutoImport {
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  constructor(private manager: SyncManager) {}
  start(): void {
    this.first = setTimeout(() => void this.tick(), 3_000);
    this.timer = setInterval(() => void this.tick(), MIN);
    document.addEventListener("visibilitychange", this.onVisible);
  }
  stop(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = this.timer = null;
    document.removeEventListener("visibilitychange", this.onVisible);
  }
  private onVisible = () => { if (document.visibilityState === "visible") void this.tick(); };
  private async tick(now = Date.now()): Promise<void> {
    if (navigator.onLine === false || this.manager.isStopped || queue.isDisconnecting(this.manager)) return;
    const state = loadCalendarState();
    const every = document.visibilityState === "visible" ? EVERY_VISIBLE : EVERY_HIDDEN;
    if (state.lastCheck && state.lastCheck <= now && now - state.lastCheck < every) return;
    try { await importCalendarNow(this.manager); } catch { /* Settings shows account-specific failures */ }
  }
}
