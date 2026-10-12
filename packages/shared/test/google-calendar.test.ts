import { describe, expect, it } from "vitest";
import { calendarNoteId, reconcileCalendar, type CalendarEvent } from "../src/calendar";
import {
  googleCalendarColor,
  googleCancelledKeys,
  googleEventColor,
  googleEventLabels,
  googleFeedToCalendarEvents,
  type GoogleFeed,
} from "../src/google-calendar";
import {
  CALENDAR_REMINDER_COLOR,
  DEFAULT_REMINDER_COLOR,
  getReminderColor,
  isHexColor,
  isValidReminderColor,
  REMINDER_COLORS,
  validateOp,
  type Op,
} from "../src/protocol";
import { emptyState } from "../src/sync";
import { filterRemindersByColor } from "../src/reminders";
import { zonedToEpoch } from "../src/calendar-util";

const NOW = Date.UTC(2026, 9, 10, 8, 0); // 10 Oct 2026, 09:00 London
const DAY = 86_400_000;
const opts = { from: NOW, to: NOW + 60 * DAY, timeZone: "Europe/London" };

function feed(events: GoogleFeed["events"], calendar: GoogleFeed["calendar"] = {}): GoogleFeed {
  return { source: "google", calendar, events };
}

describe("colour values", () => {
  it("accepts exact hex colours, plus the six retired names old reminders carry", () => {
    expect(isValidReminderColor("#d50000")).toBe(true);
    expect(isValidReminderColor("#c0ca33")).toBe(true);
    // Pocketed's pre-Google palette: kept so old reminders (and an older copy
    // of the app still open on a phone) keep syncing.
    expect(isValidReminderColor("sky")).toBe(true);
    expect(isValidReminderColor("rose")).toBe(true);
    expect(isValidReminderColor("#D50000")).toBe(false); // stored lowercase
    expect(isValidReminderColor("#fff")).toBe(false);
    expect(isValidReminderColor("red")).toBe(false);
    expect(isValidReminderColor("tomato")).toBe(false); // names, not Google's names
    expect(isValidReminderColor("toString")).toBe(false); // no prototype keys
    const op = {
      id: "o1",
      kind: "upsert",
      noteId: "n1",
      text: "x",
      updatedAt: 1,
      createdAt: 1,
      reminderAt: 5,
      color: "#33b679",
    } as Op;
    expect(validateOp(op)).toBeNull();
  });

  it("are Google Calendar's palette: the six old names are no longer offered", () => {
    expect(REMINDER_COLORS).toHaveLength(24);
    expect(REMINDER_COLORS.map((c) => c.label)).toEqual(
      expect.arrayContaining(["Tomato", "Peacock", "Avocado", "Graphite"]),
    );
    expect(REMINDER_COLORS.every((c) => isHexColor(c.id))).toBe(true);
    expect(REMINDER_COLORS.some((c) => c.id === "sky")).toBe(false);
    expect(REMINDER_COLORS.some((c) => c.id === "amber")).toBe(false);
    expect(DEFAULT_REMINDER_COLOR).toBe("#f6bf26"); // Banana
    expect(CALENDAR_REMINDER_COLOR).toBe("#039be5"); // Peacock
  });

  it("show Google's names and a tinted background", () => {
    expect(getReminderColor("#d50000")).toEqual({
      id: "#d50000",
      label: "Tomato",
      hex: "#d50000",
      bg: "rgba(213, 0, 0, 0.16)",
      border: "#d50000",
    });
    expect(getReminderColor("#123456").label).toBe("Custom");
    // A retired name reads as the Google shade closest to it.
    expect(getReminderColor("sky")).toMatchObject({ id: "#039be5", label: "Peacock" });
    expect(getReminderColor("ruby")).toMatchObject({ id: "#e67c73", label: "Flamingo" });
    expect(getReminderColor(null)).toMatchObject({ id: "#f6bf26", label: "Banana" });
  });

  it("filter by exact colour", () => {
    const ev = (key: string, color?: CalendarEvent["color"]): CalendarEvent => ({
      key,
      title: key,
      description: "",
      location: "",
      start: NOW + DAY,
      end: NOW + DAY + 1,
      allDay: false,
      color,
    });
    const s = reconcileCalendar(emptyState(), [ev("a", "#d50000"), ev("b")], NOW).state;
    const notes = Object.values(s.notes);
    expect(filterRemindersByColor(notes, "#d50000").map((n) => n.id)).toEqual([calendarNoteId("a")]);
    expect(filterRemindersByColor(notes, "sky").map((n) => n.id)).toEqual([calendarNoteId("b")]);
  });
});

