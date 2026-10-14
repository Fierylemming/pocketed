import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  calendarNoteId, filterCalendarAccounts,
} from "@pocketed/shared";
import { api } from "../src/api";
import { importCalendarNow, disconnectCalendarNow, loadCalendarState } from "../src/calendar-import";
import { importClassroomNow, disconnectClassroomNow } from "../src/classroom-import";
import { ReminderCalendar } from "../src/components/ReminderCalendar";
import { CalendarAccounts } from "../src/components/CalendarAccounts";
import { GoogleCalendar } from "../src/components/GoogleCalendar";
import { SyncManager } from "../src/store";
import { clearAll, STATE_KEY } from "../src/config";

import { backend, NOW, HOME, SCHOOL, STUDENT, UID, CFG, classroomFeed } from "./fake-google-accounts";

const managers: SyncManager[] = [];
const manager = () => { const m = new SyncManager(CFG); managers.push(m); return m; };
let mock: ReturnType<typeof backend>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  vi.stubGlobal("window", { addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true });
  mock = backend(); vi.stubGlobal("fetch", mock.fetchMock);
});
afterEach(() => { for (const m of managers.splice(0)) m.stop(); vi.useRealTimers(); vi.unstubAllGlobals(); });

async function hideSchool(m: SyncManager) {
  const status = await api.setCalendarVisibility(CFG, SCHOOL, false);
  m.setCalendarAccounts(status.accounts!, status.accountsRevision);
}

function calendarHtml(m: SyncManager) {
  return renderToStaticMarkup(<ReminderCalendar notes={Object.values(m.state.notes)} accounts={m.state.calendarAccounts}
    sections={[]} now={NOW} colorFilter="all" onColorFilterChange={() => {}} onSelectSection={() => {}}
    onQuickAddReminderForDate={() => {}} renderReminderCard={(note) => <li key={note.id}>{note.title}</li>} />);
}

