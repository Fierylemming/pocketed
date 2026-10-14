import { vi } from "vitest";
import { applyRemote, emptyState, type CalendarAccountSummary, type ClassroomFeed, type GoogleFeed, type Op } from "@pocketed/shared";

export const NOW = Date.UTC(2026, 9, 14, 10);
export const HOME = "google:home";
export const SCHOOL = "google:school";
export const STUDENT = "school";
export const UID = "same-event@google.com";
export const CFG = { serverUrl: "https://sync.test", token: "test-password" };
const calAccount = (id: string, visible = true): CalendarAccountSummary => ({
  id, visible, legacyIds: false, email: id === HOME ? "home@example.com" : "student@school.example", connectedAt: NOW, problem: null,
});
function googleFeed(id: string, title: string): GoogleFeed {
  return { source: "google", accountId: id, legacyIds: false, calendar: {}, calendars: [{ id: "primary", primary: true }],
    events: [{ id: "event", iCalUID: UID, calendarId: "primary", summary: title,
      start: { dateTime: new Date(NOW + 3_600_000).toISOString() }, end: { dateTime: new Date(NOW + 7_200_000).toISOString() } }] };
}
export function classroomFeed(accountId = STUDENT): ClassroomFeed {
  return { source: "classroom", accountId, checkedAt: NOW, complete: true, courses: [{ id: "maths", name: "Maths" }],
    courseWork: [{ id: "worksheet", courseId: "maths", state: "PUBLISHED", title: "Assignment",
      dueDate: { year: 2026, month: 10, day: 15 }, dueTime: { hours: 15 } }] };
}

export function backend() {
  const server = {
    state: emptyState(), log: [] as Op[], accounts: [calAccount(HOME), calAccount(SCHOOL)], revision: 2,
    classAccounts: [{ id: STUDENT, email: "student@school.example", connectedAt: NOW, problem: null, legacyNotes: false }],
    feeds: { [HOME]: googleFeed(HOME, "Home meeting"), [SCHOOL]: googleFeed(SCHOOL, "School event") } as Record<string, GoogleFeed>,
    classFeeds: { [STUDENT]: classroomFeed() } as Record<string, ClassroomFeed>,
    feedErrors: new Set<string>(), classErrors: new Set<string>(), feedCalls: [] as string[],
    feedWait: null as Promise<void> | null, onFeed: null as (() => void) | null,
    pullWait: null as Promise<void> | null, onPull: null as (() => void) | null,
    failVisibility: false,
  };
  const append = (op: Op) => {
    if (server.log.some((o) => o.id === op.id)) return;
    server.log.push(op); server.state = applyRemote(server.state, [op]);
  };
  const calStatus = () => ({ connected: !!server.accounts.length, mode: server.accounts.length ? "google" : null,
    accounts: server.accounts, accountsRevision: server.revision, googleAvailable: true, feed: null, connectedAt: NOW, problem: null });
  const classStatus = () => ({ connected: !!server.classAccounts.length, accounts: server.classAccounts,
    googleAvailable: true, account: null, connectedAt: NOW, problem: null });
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    const id = url.searchParams.get("accountId") ?? undefined;
    if (url.pathname === "/v1/push") {
      for (const op of body.ops) append(op);
      return Response.json({ serverSeq: server.log.length });
    }
    if (url.pathname === "/v1/pull") {
      const cursor = Number(url.searchParams.get("cursor"));
      // Capture before waiting, like an old response already travelling over the network.
      const snapshot = structuredClone({ ops: server.log.slice(cursor), cursor: server.log.length, serverSeq: server.log.length,
        calendarAccounts: server.accounts, calendarAccountsRevision: server.revision });
      server.onPull?.(); if (server.pullWait) await server.pullWait;
      return Response.json(snapshot);
    }
    if (url.pathname === "/v1/calendar") return Response.json(calStatus());
    if (url.pathname === "/v1/classroom") return Response.json(classStatus());
    if (url.pathname === "/v1/calendar/feed") {
      server.feedCalls.push(`calendar:${id}`); server.onFeed?.(); if (server.feedWait) await server.feedWait;
      if (!id || !server.accounts.some((a) => a.id === id)) return Response.json({ error: "No calendar connected." }, { status: 409 });
      if (server.feedErrors.has(id)) return Response.json({ error: "Account access blocked; existing events were kept." }, { status: 502 });
      return Response.json(server.feeds[id]);
    }
    if (url.pathname === "/v1/classroom/feed") {
      server.feedCalls.push(`classroom:${id}`);
      if (!id || !server.classAccounts.some((a) => a.id === id)) return Response.json({ error: "No Classroom account connected." }, { status: 409 });
      if (server.classErrors.has(id)) return Response.json({ error: "School permission denied." }, { status: 502 });
      return Response.json(server.classFeeds[id]);
    }
    if (url.pathname === "/v1/calendar/visibility") {
      if (server.failVisibility) return Response.json({ error: "Couldn't save the calendar choice." }, { status: 503 });
      const row = server.accounts.find((a) => a.id === body.accountId);
      if (!row) return Response.json({ error: "Missing account" }, { status: 404 });
      row.visible = body.visible; server.revision++;
      return Response.json(calStatus());
    }
    if (url.pathname === "/v1/calendar/disconnect" || url.pathname === "/v1/classroom/disconnect") {
      const source = url.pathname.startsWith("/v1/calendar/") ? "gcal" : "classroom";
      let removed = 0;
      for (const note of Object.values(server.state.notes)) {
        if (note.source !== source || note.sourceAccountId !== body.accountId || note.deleted) continue;
        append({ id: `delete-${source}-${note.id}`, kind: "delete", noteId: note.id, updatedAt: Date.now(), source,
          sourceAccountId: body.accountId, sourceRef: source === "gcal" ? "calendar-removed" : "classroom-removed" });
        removed++;
      }
      if (source === "gcal") { server.accounts = server.accounts.filter((a) => a.id !== body.accountId); server.revision++; return Response.json(calStatus()); }
      server.classAccounts = server.classAccounts.filter((a) => a.id !== body.accountId);
      return Response.json({ ...classStatus(), removed });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  });
  return { server, fetchMock };
}

