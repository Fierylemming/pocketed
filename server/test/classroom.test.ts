import { describe, expect, it } from "vitest";
import { classroomNoteId, type ClassroomFeed, type ClassroomCourseWork, type Op } from "@pocketed/shared";
import { CLASSROOM_MAX_PAGES, CLASSROOM_SCOPES } from "../src/classroom";
import { GOOGLE_CALENDAR_SCOPES } from "../src/google";
import { handle, googleConfig } from "../src/worker";
import { MemoryStore } from "../src/store";

const PASS = "test-password-1";
const GOOGLE = { clientId: "classroom-client.apps.googleusercontent.com", clientSecret: "server-only-secret" };
const APP = "https://pocketed.example.pages.dev/";
const NOW = Date.UTC(2026, 9, 13, 10);

type CoursePage = { courses?: { id: string; name: string; courseState: string }[]; nextPageToken?: string };
type WorkPage = { courseWork?: Partial<ClassroomCourseWork>[]; nextPageToken?: string };

function fakeGoogle() {
  const calls: { url: string; method: string; body: URLSearchParams; authorization: string | null }[] = [];
  const g = {
    calls,
    scope: CLASSROOM_SCOPES.join(" "),
    accountId: "google-student-1",
    email: "student@school.example",
    tokenCount: 0,
    missingRefreshToken: false,
    invalidProfile: false,
    tokenError: null as string | null,
    refreshError: null as string | null,
    failCourse: null as string | null,
    failStatus: 503,
    unauthorizedOnce: false,
    malformedPage: false,
    refreshWait: null as Promise<void> | null,
    onRefresh: null as (() => void) | null,
    workWait: null as Promise<void> | null,
    onWork: null as (() => void) | null,
    coursePages: [{ courses: [{ id: "maths", name: "Maths", courseState: "ACTIVE" }] }] as CoursePage[],
    workPages: { maths: [{ courseWork: [{
      id: "worksheet", title: "Algebra worksheet", state: "PUBLISHED", description: "<p>Do questions 1–10.</p>",
      alternateLink: "https://classroom.google.com/c/example/a/worksheet/details",
      dueDate: { year: 2026, month: 10, day: 14 }, dueTime: { hours: 22, minutes: 59 },
    }] }] } as Record<string, WorkPage[]>,
    fetch: async (url: string, init?: RequestInit): Promise<Response> => {
      const u = new URL(url);
      const body = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
      calls.push({ url, method: init?.method ?? "GET", body, authorization: new Headers(init?.headers).get("authorization") });
      if (u.hostname === "oauth2.googleapis.com" && u.pathname === "/token") {
        const refresh = body.get("grant_type") === "refresh_token";
        if (refresh) {
          g.onRefresh?.();
          if (g.refreshWait) await g.refreshWait;
        }
        const error = refresh ? g.refreshError : g.tokenError;
        if (error) return Response.json({ error }, { status: 400 });
        g.tokenCount++;
        return Response.json({
          access_token: `classroom-access-${g.tokenCount}`, scope: g.scope, expires_in: 3600,
          ...(!refresh && !g.missingRefreshToken ? { refresh_token: `classroom-refresh-${g.tokenCount}` } : {}),
        });
      }
      if (u.hostname === "oauth2.googleapis.com" && u.pathname === "/revoke") return new Response("");
      if (u.hostname === "openidconnect.googleapis.com") {
        return Response.json(g.invalidProfile ? {} : { sub: g.accountId, email: g.email });
      }
      if (u.pathname.endsWith("/users/me/calendarList/primary")) return Response.json({ id: "personal@gmail.example" });
      if (url.endsWith(".ics")) return new Response("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n");
      if (u.pathname === "/v1/courses") {
        const index = Number(u.searchParams.get("pageToken") ?? 0);
        return Response.json(g.coursePages[index] ?? {});
      }
      const path = /^\/v1\/courses\/([^/]+)\/courseWork$/.exec(u.pathname);
      if (path) {
        const id = decodeURIComponent(path[1]);
        g.onWork?.();
        if (g.workWait) await g.workWait;
        if (g.unauthorizedOnce) {
          g.unauthorizedOnce = false;
          return new Response("token expired", { status: 401 });
        }
        if (id === g.failCourse) return new Response("schoolwork unavailable", { status: g.failStatus });
        if (g.malformedPage) return Response.json({ courseWork: "not a list" });
        const index = Number(u.searchParams.get("pageToken") ?? 0);
        return Response.json(g.workPages[id]?.[index] ?? {});
      }
      return new Response("not found", { status: 404 });
    },
  };
  return g;
}

