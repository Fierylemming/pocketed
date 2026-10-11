// Google Calendar auto-import, run by the app on whichever device is open.
//
// The sync server keeps the connection — the secret iCal link, or a "Sign in
// with Google" token — and relays the calendar. This module turns upcoming
// events into reminders with the shared reconcileCalendar(), so the changes
// sync to every device like any other edit. iCal feeds are parsed here with
// ical.js (loaded on demand); Google sends ready-made events with colours.
//
// When: shortly after the app opens, then every 15 minutes while it's on
// screen (hourly in the background), and on "Check now" in Settings.

import {
  CALENDAR_WINDOW_DAYS,
  googleFeedToCalendarEvents,
  MAX_IMPORTED_EVENTS,
  reconcileCalendar,
  removeImportedReminders,
  type SyncState,
} from "@pocketed/shared";
import { api, ApiError } from "./api";
import type { SyncManager } from "./store";

const KEY = "pocketed.v2.calendar";
const MIN = 60_000;
const EVERY_VISIBLE = 15 * MIN;
const EVERY_HIDDEN = 60 * MIN;
const TICK = MIN;

export interface ImportCounts {
  added: number;
  updated: number;
  removed: number;
}

/** What this device last saw (kept in localStorage, shared between tabs). */
export interface LocalCalendarState {
  /** null = not known yet. */
  connected: boolean | null;
  lastCheck: number | null;
  lastError: string | null;
  lastCounts: ImportCounts | null;
}

const empty: LocalCalendarState = {
  connected: null,
  lastCheck: null,
  lastError: null,
  lastCounts: null,
};

export function loadCalendarState(): LocalCalendarState {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...empty, ...(JSON.parse(raw) as Partial<LocalCalendarState>) } : { ...empty };
  } catch {
    return { ...empty };
  }
}

function saveCalendarState(patch: Partial<LocalCalendarState>): LocalCalendarState {
  const next = { ...loadCalendarState(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage blocked: fine */
  }
  return next;
}

export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function importedCount(state: SyncState): number {
  return Object.values(state.notes).filter(
    (n) => n.source === "gcal" && !n.deleted && n.reminderAt != null,
  ).length;
}

export class NotConnectedError extends Error {}

let running: Promise<ImportCounts> | null = null;

/**
 * Fetches, parses and applies the calendar now. Throws NotConnectedError when
 * no calendar is linked, or an Error with a user-facing message.
 */
export function importCalendarNow(manager: SyncManager): Promise<ImportCounts> {
  running ??= run(manager).finally(() => {
    running = null;
  });
  return running;
}

async function run(manager: SyncManager): Promise<ImportCounts> {
  const startedAt = Date.now();
  try {
    // Work from fresh state so a reminder dismissed on another device stays dismissed.
    await manager.syncOnce();
    const data = await api.calendarFeed(manager.cfg);
    const window = () => {
      const now = Date.now();
      return {
        from: now,
        to: now + CALENDAR_WINDOW_DAYS * 24 * 60 * MIN,
        timeZone: deviceTimeZone(),
        maxEvents: MAX_IMPORTED_EVENTS,
      };
    };
    let events;
    if (data.kind === "google") {
      events = googleFeedToCalendarEvents(data.feed, window());
    } else {
      const { parseCalendar, CalendarParseError } = await import("./ical");
      try {
        events = parseCalendar(data.text, window());
      } catch (e) {
        throw new Error(
          e instanceof CalendarParseError ? e.message : "The calendar couldn't be read.",
        );
      }
    }
    const now = Date.now();
    const preview = reconcileCalendar(manager.state, events, now);
    const counts = { added: preview.added, updated: preview.updated, removed: preview.removed };
    if (counts.added || counts.updated || counts.removed) {
      manager.mutate((s) => reconcileCalendar(s, events, now).state);
    }
    saveCalendarState({ connected: true, lastCheck: startedAt, lastError: null, lastCounts: counts });
    return counts;
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      saveCalendarState({ connected: false, lastCheck: startedAt, lastError: null });
      throw new NotConnectedError("No calendar connected.");
    }
    const msg =
      e instanceof ApiError
        ? (e.detail ?? "The calendar check failed.")
        : e instanceof Error && e.message && !/fetch|network/i.test(e.message)
          ? e.message
          : "Couldn't reach the calendar. Are you online?";
    saveCalendarState({ lastCheck: startedAt, lastError: msg });
    throw new Error(msg);
  }
}

/** Removes this account's imported reminders (after disconnecting). */
export function removeImported(manager: SyncManager): number {
  const now = Date.now();
  const r = removeImportedReminders(manager.state, now);
  if (r.removed) manager.mutate((s) => removeImportedReminders(s, now).state);
  saveCalendarState({ connected: false, lastError: null, lastCounts: null });
  return r.removed;
}

export function noteCalendarConnected(): void {
  saveCalendarState({ connected: true, lastError: null });
}

/** Background schedule. One per open app. */
export class CalendarAutoImport {
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;

  constructor(private manager: SyncManager) {}

  start(): void {
    this.first = setTimeout(() => void this.tick(), 3_000);
    this.timer = setInterval(() => void this.tick(), TICK);
    document.addEventListener("visibilitychange", this.onVisible);
  }

  stop(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = this.timer = null;
    document.removeEventListener("visibilitychange", this.onVisible);
  }

  private onVisible = () => {
    if (document.visibilityState === "visible") void this.tick();
  };

  private async tick(now = Date.now()): Promise<void> {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    const st = loadCalendarState();
    const every = document.visibilityState === "visible" ? EVERY_VISIBLE : EVERY_HIDDEN;
    if (st.lastCheck && now - st.lastCheck < every && st.lastCheck <= now) return;
    try {
      await importCalendarNow(this.manager);
    } catch {
      /* recorded in the local state; Settings shows it */
    }
  }
}
