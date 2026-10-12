import { describe, expect, it } from "vitest";
import { calendarNoteId, reconcileCalendar, type CalendarEvent } from "../src/calendar";
import {
  googleCalendarColor,
  googleEventColor,
  googleFeedToCalendarEvents,
  type GoogleFeed,
} from "../src/google-calendar";
import {
  getReminderColor,
  isValidReminderColor,
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
  it("accept exact hex colours alongside the six named ones", () => {
    expect(isValidReminderColor("sky")).toBe(true);
    expect(isValidReminderColor("#d50000")).toBe(true);
    expect(isValidReminderColor("#D50000")).toBe(false); // stored lowercase
    expect(isValidReminderColor("#fff")).toBe(false);
    expect(isValidReminderColor("red")).toBe(false);
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

  it("show Google's names and a tinted background", () => {
    expect(getReminderColor("#d50000")).toEqual({
      id: "#d50000",
      label: "Tomato",
      hex: "#d50000",
      bg: "rgba(213, 0, 0, 0.16)",
      border: "#d50000",
    });
    expect(getReminderColor("#123456").label).toBe("Custom");
    expect(getReminderColor("sky").label).toBe("Sky");
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

    // Removing access/subscription to one calendar removes only its reminders.
    const remaining = googleFeedToCalendarEvents({
      ...multi, events: multi.events.filter((e) => e.calendarId !== "family"),
    }, opts);
    expect(reconcileCalendar(imported.state, remaining, NOW + 3))
      .toMatchObject({ added: 0, updated: 0, removed: 1 });
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
    expect(r.state.notes[id].color).toBe("sky");
    r = reconcileCalendar(r.state, [base], NOW + 1);
    expect(r).toMatchObject({ added: 0, updated: 1, removed: 0 });
    expect(r.state.notes[id].color).toBe("#0b8043");
    expect(Object.keys(r.state.notes)).toHaveLength(1);
  });
});