async function app(options: { google?: boolean; customRedirects?: boolean } = {}) {
  const store = new MemoryStore();
  const g = fakeGoogle();
  let now = NOW;
  const deps = {
    now: () => now,
    fetch: g.fetch,
    google: options.google === false ? undefined : {
      ...GOOGLE,
      ...(options.customRedirects ? {
        redirectUri: "https://calendar-api.example/v1/google/callback",
        classroomRedirectUri: "https://classroom-api.example/v1/classroom/callback",
      } : {}),
    },
  };
  await handle(new Request("https://w.example/v1/init", {
    method: "POST", body: JSON.stringify({ password: PASS, recovery: "keep-this-test-key" }),
  }), store);
  const raw = (path: string, body?: unknown, password: string | null = PASS) => handle(new Request(`https://w.example${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(password ? { authorization: `Bearer ${password}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), store, deps);
  const call = async <T = Record<string, unknown>>(path: string, body?: unknown) => {
    const response = await raw(path, body);
    return { status: response.status, body: await response.json() as T };
  };
  const start = async (integration: "classroom" | "google" = "classroom") => {
    const result = await call<{ url: string }>(`/v1/${integration}/start`, { returnUrl: APP + "?old=query#old-hash" });
    return new URL(result.body.url);
  };
  const signIn = async (callback: Record<string, string> = { code: "classroom-code" }) => {
    const url = await start();
    const params = new URLSearchParams({ state: url.searchParams.get("state")!, ...callback });
    return raw(`/v1/classroom/callback?${params}`, undefined, null);
  };
  return { store, g, deps, raw, call, start, signIn, advance: (ms: number) => { now += ms; } };
}

async function seed(store: MemoryStore, source: "classroom" | "gcal" | null, id: string) {
  const op: Op = {
    id: `seed-${id}`, kind: "upsert", noteId: id, text: id, itemKind: source ? "reminder" : "note",
    source, reminderAt: source ? NOW + 86_400_000 : null, updatedAt: NOW, createdAt: NOW,
  };
  await store.appendOp(op);
}

