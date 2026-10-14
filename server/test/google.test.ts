import { describe, expect, it } from "vitest";
import type { GoogleCalendar, GoogleEvent, GoogleEventLabel, Op } from "@pocketed/shared";
import { handle } from "../src/worker";
import { MemoryStore } from "../src/store";
import { GOOGLE_SCOPE, GOOGLE_CALENDAR_SCOPES, normalizeReturnUrl } from "../src/google";

const PASS = "test-password-1";
const GOOGLE = { clientId: "cid.apps.googleusercontent.com", clientSecret: "shh" };
const APP = "https://pocketed.example.pages.dev/";
const ICS = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";

type EventPage = { items?: GoogleEvent[]; nextPageToken?: string };
type CalendarPage = {
  items?: (GoogleCalendar & { accessRole: string; hidden?: boolean; selected?: boolean; deleted?: boolean })[];
  nextPageToken?: string;
};

interface Call {
  url: string;
  method: string;
  body: string;
  auth: string | null;
}

/** GET /calendars/{id} — the calendar resource, which carries the events' labels. */
const LABEL_CALL = /\/calendars\/[^/?]+(\?|$)/;

/** A pretend Google: token endpoint, revoke, calendarList and events. */
function fakeGoogle() {
  const calls: Call[] = [];
  const g = {
    calls,
    scope: GOOGLE_CALENDAR_SCOPES.join(" "),
    accountId: "google-home",
    email: "me@gmail.com",
    invalidProfile: false,
    eventWait: null as Promise<void> | null,
    onEvents: null as (() => void) | null,
    refreshWait: null as Promise<void> | null,
    onRefresh: null as (() => void) | null,
    refreshError: null as string | null,
    tokenCount: 0,
    calendarPages: [{ items: [{
      id: "me@gmail.com", primary: true, accessRole: "owner",
      colorId: "14", backgroundColor: "#9fe1e7",
    }] }] as CalendarPage[],
    otherEvents: {} as Record<string, EventPage[]>,
    /** labelProperties per calendar, as the calendar resource reports them. */
    labels: {} as Record<string, { labelProperties?: { eventLabels?: GoogleEventLabel[] } }>,
    failCalendar: null as string | null,
    failLabels: null as string | null,
    unauthorizedOnce: false,
    pages: [
      {
        items: [
          {
            id: "a",
            iCalUID: "a@google.com",
            summary: "Dentist",
            colorId: "11",
            start: { dateTime: "2026-10-12T10:00:00+01:00" },
            end: { dateTime: "2026-10-12T10:30:00+01:00" },
          },
          { id: "b", iCalUID: "b@google.com", status: "cancelled" },
          {
            id: "c",
            iCalUID: "c@google.com",
            eventType: "workingLocation",
            start: { date: "2026-10-13" },
            end: { date: "2026-10-14" },
          },
        ],
        nextPageToken: "p2",
      },
      {
        items: [
          {
            id: "d",
            iCalUID: "d@google.com",
            summary: "Declined meeting",
            attendees: [{ self: true, responseStatus: "declined" }],
            start: { dateTime: "2026-10-14T10:00:00Z" },
            end: { dateTime: "2026-10-14T11:00:00Z" },
          },
          {
            id: "e",
            iCalUID: "e@google.com",
            summary: "Holiday",
            start: { date: "2026-10-20" },
            end: { date: "2026-10-22" },
          },
        ],
      },
    ],
    fetch: async (url: string, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === "string" ? init.body : "";
      calls.push({ url, method: init?.method ?? "GET", body, auth: headers.get("authorization") });
      const u = new URL(url);
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        const form = new URLSearchParams(body);
        if (form.get("grant_type") === "refresh_token") { g.onRefresh?.(); if (g.refreshWait) await g.refreshWait; }
        if (form.get("grant_type") === "refresh_token" && g.refreshError) {
          return Response.json({ error: g.refreshError }, { status: 400 });
        }
        g.tokenCount++;
        return Response.json({
          access_token: `at-${g.tokenCount}`,
          expires_in: 3600,
          scope: g.scope,
          ...(form.get("grant_type") === "authorization_code" ? { refresh_token: g.accountId === "google-home" ? "rt-1" : `rt-${g.accountId}` } : {}),
        });
      }
      if (url.startsWith("https://oauth2.googleapis.com/revoke")) return new Response("");
      if (u.hostname === "openidconnect.googleapis.com") return Response.json(g.invalidProfile ? {} : { sub: g.accountId, email: g.email });
      if (u.pathname.endsWith("/users/me/calendarList/primary")) {
        return Response.json({ id: "me@gmail.com", colorId: "14", backgroundColor: "#9fe1e7" });
      }
      if (u.pathname.endsWith("/users/me/calendarList")) {
        const page = Number(u.searchParams.get("pageToken") ?? 0);
        return Response.json(g.calendarPages[page]);
      }
      const calPath = /\/calendars\/([^/]+)$/.exec(u.pathname);
      if (calPath) {
        const id = decodeURIComponent(calPath[1]);
        if (id === g.failLabels) return new Response("not yours", { status: 403 });
        return Response.json(g.labels[id] ?? {});
      }
      const eventPath = /\/calendars\/([^/]+)\/events$/.exec(u.pathname);
      if (eventPath) {
        g.onEvents?.();
        if (g.eventWait) await g.eventWait;
        const id = decodeURIComponent(eventPath[1]);
        if (g.unauthorizedOnce) {
          g.unauthorizedOnce = false;
          return new Response("expired", { status: 401 });
        }
        if (id === g.failCalendar) return new Response("unavailable", { status: 503 });
        const pages = id === "me@gmail.com" ? g.pages : g.otherEvents[id];
        return pages
          ? Response.json(u.searchParams.get("pageToken") === "p2" ? pages[1] : pages[0])
          : new Response("not found", { status: 404 });
      }
      if (url.endsWith(".ics")) return new Response(ICS);
      return new Response("not found", { status: 404 });
    },
  };
  return g;
}

