import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyRemote,
  classroomNoteId,
  emptyState,
  LIMITS,
  markReminderDone,
  MAX_IMPORTED_ASSIGNMENTS,
  putItem,
  type ClassroomCourseWork,
  type ClassroomFeed,
  type Op,
} from "@pocketed/shared";
import {
  ClassroomAutoImport,
  ClassroomNotConnectedError,
  classroomImportedCount,
  disconnectClassroomNow,
  importClassroomNow,
  loadClassroomState,
} from "../src/classroom-import";
import { SyncManager } from "../src/store";

const NOW = Date.UTC(2026, 9, 13, 10);
const CFG = { serverUrl: "https://sync.test", token: "pocketed-password" };
const ACCOUNT = "student-google-id";
const ID = classroomNoteId(ACCOUNT, "maths", "worksheet");

function work(id = "worksheet", at = NOW + 86_400_000): ClassroomCourseWork {
  const date = new Date(at);
  return {
    id, courseId: "maths", state: "PUBLISHED", title: "Algebra worksheet",
    alternateLink: "https://classroom.google.com/c/example/a/worksheet/details",
    dueDate: { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() },
    dueTime: { hours: date.getUTCHours(), minutes: date.getUTCMinutes() },
  };
}

function feed(courseWork = [work()]): ClassroomFeed {
  return { source: "classroom", accountId: ACCOUNT, checkedAt: NOW, complete: true, courses: [{ id: "maths", name: "Maths" }], courseWork };
}

function fakeServer() {
  const log: Op[] = [];
  const server = {
    log,
    state: emptyState(),
    connected: true,
    feed: feed() as unknown,
    feedCalls: 0,
    feedError: false,
    syncError: false,
    disconnectError: false,
    disconnectCalls: 0,
    pushSizes: [] as number[],
    feedWait: null as Promise<void> | null,
    onFeed: null as (() => void) | null,
    pullWait: null as Promise<void> | null,
    onPull: null as (() => void) | null,
  };
  const append = (op: Op) => {
    if (log.some((entry) => entry.id === op.id)) return;
    log.push(op);
    server.state = applyRemote(server.state, [op]);
  };
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    if (url.pathname === "/v1/push") {
      const { ops } = JSON.parse(String(init?.body)) as { ops: Op[] };
      server.pushSizes.push(ops.length);
      if (ops.length > LIMITS.opsPerPush) return Response.json({ error: "too many ops" }, { status: 400 });
      for (const op of ops) append(op);
      return Response.json({ serverSeq: log.length });
    }
    if (url.pathname === "/v1/pull") {
      server.onPull?.();
      if (server.pullWait) await server.pullWait;
      if (server.syncError) return Response.json({ error: "Couldn't sync notes." }, { status: 503 });
      const cursor = Number(url.searchParams.get("cursor"));
      const limit = Number(url.searchParams.get("limit")) || LIMITS.opsPerPull;
      const ops = log.slice(cursor, cursor + limit);
      return Response.json({ ops, cursor: cursor + ops.length, serverSeq: log.length });
    }
    if (url.pathname === "/v1/classroom") {
      return Response.json({ connected: server.connected, googleAvailable: true, account: "student@school.example", connectedAt: NOW, problem: null,
        accounts: server.connected ? [{ id: ACCOUNT, email: "student@school.example", connectedAt: NOW, problem: null, legacyNotes: true }] : [] });
    }
    if (url.pathname === "/v1/classroom/feed") {
      server.feedCalls++;
      server.onFeed?.();
      if (server.feedWait) await server.feedWait;
      if (!server.connected) return Response.json({ error: "No Classroom account connected." }, { status: 409 });
      if (server.feedError) return Response.json({ error: "School access blocked. Existing assignments were kept." }, { status: 502 });
      return Response.json(server.feed);
    }
    if (url.pathname === "/v1/classroom/disconnect") {
      server.disconnectCalls++;
      if (server.disconnectError) return Response.json({ error: "Disconnect unavailable." }, { status: 503 });
      let removed = 0;
      for (const note of Object.values(server.state.notes)) {
        if (note.source !== "classroom" || note.deleted) continue;
        append({ id: `server-disconnect-${note.id}-${Date.now()}`, kind: "delete", noteId: note.id, updatedAt: Date.now() });
        removed++;
      }
      server.connected = false;
      return Response.json({ connected: false, googleAvailable: true, account: null, connectedAt: null, problem: null, accounts: [], removed });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  });
  return { server, fetchMock };
}

