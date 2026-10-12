import { describe, expect, it } from "vitest";
import {
  calendarNoteId,
  hash64,
  reconcileCalendar,
  removeImportedReminders,
  type CalendarEvent,
} from "../src/calendar";
import {
  applyRemote,
  createReminderItem,
  deleteNote,
  emptyState,
  markReminderDone,
  updateItem,
  visibleNotes,
  type SyncState,
} from "../src/sync";

const NOW = Date.UTC(2026, 9, 10, 8, 0);
const H = 3_600_000;
const DAY = 24 * H;

const dentist: CalendarEvent = {
  key: "dentist@google.com",
  title: "Dentist",
  description: "Bring forms",
  location: "High St",
  start: NOW + 2 * DAY,
  end: NOW + 2 * DAY + H,
  allDay: false,
};
const party: CalendarEvent = {
  key: "party@google.com",
  title: "Party",
  description: "",
  location: "",
  start: NOW + 10 * DAY,
  end: NOW + 10 * DAY + 4 * H,
  allDay: false,
};
const birthday: CalendarEvent = {
  key: "bday@google.com",
  title: "Mum's birthday",
  description: "",
  location: "",
  start: NOW + 20 * DAY,
  end: NOW + 20 * DAY + 15 * H,
  allDay: true,
};

const imported = (s: SyncState) => visibleNotes(s).filter((n) => n.source === "gcal");
const idOf = (ev: CalendarEvent) => calendarNoteId(ev.key);

describe("ids", () => {
  it("are deterministic, distinct and valid", () => {
    expect(calendarNoteId("a")).toBe(calendarNoteId("a"));
    expect(calendarNoteId("a")).not.toBe(calendarNoteId("b"));
    expect(calendarNoteId("x@1")).toMatch(/^gcal-[0-9a-f]{24}$/);
    expect(hash64("")).toHaveLength(16);
    const many = new Set(Array.from({ length: 5000 }, (_, i) => calendarNoteId(`uid${i}@g`)));
    expect(many.size).toBe(5000);
  });
});

