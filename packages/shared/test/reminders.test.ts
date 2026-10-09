import { describe, expect, it } from "vitest";
import type { Note } from "../src/protocol";
import {
  formatReminderLabel,
  notificationIdFor,
  reminderDiff,
  roundToMinute,
  schedulableReminders,
} from "../src/reminders";

const NOW = 1_700_000_000_000;

const note = (id: string, reminderAt: number | null, deleted = false): Note => ({
  id,
  text: id,
  createdAt: NOW,
  updatedAt: NOW,
  reminderAt,
  deleted,
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
    const list = [note("a", NOW + 1000), note("b", NOW - 5 * 60_000), note("c", null), note("d", NOW + 2000, true)];
    const got = schedulableReminders(list, NOW);
    expect(got.map((n) => n.id)).toEqual(["a"]);
  });

  it("labels today/tomorrow/weekday", () => {
    const d = new Date(NOW);
    d.setHours(9, 0, 0, 0);
    const today9 = d.getTime() > NOW ? d.getTime() : d.getTime() + 86_400_000;
    expect(formatReminderLabel(today9, NOW)).toMatch(/^(Today|Tomorrow|Sun|Mon|Tue|Wed|Thu|Fri|Sat)/);
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
