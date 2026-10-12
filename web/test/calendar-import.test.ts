import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { calendarNoteId, type GoogleFeed, type Op } from "@pocketed/shared";
import { SyncManager } from "../src/store";
import {
  importCalendarNow,
  importedCount,
  loadCalendarState,
  NotConnectedError,
  removeImported,
} from "../src/calendar-import";

const NOW = Date.UTC(2026, 9, 10, 8, 0);

/** A tiny stand-in for the sync server + the relayed Google feed. */
function fakeServer() {
  const log: Op[] = [];
  const srv = {
    log,
    feed: { status: 200, body: "" } as { status: number; body: string },
    /** When set, the server answers like a "Sign in with Google" connection. */
    google: null as unknown,
    connected: true,
    feedCalls: 0,
  };
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    if (url.pathname === "/v1/push") {
      const { ops } = JSON.parse(String(init?.body)) as { ops: Op[] };
      for (const op of ops) if (!log.some((o) => o.id === op.id)) log.push(op);
      return Response.json({ serverSeq: log.length });
    }
    if (url.pathname === "/v1/pull") {
      const cursor = Number(url.searchParams.get("cursor"));
      return Response.json({ ops: log.slice(cursor), cursor: log.length, serverSeq: log.length });
    }
    if (url.pathname === "/v1/calendar/feed") {
      srv.feedCalls++;
      if (!srv.connected) return Response.json({ error: "No calendar connected." }, { status: 409 });
      if (srv.feed.status !== 200) {
        return Response.json({ error: "Google didn't accept that link — it may have been reset." }, { status: 502 });
      }
      if (srv.google) return Response.json(srv.google);
      return new Response(srv.feed.body, { headers: { "content-type": "text/calendar" } });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  });
  return { srv, fetchMock };
}

function ics(...events: [uid: string, summary: string, start: string, end: string][]): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "X-WR-TIMEZONE:Europe/London"];
  for (const [uid, summary, start, end] of events) {
    lines.push("BEGIN:VEVENT", `UID:${uid}`, `SUMMARY:${summary}`, `DTSTART:${start}`, `DTEND:${end}`, "END:VEVENT");
  }
  lines.push("END:VCALENDAR", "");
  return lines.join("\r\n");
}