describe("Classroom OAuth", () => {
  it("reports availability safely, and protects every private endpoint with the Pocketed password", async () => {
    const a = await app({ google: false });
    expect((await a.call("/v1/classroom")).body).toMatchObject({ connected: false, googleAvailable: false });
    expect((await a.call("/v1/classroom/start", { returnUrl: APP })).status).toBe(501);
    expect((await a.call("/v1/classroom/feed")).status).toBe(409);
    expect((await a.raw("/v1/classroom/callback?code=x&state=x", undefined, null)).status).toBe(404);
    for (const path of ["/v1/classroom", "/v1/classroom/feed", "/v1/classroom/start", "/v1/classroom/disconnect"]) {
      const post = /start|disconnect/.test(path);
      expect((await a.raw(path, post ? {} : undefined, null)).status).toBe(401);
    }
  });

  it("requests only the student's read-only scopes and has its own redirect URI", async () => {
    const a = await app();
    expect((await a.call("/v1/classroom/start", { returnUrl: "http://evil.example/" })).status).toBe(400);
    const url = await a.start();
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([...CLASSROOM_SCOPES]);
    expect(url.searchParams.get("scope")).not.toContain("calendar");
    expect(url.searchParams.get("scope")).not.toContain("coursework.students");
    expect(url.searchParams.get("redirect_uri")).toBe("https://w.example/v1/classroom/callback");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toContain("select_account");
    const custom = await app({ customRedirects: true });
    expect((await custom.start()).searchParams.get("redirect_uri")).toBe("https://classroom-api.example/v1/classroom/callback");
    expect((await custom.start("google")).searchParams.get("redirect_uri")).toBe("https://calendar-api.example/v1/google/callback");
  });

  it("stores server-only tokens and identity without replacing an existing secret Calendar link", async () => {
    const a = await app();
    await a.call("/v1/calendar", { url: "https://calendar.google.com/example/basic.ics" });
    const response = await a.signIn();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(APP + "#classroom=connected&account=google-student-1");
    expect(a.store.classroom).toMatchObject({ accountId: "google-student-1", email: "student@school.example", problem: null });
    expect(a.store.calendar).not.toBeNull();
    const status = await a.call("/v1/classroom");
    expect(status.body).toMatchObject({ connected: true, googleAvailable: true, account: "student@school.example" });
    expect(JSON.stringify(status.body)).not.toMatch(/classroom-(access|refresh)/);
    const token = a.g.calls.find((c) => new URL(c.url).pathname === "/token")!;
    expect(token.body.get("client_secret")).toBe(GOOGLE.clientSecret);
    expect(token.body.get("redirect_uri")).toBe("https://w.example/v1/classroom/callback");
  });

  it("binds one-time state to the right callback; wrong-service requests do not consume it", async () => {
    const a = await app();
    const url = await a.start();
    const query = `state=${url.searchParams.get("state")}&code=c`;
    expect((await a.raw(`/v1/google/callback?${query}`, undefined, null)).status).toBe(400);
    expect(a.g.tokenCount).toBe(0);
    expect((await a.raw(`/v1/classroom/callback?${query}`, undefined, null)).status).toBe(302);
    expect((await a.raw(`/v1/classroom/callback?${query}`, undefined, null)).status).toBe(400);
    expect(a.g.tokenCount).toBe(1);

    const calendar = await a.start("google");
    const calendarQuery = `state=${calendar.searchParams.get("state")}&code=c`;
    expect((await a.raw(`/v1/classroom/callback?${calendarQuery}`, undefined, null)).status).toBe(400);
    a.g.scope = GOOGLE_CALENDAR_SCOPES.join(" ");
    expect((await a.raw(`/v1/google/callback?${calendarQuery}`, undefined, null)).status).toBe(302);
    expect(a.store.google).not.toBeNull();
    expect(a.store.classroom).not.toBeNull();
  });

  it("rejects expired, cancelled, incomplete-permission, no-refresh-token and unidentified sign-ins", async () => {
    const a = await app();
    const url = await a.start();
    a.advance(11 * 60_000);
    expect((await a.raw(`/v1/classroom/callback?state=${url.searchParams.get("state")}&code=c`, undefined, null)).status).toBe(400);
    const denied = await a.signIn({ error: "access_denied" });
    expect(decodeURIComponent(denied.headers.get("location")!)).toMatch(/#classroom=error.*cancelled/);
    a.g.scope = "openid email " + CLASSROOM_SCOPES[2];
    expect(decodeURIComponent((await a.signIn()).headers.get("location")!)).toMatch(/permission to read your classes/);
    a.g.scope = CLASSROOM_SCOPES.join(" ");
    a.g.missingRefreshToken = true;
    expect(decodeURIComponent((await a.signIn()).headers.get("location")!)).toMatch(/ongoing access/);
    a.g.missingRefreshToken = false;
    a.g.invalidProfile = true;
    expect(decodeURIComponent((await a.signIn()).headers.get("location")!)).toMatch(/didn't identify/);
    expect(a.store.classroom).toBeNull();
  });

  it("reconnects the same account and adds another without removing existing assignments", async () => {
    const a = await app();
    await a.signIn();
    const id = classroomNoteId(a.g.accountId, "maths", "worksheet");
    await seed(a.store, "classroom", id);
    await seed(a.store, "gcal", "calendar-note");
    await seed(a.store, null, "personal-note");
    await a.signIn();
    expect(a.store.notes.get(id)?.deleted).toBe(false);
    expect(a.g.calls.some((c) => c.url.includes("/revoke"))).toBe(false);
    a.g.accountId = "google-student-2";
    a.g.email = "other@school.example";
    a.advance(1000);
    await a.signIn();
    expect(a.store.notes.get(id)?.deleted).toBe(false);
    expect(await a.store.listClassroom()).toHaveLength(2);
    expect(a.store.notes.get("calendar-note")?.deleted).toBe(false);
    expect(a.store.notes.get("personal-note")?.deleted).toBe(false);
    expect((await a.call<{ ops: Op[] }>("/v1/pull?cursor=0")).body.ops.filter((op: Op) => op.kind === "delete")).toHaveLength(0);
  });

  it("reads optional custom callback settings independently", () => {
    expect(googleConfig({ GOOGLE_CLIENT_ID: " cid ", GOOGLE_CLIENT_SECRET: " secret ",
      GOOGLE_REDIRECT_URI: " https://calendar.example/callback ", GOOGLE_CLASSROOM_REDIRECT_URI: " https://classroom.example/callback " }))
      .toEqual({ clientId: "cid", clientSecret: "secret", redirectUri: "https://calendar.example/callback", classroomRedirectUri: "https://classroom.example/callback" });
  });
});

describe("Classroom feed", () => {
  it("lists active enrolled classes and published coursework, not rosters, submissions or grades", async () => {
    const a = await app();
    await a.signIn();
    const response = await a.raw("/v1/classroom/feed");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const feed = await response.json() as ClassroomFeed;
    expect(feed).toMatchObject({ source: "classroom", accountId: "google-student-1", checkedAt: NOW, complete: true });
    expect(feed.courses).toEqual([{ id: "maths", name: "Maths" }]);
    expect(feed.courseWork[0]).toMatchObject({ id: "worksheet", courseId: "maths", description: "Do questions 1–10." });
    expect(JSON.stringify(feed)).not.toMatch(/classroom-(access|refresh)/);
    const courses = a.g.calls.find((c) => new URL(c.url).pathname === "/v1/courses")!;
    const q = new URL(courses.url).searchParams;
    expect(q.get("studentId")).toBe("me");
    expect(q.get("courseStates")).toBe("ACTIVE");
    const work = a.g.calls.find((c) => c.url.includes("/courseWork?"))!;
    expect(new URL(work.url).searchParams.get("courseWorkStates")).toBe("PUBLISHED");
    expect(new URL(work.url).searchParams.get("fields")).not.toMatch(/grade|submission|student|material/i);
    expect(work.authorization).toBe("Bearer classroom-access-1");
  });

  it("paginates classes and each class's coursework, encoding identifiers without collisions", async () => {
    const a = await app();
    await a.signIn();
    const other = "school/+class#";
    a.g.coursePages = [
      { courses: [{ id: "maths", name: "Maths", courseState: "ACTIVE" }], nextPageToken: "1" },
      { courses: [{ id: other, name: "English", courseState: "ACTIVE" }, { id: "old", name: "Old class", courseState: "ARCHIVED" }] },
    ];
    a.g.workPages.maths[0].nextPageToken = "1";
    a.g.workPages.maths.push({ courseWork: [{ id: "second", title: "Second", state: "PUBLISHED" }] });
    a.g.workPages[other] = [{ courseWork: [{ id: "worksheet", title: "Essay", state: "PUBLISHED" }] }];
    const response = await a.call<ClassroomFeed>("/v1/classroom/feed");
    expect(response.status).toBe(200);
    expect(response.body.courseWork.map((w) => [w.courseId, w.id])).toEqual([["maths", "worksheet"], ["maths", "second"], [other, "worksheet"]]);
    expect(response.body.courses.map((c) => c.id)).toEqual(["maths", other]);
    expect(a.g.calls.some((c) => c.url.includes(encodeURIComponent(other)))).toBe(true);
  });

  it("accepts empty active classes and accounts as complete lists", async () => {
    const a = await app();
    await a.signIn();
    a.g.workPages.maths = [{}];
    expect((await a.call<ClassroomFeed>("/v1/classroom/feed")).body.courseWork).toEqual([]);
    a.g.coursePages = [{}];
    expect((await a.call<ClassroomFeed>("/v1/classroom/feed")).body).toMatchObject({ courses: [], courseWork: [], complete: true });
  });

  it("fails the entire check if one class fails, and explains API or school-admin restrictions", async () => {
    const a = await app();
    await a.signIn();
    await seed(a.store, "classroom", "already-imported");
    a.g.coursePages[0].courses!.push({ id: "english", name: "English", courseState: "ACTIVE" });
    a.g.failCourse = "english";
    const response = await a.call("/v1/classroom/feed");
    expect(response.status).toBe(502);
    expect(response.body.courseWork).toBeUndefined();
    expect(a.store.notes.get("already-imported")?.deleted).toBe(false);
    a.g.failStatus = 403;
    expect((await a.call("/v1/classroom/feed")).body.error).toMatch(/Classroom API.*school administrator/);
  });

  it("refuses malformed and truncated coursework instead of presenting it as an empty class", async () => {
    const a = await app();
    await a.signIn();
    a.g.malformedPage = true;
    expect((await a.call("/v1/classroom/feed")).status).toBe(502);
    a.g.malformedPage = false;
    a.g.workPages.maths = Array.from({ length: CLASSROOM_MAX_PAGES }, (_, i) => ({ nextPageToken: String(i + 1) }));
    const tooMany = await a.call("/v1/classroom/feed");
    expect(tooMany.status).toBe(502);
    expect(tooMany.body.error).toMatch(/too many Classroom coursework pages/);
    expect(tooMany.body.courseWork).toBeUndefined();
    a.g.coursePages = Array.from({ length: CLASSROOM_MAX_PAGES }, (_, i) => ({ nextPageToken: String(i + 1) }));
    expect((await a.call("/v1/classroom/feed")).body.error).toMatch(/too many Classroom class pages/);
  });

  it("bounds total upstream requests when a student has many classes", async () => {
    const a = await app();
    await a.signIn();
    a.g.coursePages = [{ courses: Array.from({ length: 45 }, (_, i) => ({ id: `class-${i}`, name: `Class ${i}`, courseState: "ACTIVE" })) }];
    const response = await a.call("/v1/classroom/feed");
    expect(response.status).toBe(502);
    expect(response.body.error).toMatch(/too much Classroom coursework/);
  });

  it("refreshes expired tokens and retries an early 401 once", async () => {
    const a = await app();
    await a.signIn();
    a.g.unauthorizedOnce = true;
    expect((await a.call("/v1/classroom/feed")).status).toBe(200);
    expect(a.g.tokenCount).toBe(2);
    a.advance(2 * 3600_000);
    expect((await a.call("/v1/classroom/feed")).status).toBe(200);
    expect(a.g.tokenCount).toBe(3);
    expect(a.g.calls.filter((c) => c.body.get("grant_type") === "refresh_token").length).toBe(2);
  });

  it("a late token refresh cannot resurrect a disconnected Classroom connection", async () => {
    const a = await app();
    await a.signIn();
    a.advance(2 * 3600_000);
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { a.g.onRefresh = resolve; });
    a.g.refreshWait = new Promise<void>((resolve) => { release = resolve; });
    const pending = a.call("/v1/classroom/feed");
    await entered;
    await a.call("/v1/classroom/disconnect", {});
    release();
    expect((await pending).status).toBe(502);
    expect(a.store.classroom).toBeNull();
  });

  it("does not return a stale feed after another device reconnects the same account", async () => {
    const a = await app();
    await a.signIn();
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { a.g.onWork = resolve; });
    a.g.workWait = new Promise<void>((resolve) => { release = resolve; });
    const pending = a.call("/v1/classroom/feed");
    await entered;
    const old = await a.store.getClassroom();
    await a.store.setClassroom({ ...old!, refreshToken: "new-refresh-token", connectedAt: NOW + 1 });
    release();
    expect((await pending).body.error).toMatch(/account changed/);
    expect(a.store.classroom?.refreshToken).toBe("new-refresh-token");
  });

  it("records revoked access without deleting any assignments", async () => {
    const a = await app();
    await a.signIn();
    await seed(a.store, "classroom", "already-imported");
    a.advance(2 * 3600_000);
    a.g.refreshError = "invalid_grant";
    const response = await a.call("/v1/classroom/feed");
    expect(response.status).toBe(502);
    expect(response.body.error).toMatch(/Connect Google Classroom again/);
    expect((await a.call("/v1/classroom")).body.problem).toMatch(/Connect Google Classroom again/);
    expect(a.store.notes.get("already-imported")?.deleted).toBe(false);
  });
});

