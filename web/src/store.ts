// Client-side sync manager: persists state to localStorage, pushes the
// outbox, pulls new ops, and notifies the UI.

import {
  applyRemote,
  emptyState,
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
      return s;
    }
    return emptyState();
  } catch {
    return emptyState();
  }
}

export class SyncManager {
  state: SyncState;
  phase: Phase = "syncing";
  lastSync: number | null = null;
  lastError: string | null = null;
  version = 0;

  private listeners = new Set<() => void>();
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(public cfg: Config) {
    this.state = loadState();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private emit(): void {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify(this.state));
    } catch {
      /* storage full/blocked: keep going in memory */
    }
    this.version++;
    this.listeners.forEach((fn) => fn());
  }

  mutate(fn: (s: SyncState) => SyncState): void {
    this.state = fn(this.state);
    this.emit();
    this.queuePush();
  }

  private queuePush(): void {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => void this.syncOnce(), 500);
  }

  async syncOnce(): Promise<void> {
    this.phase = "syncing";
    this.emit();
    try {
      if (this.state.outbox.length) {
        await api.push(this.cfg, this.state.outbox);
      }
      for (let guard = 0; guard < 25; guard++) {
        const page = await api.pull(this.cfg, this.state.cursor);
        if (page.ops.length) {
          this.state = applyRemote(this.state, page.ops);
          this.state = { ...this.state, cursor: page.cursor };
        }
        if (!page.ops.length || page.cursor >= page.serverSeq) break;
      }
      this.phase = "synced";
      this.lastSync = Date.now();
      this.lastError = null;
    } catch (e) {
      this.phase =
        e instanceof ApiError && e.status === 401
          ? "error"
          : typeof navigator !== "undefined" && !navigator.onLine
            ? "offline"
            : "error";
      this.lastError =
        e instanceof ApiError && e.status === 401
          ? "Wrong password — open Settings and fix it."
          : e instanceof Error
            ? e.message
            : "sync failed";
    }
    this.emit();
  }

  start(): void {
    void this.syncOnce();
    this.interval = setInterval(() => void this.syncOnce(), 15_000);
    const onFocus = () => void this.syncOnce();
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onFocus);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }
}
