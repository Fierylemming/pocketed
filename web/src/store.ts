// Client-side sync manager: persists state to localStorage, pushes the
// outbox, pulls new ops, and notifies the UI.

import {
  applyRemote,
  emptyState,
  LIMITS,
  isCalendarAccountSummary,
  type CalendarAccountSummary,
  type SyncState,
} from "@pocketed/shared";
import { api, ApiError } from "./api";
import { STATE_KEY, type Config } from "./config";

export type Phase = "syncing" | "synced" | "error" | "offline";

function loadState(): SyncState {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return emptyState();
    const s = JSON.parse(raw) as SyncState;
    if (s && typeof s === "object" && s.notes && Array.isArray(s.outbox)) {
      return { ...emptyState(), ...s, sections: s.sections ?? {},
        calendarAccounts: Array.isArray(s.calendarAccounts) ? s.calendarAccounts.filter(isCalendarAccountSummary) : undefined,
        calendarAccountsRevision: Number.isSafeInteger(s.calendarAccountsRevision) && s.calendarAccountsRevision! >= 0 ? s.calendarAccountsRevision : undefined };
    }
    return emptyState();
  } catch {
    return emptyState();
  }
}

const PULL_INTERVAL_MS = 15_000;
const PUSH_DEBOUNCE_MS = 500;

export class SyncManager {
  state: SyncState;
  phase: Phase = "syncing";
  lastSync: number | null = null;
  lastError: string | null = null;
  version = 0;

  private listeners = new Set<() => void>();
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  /** The sync currently running, if any. Overlapping calls share it. */
  private running: Promise<void> | null = null;
  private rerun = false;
  private stopped = false;

  get isStopped(): boolean { return this.stopped; }

  private onWake = () => void this.syncOnce();

  constructor(public cfg: Config) {
    this.state = loadState();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private emit(): void {
    if (this.stopped) return; // a late request must not repopulate storage after sign-out
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify(this.state));
    } catch {
      /* storage full/blocked: keep going in memory */
    }
    this.version++;
    this.listeners.forEach((fn) => fn());
  }

  /** Server-owned preferences bypass the notes outbox; stale responses cannot undo a toggle. */
  setCalendarAccounts(accounts: CalendarAccountSummary[], revision?: number): void {
    if (this.stopped || !accounts.every(isCalendarAccountSummary)) return;
    const previous = this.state.calendarAccountsRevision;
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0)) return;
    if (previous !== undefined && (revision === undefined || revision < previous)) return;
    this.state = { ...this.state, calendarAccounts: accounts.map((a) => ({ ...a })), calendarAccountsRevision: revision };
    this.emit();
  }

  mutate(fn: (s: SyncState) => SyncState): void {
    if (this.stopped) return;
    this.state = fn(this.state);
    this.emit();
    this.queuePush();
  }

  private queuePush(): void {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => void this.syncOnce(), PUSH_DEBOUNCE_MS);
  }

  /**
   * Runs one push+pull cycle. If a cycle is already running, the call is
   * folded into it (one more cycle runs afterwards), so pushes and cursors
   * never interleave.
   */
  syncOnce(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    // Start after assigning `running`, so a subscriber cannot re-enter the
    // cycle during its first emit. Callers also await any requested follow-up
    // cycle instead of starting an import from an only-partly-synced state.
    this.running = Promise.resolve().then(async () => {
      do {
        this.rerun = false;
        await this.cycle();
      } while (this.rerun && !this.stopped);
    }).finally(() => { this.running = null; });
    return this.running;
  }

  private async cycle(): Promise<void> {
    if (this.stopped) return;
    this.phase = "syncing";
    this.emit();
    try {
      // A Calendar/Classroom import (or many offline edits) can exceed one
      // push's limit. Keep the snapshot until the pull acknowledges its ops.
      const queued = this.state.outbox.slice();
      for (let offset = 0; offset < queued.length; offset += LIMITS.opsPerPush) {
        if (this.stopped) return;
        await api.push(this.cfg, queued.slice(offset, offset + LIMITS.opsPerPush));
      }
      let caughtUp = false;
      for (let guard = 0; guard < 25; guard++) {
        const page = await api.pull(this.cfg, this.state.cursor);
        if (this.stopped) return;
        if (page.ops.length) {
          this.state = applyRemote(this.state, page.ops);
          this.state = { ...this.state, cursor: page.cursor };
        }
        if (page.calendarAccounts) this.setCalendarAccounts(page.calendarAccounts, page.calendarAccountsRevision);
        if (!page.ops.length || page.cursor >= page.serverSeq) { caughtUp = true; break; }
      }
      if (!caughtUp) {
        this.rerun = true; // more history: keep syncing before an importer can reconcile
        this.emit();
        return;
      }
      this.phase = "synced";
      this.lastSync = Date.now();
      this.lastError = null;
    } catch (e) {
      const unauthorized = e instanceof ApiError && e.status === 401;
      this.phase = unauthorized
        ? "error"
        : typeof navigator !== "undefined" && !navigator.onLine
          ? "offline"
          : "error";
      this.lastError = unauthorized
        ? "Wrong password — open Settings and fix it."
        : e instanceof Error
          ? e.message
          : "sync failed";
    }
    this.emit();
  }

  start(): void {
    this.stopped = false;
    void this.syncOnce();
    this.interval = setInterval(() => void this.syncOnce(), PULL_INTERVAL_MS);
    window.addEventListener("focus", this.onWake);
    window.addEventListener("online", this.onWake);
  }

  stop(): void {
    this.stopped = true;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = null;
    window.removeEventListener("focus", this.onWake);
    window.removeEventListener("online", this.onWake);
  }
}
