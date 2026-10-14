import { describe, expect, it } from "vitest";
import {
  applyRemote, calendarNoteId, deleteNote, emptyState, filterCalendarAccounts, isCalendarAccountSummary,
  LIMITS, markReminderDone, putItem, reconcileCalendar, reconcileClassroom, removeClassroomReminders,
  removeImportedReminders, updateItem, validateOp,
  type CalendarAccountSummary, type CalendarEvent, type ClassroomFeed, type Op,
} from "../src";

const NOW = Date.UTC(2026, 9, 14, 10);
const HOME = "google:home";
const SCHOOL = "google:school";
function event(title = "Shared meeting", start = NOW + 60_000): CalendarEvent {
  return { key: "same-uid@google.com", title, description: "Details", location: "", start, end: start + 3_600_000, allDay: false };
}
const account = (id: string, visible = true, legacyIds = false): CalendarAccountSummary => ({
  id, visible, legacyIds, email: `${id.replace("google:", "")}@example.com`, connectedAt: NOW, problem: null,
});
function classFeed(id: string): ClassroomFeed {
  return { source: "classroom", accountId: id, complete: true, checkedAt: NOW,
    courses: [{ id: "maths", name: "Maths" }], courseWork: [{ id: "work", courseId: "maths", state: "PUBLISHED", title: "Worksheet",
      dueDate: { year: 2026, month: 10, day: 15 }, dueTime: { hours: 15 } }] };
}

function bothCalendars(start = NOW + 60_000) {
  let state = reconcileCalendar(emptyState(), [event("Home meeting", start)], NOW, { accountId: HOME }).state;
  return reconcileCalendar(state, [event("School meeting", start)], NOW, { accountId: SCHOOL }).state;
}

describe("account-scoped imports", () => {
  it("keeps copies of the same event on school and home accounts separate", () => {
    const state = bothCalendars();
    expect(Object.keys(state.notes)).toHaveLength(2);
    expect(state.notes[calendarNoteId(event().key, HOME)]).toMatchObject({ title: "Home meeting", sourceAccountId: HOME });
    expect(state.notes[calendarNoteId(event().key, SCHOOL)]).toMatchObject({ title: "School meeting", sourceAccountId: SCHOOL });
  });

  it("a full check cannot sweep started events from another account", () => {
    const state = bothCalendars(NOW - 60_000);
    const result = reconcileCalendar(state, [event("School meeting", NOW - 60_000)], NOW + 1, { accountId: SCHOOL, sweep: true });
    expect(result.removed).toBe(0);
    expect(result.state.notes[calendarNoteId(event().key, HOME)].deleted).toBe(false);
  });

  it("a cancellation only removes the chosen account's copy", () => {
    const result = reconcileCalendar(bothCalendars(), [], NOW + 1, { accountId: SCHOOL, cancelledKeys: [event().key] });
    expect(result.removed).toBe(1);
    expect(result.state.notes[calendarNoteId(event().key, SCHOOL)].deleted).toBe(true);
    expect(result.state.notes[calendarNoteId(event().key, HOME)].deleted).toBe(false);
  });

  it("manual completion on one account never dismisses the other account's event", () => {
    const id = calendarNoteId(event().key, SCHOOL);
    const state = markReminderDone(bothCalendars(), id, NOW + 1);
    const result = reconcileCalendar(state, [event("Teacher edited title")], NOW + 2, { accountId: SCHOOL });
    expect(result.state.notes[id].reminderAt).toBeNull();
    expect(result.state.notes[calendarNoteId(event().key, HOME)].reminderAt).not.toBeNull();
  });

  it("migrates legacy ownership without duplicate IDs or overwriting personal edits", () => {
    let state = reconcileCalendar(emptyState(), [event()], NOW).state;
    const id = calendarNoteId(event().key);
    state = updateItem(state, id, { title: "My title", sectionId: "folder", pinned: true }, NOW + 1);
    const result = reconcileCalendar(state, [event()], NOW + 2, { accountId: HOME, legacyIds: true });
    expect(Object.keys(result.state.notes)).toEqual([id]);
    expect(result.state.notes[id]).toMatchObject({ title: "My title", pinned: true, sectionId: "folder", sourceAccountId: HOME });
    expect(result.updated).toBe(1);
    expect(reconcileCalendar(result.state, [event()], NOW + 3, { accountId: HOME, legacyIds: true }).updated).toBe(0);
  });

  it("a newly added account cannot claim the old single-account event", () => {
    const legacy = reconcileCalendar(emptyState(), [event("Legacy meeting")], NOW).state;
    const result = reconcileCalendar(legacy, [event("School meeting")], NOW + 1, { accountId: SCHOOL });
    expect(result.state.notes[calendarNoteId(event().key)].title).toBe("Legacy meeting");
    expect(result.state.notes[calendarNoteId(event().key, SCHOOL)].sourceAccountId).toBe(SCHOOL);
  });

  it("bulk-removal recovery does not combine separate accounts' manual deletions", () => {
    let state = bothCalendars();
    state = deleteNote(state, calendarNoteId(event().key, HOME), NOW + 1);
    state = deleteNote(state, calendarNoteId(event().key, SCHOOL), NOW + 1);
    const result = reconcileCalendar(state, [event("School meeting")], NOW + 2, { accountId: SCHOOL });
    expect(result.restored).toBe(0);
    expect(result.state.notes[calendarNoteId(event().key, SCHOOL)].deleted).toBe(true);
  });

  it("disconnect cleanup keeps other accounts, Classroom and handmade items", () => {
    let state = reconcileClassroom(bothCalendars(), classFeed("student"), NOW).state;
    state = putItem(state, "handmade", { text: "Personal", reminderAt: NOW + 60_000 }, NOW);
    const result = removeImportedReminders(state, NOW + 1, { accountId: SCHOOL });
    expect(result.removed).toBe(1);
    expect(Object.values(result.state.notes).filter((n) => !n.deleted)).toHaveLength(3);
    expect(result.state.notes[calendarNoteId(event().key, HOME)].deleted).toBe(false);
  });

  it("supports multiple Classroom accounts and disconnects only the chosen student", () => {
    let state = reconcileClassroom(emptyState(), classFeed("student-a"), NOW).state;
    state = reconcileClassroom(state, classFeed("student-b"), NOW).state;
    const result = removeClassroomReminders(state, NOW + 1, "student-a");
    expect(result.removed).toBe(1);
    expect(Object.values(result.state.notes).find((n) => n.sourceAccountId === "student-b")?.deleted).toBe(false);
  });
});