async function app(opts: { google?: boolean } = {}) {
  const store = new MemoryStore();
  const g = fakeGoogle();
  let t = 1_000_000;
  const deps = {
    now: () => t,
    fetch: g.fetch,
    google: opts.google === false ? undefined : GOOGLE,
  };
  await handle(
    new Request("https://w.example/v1/init", {
      method: "POST",
      body: JSON.stringify({ password: PASS, recovery: "abcd-1234" }),
    }),
    store,
  );
  const raw = (path: string, body?: unknown, token: string | null = PASS) =>
    handle(
      new Request("https://w.example" + path, {
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
  /** Runs the whole sign-in: start, then Google's redirect back. */
  const signIn = async (callback: Record<string, string> = { code: "the-code" }) => {
    const s = await call("/v1/google/start", { returnUrl: APP + "?x=1#old" });
    const state = new URL(s.body.url).searchParams.get("state")!;
    const q = new URLSearchParams({ state, ...callback });
    return raw(`/v1/google/callback?${q}`, undefined, null);
  };
  return { store, g, raw, call, signIn, advance: (ms: number) => (t += ms) };
}

describe("return address", () => {
  it("allows https and local http only, and strips extras", () => {
    expect(normalizeReturnUrl("https://a.example/app/?q=1#h")).toBe("https://a.example/app/");
    expect(normalizeReturnUrl("http://localhost:5173/")).toBe("http://localhost:5173/");
    expect(normalizeReturnUrl("http://evil.example/")).toBeNull();
    expect(normalizeReturnUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeReturnUrl("https://u:p@a.example/")).toBeNull();
    expect(normalizeReturnUrl(5)).toBeNull();
  });
});

describe("sign in with Google", () => {
  it("is reported as unavailable without the server secrets", async () => {
    const a = await app({ google: false });
    expect((await a.call("/v1/calendar")).body.googleAvailable).toBe(false);
    expect((await a.call("/v1/google/start", { returnUrl: APP })).status).toBe(501);
  });

  it("start needs the password and a sensible return address", async () => {
    const a = await app();
    expect((await a.call("/v1/calendar")).body.googleAvailable).toBe(true);
    expect((await a.raw("/v1/google/start", { returnUrl: APP }, null)).status).toBe(401);
    expect((await a.call("/v1/google/start", { returnUrl: "http://evil.example/" })).status).toBe(400);

    const s = await a.call("/v1/google/start", { returnUrl: APP });
    const u = new URL(s.body.url);
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("client_id")).toBe(GOOGLE.clientId);
    expect(u.searchParams.get("redirect_uri")).toBe("https://w.example/v1/google/callback");
    expect(u.searchParams.get("scope")).toBe(GOOGLE_CALENDAR_SCOPES.join(" "));
    expect(u.searchParams.get("prompt")).toBe("select_account consent");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("state")!.length).toBeGreaterThan(20);
  });

  it("finishes the sign-in, replaces a secret link, and the state works once", async () => {
    const a = await app();
    await a.call("/v1/calendar", { url: "https://calendar.google.com/x/basic.ics" });
    expect((await a.call("/v1/calendar")).body.mode).toBe("ical");

    const s = await a.call("/v1/google/start", { returnUrl: APP });
    const state = new URL(s.body.url).searchParams.get("state")!;
    const cb = await a.raw(`/v1/google/callback?state=${state}&code=c`, undefined, null);
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe(APP + "#google=connected&account=google%3Agoogle-home");

    const tokenCall = a.g.calls.find((c) => c.url.includes("/token"))!;
    const form = new URLSearchParams(tokenCall.body);
    expect(form.get("code")).toBe("c");
    expect(form.get("client_secret")).toBe("shh");
    expect(form.get("redirect_uri")).toBe("https://w.example/v1/google/callback");

    const st = (await a.call("/v1/calendar")).body;
    expect(st).toMatchObject({ connected: true, mode: "google", feed: "me@gmail.com", problem: null });
    expect(JSON.stringify(st)).not.toContain("rt-1");
    expect(a.store.calendar).toBeNull();

    const again = await a.raw(`/v1/google/callback?state=${state}&code=c`, undefined, null);
    expect(again.status).toBe(400);
    expect(await again.text()).toMatch(/expired or was already used/);
  });

  it("expired sign-in links are refused", async () => {
    const a = await app();
    const s = await a.call("/v1/google/start", { returnUrl: APP });
    const state = new URL(s.body.url).searchParams.get("state")!;
    a.advance(11 * 60_000);
    expect((await a.raw(`/v1/google/callback?state=${state}&code=c`, undefined, null)).status).toBe(400);
    expect(a.store.google).toBeNull();
  });

  it("sends cancellations and missing permission back to the app", async () => {
    const a = await app();
    const denied = await a.signIn({ error: "access_denied" });
    expect(denied.status).toBe(302);
    expect(denied.headers.get("location")).toMatch(/^https:\/\/pocketed\.example\.pages\.dev\/#google=error&message=/);
    expect(decodeURIComponent(denied.headers.get("location")!)).toMatch(/cancelled/);

    a.g.scope = "openid";
    const noScope = await a.signIn();
    expect(decodeURIComponent(noScope.headers.get("location")!)).toMatch(/permission to see your calendar/);
    expect(a.store.google).toBeNull();
  });

  it("serves upcoming events with colours, skipping the ones that aren't appointments", async () => {
    const a = await app();
    await a.signIn();
    const r = await a.raw("/v1/calendar/feed");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/json/);
    const feed = (await r.json()) as any;
    expect(feed.source).toBe("google");
    expect(feed.calendar).toEqual({ colorId: "14", backgroundColor: "#9fe1e7" });
    // Cancelled events are relayed on purpose: the app removes their reminders
    // from the calendar's own word, not by guessing from an event's absence.
    // Working-location markers and declined invitations are not appointments.
    expect(feed.events.map((e: any) => e.id)).toEqual(["a", "b", "e"]);
    expect(feed.events.find((e: any) => e.id === "b").status).toBe("cancelled");
    expect(feed.events[0].colorId).toBe("11");

    const evCall = a.g.calls.find((c) => c.url.includes("/events"))!;
    const q = new URL(evCall.url).searchParams;
    expect(q.get("singleEvents")).toBe("true");
    expect(q.get("showDeleted")).toBe("true");
    expect(q.get("timeMin")).toBe(new Date(1_000_000).toISOString());
    expect(evCall.auth).toBe("Bearer at-1"); // the token from sign-in, reused
    expect(a.g.calls.filter((c) => c.url.includes("pageToken=p2"))).toHaveLength(1);
    expect(q.get("fields")).toContain("eventLabelId");
    // No event wears a label, so no calendar is asked for its labels.
    expect(a.g.calls.filter((c) => LABEL_CALL.test(c.url))).toHaveLength(0);
  });

  it("reads an event's colour from its calendar's labels, and copes with a calendar that won't share them", async () => {
    const a = await app();
    await a.signIn();
    // Avocado: one of the 24 colours Google added for events in June 2026.
    const labelled = a.g.pages[0].items![0] as GoogleEvent;
    labelled.eventLabelId = "label-avocado";
    a.g.labels["me@gmail.com"] = {
      labelProperties: {
        eventLabels: [
          { id: "label-avocado", backgroundColor: "#c0ca33", name: "Avocado" },
          { id: "label-other", backgroundColor: "#7c54c0" },
        ],
      },
    };
    const r = await a.call("/v1/calendar/feed");
    expect(r.status).toBe(200);
    expect(r.body.events[0]).toMatchObject({ id: "a", eventLabelId: "label-avocado" });
    // Only the label this account's events wear is relayed, not all 200.
    expect(r.body.calendars[0].eventLabels).toEqual([
      { id: "label-avocado", backgroundColor: "#c0ca33", name: "Avocado" },
    ]);
    const labelCall = a.g.calls.filter((c) => LABEL_CALL.test(c.url));
    expect(labelCall).toHaveLength(1); // only calendars with a labelled event
    expect(new URL(labelCall[0].url).searchParams.get("fields")).toBe("labelProperties");
    expect(labelCall[0].auth).toBe("Bearer at-1");

    // A calendar that won't share its labels doesn't break the import: the
    // event falls back to its colour id, or its calendar's colour.
    a.g.calls.length = 0;
    a.g.failLabels = "me@gmail.com";
    const again = await a.call("/v1/calendar/feed");
    expect(again.status).toBe(200);
    expect(again.body.calendars[0].eventLabels).toBeUndefined();
    expect(again.body.events[0].eventLabelId).toBe("label-avocado");
  });

  it("paginates the calendar list and each calendar, including shared and hidden calendars", async () => {
    const a = await app();
    await a.signIn();
    const sharedId = "family/+chores#@group.calendar.google.com";
    a.g.calendarPages[0].nextPageToken = "1";
    a.g.calendarPages.push({ items: [
      { id: sharedId, accessRole: "reader", colorId: "8", hidden: true, selected: false },
      { id: "owned", accessRole: "owner", colorId: "3" },
      { id: "subscribed", accessRole: "reader" },
      { id: "busy-only", accessRole: "freeBusyReader" },
      { id: "deleted", accessRole: "owner", deleted: true },
    ] });
    a.g.otherEvents[sharedId] = [
      { items: [{ id: "f1" }], nextPageToken: "p2" },
      { items: [{ id: "f2" }, { id: "cancelled", status: "cancelled" }] },
    ];
    a.g.otherEvents.owned = [{ items: [{ id: "o1" }] }];
    a.g.otherEvents.subscribed = [{}]; // empty calendars may omit items
    const r = await a.call("/v1/calendar/feed");
    expect(r.status).toBe(200);
    expect(r.body.calendars.map((c: GoogleCalendar) => c.id)).toEqual([
      "me@gmail.com", sharedId, "owned", "subscribed",
    ]);
    expect(r.body.events.map((e: GoogleEvent) => [e.id, e.calendarId])).toEqual([
      ["a", "me@gmail.com"], ["b", "me@gmail.com"], ["e", "me@gmail.com"],
      ["f1", sharedId], ["f2", sharedId], ["cancelled", sharedId], ["o1", "owned"],
    ]);
    expect(r.body.calendars[1].colorId).toBe("8");
    const listCall = a.g.calls.find((c) => new URL(c.url).pathname.endsWith("/calendarList"))!;
    expect(new URL(listCall.url).searchParams.get("minAccessRole")).toBe("reader");
    expect(new URL(listCall.url).searchParams.get("showHidden")).toBe("true");
    expect(a.g.calls.some((c) => c.url.includes(encodeURIComponent(sharedId)))).toBe(true);
  });

  it("fails the entire feed if one calendar fails, rather than reconciling a partial snapshot", async () => {
    const a = await app();
    await a.signIn();
    a.g.calendarPages[0].items!.push({ id: "shared", accessRole: "reader" });
    a.g.failCalendar = "shared";
    const r = await a.call("/v1/calendar/feed");
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/503/);
    expect(r.body.events).toBeUndefined();
  });

  it("refuses truncated calendar lists and event pages", async () => {
    const a = await app();
    await a.signIn();
    const original = a.g.calendarPages;
    a.g.calendarPages = Array.from({ length: 4 }, (_, i) => ({ nextPageToken: String(i + 1) }));
    const list = await a.call("/v1/calendar/feed");
    expect(list.status).toBe(502);
    expect(list.body.error).toMatch(/too many calendars/);
    a.g.calendarPages = original;
    a.g.pages[1].nextPageToken = "p2";
    const events = await a.call("/v1/calendar/feed");
    expect(events.status).toBe(502);
    expect(events.body.error).toMatch(/too many events/);
  });

  it("retries an event request after an early token expiry", async () => {
    const a = await app();
    await a.signIn();
    a.g.unauthorizedOnce = true;
    expect((await a.call("/v1/calendar/feed")).status).toBe(200);
    expect(a.g.tokenCount).toBe(2);
  });

  it("refreshes the access token when it runs out", async () => {
    const a = await app();
    await a.signIn();
    a.advance(2 * 3600_000);
    await a.raw("/v1/calendar/feed");
    const refresh = a.g.calls.filter(
      (c) => c.url.includes("/token") && c.body.includes("grant_type=refresh_token"),
    );
    expect(refresh).toHaveLength(1);
    expect(new URLSearchParams(refresh[0].body).get("refresh_token")).toBe("rt-1");
    expect(a.g.calls.filter((c) => c.url.includes("/events")).pop()!.auth).toBe("Bearer at-2");
  });

  it("asks to sign in again when Google revoked access", async () => {
    const a = await app();
    await a.signIn();
    a.advance(2 * 3600_000);
    a.g.refreshError = "invalid_grant";
    const r = await a.call("/v1/calendar/feed");
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/Sign in with Google again/);
    expect((await a.call("/v1/calendar")).body.problem).toMatch(/Sign in with Google again/);
  });

  it("disconnecting revokes Google's access", async () => {
    const a = await app();
    await a.signIn();
    const d = await a.call("/v1/calendar/disconnect", {});
    expect(d.body).toMatchObject({ connected: false, mode: null });
    const revoke = a.g.calls.find((c) => c.url.includes("/revoke"))!;
    expect(new URLSearchParams(revoke.body).get("token")).toBe("rt-1");
    expect((await a.call("/v1/calendar/feed")).status).toBe(409);
  });

  it("a secret link replaces the Google sign-in", async () => {
    const a = await app();
    await a.signIn();
    const c = await a.call("/v1/calendar", { url: "https://calendar.google.com/x/basic.ics" });
    expect(c.body).toMatchObject({ connected: true, mode: "ical" });
    expect(a.store.google).toBeNull();
    expect(a.g.calls.some((x) => x.url.includes("/revoke"))).toBe(true);
  });
});


