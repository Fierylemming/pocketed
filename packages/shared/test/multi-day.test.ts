import { describe, expect, it } from "vitest";
import { reconcileCalendar, type CalendarEvent } from "../src/calendar";
import type { Note } from "../src/protocol";
import { validateOp } from "../src/protocol";
import {
  buildCalendarMonth,
  formatSpanLabel,
  isMultiDay,
  localDateKey,
  occurrenceSpansBetween,
  reminderCoversDay,
  spanDayCount,
} from "../src/reminders";
import {
  applyRemote,
  emptyState,
  markReminderDone,
  putItem,
  updateItem,
  visibleNotes,
} from "../src/sync";

// Local times, so the tests hold in any time zone.
const at = (m: number, d: number, h = 0, mi = 0) => new Date(2026, m, d, h, mi).getTime();
const H = 3_600_000;

const rem = (id: string, over: Partial<Note>): Note => ({
  id,
  text: id,
  kind: "reminder",
  title: id,
  createdAt: 0,
  updatedAt: 0,
  reminderAt: null,
  deleted: false,
  ...over,
});

/** Oct 12–14 2026, all day (Google: start 9:00 on the 12th, end midnight after the 14th). */
const trip = rem("trip", { reminderAt: at(9, 12, 9), endAt: at(9, 15), allDay: true });

describe("how long an event runs", () => {
  it("counts the calendar days it touches", () => {
    expect(spanDayCount(at(9, 12, 9), at(9, 15))).toBe(3);
    expect(spanDayCount(at(9, 12, 22), at(9, 13, 2))).toBe(2); // overnight
    expect(spanDayCount(at(9, 12, 22), at(9, 13, 0))).toBe(1); // ends at midnight
    expect(spanDayCount(at(9, 12, 9), null)).toBe(1);
  });

  it("knows a multi-day event", () => {
    expect(isMultiDay(trip)).toBe(true);
    expect(isMultiDay(rem("x", { reminderAt: at(9, 12, 9), endAt: at(9, 12, 10) }))).toBe(false);
    expect(isMultiDay(rem("x", { reminderAt: at(9, 12, 9) }))).toBe(false);
    // An end before the start is ignored.
    expect(isMultiDay(rem("x", { reminderAt: at(9, 12, 9), endAt: at(9, 10) }))).toBe(false);
  });

  it("finds an event that started before the window and is still on", () => {
    expect(occurrenceSpansBetween(trip, at(9, 13), at(9, 14))).toEqual([
      { start: trip.reminderAt, end: trip.endAt },
    ]);
    expect(occurrenceSpansBetween(trip, at(9, 15), at(9, 16))).toEqual([]);
    expect(reminderCoversDay(trip, "2026-10-14")).toBe(true);
    expect(reminderCoversDay(trip, "2026-10-15")).toBe(false);
    expect(reminderCoversDay(trip, "2026-10-11")).toBe(false);
  });

  it("labels the range, and which day it's on", () => {
    expect(formatSpanLabel(trip, at(9, 1))).toBe("Mon 12 Oct – Wed 14 Oct · 3 days");
    expect(formatSpanLabel(trip, at(9, 13, 12))).toBe(
      "Mon 12 Oct – Wed 14 Oct · 3 days · now, day 2 of 3",
    );
    const overnight = rem("o", { reminderAt: at(9, 16, 22), endAt: at(9, 17, 2) });
    expect(formatSpanLabel(overnight, at(9, 1))).toBe("Fri 16 Oct 22:00 – Sat 17 Oct 02:00");
    expect(formatSpanLabel(rem("x", { reminderAt: at(9, 12, 9) }), 0)).toBeNull();
  });
});