describe("calendar account visibility", () => {
  it("hides school Calendar events without hiding school Classroom deadlines or handmade reminders", () => {
    let state = reconcileClassroom(bothCalendars(), classFeed(SCHOOL), NOW).state;
    state = putItem(state, "handmade", { text: "Personal", reminderAt: NOW + 60_000 }, NOW);
    const before = JSON.stringify(state);
    const notes = filterCalendarAccounts(Object.values(state.notes), [account(HOME), account(SCHOOL, false)]);
    expect(notes.map((n) => n.sourceAccountId)).toContain(HOME);
    expect(notes.some((n) => n.source === "gcal" && n.sourceAccountId === SCHOOL)).toBe(false);
    expect(notes.some((n) => n.source === "classroom" && n.sourceAccountId === SCHOOL)).toBe(true);
    expect(notes.some((n) => n.id === "handmade")).toBe(true);
    expect(JSON.stringify(state)).toBe(before);
  });

  it("turning all event calendars off still leaves assignments, and turning them on restores the view", () => {
    const state = reconcileClassroom(bothCalendars(), classFeed(SCHOOL), NOW).state;
    const notes = Object.values(state.notes);
    expect(filterCalendarAccounts(notes, [account(HOME, false), account(SCHOOL, false)]).map((n) => n.source)).toEqual(["classroom"]);
    expect(filterCalendarAccounts(notes, [account(HOME), account(SCHOOL)])).toHaveLength(3);
  });

  it("the legacy account's switch also hides older untagged events, not assignments", () => {
    const state = reconcileClassroom(reconcileCalendar(emptyState(), [event()], NOW).state, classFeed(SCHOOL), NOW).state;
    expect(filterCalendarAccounts(Object.values(state.notes), [account(HOME, false, true)]).map((n) => n.source)).toEqual(["classroom"]);
  });
});

describe("ownership sync and validation", () => {
  it("carries account ownership on compacted delete tombstones and preserves it on old ops", () => {
    const id = calendarNoteId(event().key, HOME);
    const state = deleteNote(reconcileCalendar(emptyState(), [event()], NOW, { accountId: HOME }).state, id, NOW + 1);
    expect(state.outbox).toHaveLength(1);
    expect(state.outbox[0]).toMatchObject({ kind: "delete", sourceAccountId: HOME });
    const remote = applyRemote(emptyState(), state.outbox);
    expect(remote.notes[id]).toMatchObject({ deleted: true, sourceAccountId: HOME });
    const old: Op = { id: "old-delete", kind: "delete", noteId: id, updatedAt: NOW + 2 };
    expect(applyRemote(remote, [old]).notes[id].sourceAccountId).toBe(HOME);
  });

  it("rejects malformed account IDs on both upserts and deletes", () => {
    for (const kind of ["delete", "upsert"] as const) {
      const op: Op = { id: "op", kind, noteId: "note", text: "text", updatedAt: NOW };
      for (const bad of [42, "", "x".repeat(LIMITS.sourceAccountIdChars + 1)]) {
        expect(validateOp({ ...op, sourceAccountId: bad } as Op)).toBe("op.sourceAccountId invalid");
      }
      expect(validateOp({ ...op, sourceAccountId: HOME })).toBeNull();
      expect(validateOp({ ...op, sourceAccountId: null })).toBeNull();
    }
  });

  it("validates safe public account summaries before using stored preferences", () => {
    expect(isCalendarAccountSummary(account(HOME))).toBe(true);
    expect(isCalendarAccountSummary({ ...account(HOME), visible: "false" })).toBe(false);
    expect(isCalendarAccountSummary({ ...account(HOME), id: "" })).toBe(false);
  });
});