describe("multiple Calendar accounts", () => {
  async function twoAccounts() {
    const a = await app();
    await a.signIn();
    a.g.accountId = "google-school";
    a.g.email = "student@school.example";
    await a.signIn();
    return a;
  }

  it("adds school without replacing home, returns both identities, and reconnects in place", async () => {
    const a = await twoAccounts();
    const status = (await a.call("/v1/calendar")).body;
    expect(status.accounts.map((r: any) => r.email)).toEqual(["me@gmail.com", "student@school.example"]);
    expect(await a.store.listGoogle()).toHaveLength(2);
    expect(a.g.calls.some((c) => c.url.includes("/revoke"))).toBe(false);
    await a.call("/v1/calendar/visibility", { accountId: "google:google-school", visible: false });
    const before = await a.store.getGoogle("google:google-school");
    await a.signIn();
    expect(await a.store.listGoogle()).toHaveLength(2);
    expect(await a.store.getGoogle("google:google-school")).toMatchObject({ visible: false, id: before!.id });
    expect((await a.store.getGoogle("google:google-school"))!.connectedAt).toBeGreaterThan(before!.connectedAt);
    expect(await a.store.getGoogle("google:google-home")).not.toBeNull();
    expect(JSON.stringify((await a.call("/v1/calendar")).body)).not.toMatch(/rt-|at-|refreshToken|accessToken/);
  });

  it("persists account visibility in sync pulls without changing events, assignments or tokens", async () => {
    const a = await twoAccounts();
    await a.store.setClassroom({ accountId: "google-school", refreshToken: "class-refresh", accessToken: "class-access",
      accessExpires: 99_000_000, email: "student@school.example", connectedAt: 1_000_000, problem: null });
    const note: Op = { id: "seed", kind: "upsert", noteId: "homework", text: "Homework", source: "classroom",
      sourceAccountId: "google-school", reminderAt: 99_000_000, updatedAt: 1_000_000 };
    await a.store.appendOp(note);
    const sequence = await a.store.serverSeq();
    const revision = a.store.googleRevision;
    const response = await a.raw("/v1/calendar/visibility", { accountId: "google:google-school", visible: false });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const changed = await response.json() as any;
    expect(changed.accounts.find((r: any) => r.id === "google:google-school").visible).toBe(false);
    expect(changed.accounts.find((r: any) => r.id === "google:google-home").visible).toBe(true);
    expect(changed.accountsRevision).toBe(revision + 1);
    const pull = (await a.call("/v1/pull?cursor=0")).body;
    expect(pull.calendarAccounts).toEqual(changed.accounts);
    expect(pull.calendarAccountsRevision).toBe(changed.accountsRevision);
    expect(await a.store.serverSeq()).toBe(sequence);
    expect(a.store.notes.get("homework")?.deleted).toBe(false);
    expect((await a.call("/v1/classroom")).body.connected).toBe(true);
    expect((await a.call("/v1/calendar/feed?accountId=google%3Agoogle-school")).status).toBe(200); // still syncs while hidden
    expect(a.g.calls.some((c) => c.url.includes("/revoke"))).toBe(false);
    await a.call("/v1/calendar/visibility", { accountId: "google:google-school", visible: true });
    expect((await a.store.getGoogle("google:google-school"))?.visible).toBe(true);
    expect(a.store.notes.get("homework")?.deleted).toBe(false);
  });

  it("requires account selection for ambiguous feed/disconnect requests and never echoes tokens", async () => {
    const a = await twoAccounts();
    expect((await a.call("/v1/calendar/feed")).status).toBe(400);
    expect((await a.call("/v1/calendar/disconnect", {})).status).toBe(400);
    expect(await a.store.listGoogle()).toHaveLength(2);
    for (const id of ["google:google-home", "google:google-school"]) {
      const feed = await a.call(`/v1/calendar/feed?accountId=${encodeURIComponent(id)}`);
      expect(feed.status).toBe(200);
      expect(feed.body.accountId).toBe(id);
      expect(JSON.stringify(feed.body)).not.toMatch(/rt-|at-|refreshToken|accessToken/);
    }
    expect((await a.call("/v1/calendar/feed?accountId=missing")).status).toBe(409);
  });

  it("rejects unauthenticated, malformed and unknown visibility changes", async () => {
    const a = await twoAccounts();
    expect((await a.raw("/v1/calendar/visibility", { accountId: "google:google-school", visible: false }, null)).status).toBe(401);
    for (const body of [{}, { accountId: null, visible: false }, { accountId: "", visible: false },
      { accountId: "google:google-school", visible: "false" }]) {
      expect((await a.call("/v1/calendar/visibility", body)).status).toBe(400);
    }
    expect((await a.call("/v1/calendar/visibility", { accountId: "missing", visible: false })).status).toBe(404);
    expect((await a.store.getGoogle("google:google-school"))?.visible).toBe(true);
  });

  it("disconnects only school events, preserving home and the school's Classroom grant", async () => {
    const a = await twoAccounts();
    await a.store.setClassroom({ accountId: "google-school", refreshToken: "class-refresh", accessToken: "class-access",
      accessExpires: 99_000_000, email: "student@school.example", connectedAt: 1_000_000, problem: null });
    for (const [id, source, owner] of [["school-event", "gcal", "google:google-school"], ["home-event", "gcal", "google:google-home"],
      ["homework", "classroom", "google-school"], ["personal", null, null]] as const) {
      await a.store.appendOp({ id: `seed-${id}`, kind: "upsert", noteId: id, text: id, source, sourceAccountId: owner,
        reminderAt: 99_000_000, updatedAt: 1_000_000 });
    }
    const result = await a.call("/v1/calendar/disconnect", { accountId: "google:google-school" });
    expect(result.status).toBe(200);
    expect(result.body.accounts.map((r: any) => r.id)).toEqual(["google:google-home"]);
    expect(a.store.notes.get("school-event")?.deleted).toBe(true);
    for (const id of ["home-event", "homework", "personal"]) expect(a.store.notes.get(id)?.deleted).toBe(false);
    expect(a.g.calls.some((c) => c.url.includes("/revoke"))).toBe(false);
    expect(await a.store.getClassroom("google-school")).not.toBeNull();
    const pull = (await a.call("/v1/pull?cursor=0")).body;
    expect(pull.ops).toContainEqual(expect.objectContaining({ noteId: "school-event", kind: "delete", sourceAccountId: "google:google-school" }));
    await a.call("/v1/calendar/disconnect", { accountId: "google:google-home" });
    expect(a.g.calls.filter((c) => c.url.includes("/revoke"))).toHaveLength(1);
    expect(await a.store.getClassroom("google-school")).not.toBeNull();
  });

  it("allows an in-flight feed to finish when visibility changes, but rejects it after disconnect", async () => {
    const a = await twoAccounts();
    let release!: () => void;
    let entered = new Promise<void>((resolve) => { a.g.onEvents = resolve; });
    a.g.eventWait = new Promise<void>((resolve) => { release = resolve; });
    const pending = a.call("/v1/calendar/feed?accountId=google%3Agoogle-school");
    await entered;
    await a.call("/v1/calendar/visibility", { accountId: "google:google-school", visible: false });
    release();
    expect((await pending).status).toBe(200);
    entered = new Promise<void>((resolve) => { a.g.onEvents = resolve; });
    a.g.eventWait = new Promise<void>((resolve) => { release = resolve; });
    const disconnected = a.call("/v1/calendar/feed?accountId=google%3Agoogle-school");
    await entered;
    await a.call("/v1/calendar/disconnect", { accountId: "google:google-school" });
    release();
    expect((await disconnected).status).toBe(409);
    expect(await a.store.getGoogle("google:google-home")).not.toBeNull();
  });

  it("a late refresh cannot resurrect school or overwrite home's credentials or visibility", async () => {
    const a = await twoAccounts();
    a.advance(2 * 3_600_000);
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { a.g.onRefresh = resolve; });
    a.g.refreshWait = new Promise<void>((resolve) => { release = resolve; });
    const pending = a.call("/v1/calendar/feed?accountId=google%3Agoogle-school");
    await entered;
    await a.call("/v1/calendar/visibility", { accountId: "google:google-home", visible: false });
    const home = await a.store.getGoogle("google:google-home");
    await a.call("/v1/calendar/disconnect", { accountId: "google:google-school" });
    release();
    expect((await pending).status).toBe(502);
    expect(await a.store.getGoogle("google:google-school")).toBeNull();
    expect(await a.store.getGoogle("google:google-home")).toEqual(home);
  });

  it("never replaces the migrated connection when adding another account, and reconnects legacy IDs in place", async () => {
    const a = await app();
    await a.store.setGoogle({ refreshToken: "legacy-refresh", accessToken: "legacy-access", accessExpires: 99_000_000,
      email: "me@gmail.com", connectedAt: 1, problem: null });
    await a.signIn();
    const legacy = await a.store.getGoogle("google:legacy");
    expect(legacy).toMatchObject({ accountId: "google-home", legacyIds: true });
    expect(await a.store.listGoogle()).toHaveLength(1);
    a.g.accountId = "google-school"; a.g.email = "student@school.example";
    await a.signIn();
    expect(await a.store.listGoogle()).toHaveLength(2);
    expect(await a.store.getGoogle("google:legacy")).toEqual(legacy);
  });

  it("requires explicit confirmation before a secret link replaces multiple accounts", async () => {
    const a = await twoAccounts();
    expect((await a.call("/v1/calendar", { url: "https://calendar.google.com/x/basic.ics" })).status).toBe(409);
    expect(await a.store.listGoogle()).toHaveLength(2);
    expect((await a.call("/v1/calendar", { url: "https://calendar.google.com/x/basic.ics", replaceGoogle: true })).status).toBe(200);
    expect(await a.store.listGoogle()).toHaveLength(0);
  });

  it("keeps existing accounts when Google cannot identify a new sign-in", async () => {
    const a = await app(); await a.signIn();
    const before = await a.store.listGoogle();
    a.g.invalidProfile = true;
    const response = await a.signIn();
    expect(decodeURIComponent(response.headers.get("location")!)).toMatch(/#google=error.*identify/);
    expect(await a.store.listGoogle()).toEqual(before);
  });

  it("bounds the number of accounts without blocking an existing account's reconnect", async () => {
    const a = await app();
    for (let i = 0; i < 10; i++) await a.store.setGoogle({ id: `google:seed-${i}`, accountId: `seed-${i}`, legacyIds: false,
      refreshToken: `refresh-${i}`, accessToken: `access-${i}`, accessExpires: 99_000_000,
      email: `user${i}@example.com`, connectedAt: 1_000_000, problem: null });
    const limited = await a.signIn();
    expect(decodeURIComponent(limited.headers.get("location")!)).toMatch(/up to 10 Calendar accounts/);
    expect(await a.store.listGoogle()).toHaveLength(10);
    a.g.accountId = "seed-0"; a.g.email = "user0@example.com";
    expect((await a.signIn()).headers.get("location")).toContain("#google=connected");
    expect(await a.store.listGoogle()).toHaveLength(10);
  });
});
