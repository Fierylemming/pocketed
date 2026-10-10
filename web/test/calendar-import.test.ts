import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { calendarNoteId, type Op } from "@pocketed/shared";
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
});