describe("the month grid", () => {
  const cell = (grid: ReturnType<typeof buildCalendarMonth>, m: number, d: number) =>
    grid.find((c) => c.dateKey === localDateKey(at(m, d)))!;

  it("puts a multi-day event on every day it covers", () => {
    const grid = buildCalendarMonth(2026, 9, [trip], at(9, 1));
    for (const d of [12, 13, 14]) expect(cell(grid, 9, d).reminders.map((n) => n.id)).toEqual(["trip"]);
    expect(cell(grid, 9, 11).reminders).toEqual([]);
    expect(cell(grid, 9, 15).reminders).toEqual([]);
    expect(cell(grid, 9, 12).entries[0]).toMatchObject({
      multiDay: true,
      dayIndex: 0,
      dayCount: 3,
      continuesBefore: false,
      continuesAfter: true,
    });
    expect(cell(grid, 9, 14).entries[0]).toMatchObject({
      dayIndex: 2,
      continuesBefore: true,
      continuesAfter: false,
    });
  });

  it("shows an event that began before the visible weeks", () => {
    // October 2026's grid starts on Sun 27 Sep.
    const long = rem("long", { reminderAt: at(8, 20, 9), endAt: at(9, 3), allDay: true });
    const grid = buildCalendarMonth(2026, 9, [long], at(9, 1));
    const first = grid[0]!;
    expect(first.dateKey).toBe("2026-09-27");
    expect(first.entries[0]).toMatchObject({ dayIndex: 7, dayCount: 13, continuesBefore: true });
    expect(cell(grid, 9, 2).entries[0]).toMatchObject({ dayIndex: 12, continuesAfter: false });
    expect(cell(grid, 9, 3).entries).toEqual([]);
  });

  it("keeps each multi-day event in one lane across its days", () => {
    const a = rem("a", { reminderAt: at(9, 12, 9), endAt: at(9, 16), allDay: true }); // Mon–Thu
    const b = rem("b", { reminderAt: at(9, 13, 9), endAt: at(9, 15), allDay: true }); // Tue–Wed
    const single = rem("s", { reminderAt: at(9, 15, 10) }); // Thu
    const grid = buildCalendarMonth(2026, 9, [single, b, a], at(9, 1));
    const lane = (d: number, id: string) =>
      cell(grid, 9, d).slots.findIndex((e) => e?.note.id === id);
    for (const d of [12, 13, 14, 15]) expect(lane(d, "a")).toBe(0);
    for (const d of [13, 14]) expect(lane(d, "b")).toBe(1);
    // b has ended by Thursday, so the single reminder takes the free lane.
    expect(lane(15, "s")).toBe(1);
    expect(cell(grid, 9, 12).slots).toHaveLength(1);
  });

  it("leaves an empty lane so bars below stay lined up", () => {
    const a = rem("a", { reminderAt: at(9, 12, 9), endAt: at(9, 14), allDay: true }); // Mon–Tue
    const b = rem("b", { reminderAt: at(9, 12, 9), endAt: at(9, 16), allDay: true }); // Mon–Thu
    const grid = buildCalendarMonth(2026, 9, [a, b], at(9, 1));
    // Longest first: b in lane 0, a in lane 1; on Wednesday only b remains.
    expect(cell(grid, 9, 12).slots.map((e) => e?.note.id)).toEqual(["b", "a"]);
    expect(cell(grid, 9, 14).slots.map((e) => e?.note.id ?? null)).toEqual(["b"]);
  });

  it("re-packs lanes each week", () => {
    // Sat 17 – Mon 19 Oct crosses into a new week row.
    const weekend = rem("w", { reminderAt: at(9, 17, 9), endAt: at(9, 20), allDay: true });
    const grid = buildCalendarMonth(2026, 9, [weekend], at(9, 1));
    expect(cell(grid, 9, 17).entries[0]).toMatchObject({ continuesAfter: true });
    expect(cell(grid, 9, 18).entries[0]).toMatchObject({ continuesBefore: true, dayIndex: 1 });
    expect(cell(grid, 9, 18).slots[0]?.note.id).toBe("w");
  });
});

