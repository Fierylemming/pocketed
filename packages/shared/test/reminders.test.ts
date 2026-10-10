import { describe, expect, it } from "vitest";
import type { Note } from "../src/protocol";
import {
  buildCalendarMonth,
  filterRemindersByColor,
  formatReminderLabel,
  fromLocalInput,
  localDateKey,
  notificationIdFor,
  quickReminders,
  reminderDiff,
  remindersDueBetween,
  roundToMinute,
  schedulableReminders,
  toLocalInput,
} from "../src/reminders";

const NOW = 1_700_000_000_000;

const note = (
  id: string,
  reminderAt: number | null,
  deleted = false,
  over: Partial<Note> = {},
): Note => ({
  id,
  text: id,
  createdAt: NOW,
  updatedAt: NOW,
  reminderAt,
  deleted,
  ...over,
});

describe("reminders", () => {
  it("notification ids are stable, positive and distinct", () => {
    const a = notificationIdFor("n1", 123);
    const b = notificationIdFor("n1", 123);
    const c = notificationIdFor("n1", 124);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(2147483647);
  });

  it("schedulableReminders skips deleted and past notes", () => {
    const list = [
      note("a", NOW + 1000),
      note("b", NOW - 5 * 60_000),
      note("c", null),
      note("d", NOW + 2000, true),
    ];
    const got = schedulableReminders(list, NOW);
    expect(got.map((n) => n.id)).toEqual(["a"]);
  });

  it("labels today/tomorrow/weekday", () => {
    const d = new Date(NOW);
    d.setHours(9, 0, 0, 0);
    const today9 = d.getTime() > NOW ? d.getTime() : d.getTime() + 86_400_000;
    expect(formatReminderLabel(today9, NOW)).toMatch(
      /^(Today|Tomorrow|Sun|Mon|Tue|Wed|Thu|Fri|Sat)/,
    );
    expect(formatReminderLabel(NOW + 86_400_000, NOW)).toMatch(/.+/);
  });

  it("diff produces schedule + cancel sets", () => {
    const notes = [note("a", NOW + 60_000)];
    const plan = reminderDiff(notes, [42], NOW);
    expect(plan.toSchedule).toHaveLength(1);
    expect(plan.toCancel).toEqual([42]);
  });

  it("rounds to minutes", () => {
    expect(roundToMinute(NOW + 30_000) % 60_000).toBe(0);
  });
});

describe("reminder windows and pickers", () => {
  it("remindersDueBetween is half-open (from, to] and skips deleted", () => {
    const list = [
      note("in", NOW + 10),
      note("edge", NOW + 20),
      note("gone", NOW + 15, true),
      note("none", null),
    ];
    const got = remindersDueBetween(list, NOW, NOW + 20).map((n) => n.id);
    expect(got).toEqual(["in", "edge"]);
    expect(remindersDueBetween(list, NOW + 20, NOW + 30)).toEqual([]);
  });

  it("quick reminders are all in the future and minute-aligned", () => {
    const picks = quickReminders(NOW);
    expect(picks.length).toBeGreaterThan(0);
    for (const p of picks) {
      expect(p.at).toBeGreaterThan(NOW);
      expect(p.at % 60_000).toBe(0);
    }
    const tomorrow = picks.find((p) => p.id === "tomorrow")!;
    expect(new Date(tomorrow.at).getHours()).toBe(9);
  });

  it("datetime-local round-trips in local time", () => {
    const ts = new Date(2026, 4, 3, 7, 45).getTime();
    expect(toLocalInput(ts)).toBe("2026-05-03T07:45");
    expect(fromLocalInput("2026-05-03T07:45")).toBe(ts);
  });

  it("datetime-local rejects garbage and overflowed dates", () => {
    expect(fromLocalInput("")).toBeNull();
    expect(fromLocalInput("nonsense")).toBeNull();
    expect(fromLocalInput("2026-02-31T10:00")).toBeNull();
    expect(fromLocalInput("2026-05-03T25:00")).toBeNull();
  });
});

describe("calendar & colour filtering", () => {
  it("filters reminders by colour and populates calendar month cells", () => {
    const oct10 = new Date(2026, 9, 10, 14, 0).getTime();
    const oct15 = new Date(2026, 9, 15, 9, 30).getTime();
    const list = [
      note("r-ruby", oct10, false, { color: "ruby", title: "Doctor" }),
      note("r-emerald", oct10, false, { color: "emerald", title: "Groceries" }),
      note("r-sky", oct15, false, { color: "sky", title: "Flight" }),
      note("plain-note", null, false, { kind: "note", title: "Ideas" }),
    ];

    expect(filterRemindersByColor(list, "all").map((n) => n.id)).toEqual([
      "r-ruby",
      "r-emerald",
      "r-sky",
    ]);
    expect(filterRemindersByColor(list, "ruby").map((n) => n.id)).toEqual([
      "r-ruby",
    ]);
    expect(filterRemindersByColor(list, "violet")).toEqual([]);

    const gridAll = buildCalendarMonth(2026, 9, list, oct10, "all");
    expect(gridAll).toHaveLength(42);
    const cell10 = gridAll.find((c) => c.dateKey === localDateKey(oct10))!;
    expect(cell10.isToday).toBe(true);
    expect(cell10.reminders.map((r) => r.id)).toEqual(["r-ruby", "r-emerald"]);

    const gridEmerald = buildCalendarMonth(2026, 9, list, oct10, "emerald");
    const cell10Emerald = gridEmerald.find(
      (c) => c.dateKey === localDateKey(oct10),
    )!;
    expect(cell10Emerald.reminders.map((r) => r.id)).toEqual(["r-emerald"]);
  });
});
