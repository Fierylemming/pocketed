// Classroom accounts import independently of Calendar accounts and visibility.
// Google credentials stay on the Worker, never in browser storage.

import { reconcileClassroom, removeClassroomReminders, type SyncState } from "@pocketed/shared";
import { api, ApiError, type ClassroomAccountSummary, type ClassroomDisconnectResult } from "./api";
import { AccountImportQueue, assertImportActive, syncBeforeImport } from "./account-import-queue";
import type { SyncManager } from "./store";

const KEY = "pocketed.v2.classroom";
export const CLASSROOM_STATE_EVENT = "pocketed:classroom-state";
const MIN = 60_000;
const EVERY_VISIBLE = 15 * MIN;
const EVERY_HIDDEN = 60 * MIN;

export interface ClassroomImportCounts {
  added: number;
  updated: number;
  removed: number;
  undated: number;
  invalid: number;
  capped: number;
}

export interface LocalClassroomState {
  connected: boolean | null;
  lastCheck: number | null;
  lastError: string | null;
  lastCounts: ClassroomImportCounts | null;
  accounts?: Record<string, LocalClassroomState>;
}

const empty: LocalClassroomState = { connected: null, lastCheck: null, lastError: null, lastCounts: null };
const noChanges = (): ClassroomImportCounts => ({ added: 0, updated: 0, removed: 0, undated: 0, invalid: 0, capped: 0 });

export function loadClassroomState(accountId?: string): LocalClassroomState {
  try {
    const raw = localStorage.getItem(KEY);
    const root = raw ? JSON.parse(raw) as LocalClassroomState : { ...empty };
    return { ...empty, ...(accountId === undefined ? root : root.accounts?.[accountId]) };
  } catch { return { ...empty }; }
}

function saveState(patch: Partial<LocalClassroomState>, accountId?: string): void {
  const root = loadClassroomState();
  const next = accountId === undefined ? { ...root, ...patch }
    : { ...root, accounts: { ...root.accounts, [accountId]: { ...loadClassroomState(accountId), ...patch } } };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* synced assignments still work */ }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CLASSROOM_STATE_EVENT));
}

export function noteClassroomConnected(accountId?: string): void {
  saveState({ connected: true, lastCheck: null, lastError: null }, accountId);
}

export function classroomImportedCount(state: SyncState, accountId?: string, legacyNotes = false): number {
  return Object.values(state.notes).filter((n) => n.source === "classroom" && !n.deleted && n.reminderAt != null &&
    (!accountId || n.sourceAccountId === accountId || (legacyNotes && !n.sourceAccountId))).length;
}

export class ClassroomNotConnectedError extends Error {}
const queue = new AccountImportQueue<ClassroomImportCounts, ClassroomDisconnectResult>();

export function importClassroomNow(manager: SyncManager, accountId?: string): Promise<ClassroomImportCounts> {
  return queue.check(manager, accountId, () => run(manager, accountId), new ClassroomNotConnectedError("Disconnecting Classroom."));
}

function errorMessage(e: unknown): string {
  return e instanceof ApiError ? e.detail ?? "The Classroom check failed."
    : e instanceof Error && e.message && !/fetch|network/i.test(e.message) ? e.message
      : "Couldn't reach Google Classroom. Are you online?";
}

