import { describe, expect, it } from "vitest";
import { calendarNoteId, emptyState, reconcileCalendar } from "@pocketed/shared";
import {
  CalendarParseError,
  cleanDescription,
  parseCalendar,
  parseCalendarDetailed,
  prefilter,
  zonedToEpoch,
} from "../src/ical";

const NOW = Date.UTC(2026, 9, 10, 8, 0); // Sat 10 Oct 2026 09:00 BST
const DAY = 86_400_000;
const opts = { from: NOW, to: NOW + 60 * DAY, timeZone: "Europe/London" };

const VTZ = [
  "BEGIN:VTIMEZONE",
  "TZID:Europe/London",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:+0000",
  "TZOFFSETTO:+0100",
  "TZNAME:BST",
  "DTSTART:19700329T010000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0000",
  "TZNAME:GMT",
  "DTSTART:19701025T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
];

/** Google-Calendar-shaped feed (CRLF, VTIMEZONE, X-WR-TIMEZONE). */
function feed(...events: string[]): string {
  return [
    "BEGIN:VCALENDAR",
    "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
    "VERSION:2.0",
    "X-WR-TIMEZONE:Europe/London",
    ...VTZ,
    ...events,
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

const ev = (lines: string[]) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n");

describe("zonedToEpoch", () => {
  it("handles BST, GMT and other zones", () => {
    expect(zonedToEpoch({ y: 2026, mo: 10, d: 12, h: 10, mi: 0, s: 0 }, "Europe/London")).toBe(
      Date.UTC(2026, 9, 12, 9, 0),
    );
    expect(zonedToEpoch({ y: 2026, mo: 11, d: 2, h: 10, mi: 0, s: 0 }, "Europe/London")).toBe(
      Date.UTC(2026, 10, 2, 10, 0),
    );
    expect(zonedToEpoch({ y: 2026, mo: 7, d: 1, h: 9, mi: 0, s: 0 }, "America/New_York")).toBe(
      Date.UTC(2026, 6, 1, 13, 0),
    );
  });
});

describe("parseCalendar", () => {
  it("reads a timed event with a TZID, location and HTML description", () => {
    const out = parseCalendar(
      feed(
        ev([
          "DTSTART;TZID=Europe/London:20261012T100000",
          "DTEND;TZID=Europe/London:20261012T110000",
          "UID:abc123@google.com",
          "SUMMARY:Dentist",
          "LOCATION:12 High St\\, St Albans",
          "DESCRIPTION:Bring <b>forms</b><br>and card &amp\\; ID",
          "STATUS:CONFIRMED",
        ]),
      ),
      opts,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      key: "abc123@google.com",
      title: "Dentist",
      location: "12 High St, St Albans",
      description: "Bring forms\nand card & ID",
      start: Date.UTC(2026, 9, 12, 9, 0),
      end: Date.UTC(2026, 9, 12, 10, 0),
      allDay: false,
    });
  });

  it("reads UTC times and unfolds long lines", () => {
    const out = parseCalendar(
      feed(
        ev([
          "DTSTART:20261015T140000Z",
          "DTEND:20261015T143000Z",
          "UID:utc@google.com",
          "SUMMARY:A very long meeting title that Google folds onto",
          "  a second line",
        ]),
      ),
      opts,
    );
    expect(out[0].start).toBe(Date.UTC(2026, 9, 15, 14, 0));
    expect(out[0].title).toBe("A very long meeting title that Google folds onto a second line");
  });

  it("reports cancelled events instead of importing them, including one instance of a repeat", () => {
    const parsed = parseCalendarDetailed(
      feed(
        ev([
          "DTSTART:20261012T100000Z",
          "DTEND:20261012T110000Z",
          "UID:keep@g",
          "SUMMARY:Keep me",
          "STATUS:CONFIRMED",
        ]),
        ev([
          "DTSTART:20261013T100000Z",
          "DTEND:20261013T110000Z",
          "UID:gone@g",
          "SUMMARY:Gone",
          "STATUS:CANCELLED",
        ]),
        ev([
          "DTSTART:20261012T120000Z",
          "DTEND:20261012T130000Z",
          "UID:series@g",
          "SUMMARY:Series",
          "RRULE:FREQ=DAILY;COUNT=3",
        ]),
        ev([
          "RECURRENCE-ID:20261013T120000Z",
          "DTSTART:20261013T120000Z",
          "DTEND:20261013T130000Z",
          "UID:series@g",
          "SUMMARY:Series",
          "STATUS:CANCELLED",
        ]),
      ),
      opts,
    );
    const day12 = Date.UTC(2026, 9, 12, 12, 0);
    const day13 = Date.UTC(2026, 9, 13, 12, 0); // the cancelled instance
    const day14 = Date.UTC(2026, 9, 14, 12, 0);
    expect(parsed.events.map((e) => e.key)).toEqual([
      "keep@g",
      `series@g@${day12}`,
      `series@g@${day14}`,
    ]);
    expect(parsed.cancelledKeys).toEqual(["gone@g", `series@g@${day13}`]);
    // The keys are the ones the reminders were made with.
    expect(parsed.cancelledKeys.map((k) => calendarNoteId(k))).toEqual([
      calendarNoteId("gone@g"),
      calendarNoteId(`series@g@${day13}`),
    ]);
  });

  it("puts all-day events at 9:00 in the device's zone and ends them at midnight", () => {
    const out = parseCalendar(
      feed(
        ev([
          "DTSTART;VALUE=DATE:20261103",
          "DTEND;VALUE=DATE:20261104",
          "UID:bday@google.com",
          "SUMMARY:Mum's birthday",
        ]),
      ),
      opts,
    );
    expect(out[0]).toMatchObject({
      allDay: true,
      start: Date.UTC(2026, 10, 3, 9, 0), // GMT in November
      end: Date.UTC(2026, 10, 4, 0, 0),
    });
  });

  it("keeps the whole length of events that run across several days", () => {
    const out = parseCalendar(
      feed(
        // A holiday Mon 12 – Fri 16 Oct, all day.
        ev([
          "DTSTART;VALUE=DATE:20261012",
          "DTEND;VALUE=DATE:20261017",
          "UID:holiday@google.com",
          "SUMMARY:Holiday",
        ]),
        // A conference that began before today and is still on.
        ev([
          "DTSTART;VALUE=DATE:20261008",
          "DTEND;VALUE=DATE:20261012",
          "UID:conf@google.com",
          "SUMMARY:Conference",
        ]),
        // An overnight timed event.
        ev([
          "DTSTART;TZID=Europe/London:20261016T220000",
          "DTEND;TZID=Europe/London:20261017T020000",
          "UID:night@google.com",
          "SUMMARY:Night shift",
        ]),
      ),
      opts,
    );
    const by = Object.fromEntries(out.map((e) => [e.title, e]));
    expect(by.Holiday).toMatchObject({
      allDay: true,
      start: Date.UTC(2026, 9, 12, 8, 0), // 9:00 BST
      end: Date.UTC(2026, 9, 16, 23, 0), // midnight after Fri 16 (BST)
    });
    expect(by.Conference).toMatchObject({ end: Date.UTC(2026, 9, 11, 23, 0) });
    expect(by["Night shift"]).toMatchObject({
      allDay: false,
      start: Date.UTC(2026, 9, 16, 21, 0),
      end: Date.UTC(2026, 9, 17, 1, 0),
    });

    // Imported, the reminders keep their end, so the calendar can span them.
    const { state } = reconcileCalendar(emptyState(), out, NOW);
    const notes = Object.values(state.notes);
    for (const e of out) {
      const n = notes.find((x) => x.title === e.title)!;
      expect(n).toMatchObject({ reminderAt: e.start, endAt: e.end, allDay: e.allDay });
    }
  });

  it("expands weekly repeats across the clocks going back, with exdates, moves and cancellations", () => {
    const out = parseCalendar(
      feed(
        ev([
          "DTSTART;TZID=Europe/London:20260901T180000",
          "DTEND;TZID=Europe/London:20260901T190000",
          "RRULE:FREQ=WEEKLY;BYDAY=TU",
          "EXDATE;TZID=Europe/London:20261020T180000",
          "UID:gym@google.com",
          "SUMMARY:Gym",
        ]),
        // 3 Nov moved to Wednesday 19:30
        ev([
          "DTSTART;TZID=Europe/London:20261104T193000",
          "DTEND;TZID=Europe/London:20261104T203000",
          "RECURRENCE-ID;TZID=Europe/London:20261103T180000",
          "UID:gym@google.com",
          "SUMMARY:Gym (moved)",
        ]),
        // 10 Nov cancelled
        ev([
          "DTSTART;TZID=Europe/London:20261110T180000",
          "DTEND;TZID=Europe/London:20261110T190000",
          "RECURRENCE-ID;TZID=Europe/London:20261110T180000",
          "STATUS:CANCELLED",
          "UID:gym@google.com",
          "SUMMARY:Gym",
        ]),
      ),
      { ...opts, to: Date.UTC(2026, 10, 20) },
    );
    expect(out.map((e) => new Date(e.start).toISOString())).toEqual([
      "2026-10-13T17:00:00.000Z", // BST: 18:00 local
      // 20 Oct excluded
      "2026-10-27T18:00:00.000Z", // GMT now: still 18:00 local
      "2026-11-04T19:30:00.000Z", // moved occurrence
      // 10 Nov cancelled
      "2026-11-17T18:00:00.000Z",
    ]);
    expect(out[2].title).toBe("Gym (moved)");
    expect(new Set(out.map((e) => e.key)).size).toBe(out.length);
    expect(out[2].key).toBe(`gym@google.com@${Date.UTC(2026, 10, 3, 18, 0)}`);
  });

  it("keeps an event that is in progress and drops ones that ended or are past the window", () => {
    const out = parseCalendar(
      feed(
        ev(["DTSTART:20261010T073000Z", "DTEND:20261010T090000Z", "UID:now", "SUMMARY:Now"]),
        ev(["DTSTART:20261009T073000Z", "DTEND:20261009T090000Z", "UID:past", "SUMMARY:Past"]),
        ev(["DTSTART:20270101T090000Z", "DTEND:20270101T100000Z", "UID:far", "SUMMARY:Far"]),
      ),
      opts,
    );
    expect(out.map((e) => e.key)).toEqual(["now"]);
  });

  it("respects COUNT and long-running daily series", () => {
    const out = parseCalendar(
      feed(
        ev(["DTSTART:20200101T090000Z", "DTEND:20200101T091500Z", "RRULE:FREQ=DAILY", "UID:daily", "SUMMARY:Daily"]),
        ev(["DTSTART:20261011T090000Z", "RRULE:FREQ=DAILY;COUNT=3", "UID:three", "SUMMARY:Three"]),
      ),
      opts,
    );
    expect(out.filter((e) => e.key.startsWith("daily@")).length).toBe(60);
    expect(out.filter((e) => e.key.startsWith("three@")).length).toBe(3);
  });

  it("rejects things that aren't calendars", () => {
    expect(() => parseCalendar("<html>Sign in</html>", opts)).toThrow(CalendarParseError);
  });
});

// ---- the speed shortcuts must not change the answer ----

const p2 = (n: number) => String(n).padStart(2, "0");
const local = (d: Date) =>
  `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}T${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}00`;

/** Years of history plus a zoo of repeating series, like a real long-lived calendar. */
function bigFeed(): string {
  const events: string[] = [];
  let t = Date.UTC(2023, 0, 1, 9);
  let i = 0;
  while (t < Date.UTC(2027, 1, 1)) {
    const s = new Date(t);
    const e = new Date(t + 3600e3);
    events.push(
      ev([
        `DTSTART;TZID=Europe/London:${local(s)}`,
        `DTEND;TZID=Europe/London:${local(e)}`,
        `UID:one-${i}@google.com`,
        `SUMMARY:One-off ${i}`,
        "DESCRIPTION:Notes\\nhttps://meet.google.com/abc-defg-hij",
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        "TRIGGER:-P0DT0H30M0S",
        "END:VALARM",
      ]),
    );
    t += 23 * 3600e3;
    i++;
  }
  const series: [string, string, string[]][] = [
    ["daily", "20230105T083000", ["RRULE:FREQ=DAILY"]],
    ["weekdays", "20230102T091500", ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"]],
    ["mon-wed", "20230102T180000", ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE"]],
    ["fortnight", "20230110T120000", ["RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU"]],
    ["every3days", "20230101T070000", ["RRULE:FREQ=DAILY;INTERVAL=3"]],
    // start date doesn't match BYDAY (RFC: the start still counts once)
    ["odd-start", "20230101T100000", ["RRULE:FREQ=WEEKLY;BYDAY=TH"]],
    ["monthly", "20230131T090000", ["RRULE:FREQ=MONTHLY;BYMONTHDAY=31"]],
    ["last-fri", "20230127T160000", ["RRULE:FREQ=MONTHLY;BYDAY=-1FR"]],
    ["yearly", "20231103T090000", ["RRULE:FREQ=YEARLY"]],
    ["ended", "20230101T090000", ["RRULE:FREQ=WEEKLY;UNTIL=20240101T000000Z"]],
    ["counted", "20230101T090000", ["RRULE:FREQ=WEEKLY;COUNT=100"]],
    [
      "with-exdates",
      "20230103T130000",
      [
        "RRULE:FREQ=WEEKLY;BYDAY=TU,TH",
        "EXDATE;TZID=Europe/London:20261013T130000,20261105T130000",
      ],
    ],
    ["ends-soon", "20230104T110000", ["RRULE:FREQ=WEEKLY;UNTIL=20261030T000000Z"]],
  ];
  for (const [uid, start, extra] of series) {
    events.push(
      ev([
        `DTSTART;TZID=Europe/London:${start}`,
        `DTEND;TZID=Europe/London:${start.slice(0, 9)}${p2(Number(start.slice(9, 11)) + 1)}${start.slice(11)}`,
        ...extra,
        `UID:${uid}@google.com`,
        `SUMMARY:${uid}`,
      ]),
    );
  }
  // a moved occurrence of "mon-wed": Mon 19 Oct 2026 -> Fri 23 Oct
  events.push(
    ev([
      "DTSTART;TZID=Europe/London:20261023T080000",
      "DTEND;TZID=Europe/London:20261023T090000",
      "RECURRENCE-ID;TZID=Europe/London:20261019T180000",
      "UID:mon-wed@google.com",
      "SUMMARY:mon-wed (moved)",
    ]),
    // an occurrence from long ago moved into the window
    ev([
      "DTSTART;TZID=Europe/London:20261020T070000",
      "DTEND;TZID=Europe/London:20261020T080000",
      "RECURRENCE-ID;TZID=Europe/London:20230106T083000",
      "UID:daily@google.com",
      "SUMMARY:daily (moved from 2023)",
    ]),
  );
  return feed(...events);
}

describe("speed shortcuts", () => {
  const text = bigFeed();

  it("give exactly the same events as a full parse", () => {
    const fast = parseCalendar(text, opts);
    const exact = parseCalendar(text, { ...opts, noShortcuts: true });
    expect(fast.length).toBeGreaterThan(200);
    expect(fast).toEqual(exact);
    // spot checks
    expect(fast.some((e) => e.title === "mon-wed (moved)")).toBe(true);
    expect(fast.some((e) => e.title === "daily (moved from 2023)")).toBe(true);
    expect(fast.some((e) => e.key.startsWith("ended@"))).toBe(false);
    expect(fast.some((e) => e.key.startsWith("counted@"))).toBe(false);
    expect(fast.filter((e) => e.key.startsWith("ends-soon@")).length).toBe(3);
  });

  it("the pre-filter throws away the history", () => {
    expect(prefilter(text, opts).length).toBeLessThan(text.length / 5);
  });

  it("are fast on a big calendar", () => {
    const t0 = performance.now();
    parseCalendar(text, opts);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(1500); // generous for slow CI; typically far less
  });
});

describe("cleanDescription", () => {
  it("truncates to the reminder body limit", () => {
    expect(cleanDescription("x".repeat(2000)).length).toBeLessThanOrEqual(500);
  });
});
