import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Note } from "@pocketed/shared";
import { ReminderCalendar } from "../src/components/ReminderCalendar";
import { reminderMeta } from "../src/view-model";

const at = (m: number, d: number, h = 0) => new Date(2026, m, d, h).getTime();
const rem = (id: string, over: Partial<Note>): Note => ({
  id,
  text: id,
  kind: "reminder",
  title: id,
  color: "#039be5",
  createdAt: 0,
  updatedAt: 0,
  reminderAt: null,
  deleted: false,
  ...over,
});

function render(notes: Note[]) {
  return renderToStaticMarkup(
    <ReminderCalendar
      notes={notes}
      sections={[]}
      now={at(9, 1, 8)}
      colorFilter="all"
      onColorFilterChange={() => {}}
      onSelectSection={() => {}}
      onQuickAddReminderForDate={() => {}}
      renderReminderCard={(n) => <li key={n.id}>{n.title}</li>}
    />,
  );
}

/** Class lists of the multi-day segments, in grid order. */
const segments = (html: string) =>
  [...html.matchAll(/class="calendar-pill span([^"]*)"/g)].map((m) => m[1]!.trim());

describe("ReminderCalendar: events running across several days", () => {
  it("draws one joined-up bar, titled on its first day", () => {
    // Mon 12 – Wed 14 Oct, all day.
    const html = render([rem("Trip", { reminderAt: at(9, 12, 9), endAt: at(9, 15), allDay: true })]);
    expect(segments(html)).toEqual([
      "cont-after join-right",
      "cont-before cont-after join-left join-right",
      "cont-before join-left",
    ]);
    // Title once, on the first day; the other segments keep the bar's height.
    expect(html.match(/<span class="calendar-pill-text">Trip<\/span>/g)).toHaveLength(1);
    expect(html).toContain("running across several days");
    expect(html).toContain("day 2 of 3");
  });

  it("cuts the bar at the end of a week row and titles it again on the next", () => {
    // Sat 17 – Mon 19 Oct.
    const html = render([rem("Away", { reminderAt: at(9, 17, 9), endAt: at(9, 20), allDay: true })]);
    expect(segments(html)).toEqual([
      "cont-after", // Saturday: last column, no join across the row's edge
      "cont-before cont-after join-right", // Sunday starts a new row
      "cont-before join-left",
    ]);
    expect(html.match(/<span class="calendar-pill-text">Away<\/span>/g)).toHaveLength(2);
  });

  it("keeps ordinary reminders as single pills", () => {
    const html = render([rem("Dentist", { reminderAt: at(9, 12, 10), endAt: at(9, 12, 11) })]);
    expect(segments(html)).toEqual([]);
    expect(html).toContain(">Dentist<");
  });

  it("labels multi-day reminders with their whole range", () => {
    const n = rem("Trip", { reminderAt: at(9, 12, 9), endAt: at(9, 15), allDay: true });
    expect(reminderMeta(n, at(9, 1))).toBe("📅 Mon 12 Oct – Wed 14 Oct · 3 days");
    expect(reminderMeta(n, at(9, 13, 12))).toContain("now, day 2 of 3");
    expect(reminderMeta(rem("x", { reminderAt: at(9, 12, 10) }), at(9, 1))).toMatch(/^⏰ /);
  });
});