describe("Google colours", () => {
  it("translate event colour ids to the shades Google Calendar shows", () => {
    expect(googleEventColor({ colorId: "11" }, null)).toBe("#d50000"); // Tomato
    expect(googleEventColor({ colorId: "2" }, null)).toBe("#33b679"); // Sage
    expect(googleEventColor({ colorId: "10" }, "#039be5")).toBe("#0b8043"); // Basil
  });

  it("take an event's own colour from its label (Google's 24 event colours, and custom ones)", () => {
    const avocado = new Map([["label-1", "#c0ca33" as const]]);
    expect(googleEventColor({ eventLabelId: "label-1" }, "#039be5", avocado)).toBe("#c0ca33");
    // A label is what the UI shows, so it wins over a stale legacy colour id…
    expect(
      googleEventColor({ eventLabelId: "label-2", colorId: "10" }, null, new Map([["label-2", "#7c54c0"]])),
    ).toBe("#7c54c0");
    // …but an unreadable label still falls back to the id, then the calendar.
    expect(googleEventColor({ eventLabelId: "gone", colorId: "10" }, "#039be5", avocado)).toBe("#0b8043");
    expect(googleEventColor({ eventLabelId: "gone" }, "#039be5", avocado)).toBe("#039be5");
    expect(googleEventColor({ eventLabelId: "label-1" }, "#039be5", null)).toBe("#039be5");
  });

  it("index a calendar's labels by id, ignoring unusable ones", () => {
    expect(
      googleEventLabels({
        id: "me",
        eventLabels: [
          { id: "a", backgroundColor: "#C0CA33" }, // stored lowercase
          { id: "b", backgroundColor: "avocado" },
          { id: "", backgroundColor: "#123456" },
          { id: "c" } as never,
        ],
      }),
    ).toEqual(new Map([["a", "#c0ca33"]]));
    expect(googleEventLabels(null).size).toBe(0);
    expect(googleEventLabels({ id: "me" }).size).toBe(0);
  });

  it("fall back to the calendar's colour (modern shade, or a custom one exactly)", () => {
    expect(googleEventColor({}, "#039be5")).toBe("#039be5");
    expect(googleCalendarColor({ colorId: "14", backgroundColor: "#9fe1e7" })).toBe("#039be5");
    expect(googleCalendarColor({ backgroundColor: "#9FE1E7" })).toBe("#039be5");
    expect(googleCalendarColor({ colorId: "14", backgroundColor: "#Ab12Cd" })).toBe("#ab12cd");
    expect(googleCalendarColor({ colorId: "7" })).toBe("#009688");
    expect(googleCalendarColor({})).toBeNull();
    expect(googleCalendarColor({ backgroundColor: "blue" })).toBeNull();
  });
});

