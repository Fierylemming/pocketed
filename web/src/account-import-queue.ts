import type { SyncManager } from "./store";

interface QueueState<T, D> {
  tail: Promise<unknown>;
  imports: Map<string, Promise<T>>;
  disconnects: Map<string, Promise<D>>;
}

/**
 * Deduplicate identical checks (including StrictMode), but serialize different
 * accounts and disconnects. One workspace's requests never lock another's.
 */
export class AccountImportQueue<T, D> {
  private states = new WeakMap<SyncManager, QueueState<T, D>>();

  private state(manager: SyncManager): QueueState<T, D> {
    let state = this.states.get(manager);
    if (!state) {
      state = { tail: Promise.resolve(), imports: new Map(), disconnects: new Map() };
      this.states.set(manager, state);
    }
    return state;
  }

  isDisconnecting(manager: SyncManager): boolean {
    return !!this.states.get(manager)?.disconnects.size;
  }

  check(manager: SyncManager, accountId: string | undefined, work: () => Promise<T>, blocked: Error): Promise<T> {
    const state = this.state(manager);
    const key = accountId ?? "*";
    if (state.disconnects.has("*") || state.disconnects.has(key) || (key === "*" && state.disconnects.size)) {
      return Promise.reject(blocked);
    }
    const existing = state.imports.get(key);
    if (existing) return existing;
    const pending = state.tail.then(work).finally(() => state.imports.delete(key));
    state.imports.set(key, pending);
    state.tail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  disconnect(manager: SyncManager, accountId: string | undefined, work: () => Promise<D>): Promise<D> {
    const state = this.state(manager);
    const key = accountId ?? "*";
    const existing = state.disconnects.get(key);
    if (existing) return existing;
    const pending = state.tail.then(work).finally(() => state.disconnects.delete(key));
    state.disconnects.set(key, pending);
    state.tail = pending.then(() => undefined, () => undefined);
    return pending;
  }
}

export function assertImportActive(manager: SyncManager): void {
  if (manager.isStopped) throw new Error("The Google check was cancelled after sign-out.");
}

export async function syncBeforeImport(manager: SyncManager): Promise<void> {
  assertImportActive(manager);
  await manager.syncOnce();
  assertImportActive(manager);
  if (manager.phase !== "synced") throw new Error(manager.lastError ?? "Couldn't sync your notes before checking Google.");
}