describe("reconcileCalendar", () => {
  it("imports events as reminders with a 30-minute early alert", () => {
    const r = reconcileCalendar(emptyState(), [dentist, party, birthday], NOW);
    expect(r).toMatchObject({ added: 3, updated: 0, removed: 0 });
    const d = r.state.notes[idOf(dentist)];
    expect(d).toMatchObject({
      kind: "reminder",
      title: "Dentist",
      body: "Bring forms",
      location: "High St",
      reminderAt: dentist.start,
      repeat: "none",
      alertBefore: 30,
      color: "#039be5", // no colour of its own: the calendar's own default
      source: "gcal",
    });
    expect(r.state.notes[idOf(party)].location).toBeNull();
    expect(r.state.notes[idOf(birthday)].alertBefore).toBeNull(); // all-day: single alert
    expect(r.state.outbox).toHaveLength(3);
    expect(r.state.outbox[0]).toMatchObject({ source: "gcal", alertBefore: 30 });
  });

  it("an unchanged calendar writes nothing", () => {
    const s = reconcileCalendar(emptyState(), [dentist, party], NOW).state;
    const r = reconcileCalendar(s, [dentist, party], NOW + 15 * 60_000);
    expect(r).toMatchObject({ added: 0, updated: 0, removed: 0 });
    expect(r.state).toBe(s);
  });

  it("updates changed events but keeps your colour, section and pin", () => {
    let s = reconcileCalendar(emptyState(), [dentist], NOW).state;
    s = updateItem(s, idOf(dentist), { color: "ruby", sectionId: "health", pinned: true }, NOW + 1);
    const moved = { ...dentist, title: "Dentist (check-up)", start: dentist.start + 30 * 60_000 };
    const r = reconcileCalendar(s, [moved], NOW + 2);
    expect(r.updated).toBe(1);
    expect(r.state.notes[idOf(dentist)]).toMatchObject({
      title: "Dentist (check-up)",
      reminderAt: moved.start,
      color: "ruby",
      sectionId: "health",
      pinned: true,
    });
  });

  it("a deleted reminder stays deleted unless the event moves", () => {
    let s = reconcileCalendar(emptyState(), [dentist], NOW).state;
    s = deleteNote(s, idOf(dentist), NOW + 1);
    // details change, time doesn't: stays gone
    let r = reconcileCalendar(s, [{ ...dentist, location: "New surgery" }], NOW + 2);
    expect(r.added + r.updated).toBe(0);
    expect(r.state.notes[idOf(dentist)].deleted).toBe(true);
    // rescheduled: comes back
    r = reconcileCalendar(r.state, [{ ...dentist, start: dentist.start + DAY }], NOW + 3);
    expect(r.added).toBe(1);
    expect(r.state.notes[idOf(dentist)]).toMatchObject({
      deleted: false,
      reminderAt: dentist.start + DAY,
      location: "High St",
    });
  });

  it("a reminder marked done stays done unless the event moves", () => {
    let s = reconcileCalendar(emptyState(), [dentist], NOW).state;
    s = markReminderDone(s, idOf(dentist), NOW + 1);
    expect(s.notes[idOf(dentist)].reminderAt).toBeNull();
    let r = reconcileCalendar(s, [{ ...dentist, description: "changed" }], NOW + 2);
    expect(r.state.notes[idOf(dentist)].reminderAt).toBeNull();
    r = reconcileCalendar(r.state, [{ ...dentist, start: dentist.start + H }], NOW + 3);
    expect(r.state.notes[idOf(dentist)].reminderAt).toBe(dentist.start + H);
  });

  it("removes cancelled and ended events, and done ones once they're over", () => {
    let s = reconcileCalendar(emptyState(), [dentist, party, birthday], NOW).state;
    s = markReminderDone(s, idOf(birthday), NOW + 1);
    // party cancelled; birthday has passed (no longer in the feed's upcoming list)
    const r = reconcileCalendar(s, [dentist], NOW + 2);
    expect(r.removed).toBe(2);
    expect(imported(r.state).map((n) => n.title)).toEqual(["Dentist"]);
  });

  it("works with what other devices did (dismissals sync)", () => {
    // Device A imports and pushes; device B pulls, deletes; A pulls the delete.
    const a1 = reconcileCalendar(emptyState(), [dentist], NOW).state;
    let b = applyRemote(emptyState(), a1.outbox);
    b = deleteNote(b, idOf(dentist), NOW + 1);
    const a2 = applyRemote({ ...a1, outbox: [] }, b.outbox);
    const r = reconcileCalendar(a2, [dentist], NOW + 2);
    expect(r.added).toBe(0);
    expect(r.state.notes[idOf(dentist)].deleted).toBe(true);
    // a fresh device that only ever saw the op log agrees
    const fresh = applyRemote(emptyState(), [...a1.outbox, ...b.outbox]);
    expect(reconcileCalendar(fresh, [dentist], NOW + 3).added).toBe(0);
  });

  it("never touches hand-made reminders", () => {
    const mine = createReminderItem(emptyState(), { title: "Buy milk", reminderAt: NOW + H }, NOW);
    let s = reconcileCalendar(mine.state, [dentist], NOW).state;
    s = reconcileCalendar(s, [], NOW + 1).state;
    expect(s.notes[mine.note.id].deleted).toBe(false);
    s = removeImportedReminders(s, NOW + 2).state;
    expect(s.notes[mine.note.id].deleted).toBe(false);
  });

  it("disconnect removes the imported reminders", () => {
    const s = reconcileCalendar(emptyState(), [dentist, party], NOW).state;
    const r = removeImportedReminders(s, NOW + 1);
    expect(r.removed).toBe(2);
    expect(imported(r.state)).toHaveLength(0);
  });

  it("ignores duplicate occurrences and long fields", () => {
    const long = { ...dentist, title: "x".repeat(500), description: "y".repeat(2000) };
    const r = reconcileCalendar(emptyState(), [long, long], NOW);
    expect(r.added).toBe(1);
    const n = r.state.notes[idOf(dentist)];
    expect(n.title!.length).toBeLessThanOrEqual(200);
    expect(n.body!.length).toBeLessThanOrEqual(500);
  });
});
