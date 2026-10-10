import { describe, expect, it } from "vitest";
import {
  applyRemote,
  createReminderItem,
  emptyState,
  markReminderDone,
  nextOccurrence,
  occurrencesBetween,
  reminderAfterDone,
  repeatSummary,
  stepRepeat,
  updateItem,
  validateOp,
  type Note,
  type Op,
} from "../src/index";

// Local-time helpers so the tests hold in any timezone.
const at = (y: number, m: number, d: number, h = 9, mi = 0) =>
  new Date(y, m - 1, d, h, mi).getTime();
const day = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${d.getMinutes()}`;
};

describe("stepRepeat", () => {
  it("daily / weekly / biweekly add fixed days", () => {
    expect(day(stepRepeat(at(2026, 10, 10), "daily"))).toBe("2026-10-11 9:0");
    expect(day(stepRepeat(at(2026, 10, 10), "weekly"))).toBe("2026-10-17 9:0");
    expect(day(stepRepeat(at(2026, 10, 10), "biweekly"))).toBe("2026-10-24 9:0");
  });

  it("weekdays skips Saturday and Sunday", () => {
    // 2026-10-09 is a Friday
    expect(day(stepRepeat(at(2026, 10, 9), "weekdays"))).toBe("2026-10-12 9:0");
    // 2026-10-10 is a Saturday
    expect(day(stepRepeat(at(2026, 10, 10), "weekdays"))).toBe("2026-10-12 9:0");
  });

  it("monthly clamps the day for short months and keeps the time", () => {
    expect(day(stepRepeat(at(2026, 1, 31, 18, 30), "monthly"))).toBe("2026-2-28 18:30");
    expect(day(stepRepeat(at(2028, 1, 31), "monthly"))).toBe("2028-2-29 9:0");
  });

  it("yearly keeps month and day", () => {
    expect(day(stepRepeat(at(2026, 3, 15), "yearly"))).toBe("2027-3-15 9:0");
    expect(day(stepRepeat(at(2028, 2, 29), "yearly"))).toBe("2029-2-28 9:0");
  });
});

describe("nextOccurrence / reminderAfterDone", () => {
  it("returns null for one-off reminders", () => {
    expect(nextOccurrence(at(2026, 10, 10), "none", 0)).toBeNull();
    expect(nextOccurrence(at(2026, 10, 10), null, 0)).toBeNull();
  });

  it("lands on the first occurrence strictly after now", () => {
    const start = at(2026, 10, 1);
    const now = at(2026, 10, 10, 12);
    expect(day(nextOccurrence(start, "weekly", now) as number)).toBe("2026-10-15 9:0");
  });

  it("rolls a repeating reminder forward and clears a one-off", () => {
    const due = at(2026, 10, 10);
    expect(day(reminderAfterDone(due, "weekly", due + 60_000) as number)).toBe(
      "2026-10-17 9:0",
    );
    expect(reminderAfterDone(due, "none", due + 60_000)).toBeNull();
    expect(reminderAfterDone(null, "daily", 0)).toBeNull();
  });
});

describe("occurrencesBetween", () => {
  const base = (over: Partial<Note>): Note => ({
    id: "n",
    text: "x",
    createdAt: 0,
    updatedAt: 0,
    reminderAt: at(2026, 10, 1),
    deleted: false,
    ...over,
  });

  it("lists every weekly occurrence inside the window", () => {
    const n = base({ repeat: "weekly" });
    const got = occurrencesBetween(n, at(2026, 10, 1), at(2026, 10, 31)).map((t) =>
      new Date(t).getDate(),
    );
    expect(got).toEqual([1, 8, 15, 22, 29]);
  });

  it("returns only the single time for one-off reminders", () => {
    const n = base({ repeat: "none" });
    expect(occurrencesBetween(n, at(2026, 9, 1), at(2026, 11, 1))).toEqual([n.reminderAt]);
    expect(occurrencesBetween(n, at(2026, 10, 2), at(2026, 11, 1))).toEqual([]);
  });

  it("starts from the stored time, never earlier", () => {
    const n = base({ repeat: "daily", reminderAt: at(2026, 10, 20) });
    expect(occurrencesBetween(n, at(2026, 10, 1), at(2026, 10, 22))).toHaveLength(2);
  });
});

describe("sync with repeats", () => {
  it("creates, round-trips through ops, and survives markReminderDone", () => {
    const now = at(2026, 10, 1, 8);
    const fire = at(2026, 10, 5, 9);
    const { state, note } = createReminderItem(
      emptyState(),
      { title: "Bins", reminderAt: fire, repeat: "weekly" },
      now,
    );
    expect(note.repeat).toBe("weekly");
    const op = state.outbox.find((o) => o.noteId === note.id) as Op;
    expect(op.repeat).toBe("weekly");
    expect(validateOp(op)).toBeNull();

    // A second device receives the op and sees the same repeat.
    const remote = applyRemote(emptyState(), [op]);
    expect(remote.notes[note.id].repeat).toBe("weekly");

    // Marking done rolls it to next week and keeps the repeat.
    const after = markReminderDone(state, note.id, fire + 1000);
    expect(day(after.notes[note.id].reminderAt as number)).toBe("2026-10-12 9:0");
    expect(after.notes[note.id].repeat).toBe("weekly");
  });

  it("clears the repeat when the reminder is removed", () => {
    const { state, note } = createReminderItem(
      emptyState(),
      { title: "Gym", reminderAt: at(2026, 10, 5), repeat: "daily" },
      1,
    );
    const cleared = updateItem(state, note.id, { reminderAt: null }, 2);
    expect(cleared.notes[note.id].repeat).toBeNull();
  });

  it("one-off Done still clears the reminder and keeps the note", () => {
    const { state, note } = createReminderItem(
      emptyState(),
      { title: "Call", reminderAt: at(2026, 10, 5) },
      1,
    );
    const done = markReminderDone(state, note.id, at(2026, 10, 5, 10));
    expect(done.notes[note.id].reminderAt).toBeNull();
    expect(done.notes[note.id].deleted).toBe(false);
  });

  it("rejects an unknown repeat value", () => {
    const op = {
      id: "o",
      kind: "upsert",
      noteId: "n",
      text: "x",
      reminderAt: 1,
      repeat: "hourly",
      updatedAt: 1,
    } as unknown as Op;
    expect(validateOp(op)).toBe("op.repeat invalid");
  });

  it("gives human labels", () => {
    expect(repeatSummary("weekdays")).toMatch(/weekday/i);
    expect(repeatSummary("none")).toBe("");
  });
});
