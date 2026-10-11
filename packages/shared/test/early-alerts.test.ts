import { describe, expect, it } from "vitest";
import type { Note, Op } from "../src/protocol";
import { validateOp } from "../src/protocol";
import {
  alertSummary,
  earlyAlertAt,
  earlyAlertsDueBetween,
  formatLeadTime,
  remindersDueBetween,
} from "../src/reminders";
import { applyRemote, emptyState, markReminderDone, updateItem } from "../src/sync";

const T = 1_800_000_000_000;
const MIN = 60_000;

const n = (id: string, reminderAt: number | null, over: Partial<Note> = {}): Note => ({
  id,
  text: id,
  kind: "reminder",
  createdAt: T,
  updatedAt: T,
  reminderAt,
  deleted: false,
  ...over,
});

describe("early alerts", () => {
  it("fires alertBefore minutes ahead, and the main alert still fires at the time", () => {
    const ev = n("dentist", T + 60 * MIN, { alertBefore: 30 });
    expect(earlyAlertAt(ev)).toBe(T + 30 * MIN);
    expect(earlyAlertsDueBetween([ev], T, T + 29 * MIN)).toHaveLength(0);
    const early = earlyAlertsDueBetween([ev], T + 29 * MIN, T + 30 * MIN);
    expect(early).toEqual([{ note: ev, at: T + 30 * MIN, minutes: 30 }]);
    expect(remindersDueBetween([ev], T + 59 * MIN, T + 60 * MIN)).toEqual([ev]);
  });

  it("ignores notes without an early alert, deleted notes and cleared reminders", () => {
    const list = [
      n("plain", T + 60 * MIN),
      n("zero", T + 60 * MIN, { alertBefore: 0 }),
      n("gone", T + 60 * MIN, { alertBefore: 30, deleted: true }),
      n("cleared", null, { alertBefore: 30 }),
    ];
    expect(earlyAlertsDueBetween(list, T, T + 2 * 60 * MIN)).toHaveLength(0);
  });

  it("labels lead times", () => {
    expect(formatLeadTime(30)).toBe("30 min");
    expect(formatLeadTime(60)).toBe("1 hr");
    expect(formatLeadTime(90)).toBe("1 hr 30 min");
    expect(formatLeadTime(1440)).toBe("1 day");
    expect(alertSummary(n("x", T, { alertBefore: 30 }))).toBe(
      "Alerts 30 min before and at the start",
    );
    expect(alertSummary(n("x", T))).toBe("");
  });
});

describe("source + alertBefore through the sync engine", () => {
  const remote: Op = {
    id: "op1",
    kind: "upsert",
    noteId: "gcal-1",
    text: "Dentist",
    itemKind: "reminder",
    title: "Dentist",
    reminderAt: T + 60 * MIN,
    alertBefore: 30,
    source: "gcal",
    updatedAt: T,
  };

  it("validates the new fields", () => {
    expect(validateOp(remote)).toBeNull();
    expect(validateOp({ ...remote, alertBefore: -5 })).toMatch(/alertBefore/);
    expect(validateOp({ ...remote, alertBefore: 1.5 })).toMatch(/alertBefore/);
    expect(validateOp({ ...remote, alertBefore: 99_999 })).toMatch(/alertBefore/);
    expect(validateOp({ ...remote, source: "outlook" as never })).toMatch(/source/);
    expect(validateOp({ ...remote, alertBefore: null, source: null })).toBeNull();
  });

  it("keeps them when pulled, edited locally and marked done", () => {
    let s = applyRemote(emptyState(), [remote]);
    expect(s.notes["gcal-1"]).toMatchObject({ alertBefore: 30, source: "gcal" });

    s = updateItem(s, "gcal-1", { color: "ruby" }, T + 1);
    expect(s.notes["gcal-1"]).toMatchObject({ alertBefore: 30, source: "gcal", color: "ruby" });
    const op = s.outbox[s.outbox.length - 1];
    expect(op).toMatchObject({ alertBefore: 30, source: "gcal" });

    s = markReminderDone(s, "gcal-1", T + 2);
    expect(s.notes["gcal-1"].reminderAt).toBeNull();
    expect(s.notes["gcal-1"].source).toBe("gcal");
  });
});