describe("importCalendarNow", () => {
  let server: ReturnType<typeof fakeServer>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    server = fakeServer();
    vi.stubGlobal("fetch", server.fetchMock);
    const mem = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const manager = () => new SyncManager({ serverUrl: "https://sync.test", token: "pw-12345678" });

  it("imports the feed as reminders and pushes them", async () => {
    server.srv.feed.body = ics(
      ["dentist@g", "Dentist", "20261012T090000Z", "20261012T100000Z"],
      ["old@g", "Old", "20250101T090000Z", "20250101T100000Z"],
    );
    const m = manager();
    const r = await importCalendarNow(m);
    expect(r).toEqual({ added: 1, updated: 0, removed: 0 });
    const n = m.state.notes[calendarNoteId("dentist@g")];
    expect(n).toMatchObject({ title: "Dentist", alertBefore: 30, source: "gcal" });
    expect(importedCount(m.state)).toBe(1);
    expect(loadCalendarState()).toMatchObject({ connected: true, lastCheck: NOW, lastError: null });

    await m.syncOnce();
    expect(server.srv.log.filter((o) => o.source === "gcal")).toHaveLength(1);
  });

  it("a second device agrees and writes nothing new", async () => {
    server.srv.feed.body = ics(["dentist@g", "Dentist", "20261012T090000Z", "20261012T100000Z"]);
    const a = manager();
    await importCalendarNow(a);
    await a.syncOnce();
    const before = server.srv.log.length;

    localStorage.removeItem("pocketed.v2.state"); // a different device
    const b = manager();
    const r = await importCalendarNow(b);
    expect(r).toEqual({ added: 0, updated: 0, removed: 0 });
    await b.syncOnce();
    expect(server.srv.log.length).toBe(before);
  });

  it("reports 'not connected' and errors without touching reminders", async () => {
    server.srv.connected = false;
    await expect(importCalendarNow(manager())).rejects.toBeInstanceOf(NotConnectedError);
    expect(loadCalendarState().connected).toBe(false);

    server.srv.connected = true;
    server.srv.feed.body = "<html>nope</html>";
    await expect(importCalendarNow(manager())).rejects.toThrow(/didn't return a calendar/);
    server.srv.feed = { status: 502, body: "" };
    await expect(importCalendarNow(manager())).rejects.toThrow(/reset/);
    expect(loadCalendarState().lastError).toMatch(/reset/);
  });

  it("disconnect cleanup removes imported reminders", async () => {
    server.srv.feed.body = ics(
      ["a@g", "A", "20261012T090000Z", "20261012T100000Z"],
      ["b@g", "B", "20261013T090000Z", "20261013T100000Z"],
    );
    const m = manager();
    await importCalendarNow(m);
    expect(removeImported(m)).toBe(2);
    expect(importedCount(m.state)).toBe(0);
  });

  it("imports Google sign-in events with their colours, matching the secret-link reminders", async () => {
    // First via the secret link (no colours)…
    server.srv.feed.body = ics(["gym@google.com", "Gym", "20261012T170000Z", "20261012T180000Z"]);
    const m = manager();
    await importCalendarNow(m);
    const id = calendarNoteId("gym@google.com");
    expect(m.state.notes[id].color).toBe("#039be5"); // Peacock: no colours in a secret link

    // …then signed in with Google: same reminder, now in Google's Basil green.
    server.srv.google = {
      source: "google",
      calendar: { colorId: "14", backgroundColor: "#9fe1e7" },
      events: [
        {
          iCalUID: "gym@google.com",
          summary: "Gym",
          colorId: "10",
          start: { dateTime: "2026-10-12T17:00:00Z" },
          end: { dateTime: "2026-10-12T18:00:00Z" },
        },
        {
          iCalUID: "lunch@google.com",
          summary: "Lunch",
          start: { dateTime: "2026-10-13T12:00:00+01:00" },
          end: { dateTime: "2026-10-13T13:00:00+01:00" },
        },
      ],
    };
    const r = await importCalendarNow(m);
    expect(r).toEqual({ added: 1, updated: 1, removed: 0 });
    expect(m.state.notes[id].color).toBe("#0b8043");
    expect(m.state.notes[calendarNoteId("lunch@google.com")]).toMatchObject({
      title: "Lunch",
      color: "#039be5", // the calendar's Peacock blue
      alertBefore: 30,
    });
    await m.syncOnce();
    expect(server.srv.log.find((o) => o.noteId === id && o.color === "#0b8043")).toBeTruthy();
  });

  it("imports an event wearing one of Google's newer event colours (a label)", async () => {
    // Avocado isn't one of the eleven colours events used to have, so it only
    // reaches the API as a label on the event's own calendar.
    const feed: GoogleFeed = {
      source: "google", calendar: { colorId: "14" },
      calendars: [
        { id: "primary-id", primary: true, colorId: "14" },
        {
          id: "family-id",
          colorId: "8",
          eventLabels: [
            { id: "label-avocado", backgroundColor: "#c0ca33", name: "Avocado" },
            { id: "label-custom", backgroundColor: "#7c54c0" },
          ],
        },
      ],
      events: [
        {
          iCalUID: "avocado@google.com", summary: "Salad club", calendarId: "family-id",
          eventLabelId: "label-avocado",
          start: { dateTime: "2026-10-12T10:00:00Z" },
          end: { dateTime: "2026-10-12T11:00:00Z" },
        },
        {
          iCalUID: "custom@google.com", summary: "Pilates", calendarId: "family-id",
          eventLabelId: "label-custom",
          start: { dateTime: "2026-10-13T10:00:00Z" },
          end: { dateTime: "2026-10-13T11:00:00Z" },
        },
        {
          iCalUID: "plain@google.com", summary: "Plain", calendarId: "family-id",
          start: { dateTime: "2026-10-14T10:00:00Z" },
          end: { dateTime: "2026-10-14T11:00:00Z" },
        },
      ],
    };
    server.srv.google = feed;
    const m = manager();
    expect(await importCalendarNow(m)).toEqual({ added: 3, updated: 0, removed: 0 });
    expect(m.state.notes[calendarNoteId('google:["family-id","avocado@google.com"]')].color).toBe("#c0ca33");
    expect(m.state.notes[calendarNoteId('google:["family-id","custom@google.com"]')].color).toBe("#7c54c0");
    expect(m.state.notes[calendarNoteId('google:["family-id","plain@google.com"]')].color).toBe("#0b8043");
    await m.syncOnce();
    expect(server.srv.log.filter((o) => o.source === "gcal")).toHaveLength(3);
  });

  it("imports multiple calendars, syncs them, and keeps reminders when a check fails", async () => {
    const event = {
      iCalUID: "appointment@google.com", summary: "Appointment",
      start: { dateTime: "2026-10-12T10:00:00Z" },
      end: { dateTime: "2026-10-12T11:00:00Z" },
    };
    const feed: GoogleFeed = {
      source: "google", calendar: { colorId: "14" },
      calendars: [
        { id: "primary-id", primary: true, colorId: "14" },
        { id: "family-id", colorId: "8" },
      ],
      events: [
        { ...event, calendarId: "primary-id" },
        { ...event, calendarId: "family-id", summary: "Family appointment" },
      ],
    };
    server.srv.google = feed;
    const m = manager();
    expect(await importCalendarNow(m)).toEqual({ added: 2, updated: 0, removed: 0 });
    expect(importedCount(m.state)).toBe(2);
    expect(m.state.notes[calendarNoteId(event.iCalUID)].color).toBe("#039be5");
    expect(Object.values(m.state.notes).find((n) => n.title === "Family appointment")?.color).toBe("#0b8043");
    await m.syncOnce();
    expect(server.srv.log.filter((o) => o.source === "gcal")).toHaveLength(2);

    // A second device uses the same calendar-scoped IDs, without duplicates.
    localStorage.removeItem("pocketed.v2.state");
    const second = manager();
    expect(await importCalendarNow(second)).toEqual({ added: 0, updated: 0, removed: 0 });
    const before = JSON.stringify(second.state.notes);
    server.srv.feed.status = 502;
    await expect(importCalendarNow(second)).rejects.toThrow();
    expect(JSON.stringify(second.state.notes)).toBe(before);
    expect(loadCalendarState().lastError).toBeTruthy();

    // A successful snapshot after unsubscribing removes only that calendar.
    server.srv.feed.status = 200;
    feed.calendars = feed.calendars!.filter((c) => c.primary);
    feed.events = feed.events.filter((e) => e.calendarId === "primary-id");
    expect(await importCalendarNow(second)).toEqual({ added: 0, updated: 0, removed: 1 });
    expect(importedCount(second.state)).toBe(1);
    expect(second.state.notes[calendarNoteId(event.iCalUID)].title).toBe("Appointment");
  });

});