describe("Google events -> calendar events", () => {
  it("converts timed, all-day and repeating events with keys matching the iCal import", () => {
    const events = googleFeedToCalendarEvents(
      feed(
        [
          {
            iCalUID: "dentist@google.com",
            summary: "  Dentist ",
            description: "Bring <b>forms</b><br>please",
            location: "High St",
            colorId: "11",
            start: { dateTime: "2026-10-12T10:00:00+01:00" },
            end: { dateTime: "2026-10-12T10:30:00+01:00" },
          },
          {
            iCalUID: "bday@google.com",
            start: { date: "2026-10-20" },
            end: { date: "2026-10-21" },
          },
          {
            iCalUID: "standup@google.com",
            recurringEventId: "standup",
            summary: "Stand-up",
            start: { dateTime: "2026-10-13T09:30:00+01:00" },
            end: { dateTime: "2026-10-13T09:45:00+01:00" },
            originalStartTime: { dateTime: "2026-10-13T09:00:00+01:00" },
          },
          {
            iCalUID: "bins@google.com",
            recurringEventId: "bins",
            summary: "Bins",
            start: { date: "2026-10-14" },
            end: { date: "2026-10-15" },
            originalStartTime: { date: "2026-10-14" },
          },
        ],
        { colorId: "14", backgroundColor: "#9fe1e7" },
      ),
      opts,
    );
    expect(events).toEqual<CalendarEvent[]>([
      {
        key: "dentist@google.com",
        title: "Dentist",
        description: "Bring forms\nplease",
        location: "High St",
        start: Date.UTC(2026, 9, 12, 9, 0),
        end: Date.UTC(2026, 9, 12, 9, 30),
        allDay: false,
        color: "#d50000",
      },
      {
        key: `standup@google.com@${Date.UTC(2026, 9, 13, 8, 0)}`,
        title: "Stand-up",
        description: "",
        location: "",
        start: Date.UTC(2026, 9, 13, 8, 30),
        end: Date.UTC(2026, 9, 13, 8, 45),
        allDay: false,
        color: "#039be5",
      },
      {
        key: `bins@google.com@${zonedToEpoch({ y: 2026, mo: 10, d: 14, h: 0, mi: 0, s: 0 }, "Europe/London")}`,
        title: "Bins",
        description: "",
        location: "",
        start: Date.UTC(2026, 9, 14, 8, 0), // 9:00 London
        end: Date.UTC(2026, 9, 14, 23, 0), // midnight London
        allDay: true,
        color: "#039be5",
      },
      {
        key: "bday@google.com",
        title: "(No title)",
        description: "",
        location: "",
        start: Date.UTC(2026, 9, 20, 8, 0),
        end: Date.UTC(2026, 9, 20, 23, 0),
        allDay: true,
        color: "#039be5",
      },
    ]);
  });

  it("keeps calendar identities and colours separate while preserving primary reminder IDs", () => {
    const event = {
      iCalUID: "same@google.com", summary: "Shared appointment",
      start: { dateTime: "2026-10-12T10:00:00Z" },
      end: { dateTime: "2026-10-12T11:00:00Z" },
    };
    const multi: GoogleFeed = {
      source: "google", calendar: { colorId: "14" },
      calendars: [
        { id: "me", primary: true, colorId: "14" },
        { id: "family", colorId: "8" },
        { id: "work", backgroundColor: "#123456" },
      ],
      events: [
        { ...event, calendarId: "me" },
        { ...event, calendarId: "family" },
        { ...event, calendarId: "work", colorId: "11" },
      ],
    };
    const converted = googleFeedToCalendarEvents(multi, opts);
    expect(new Set(converted.map((e) => e.key)).size).toBe(3);
    expect(converted.find((e) => e.key === event.iCalUID)?.color).toBe("#039be5");
    expect(converted.find((e) => e.key.includes('"family"'))?.color).toBe("#0b8043");
    expect(converted.find((e) => e.key.includes('"work"'))?.color).toBe("#d50000");

    const old = reconcileCalendar(emptyState(), googleFeedToCalendarEvents(feed([event], multi.calendar), opts), NOW);
    const imported = reconcileCalendar(old.state, converted, NOW + 1);
    expect(imported).toMatchObject({ added: 2, updated: 0, removed: 0 });
    const again = reconcileCalendar(imported.state, googleFeedToCalendarEvents({
      ...multi, calendars: [...multi.calendars!].reverse(), events: [...multi.events].reverse(),
    }, opts), NOW + 2);
    expect(again).toMatchObject({ added: 0, updated: 0, removed: 0 });

    // A calendar that drops out of the feed doesn't cost its reminders: the
    // event is still to come, so the reminder stays until it has started.
    const remaining = googleFeedToCalendarEvents({
      ...multi, events: multi.events.filter((e) => e.calendarId !== "family"),
    }, opts);
    const kept = reconcileCalendar(imported.state, remaining, NOW + 3);
    expect(kept).toMatchObject({ added: 0, updated: 0, removed: 0, kept: 1 });
    const familyKey = converted.find((e) => e.key.includes('"family"'))!.key;
    expect(kept.state.notes[calendarNoteId(familyKey)].deleted).toBe(false);

    // Once that event has started and the calendar still doesn't list it, its
    // reminder goes like any other event that's over.
    expect(reconcileCalendar(kept.state, remaining, NOW + 3 * DAY))
      .toMatchObject({ removed: 1, kept: 0 });
  });

  it("keeps the rest of the window when the feed doesn't say where it ends", () => {
    // The server cuts the feed to the upcoming window with its own clock, so
    // the app passes no window of its own: nothing is dropped for being far off.
    const at = (uid: string, days: number) => ({
      iCalUID: uid,
      start: { dateTime: new Date(NOW + days * DAY).toISOString() },
      end: { dateTime: new Date(NOW + days * DAY + 3_600_000).toISOString() },
    });
    const events = [at("soon", 1), at("later", 30), at("latest", 59)];
    expect(
      googleFeedToCalendarEvents(feed(events), { timeZone: "Europe/London" }).map((e) => e.key),
    ).toEqual(["soon", "later", "latest"]);
    // …whereas an explicit window still filters, for callers that want one.
    expect(
      googleFeedToCalendarEvents(feed(events), { ...opts, to: NOW + 7 * DAY }).map((e) => e.key),
    ).toEqual(["soon"]);
  });

  it("collects the events Google reports as cancelled or deleted, and their exact keys", () => {
    const event = {
      iCalUID: "same@google.com", summary: "Shared appointment",
      start: { dateTime: "2026-10-12T10:00:00Z" },
      end: { dateTime: "2026-10-12T11:00:00Z" },
    };
    const cancelled: GoogleFeed = {
      source: "google",
      calendar: { colorId: "14" },
      calendars: [{ id: "me", primary: true, colorId: "14" }, { id: "family", colorId: "8" }],
      events: [
        { iCalUID: "one-off@google.com", status: "cancelled" },
        {
          iCalUID: "rep@google.com",
          status: "cancelled",
          recurringEventId: "rep@google.com",
          originalStartTime: { dateTime: "2026-10-12T10:00:00Z" },
        },
        { iCalUID: "fam@google.com", status: "cancelled", calendarId: "family" },
        { iCalUID: "wfh@google.com", status: "cancelled", eventType: "workingLocation" },
        {
          iCalUID: "declined@google.com",
          status: "cancelled",
          attendees: [{ self: true, responseStatus: "declined" }],
        },
        { ...event, calendarId: "me" }, // still on: not a cancellation
      ],
    };
    expect(googleCancelledKeys(cancelled, opts)).toEqual([
      "one-off@google.com",
      `rep@google.com@${Date.UTC(2026, 9, 12, 10, 0)}`,
      `google:${JSON.stringify(["family", "fam@google.com"])}`,
    ]);
    // The keys match what the importer would have called those reminders.
    expect(calendarNoteId(googleCancelledKeys(cancelled, opts)[0])).toBe(
      calendarNoteId("one-off@google.com"),
    );
    // Only the event that is still on becomes a reminder.
    expect(googleFeedToCalendarEvents(cancelled, opts).map((e) => e.key)).toEqual([
      "same@google.com",
    ]);
  });

  it("resolves an event's label against its own calendar, falling back when unknown", () => {
    const at = (iCalUID: string, extra: Partial<GoogleFeed["events"][number]> = {}) => ({
      iCalUID,
      start: { dateTime: "2026-10-12T10:00:00Z" },
      end: { dateTime: "2026-10-12T11:00:00Z" },
      ...extra,
    });
    const multi: GoogleFeed = {
      source: "google", calendar: { colorId: "14" },
      calendars: [
        // The same label id on two calendars is two different colours.
        { id: "me", primary: true, colorId: "14", eventLabels: [{ id: "L", backgroundColor: "#c0ca33" }] },
        { id: "family", colorId: "8", eventLabels: [{ id: "L", backgroundColor: "#ad1457" }] },
      ],
      events: [
        at("a", { calendarId: "me", eventLabelId: "L" }),
        at("b", { calendarId: "family", eventLabelId: "L" }),
        at("c", { calendarId: "family", eventLabelId: "gone" }), // calendar's labels not read
        at("d", { calendarId: "family", colorId: "11" }),
      ],
    };
    const converted = googleFeedToCalendarEvents(multi, opts);
    const color = (key: string) => converted.find((e) => e.key.includes(key))?.color;
    expect(color('"a"')).toBeUndefined(); // the primary calendar's key isn't prefixed
    expect(converted.find((e) => e.key === "a")?.color).toBe("#c0ca33");
    expect(color('["family","b"]')).toBe("#ad1457");
    expect(color('["family","c"]')).toBe("#0b8043");
    expect(color('["family","d"]')).toBe("#d50000");
  });

  it("uses stable recurring keys per calendar, including all-day events and moved instances", () => {
    const multi: GoogleFeed = {
      source: "google", calendar: {},
      calendars: [{ id: "family", colorId: "8" }],
      events: [
        { calendarId: "family", iCalUID: "repeat", recurringEventId: "r",
          originalStartTime: { date: "2026-10-12" }, start: { date: "2026-10-13" } },
        { calendarId: "family", iCalUID: "repeat", recurringEventId: "r",
          originalStartTime: { date: "2026-10-19" }, start: { date: "2026-10-19" } },
      ],
    };
    const before = googleFeedToCalendarEvents(multi, opts);
    expect(before[0].key).not.toBe(before[1].key);
    multi.events[0].start = { date: "2026-10-14" };
    const after = googleFeedToCalendarEvents(multi, opts);
    expect(after.map((e) => e.key)).toEqual(before.map((e) => e.key));
    expect(after[0]).toMatchObject({ allDay: true, color: "#0b8043" });
  });

  it("sorts and caps events across all calendars, not separately per calendar", () => {
    const multi: GoogleFeed = {
      source: "google", calendar: {},
      calendars: [{ id: "me", primary: true }, { id: "family" }],
      events: [
        { calendarId: "me", id: "later", start: { date: "2026-10-20" } },
        { calendarId: "family", id: "sooner", start: { date: "2026-10-12" } },
      ],
    };
    const out = googleFeedToCalendarEvents(multi, { ...opts, maxEvents: 1 });
    expect(out).toHaveLength(1);
    expect(out[0].key).toContain("sooner");
    expect(out[0].color).toBeNull();
  });

  it("skips cancelled, declined, working-location and out-of-window events", () => {
    const t = (iso: string) => ({ dateTime: iso });
    const events = googleFeedToCalendarEvents(
      feed([
        { iCalUID: "x1", status: "cancelled", start: t("2026-10-12T10:00:00Z"), end: t("2026-10-12T11:00:00Z") },
        {
          iCalUID: "x2",
          attendees: [{ self: true, responseStatus: "declined" }],
          start: t("2026-10-12T10:00:00Z"),
          end: t("2026-10-12T11:00:00Z"),
        },
        { iCalUID: "x3", eventType: "workingLocation", start: { date: "2026-10-12" }, end: { date: "2026-10-13" } },
        { iCalUID: "x4", start: t("2026-10-09T10:00:00Z"), end: t("2026-10-09T11:00:00Z") }, // over
        { iCalUID: "x5", start: t("2027-01-09T10:00:00Z"), end: t("2027-01-09T11:00:00Z") }, // too far
        { iCalUID: "ok", start: t("2026-10-10T07:00:00Z"), end: t("2026-10-10T09:00:00Z") }, // on now
        {
          iCalUID: "ok2",
          attendees: [{ self: true, responseStatus: "accepted" }],
          start: t("2026-10-12T10:00:00Z"),
          end: t("2026-10-12T11:00:00Z"),
        },
      ]),
      opts,
    );
    expect(events.map((e) => e.key)).toEqual(["ok", "ok2"]);
  });
});