describe("independent Google integrations and cleanup", () => {
  it("disconnects Classroom on every device, removing only its reminders and revoking the final grant", async () => {
    const a = await app();
    await a.signIn();
    await seed(a.store, "classroom", "homework");
    await seed(a.store, "gcal", "calendar");
    await seed(a.store, null, "personal");
    const disconnected = await a.call("/v1/classroom/disconnect", {});
    expect(disconnected.body).toMatchObject({ connected: false, removed: 1 });
    expect(a.store.classroom).toBeNull();
    expect(a.store.notes.get("homework")?.deleted).toBe(true);
    expect(a.store.notes.get("calendar")?.deleted).toBe(false);
    expect(a.store.notes.get("personal")?.deleted).toBe(false);
    expect(a.g.calls.filter((c) => c.url.includes("/revoke"))).toHaveLength(1);
    expect((await a.call("/v1/classroom/feed")).status).toBe(409);
  });

  it("round-trips Classroom import references on delete tombstones and validates their metadata", async () => {
    const a = await app();
    await seed(a.store, "classroom", "homework");
    const deletion: Op = { id: "teacher-removal", kind: "delete", noteId: "homework", updatedAt: NOW + 1,
      source: "classroom", sourceRef: "classroom-removed" };
    expect((await a.call("/v1/push", { ops: [deletion] })).status).toBe(200);
    expect(a.store.notes.get("homework")).toMatchObject({ deleted: true, source: "classroom", sourceRef: "classroom-removed" });
    const pulled = await a.call<{ ops: Op[] }>("/v1/pull?cursor=0");
    expect(pulled.body.ops.find((op) => op.id === deletion.id)).toMatchObject(deletion);
    expect((await a.call("/v1/push", { ops: [{ ...deletion, id: "bad-source", source: "not-a-source" }] })).status).toBe(400);
    expect((await a.call("/v1/push", { ops: [{ ...deletion, id: "bad-ref", sourceRef: "x".repeat(201) }] })).status).toBe(400);
  });

  it("Calendar reconnect, secret-link replacement and disconnect cannot revoke an active Classroom connection", async () => {
    const a = await app();
    await a.signIn();
    a.g.scope = GOOGLE_CALENDAR_SCOPES.join(" ");
    for (let i = 0; i < 2; i++) {
      const url = await a.start("google");
      expect((await a.raw(`/v1/google/callback?state=${url.searchParams.get("state")}&code=c`, undefined, null)).status).toBe(302);
    }
    expect(a.store.classroom).not.toBeNull();
    expect(a.g.calls.some((c) => c.url.includes("/revoke"))).toBe(false);
    await a.call("/v1/calendar", { url: "https://calendar.google.com/example/basic.ics" });
    expect(a.store.google).toBeNull();
    expect(a.store.classroom).not.toBeNull();
    expect(a.g.calls.some((c) => c.url.includes("/revoke"))).toBe(false);
    await a.call("/v1/calendar/disconnect", {});
    expect(a.store.classroom).not.toBeNull();
  });

  it("Classroom disconnect preserves the same account's Calendar grant", async () => {
    const a = await app();
    await a.signIn();
    await a.store.setGoogle({ refreshToken: "calendar-refresh", accessToken: "calendar-access", accessExpires: NOW + 3_600_000,
      email: a.g.email, accountId: a.g.accountId, connectedAt: NOW, problem: null });
    await a.call("/v1/classroom/disconnect", {});
    expect(a.store.google?.refreshToken).toBe("calendar-refresh");
    expect(a.g.calls.some((c) => c.url.includes("/revoke"))).toBe(false);
  });
});


