import { describe, expect, it } from "vitest";
import { handle } from "../src/worker";
import { MemoryStore } from "../src/store";
import { GOOGLE_SCOPE, normalizeReturnUrl } from "../src/google";

const PASS = "test-password-1";
const GOOGLE = { clientId: "cid.apps.googleusercontent.com", clientSecret: "shh" };
const APP = "https://pocketed.example.pages.dev/";
const ICS = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";

interface Call {
  url: string;
  method: string;
  body: string;
  auth: string | null;
}

/** A pretend Google: token endpoint, revoke, calendarList and events. */
function fakeGoogle() {
  const calls: Call[] = [];
  const g = {
    calls,
    scope: GOOGLE_SCOPE,
    refreshError: null as string | null,
    tokenCount: 0,
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
        if (form.get("grant_type") === "refresh_token" && g.refreshError) {
          return Response.json({ error: g.refreshError }, { status: 400 });
        }
        g.tokenCount++;
        return Response.json({
          access_token: `at-${g.tokenCount}`,
          expires_in: 3600,
          scope: g.scope,
          ...(form.get("grant_type") === "authorization_code" ? { refresh_token: "rt-1" } : {}),
        });
      }
      if (url.startsWith("https://oauth2.googleapis.com/revoke")) return new Response("");
      if (u.pathname.endsWith("/users/me/calendarList/primary")) {
        return Response.json({ id: "me@gmail.com", colorId: "14", backgroundColor: "#9fe1e7" });
      }
      if (u.pathname.endsWith("/calendars/primary/events")) {
        return Response.json(u.searchParams.get("pageToken") === "p2" ? g.pages[1] : g.pages[0]);
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
    expect(u.searchParams.get("scope")).toBe(GOOGLE_SCOPE);
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
    expect(cb.headers.get("location")).toBe(APP + "#google=connected");

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
    expect(feed.events.map((e: any) => e.id)).toEqual(["a", "e"]);
    expect(feed.events[0].colorId).toBe("11");

    const evCall = a.g.calls.find((c) => c.url.includes("/events"))!;
    const q = new URL(evCall.url).searchParams;
    expect(q.get("singleEvents")).toBe("true");
    expect(q.get("timeMin")).toBe(new Date(1_000_000).toISOString());
    expect(evCall.auth).toBe("Bearer at-1"); // the token from sign-in, reused
    expect(a.g.calls.filter((c) => c.url.includes("pageToken=p2"))).toHaveLength(1);
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