describe("reconcile with Google colours", () => {
  const base: CalendarEvent = {
    key: "e@google.com",
    title: "Gym",
    description: "",
    location: "",
    start: NOW + DAY,
    end: NOW + DAY + 3_600_000,
    allDay: false,
    color: "#0b8043",
  };
  const id = calendarNoteId(base.key);

  it("copies the colour, and follows colour changes made in Google", () => {
    let r = reconcileCalendar(emptyState(), [base], NOW);
    expect(r.state.notes[id].color).toBe("#0b8043");

    r = reconcileCalendar(r.state, [{ ...base, color: "#d50000" }], NOW + 1);
    expect(r.updated).toBe(1);
    expect(r.state.notes[id].color).toBe("#d50000");
  });

  it("switching from the secret link to Google recolours instead of duplicating", () => {
    const { color: _c, ...noColour } = base;
    let r = reconcileCalendar(emptyState(), [noColour], NOW);
    expect(r.state.notes[id].color).toBe("#039be5");
    r = reconcileCalendar(r.state, [base], NOW + 1);
    expect(r).toMatchObject({ added: 0, updated: 1, removed: 0 });
    expect(r.state.notes[id].color).toBe("#0b8043");
    expect(Object.keys(r.state.notes)).toHaveLength(1);
  });
});