describe("multiple Classroom accounts", () => {
  it("requires an explicit student for ambiguous checks/disconnects and cleans up only that student", async () => {
    const a = await app(); await a.signIn();
    const first = a.g.accountId;
    a.g.accountId = "second-student"; a.g.email = "second@school.example"; await a.signIn();
    for (const id of [first, "second-student"]) await a.store.appendOp({ id: `seed-${id}`, kind: "upsert", noteId: `work-${id}`,
      text: "Assignment", reminderAt: NOW + 10000, updatedAt: NOW, source: "classroom", sourceAccountId: id });
    expect((await a.call("/v1/classroom/feed")).status).toBe(400);
    expect((await a.call("/v1/classroom/disconnect", {})).status).toBe(400);
    expect((await a.call("/v1/classroom/disconnect", { accountId: null })).status).toBe(400);
    expect((await a.call("/v1/classroom/disconnect", { accountId: "missing" })).status).toBe(404);
    const feed = await a.call<ClassroomFeed>(`/v1/classroom/feed?accountId=${first}`);
    expect(feed.status).toBe(200); expect(feed.body.accountId).toBe(first);
    const result = await a.call<{ connected: boolean; accounts: { id: string }[]; removed: number }>("/v1/classroom/disconnect", { accountId: first });
    expect(result.body.connected).toBe(true); expect(result.body.accounts.map((r) => r.id)).toEqual(["second-student"]);
    expect(result.body.removed).toBe(1);
    expect(a.store.notes.get(`work-${first}`)?.deleted).toBe(true);
    expect(a.store.notes.get("work-second-student")?.deleted).toBe(false);
  });

  it("an in-flight student feed remains valid when a different student is added", async () => {
    const a = await app(); await a.signIn();
    const first = a.g.accountId;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { a.g.onWork = resolve; });
    a.g.workWait = new Promise<void>((resolve) => { release = resolve; });
    const pending = a.call<ClassroomFeed>(`/v1/classroom/feed?accountId=${first}`);
    await entered;
    a.g.accountId = "second-student"; a.g.email = "second@school.example"; await a.signIn();
    release();
    const feed = await pending;
    expect(feed.status).toBe(200); expect(feed.body.accountId).toBe(first);
    expect(await a.store.listClassroom()).toHaveLength(2);
  });

  it("defers revocation while an unidentified legacy Calendar grant could still rely on it", async () => {
    const a = await app(); await a.signIn();
    await a.store.setGoogle({ refreshToken: "legacy-refresh", accessToken: "legacy-access", accessExpires: NOW + 10000,
      email: null, connectedAt: NOW, problem: null });
    await a.call("/v1/classroom/disconnect", { accountId: a.g.accountId });
    expect(a.g.calls.some((c) => c.url.includes("/revoke"))).toBe(false);
    expect(a.store.google?.refreshToken).toBe("legacy-refresh");
  });

  it("revokes only a student's final grant, not a different known home account", async () => {
    const a = await app(); await a.signIn();
    await a.store.setGoogle({ id: "google:home", accountId: "home", legacyIds: false, refreshToken: "home-refresh",
      accessToken: "home-access", accessExpires: NOW + 10000, email: "home@example.com", connectedAt: NOW, problem: null });
    await a.call("/v1/classroom/disconnect", { accountId: a.g.accountId });
    const revokes = a.g.calls.filter((c) => c.url.includes("/revoke"));
    expect(revokes).toHaveLength(1); expect(revokes[0].body.get("token")).toBe("classroom-refresh-1");
    expect((await a.store.getGoogle("google:home"))?.refreshToken).toBe("home-refresh");
  });
});