describe("multiple accounts in the browser", () => {
  it("imports school/home independently, even when both contain the same event UID", async () => {
    const m = manager();
    expect(await importCalendarNow(m)).toMatchObject({ added: 2, removed: 0 });
    expect(m.state.notes[calendarNoteId(UID, HOME)]).toMatchObject({ title: "Home meeting", sourceAccountId: HOME });
    expect(m.state.notes[calendarNoteId(UID, SCHOOL)]).toMatchObject({ title: "School event", sourceAccountId: SCHOOL });
    expect(mock.server.feedCalls).toEqual([`calendar:${HOME}`, `calendar:${SCHOOL}`]);
    const request = mock.fetchMock.mock.calls.find(([url]) => new URL(url).pathname === "/v1/calendar/feed")!;
    expect(request[0]).toContain("accountId=google%3Ahome");
    expect(request[1]?.cache).toBe("no-store");
  });

  it("hides school calendar events but keeps school Classroom assignments visible and syncing", async () => {
    const m = manager(); await importCalendarNow(m); await importClassroomNow(m);
    const before = Object.keys(m.state.notes).length;
    await hideSchool(m);
    const html = calendarHtml(m);
    expect(html).toContain("Home meeting");
    expect(html).not.toContain("School event");
    expect(html).toContain("Maths: Assignment");
    expect(Object.keys(m.state.notes)).toHaveLength(before);
    expect(Object.values(m.state.notes).every((n) => !n.deleted)).toBe(true);
    mock.server.feeds[SCHOOL].events[0].summary = "Updated hidden event";
    expect(await importCalendarNow(m, SCHOOL)).toMatchObject({ updated: 1 });
    expect(m.state.notes[calendarNoteId(UID, SCHOOL)].title).toBe("Updated hidden event");
    expect(calendarHtml(m)).not.toContain("Updated hidden event");
    expect(calendarHtml(m)).toContain("Maths: Assignment");
  });

  it("keeps healthy account updates when another account fails", async () => {
    const m = manager(); await importCalendarNow(m);
    mock.server.feeds[HOME].events[0].summary = "Updated home meeting";
    mock.server.feedErrors.add(SCHOOL);
    expect(await importCalendarNow(m)).toMatchObject({ updated: 1, removed: 0 });
    expect(m.state.notes[calendarNoteId(UID, HOME)].title).toBe("Updated home meeting");
    expect(m.state.notes[calendarNoteId(UID, SCHOOL)].deleted).toBe(false);
    expect(loadCalendarState(SCHOOL).lastError).toContain("access blocked");
    expect(loadCalendarState(HOME).lastError).toBeNull();
    expect(loadCalendarState().lastError).toContain("student@school.example");
  });

  it("rejects a feed from the wrong account instead of applying its updates or deletions", async () => {
    const m = manager(); await importCalendarNow(m);
    const before = structuredClone(m.state.notes);
    mock.server.feeds[SCHOOL].accountId = HOME;
    await expect(importCalendarNow(m, SCHOOL)).rejects.toThrow("different Calendar account");
    expect(m.state.notes).toEqual(before);
  });

  it("disconnects one Calendar account while keeping the other account and Classroom", async () => {
    const m = manager(); await importCalendarNow(m); await importClassroomNow(m);
    await disconnectCalendarNow(m, SCHOOL);
    expect(m.state.notes[calendarNoteId(UID, SCHOOL)].deleted).toBe(true);
    expect(m.state.notes[calendarNoteId(UID, HOME)].deleted).toBe(false);
    expect(Object.values(m.state.notes).find((n) => n.source === "classroom")?.deleted).toBe(false);
    expect(m.state.calendarAccounts?.map((a) => a.id)).toEqual([HOME]);
    await expect(importCalendarNow(m, SCHOOL)).rejects.toThrow("No calendar connected");
    expect(await importCalendarNow(m, HOME)).toMatchObject({ added: 0 });
  });

  it("refuses ambiguous browser disconnects before any account is removed", async () => {
    const m = manager(); await importCalendarNow(m);
    await expect(disconnectCalendarNow(m)).rejects.toThrow("Choose a Calendar account");
    expect(mock.server.accounts).toHaveLength(2);
    expect(mock.fetchMock.mock.calls.filter(([url]) => new URL(url).pathname.endsWith("/disconnect"))).toHaveLength(0);
  });

  it("makes the visibility choice available on another device without reimporting", async () => {
    const a = manager(); await importCalendarNow(a); await importClassroomNow(a); await a.syncOnce();
    await hideSchool(a);
    localStorage.removeItem(STATE_KEY);
    const b = manager(); await b.syncOnce();
    expect(b.state.calendarAccounts?.find((r) => r.id === SCHOOL)?.visible).toBe(false);
    expect(calendarHtml(b)).not.toContain("School event");
    expect(calendarHtml(b)).toContain("Maths: Assignment");
    const status = await api.setCalendarVisibility(CFG, SCHOOL, true);
    a.setCalendarAccounts(status.accounts!, status.accountsRevision);
    await b.syncOnce();
    expect(calendarHtml(b)).toContain("School event");
  });

  it("overlapping callers await the follow-up sync instead of importing while it is still running", async () => {
    const m = manager();
    let releaseFirst!: () => void; let releaseSecond!: () => void;
    const enteredFirst = new Promise<void>((resolve) => { mock.server.onPull = resolve; });
    mock.server.pullWait = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = m.syncOnce(); await enteredFirst;
    const second = m.syncOnce(); expect(second).toBe(first);
    const enteredSecond = new Promise<void>((resolve) => { mock.server.onPull = resolve; });
    mock.server.pullWait = new Promise<void>((resolve) => { releaseSecond = resolve; });
    let completed = false; void first.then(() => { completed = true; });
    releaseFirst(); await enteredSecond; await Promise.resolve();
    expect(completed).toBe(false); expect(m.phase).toBe("syncing");
    releaseSecond(); await first;
    expect(completed).toBe(true); expect(m.phase).toBe("synced");
  });

  it("catches up beyond a pull batch limit before reporting synced", async () => {
    const m = manager();
    let pulls = 0;
    vi.spyOn(api, "pull").mockImplementation(async (_cfg, cursor) => {
      pulls++;
      return { ops: [{ id: `op-${cursor}`, kind: "upsert", noteId: "event", text: `Edit ${cursor}`, updatedAt: cursor + 1 }],
        cursor: cursor + 1, serverSeq: 26 };
    });
    await m.syncOnce();
    expect(pulls).toBe(26); expect(m.state.cursor).toBe(26); expect(m.phase).toBe("synced");
    expect(m.state.notes.event.text).toBe("Edit 25");
    vi.restoreAllMocks();
  });

  it("a stale sync response cannot undo a newer visibility toggle", async () => {
    const m = manager(); await importCalendarNow(m); await m.syncOnce();
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { mock.server.onPull = resolve; });
    mock.server.pullWait = new Promise<void>((resolve) => { release = resolve; });
    const pending = m.syncOnce(); await entered;
    await hideSchool(m);
    release(); await pending;
    expect(m.state.calendarAccounts?.find((r) => r.id === SCHOOL)?.visible).toBe(false);
    expect(m.state.calendarAccountsRevision).toBe(3);
  });

  it("a Calendar feed finishing after sign-out cannot restore notes or connection settings", async () => {
    const m = manager();
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { mock.server.onFeed = resolve; });
    mock.server.feedWait = new Promise<void>((resolve) => { release = resolve; });
    const pending = importCalendarNow(m, SCHOOL); await entered;
    m.stop(); clearAll(); release();
    await expect(pending).rejects.toThrow("cancelled after sign-out");
    expect(localStorage.getItem(STATE_KEY)).toBeNull();
    expect(localStorage.getItem("pocketed.v2.calendar")).toBeNull();
  });

  it("imports two Classroom accounts and removes only the chosen student's work", async () => {
    mock.server.classAccounts.push({ id: "other-student", email: "other@school.example", connectedAt: NOW, problem: null, legacyNotes: false });
    mock.server.classFeeds["other-student"] = classroomFeed("other-student");
    const m = manager();
    expect(await importClassroomNow(m)).toMatchObject({ added: 2 });
    await disconnectClassroomNow(m, STUDENT);
    expect(Object.values(m.state.notes).find((n) => n.sourceAccountId === STUDENT)?.deleted).toBe(true);
    expect(Object.values(m.state.notes).find((n) => n.sourceAccountId === "other-student")?.deleted).toBe(false);
    expect(mock.server.classAccounts).toHaveLength(1);
  });

  it("calendar settings and accessible switches explain account isolation without deleting assignments", async () => {
    const m = manager(); await importCalendarNow(m); await hideSchool(m);
    const html = renderToStaticMarkup(<CalendarAccounts manager={m} />);
    expect(html).toContain("home@example.com"); expect(html).toContain("student@school.example");
    expect(html).toContain('type="checkbox"'); expect(html).toContain("across all your devices");
    expect(html).toContain("Classroom assignments always stay visible"); expect(html).toContain("Nothing is deleted");
    expect(html).toContain("reminder lists and alerts are unchanged");
    const settings = renderToStaticMarkup(<GoogleCalendar manager={m} />);
    expect(settings).toContain("Adding an account never replaces another");
    expect(settings).toContain("home@example.com"); expect(settings).toContain("student@school.example");
    expect(filterCalendarAccounts(Object.values(m.state.notes), m.state.calendarAccounts!).map((n) => n.title)).toEqual(["Home meeting"]);
  });
});
