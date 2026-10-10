import { describe, expect, it } from "vitest";
import type { Op } from "@pocketed/shared";
import { handle } from "../src/worker";
import { MemoryStore } from "../src/store";
import { feedHint, normalizeFeedUrl } from "../src/calendar";

const PASS = "test-password-1";
const SECRET =
  "https://calendar.google.com/calendar/ical/me%40gmail.com/private-0123456789abcdef/basic.ics";
const ICS = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";

async function app() {
  const store = new MemoryStore();
  let upstream: () => Response = () => new Response(ICS);
  const fetched: string[] = [];
  const deps = {
    now: () => 1_000,
    fetch: async (url: string) => {
      fetched.push(url);
      return upstream();
    },
  };
  await handle(
    new Request("https://x/v1/init", {
      method: "POST",
      body: JSON.stringify({ password: PASS, recovery: "abcd-1234" }),
    }),
    store,
  );
  const raw = (path: string, body?: unknown, token: string | null = PASS) =>
    handle(
      new Request("https://x" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      store,
      deps,
    );
  const call = async (path: string, body?: unknown) => {
    const r = await raw(path, body);
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  return { store, raw, call, fetched, setUpstream: (f: () => Response) => (upstream = f) };
}

describe("feed links", () => {
  it("accepts https and webcal, rejects the rest", () => {
    expect(normalizeFeedUrl(SECRET)).toBe(SECRET);
    expect(normalizeFeedUrl("  webcal://calendar.google.com/a.ics ")).toBe(
      "https://calendar.google.com/a.ics",
    );
    expect(normalizeFeedUrl("http://calendar.google.com/a.ics")).toBeNull();
    expect(normalizeFeedUrl("https://user:pw@calendar.google.com/a.ics")).toBeNull();
    expect(normalizeFeedUrl("not a link")).toBeNull();
    expect(normalizeFeedUrl(42)).toBeNull();
  });

  it("hints without leaking the secret", () => {
    expect(feedHint(SECRET)).toBe("calendar.google.com · …/basic.ics");
  });
});

describe("calendar endpoints", () => {
  it("need the password", async () => {
    const a = await app();
    for (const p of ["/v1/calendar", "/v1/calendar/feed"]) {
      expect((await a.raw(p, undefined, null)).status).toBe(401);
      expect((await a.raw(p, undefined, "wrong-password-9")).status).toBe(401);
    }
  });

  it("starts disconnected; the feed says so", async () => {
    const a = await app();
    expect((await a.call("/v1/calendar")).body).toEqual({
      connected: false,
      feed: null,
      connectedAt: null,
    });
    const r = await a.call("/v1/calendar/feed");
    expect(r.status).toBe(409);
    expect(a.fetched).toHaveLength(0);
  });

  it("rejects bad links, Google errors and non-calendars without saving", async () => {
    const a = await app();
    expect((await a.call("/v1/calendar", { url: "hello" })).status).toBe(400);

    a.setUpstream(() => new Response("<html>Sign in</html>"));
    const html = await a.call("/v1/calendar", { url: SECRET });
    expect(html.status).toBe(400);
    expect(html.body.error).toMatch(/Secret address in iCal format/);

    a.setUpstream(() => new Response("nope", { status: 404 }));
    const gone = await a.call("/v1/calendar", { url: SECRET });
    expect(gone.status).toBe(502);
    expect(gone.body.error).toMatch(/reset/);

    a.setUpstream(() => {
      throw new Error("network");
    });
    expect((await a.call("/v1/calendar", { url: SECRET })).body.error).toMatch(/reach/);

    expect((await a.call("/v1/calendar")).body.connected).toBe(false);
  });

  it("connects, streams the feed through, and never echoes the secret", async () => {
    const a = await app();
    const c = await a.call("/v1/calendar", { url: SECRET });
    expect(c.status).toBe(200);
    expect(c.body).toEqual({
      connected: true,
      feed: "calendar.google.com · …/basic.ics",
      connectedAt: 1_000,
    });
    expect(JSON.stringify(c.body)).not.toContain("private-0123456789abcdef");

    const big = "BEGIN:VCALENDAR\r\n" + "X-PAD:" + "x".repeat(100_000) + "\r\nEND:VCALENDAR\r\n";
    a.setUpstream(() => new Response(big));
    const f = await a.raw("/v1/calendar/feed");
    expect(f.status).toBe(200);
    expect(f.headers.get("content-type")).toMatch(/text\/calendar/);
    expect(f.headers.get("cache-control")).toBe("no-store");
    expect(f.headers.get("access-control-allow-origin")).toBe("*");
    expect(await f.text()).toBe(big);
    expect(a.fetched.at(-1)).toBe(SECRET);
  });

  it("reports a broken link when relaying", async () => {
    const a = await app();
    await a.call("/v1/calendar", { url: SECRET });
    a.setUpstream(() => new Response("gone", { status: 403 }));
    const r = await a.call("/v1/calendar/feed");
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/reset/);
  });

  it("disconnect forgets the link", async () => {
    const a = await app();
    await a.call("/v1/calendar", { url: SECRET });
    const d = await a.call("/v1/calendar/disconnect", {});
    expect(d.body.connected).toBe(false);
    expect(a.store.calendar).toBeNull();
    expect((await a.call("/v1/calendar/feed")).status).toBe(409);
  });
});

describe("imported reminders sync like any other", () => {
  it("keeps alertBefore, source and sourceRef through push and pull", async () => {
    const a = await app();
    const op: Op = {
      id: "op-1",
      kind: "upsert",
      noteId: "gcal-abc",
      text: "Dentist",
      itemKind: "reminder",
      title: "Dentist",
      reminderAt: 5_000_000,
      alertBefore: 30,
      source: "gcal",
      sourceRef: "5000000:0123456789abcdef",
      updatedAt: 2,
    };
    expect((await a.call("/v1/push", { ops: [op] })).status).toBe(200);
    const pulled = (await a.call("/v1/pull?cursor=0")).body.ops as Op[];
    expect(pulled[0]).toMatchObject({ alertBefore: 30, source: "gcal", sourceRef: op.sourceRef });
    const note = (await a.store.allNotes())[0];
    expect(note).toMatchObject({ alertBefore: 30, source: "gcal", sourceRef: op.sourceRef });

    const bad = await a.call("/v1/push", { ops: [{ ...op, id: "op-2", alertBefore: -1 }] });
    expect(bad.status).toBe(400);
  });
});