async function run(manager: SyncManager, accountId?: string): Promise<ClassroomImportCounts> {
  const startedAt = Date.now();
  try {
    await syncBeforeImport(manager);
    const status = await api.classroomStatus(manager.cfg);
    assertImportActive(manager);
    const accounts = status.accounts ?? [];
    const target = accountId === undefined ? undefined : accounts.find((a) => a.id === accountId);
    if (!status.connected || (accountId !== undefined && !target)) throw new ClassroomNotConnectedError("No Classroom account connected.");
    const targets: (ClassroomAccountSummary | undefined)[] = accountId !== undefined ? [target] : accounts.length ? accounts : [undefined];
    const counts = noChanges();
    const failures: string[] = [];
    let succeeded = 0;
    for (const row of targets) {
      try {
        const result = await checkOne(manager, row, startedAt);
        for (const key of Object.keys(counts) as (keyof ClassroomImportCounts)[]) counts[key] += result[key];
        succeeded++;
      } catch (e) {
        if (manager.isStopped) throw e;
        if (targets.length === 1) throw e;
        failures.push(`${row?.email ?? "Classroom"}: ${errorMessage(e)}`);
      }
    }
    const lastError = failures.length ? failures.join(" ") : null;
    if (!succeeded) throw new Error(lastError ?? "The Classroom check failed.");
    saveState({ connected: true, lastCheck: startedAt, lastError, lastCounts: counts });
    return counts;
  } catch (e) {
    if (manager.isStopped) throw e;
    if (e instanceof ClassroomNotConnectedError || (e instanceof ApiError && e.status === 409)) {
      saveState({ ...(accountId === undefined ? { connected: false } : {}), lastCheck: startedAt, lastError: null, lastCounts: null });
      throw new ClassroomNotConnectedError("No Classroom account connected.");
    }
    const message = errorMessage(e);
    saveState({ lastCheck: startedAt, lastError: message });
    throw new Error(message);
  }
}

async function checkOne(manager: SyncManager, account: ClassroomAccountSummary | undefined, startedAt: number): Promise<ClassroomImportCounts> {
  try {
    const feed = await api.classroomFeed(manager.cfg, account?.id);
    assertImportActive(manager);
    const now = Date.now();
    const { state: _state, ...counts } = reconcileClassroom(manager.state, feed, now);
    if (counts.added || counts.updated || counts.removed) manager.mutate((s) => reconcileClassroom(s, feed, now).state);
    saveState({ connected: true, lastCheck: startedAt, lastError: null, lastCounts: counts }, account?.id);
    return counts;
  } catch (e) {
    if (manager.isStopped) throw e;
    saveState({ connected: !(e instanceof ApiError && e.status === 409), lastCheck: startedAt, lastError: errorMessage(e) }, account?.id);
    throw e;
  }
}

/** Only this student's assignments are removed. Calendar visibility and other accounts stay. */
export function disconnectClassroomNow(manager: SyncManager, accountId?: string): Promise<ClassroomDisconnectResult> {
  return queue.disconnect(manager, accountId, async () => {
    await syncBeforeImport(manager);
    const status = await api.classroomStatus(manager.cfg);
    assertImportActive(manager);
    if (accountId === undefined && (status.accounts?.length ?? 0) > 1) throw new Error("Choose a Classroom account to disconnect.");
    const row = accountId === undefined ? status.accounts?.[0] : status.accounts?.find((a) => a.id === accountId);
    const targetId = accountId ?? row?.id;
    if (accountId && !row) throw new ClassroomNotConnectedError("That Classroom account is no longer connected.");
    const result = await api.disconnectClassroom(manager.cfg, targetId);
    assertImportActive(manager);
    const now = Date.now();
    const removed = removeClassroomReminders(manager.state, now, targetId, row?.legacyNotes);
    if (removed.removed) manager.mutate((s) => removeClassroomReminders(s, now, targetId, row?.legacyNotes).state);
    await manager.syncOnce();
    assertImportActive(manager);
    saveState({ connected: false, lastCheck: now, lastError: null, lastCounts: null }, targetId);
    saveState({ connected: result.connected, lastError: null, lastCounts: null });
    return result;
  });
}

/** Shortly after opening, then 15 min visible / hourly hidden; no closed-app jobs. */
export class ClassroomAutoImport {
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  constructor(private manager: SyncManager) {}
  start(): void {
    this.first = setTimeout(() => void this.tick(), 4_000);
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
    const state = loadClassroomState();
    const interval = document.visibilityState === "visible" ? EVERY_VISIBLE : EVERY_HIDDEN;
    if (state.lastCheck && state.lastCheck <= now && now - state.lastCheck < interval) return;
    try { await importClassroomNow(this.manager); } catch { /* Settings shows per-account errors */ }
  }
}