describe("sync keeps an event's end", () => {
  it("stores, moves and clears endAt with the reminder", () => {
    let s = putItem(emptyState(), "trip", { ...trip, text: "Trip" }, 1);
    expect(s.outbox[s.outbox.length - 1]).toMatchObject({ endAt: trip.endAt, allDay: true });

    // Moving the reminder keeps the same length.
    s = updateItem(s, "trip", { reminderAt: trip.reminderAt! + 24 * H }, 2);
    expect(s.notes.trip!.endAt).toBe(trip.endAt! + 24 * H);

    // Done clears it along with the time.
    s = markReminderDone(s, "trip", at(9, 20));
    expect(s.notes.trip!.reminderAt).toBeNull();
    expect(s.notes.trip!.endAt).toBeNull();
  });

  it("a repeating reminder's next time keeps its length", () => {
    let s = putItem(
      emptyState(),
      "r",
      { text: "r", kind: "reminder", reminderAt: at(9, 12, 22), endAt: at(9, 13, 1), repeat: "weekly" },
      1,
    );
    s = markReminderDone(s, "r", at(9, 13, 2));
    expect(s.notes.r!.reminderAt).toBe(at(9, 19, 22));
    expect(s.notes.r!.endAt).toBe(at(9, 20, 1));
  });

  it("an op from an older app without endAt keeps the one we have", () => {
    let s = putItem(emptyState(), "trip", { ...trip, text: "Trip" }, 1);
    s = applyRemote(s, [
      { id: "o1", kind: "upsert", noteId: "trip", text: "Trip!", reminderAt: trip.reminderAt, updatedAt: 5 },
    ]);
    expect(s.notes.trip).toMatchObject({ text: "Trip!", endAt: trip.endAt, allDay: true });
  });

  it("validates endAt and allDay", () => {
    const base = { id: "o", kind: "upsert" as const, noteId: "n", text: "t", updatedAt: 1 };
    expect(validateOp({ ...base, endAt: 5, allDay: false })).toBeNull();
    expect(validateOp({ ...base, endAt: null, allDay: null })).toBeNull();
    expect(validateOp({ ...base, endAt: -1 })).toMatch(/endAt/);
    expect(validateOp({ ...base, allDay: 1 as unknown as boolean })).toMatch(/allDay/);
  });
});

describe("calendar import of multi-day events", () => {
  const NOW = at(9, 1, 8);
  const holiday: CalendarEvent = {
    key: "holiday@google.com",
    title: "Holiday",
    description: "",
    location: "",
    start: at(9, 12, 9),
    end: at(9, 17),
    allDay: true,
  };

  it("keeps the end and all-day flag on the reminder", () => {
    const r = reconcileCalendar(emptyState(), [holiday], NOW);
    const [n] = visibleNotes(r.state);
    expect(n).toMatchObject({ reminderAt: holiday.start, endAt: holiday.end, allDay: true });
    expect(isMultiDay(n!)).toBe(true);
    // Checking again changes nothing.
    expect(reconcileCalendar(r.state, [holiday], NOW + H)).toMatchObject({ added: 0, updated: 0 });
  });

  it("fills in the end of reminders imported before it was kept, once", () => {
    const first = reconcileCalendar(emptyState(), [holiday], NOW).state;
    const id = Object.keys(first.notes)[0]!;
    // As an older app (or server) left it: no end, no all-day flag.
    const old = { ...first, outbox: [], notes: { [id]: { ...first.notes[id]!, endAt: undefined, allDay: undefined, title: "My own title" } } };
    const r = reconcileCalendar(old, [holiday], NOW + H);
    expect(r.updated).toBe(1);
    // Only the two fields: your own changes stay.
    expect(r.state.notes[id]).toMatchObject({ endAt: holiday.end, allDay: true, title: "My own title" });
    expect(reconcileCalendar(r.state, [holiday], NOW + 2 * H).updated).toBe(0);
  });

  it("an old reminder you moved stays a moment in time", () => {
    const first = reconcileCalendar(emptyState(), [holiday], NOW).state;
    const id = Object.keys(first.notes)[0]!;
    const moved = { ...first.notes[id]!, reminderAt: at(9, 20, 9), endAt: undefined, allDay: undefined };
    const r = reconcileCalendar({ ...first, notes: { [id]: moved } }, [holiday], NOW + H);
    expect(r.state.notes[id]).toMatchObject({ reminderAt: at(9, 20, 9), endAt: null, allDay: true });
  });

  it("keeps an ongoing multi-day event while it's still on", () => {
    const r = reconcileCalendar(emptyState(), [holiday], NOW).state;
    // Day 3 of the holiday: Google still lists it (it hasn't ended).
    const mid = reconcileCalendar(r, [holiday], at(9, 14, 12));
    expect(mid.removed).toBe(0);
    expect(visibleNotes(mid.state)).toHaveLength(1);
  });
});