describe("Classroom import", () => {
  let backend: ReturnType<typeof fakeServer>;
  const managers: SyncManager[] = [];
  const manager = (serverUrl = CFG.serverUrl) => {
    const value = new SyncManager({ ...CFG, serverUrl });
    managers.push(value);
    return value;
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const memory = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => void memory.set(key, value),
      removeItem: (key: string) => void memory.delete(key),
    });
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() });
    backend = fakeServer();
    vi.stubGlobal("fetch", backend.fetchMock);
  });

  afterEach(() => {
    managers.splice(0).forEach((value) => value.stop());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("imports teacher deadlines into synced reminders and records the check", async () => {
    const m = manager();
    expect(await importClassroomNow(m)).toMatchObject({ added: 1, updated: 0, removed: 0 });
    expect(m.state.notes[ID]).toMatchObject({ title: "Maths: Algebra worksheet", source: "classroom", reminderAt: NOW + 86_400_000 });
    expect(classroomImportedCount(m.state)).toBe(1);
    expect(loadClassroomState()).toMatchObject({ connected: true, lastCheck: NOW, lastError: null, lastCounts: { added: 1 } });
    await m.syncOnce();
    expect(backend.server.log).toEqual(expect.arrayContaining([expect.objectContaining({ noteId: ID, source: "classroom" })]));
    const call = backend.fetchMock.mock.calls.find(([url]) => new URL(url).pathname === "/v1/classroom/feed")!;
    expect(new Headers(call[1]?.headers).get("authorization")).toBe(`Bearer ${CFG.token}`);
    expect(call[1]?.cache).toBe("no-store");
  });

  it("a second device honours completions from the first, until a teacher reschedules", async () => {
    const first = manager();
    await importClassroomNow(first);
    await first.syncOnce();
    vi.setSystemTime(NOW + 1000);
    first.mutate((state) => markReminderDone(state, ID, Date.now()));
    await first.syncOnce();
    localStorage.removeItem("pocketed.v2.state");
    const second = manager();
    expect(await importClassroomNow(second)).toMatchObject({ added: 0, updated: 0 });
    expect(second.state.notes[ID].reminderAt).toBeNull();
    backend.server.feed = feed([work("worksheet", NOW + 2 * 86_400_000)]);
    vi.setSystemTime(NOW + 2000);
    expect(await importClassroomNow(second)).toMatchObject({ added: 1 });
    expect(second.state.notes[ID].reminderAt).toBe(NOW + 2 * 86_400_000);
  });

  it("keeps existing assignments on API, malformed-feed and partial-feed errors", async () => {
    const m = manager();
    await importClassroomNow(m);
    await m.syncOnce();
    const before = JSON.stringify(m.state.notes);
    backend.server.feedError = true;
    await expect(importClassroomNow(m)).rejects.toThrow(/School access blocked/);
    backend.server.feedError = false;
    for (const bad of [{ ...feed(), complete: false }, { ...feed(), courseWork: "bad" }, {}]) {
      backend.server.feed = bad;
      await expect(importClassroomNow(m)).rejects.toThrow(/couldn't be read/);
      expect(JSON.stringify(m.state.notes)).toBe(before);
    }
    expect(loadClassroomState().lastError).toMatch(/couldn't be read/);
  });

  it("syncs teacher-removal bookkeeping so another device can restore a republished deadline", async () => {
    const first = manager();
    await importClassroomNow(first);
    await first.syncOnce();
    vi.setSystemTime(NOW + 1000);
    backend.server.feed = feed([]);
    await importClassroomNow(first);
    await first.syncOnce();
    expect(backend.server.state.notes[ID]).toMatchObject({ deleted: true, source: "classroom", sourceRef: "classroom-removed" });
    localStorage.removeItem("pocketed.v2.state");
    const second = manager();
    backend.server.feed = feed();
    vi.setSystemTime(NOW + 2000);
    expect(await importClassroomNow(second)).toMatchObject({ added: 1 });
    expect(second.state.notes[ID]).toMatchObject({ deleted: false, reminderAt: NOW + 86_400_000 });
  });

  it("requires a successful notes sync before applying Classroom, so offline checks cannot undo remote dismissals", async () => {
    const m = manager();
    backend.server.syncError = true;
    await expect(importClassroomNow(m)).rejects.toThrow(/Couldn't sync notes/);
    expect(backend.server.feedCalls).toBe(0);
    expect(Object.keys(m.state.notes)).toHaveLength(0);
  });

  it("reports a disconnected account without deleting notes itself", async () => {
    const m = manager();
    await importClassroomNow(m);
    backend.server.connected = false;
    await expect(importClassroomNow(m)).rejects.toBeInstanceOf(ClassroomNotConnectedError);
    expect(loadClassroomState()).toMatchObject({ connected: false, lastError: null });
    expect(m.state.notes[ID].deleted).toBe(false); // only a server cleanup op can remove it
  });

  it("deduplicates overlapping checks of the same manager", async () => {
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { backend.server.onFeed = resolve; });
    backend.server.feedWait = new Promise<void>((resolve) => { release = resolve; });
    const m = manager();
    const a = importClassroomNow(m);
    const b = importClassroomNow(m);
    expect(a).toBe(b);
    await entered;
    expect(backend.server.feedCalls).toBe(1);
    release();
    expect(await a).toMatchObject({ added: 1 });
  });

  it("a feed finishing after sign-out cannot restore notes or import settings on that device", async () => {
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { backend.server.onFeed = resolve; });
    backend.server.feedWait = new Promise<void>((resolve) => { release = resolve; });
    const m = manager();
    const pending = importClassroomNow(m);
    await entered;
    m.stop();
    localStorage.removeItem("pocketed.v2.state");
    localStorage.removeItem("pocketed.v2.classroom");
    release();
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(localStorage.getItem("pocketed.v2.state")).toBeNull();
    expect(localStorage.getItem("pocketed.v2.classroom")).toBeNull();
    expect(backend.server.log).toHaveLength(0);
  });

  it("a sync response finishing after sign-out cannot repopulate the erased notes cache", async () => {
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { backend.server.onPull = resolve; });
    backend.server.pullWait = new Promise<void>((resolve) => { release = resolve; });
    const m = manager();
    const pending = m.syncOnce();
    await entered;
    m.stop();
    localStorage.removeItem("pocketed.v2.state");
    release();
    await pending;
    expect(localStorage.getItem("pocketed.v2.state")).toBeNull();
  });

  it("does not share an in-flight feed with another manager/server", async () => {
    const other = fakeServer();
    other.server.feed = feed([work("other-assignment")]);
    vi.stubGlobal("fetch", (input: string, init?: RequestInit) =>
      new URL(input).hostname === "other-sync.test" ? other.fetchMock(input, init) : backend.fetchMock(input, init));
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { backend.server.onFeed = resolve; });
    backend.server.feedWait = new Promise<void>((resolve) => { release = resolve; });
    const first = manager();
    const second = manager("https://other-sync.test");
    const pending = importClassroomNow(first);
    await entered;
    expect(await importClassroomNow(second)).toMatchObject({ added: 1 });
    expect(second.state.notes[ID]).toBeUndefined();
    expect(second.state.notes[classroomNoteId(ACCOUNT, "maths", "other-assignment")]).toBeDefined();
    release();
    await pending;
    expect(first.state.notes[ID]).toBeDefined();
  });

  it("disconnect waits for a pending import and cannot recreate its assignments later", async () => {
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { backend.server.onFeed = resolve; });
    backend.server.feedWait = new Promise<void>((resolve) => { release = resolve; });
    const m = manager();
    const pending = importClassroomNow(m);
    await entered;
    const disconnect = disconnectClassroomNow(m);
    expect(backend.server.disconnectCalls).toBe(0);
    await expect(importClassroomNow(m)).rejects.toBeInstanceOf(ClassroomNotConnectedError);
    release();
    await pending;
    expect(await disconnect).toMatchObject({ connected: false, removed: 1 });
    expect(m.state.notes[ID].deleted).toBe(true);
    expect(classroomImportedCount(m.state)).toBe(0);
    expect(loadClassroomState().connected).toBe(false);
  });

  it("disconnect removes only Classroom reminders and failed disconnects can retry", async () => {
    const m = manager();
    await importClassroomNow(m);
    m.mutate((state) => putItem(state, "calendar-note", { text: "Dentist", source: "gcal", reminderAt: NOW + 86_400_000 }, NOW));
    m.mutate((state) => putItem(state, "personal-note", { text: "Private note", reminderAt: null }, NOW));
    await m.syncOnce();
    backend.server.disconnectError = true;
    await expect(disconnectClassroomNow(m)).rejects.toThrow(/Disconnect unavailable/);
    expect(m.state.notes[ID].deleted).toBe(false);
    backend.server.disconnectError = false;
    await disconnectClassroomNow(m);
    expect(m.state.notes[ID].deleted).toBe(true);
    expect(m.state.notes["calendar-note"].deleted).toBe(false);
    expect(m.state.notes["personal-note"].deleted).toBe(false);
  });

  it("batches a large reconciliation outbox instead of exceeding the sync server's push limit", async () => {
    backend.server.feed = feed(Array.from({ length: MAX_IMPORTED_ASSIGNMENTS }, (_, i) => work(`work-${i}`, NOW + 86_400_000 + i * 60_000)));
    const m = manager();
    expect(await importClassroomNow(m)).toMatchObject({ added: MAX_IMPORTED_ASSIGNMENTS });
    await m.syncOnce();
    backend.server.feed = feed(Array.from({ length: MAX_IMPORTED_ASSIGNMENTS }, (_, i) => work(`new-work-${i}`))); // new work replaces the original assignments
    vi.setSystemTime(NOW + 1000);
    expect(await importClassroomNow(m)).toMatchObject({ removed: MAX_IMPORTED_ASSIGNMENTS });
    expect(m.state.outbox.length).toBeGreaterThan(LIMITS.opsPerPush);
    await m.syncOnce();
    expect(m.phase).toBe("synced");
    expect(m.state.outbox).toHaveLength(0);
    expect(backend.server.pushSizes.every((size) => size <= LIMITS.opsPerPush)).toBe(true);
    expect(classroomImportedCount(backend.server.state)).toBe(MAX_IMPORTED_ASSIGNMENTS);
  });

  it("automatically checks on opening and every 15 minutes while visible, and stops cleanly", async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("document", { visibilityState: "visible", addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const m = manager();
    const schedule = new ClassroomAutoImport(m);
    schedule.start();
    await vi.advanceTimersByTimeAsync(4000);
    expect(backend.server.feedCalls, JSON.stringify(loadClassroomState())).toBe(1);
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    expect(backend.server.feedCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(backend.server.feedCalls).toBe(2);
    schedule.stop();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(backend.server.feedCalls).toBe(2);
  });
});
