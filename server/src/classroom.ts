// Student-only, read-only Google Classroom connection. Independent from the
// Calendar connection, including when the student uses a school Google account.

import {
  cleanDescription,
  CLASSROOM_REMOVED_REF,
  isClassroomFeed,
  truncate,
  type ClassroomCourse,
  type ClassroomCourseWork,
  type ClassroomFeed,
} from "@pocketed/shared";
import { CalendarInputError, type Fetcher } from "./calendar";
import {
  backToGoogleApp,
  finishGoogleOAuth,
  googleAccessToken,
  googleApiGet,
  googleTokenExpiry,
  MAX_GOOGLE_CONNECTIONS,
  googleGrantStillUsed,
  revokeGoogleGrant,
  startGoogleOAuth,
  type GoogleConfig,
} from "./google-oauth";
import type { ClassroomAccountRow, Store } from "./store";

export const CLASSROOM_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/classroom.courses.readonly",
  "https://www.googleapis.com/auth/classroom.coursework.me.readonly",
] as const;
const API = "https://classroom.googleapis.com/v1";
const USER_INFO = "https://openidconnect.googleapis.com/v1/userinfo";
const PAGE_SIZE = 100;
export const CLASSROOM_MAX_PAGES = 10;
/** Leave room for OAuth/refresh requests within Workers' free-plan subrequest budget. */
const MAX_REQUESTS = 40;
const CONCURRENCY = 4;
const SIGN_IN_AGAIN = "Google no longer accepts Pocketed's Classroom connection. Connect Google Classroom again in Settings.";
const FORBIDDEN = "Google refused Classroom access (403). Enable the Google Classroom API, grant the read-only permissions, " +
  "and check whether your school administrator needs to approve Pocketed.";

export function classroomRedirectUriFor(cfg: GoogleConfig, reqUrl: URL): string {
  return cfg.classroomRedirectUri || `${reqUrl.origin}/v1/classroom/callback`;
}

export interface ClassroomStatus {
  connected: boolean;
  accounts: { id: string; email: string | null; connectedAt: number; problem: string | null; legacyNotes: boolean }[];
  googleAvailable: boolean;
  account: string | null;
  connectedAt: number | null;
  problem: string | null;
}

export async function classroomStatus(store: Store, googleAvailable: boolean): Promise<ClassroomStatus> {
  const rows = await store.listClassroom();
  const row = rows[0];
  return {
    accounts: rows.map((r) => ({ id: r.accountId, email: r.email, connectedAt: r.connectedAt, problem: r.problem, legacyNotes: !!r.legacyNotes })),
    connected: !!row,
    googleAvailable,
    account: row?.email ?? null,
    connectedAt: row?.connectedAt ?? null,
    problem: row?.problem ?? null,
  };
}

export function startClassroomSignIn(
  store: Store, cfg: GoogleConfig, redirectUri: string, returnUrl: unknown, now: number,
): Promise<string> {
  return startGoogleOAuth(store, cfg, redirectUri, returnUrl, now, "classroom", CLASSROOM_SCOPES);
}

/** Cleanup is logged on the SERVER, so it reaches every device, not just this tab. */
async function forgetClassroomReminders(store: Store, now: number, row: ClassroomAccountRow): Promise<number> {
  let removed = 0;
  for (const note of await store.allNotes()) {
    if (note.source !== "classroom" || note.deleted || (note.sourceAccountId !== row.accountId && !(row.legacyNotes && !note.sourceAccountId))) continue;
    await store.appendOp({
      id: crypto.randomUUID(), kind: "delete", noteId: note.id, updatedAt: Math.max(now, note.updatedAt),
      source: "classroom", sourceRef: CLASSROOM_REMOVED_REF, sourceAccountId: row.accountId,
    });
    removed++;
  }
  return removed;
}

export async function finishClassroomSignIn(
  store: Store, cfg: GoogleConfig, redirectUri: string, params: URLSearchParams, now: number, fetcher: Fetcher,
): Promise<Response> {
  const result = await finishGoogleOAuth(
    store, cfg, redirectUri, params, now, fetcher, "classroom",
    [["openid"], ["email", "https://www.googleapis.com/auth/userinfo.email"], [CLASSROOM_SCOPES[2]], [CLASSROOM_SCOPES[3]]],
    "Pocketed needs permission to read your classes and your own coursework — tick those boxes when Google asks.",
  );
  if (result instanceof Response) return result;
  const { returnUrl, tokens } = result;
  const back = (error?: string) => backToGoogleApp(returnUrl, "classroom", error);

  // A stable Google subject scopes deterministic note IDs across accounts.
  // This reads only the account being connected, not a class roster/profile list.
  let profile: { sub?: string; email?: string } | null;
  try {
    const response = await googleApiGet<{ sub?: string; email?: string }>(fetcher, USER_INFO, tokens.access_token, "Classroom");
    profile = response.status === 200 ? response.body : null;
  } catch {
    return back("Couldn't confirm your Google account. Try connecting Classroom again.");
  }
  if (typeof profile?.sub !== "string" || !profile.sub || profile.sub.length > 240) {
    return back("Google didn't identify the Classroom account. Try connecting again.");
  }
  const accounts = await store.listClassroom();
  const old = accounts.find((r) => r.accountId === profile!.sub);
  if (!old && accounts.length >= MAX_GOOGLE_CONNECTIONS) {
    return back(`You can connect up to ${MAX_GOOGLE_CONNECTIONS} Classroom accounts. Disconnect one before adding another.`);
  }
  // Don't revoke superseded tokens: revocation can also break Calendar or the
  // newly issued Classroom token. Only the final disconnect revokes the grant.
  await store.setClassroom({
    accountId: profile.sub,
    legacyNotes: old?.legacyNotes ?? accounts.length === 0,
    email: typeof profile.email === "string" ? profile.email : null,
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token,
    accessExpires: googleTokenExpiry(now, tokens.expires_in),
    connectedAt: Math.max(now, (old?.connectedAt ?? 0) + 1),
    problem: null,
  });
  return backToGoogleApp(returnUrl, "classroom", undefined, profile.sub);
}

export async function disconnectClassroom(store: Store, now: number, fetcher: Fetcher, accountId?: string): Promise<number> {
  const row = await store.getClassroom(accountId);
  if (!row) return 0;
  await store.removeClassroom(row.accountId);
  const removed = await forgetClassroomReminders(store, now, row);
  // Google revokes the app grant for THIS identity, not unrelated home/school accounts.
  if (!(await googleGrantStillUsed(store, row.accountId))) await revokeGoogleGrant(fetcher, row.refreshToken);
  return removed;
}

function record(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function pageItems<T>(page: unknown, key: string): { items: T[]; next?: string } {
  if (!record(page) || (page[key] !== undefined && !Array.isArray(page[key])) ||
      (page.nextPageToken !== undefined && typeof page.nextPageToken !== "string") || page.error) {
    throw new CalendarInputError("Google Classroom returned an unreadable list. Existing assignments were kept.", 502);
  }
  return { items: (page[key] ?? []) as T[], next: (page.nextPageToken as string | undefined) || undefined };
}

/** Every page must succeed; never return a partial snapshot that could erase assignments. */
export async function classroomFeed(store: Store, cfg: GoogleConfig, now: number, fetcher: Fetcher, accountId?: string): Promise<ClassroomFeed> {
  const row = await store.getClassroom(accountId);
  if (!row) throw new CalendarInputError("No Classroom account connected.", 409);
  let token = await googleAccessToken(row, cfg, now, fetcher, (r) => store.updateClassroomTokens(r), SIGN_IN_AGAIN);
  let refreshing: Promise<string> | null = null;
  let requests = 0;
  const get = async (url: string): Promise<unknown> => {
    for (let attempt = 0; ; attempt++) {
      if (++requests > MAX_REQUESTS) {
        throw new CalendarInputError("There is too much Classroom coursework to check safely in one request. Existing assignments were kept.", 502);
      }
      const used = token;
      const response = await googleApiGet<unknown>(fetcher, url, used, "Classroom");
      if (response.status === 401 && attempt === 0) {
        if (token === used) {
          refreshing ??= googleAccessToken(row, cfg, now, fetcher, (r) => store.updateClassroomTokens(r), SIGN_IN_AGAIN, true);
          token = await refreshing;
        }
        continue;
      }
      if (response.status === 403) throw new CalendarInputError(FORBIDDEN, 502);
      if (response.status !== 200 || !record(response.body)) {
        throw new CalendarInputError(`Google Classroom answered with an error (${response.status}). Existing assignments were kept.`, 502);
      }
      return response.body;
    }
  };

  const courses = new Map<string, ClassroomCourse>();
  let pageToken: string | undefined;
  for (let i = 0; ; i++) {
    const q = new URLSearchParams({
      studentId: "me",
      courseStates: "ACTIVE",
      pageSize: String(PAGE_SIZE),
      fields: "nextPageToken,courses(id,name,courseState)",
    });
    if (pageToken) q.set("pageToken", pageToken);
    const page = pageItems<ClassroomCourse & { courseState: string }>(await get(`${API}/courses?${q}`), "courses");
    for (const course of page.items) {
      if (!record(course) || typeof course.id !== "string" || !course.id || typeof course.name !== "string" ||
          typeof course.courseState !== "string") {
        throw new CalendarInputError("Google Classroom returned an unreadable class. Existing assignments were kept.", 502);
      }
      if (course.courseState !== "ACTIVE") continue;
      courses.set(course.id, { id: course.id, name: truncate(course.name, 750) });
    }
    if (!page.next) break;
    if (i + 1 >= CLASSROOM_MAX_PAGES) {
      throw new CalendarInputError("Google returned too many Classroom class pages to import safely. Existing assignments were kept.", 502);
    }
    pageToken = page.next;
  }

  const allCourses = [...courses.values()];
  const courseWork: ClassroomCourseWork[] = [];
  for (let offset = 0; offset < allCourses.length; offset += CONCURRENCY) {
    const batches = await Promise.all(allCourses.slice(offset, offset + CONCURRENCY).map(async (course) => {
      const items: ClassroomCourseWork[] = [];
      let workToken: string | undefined;
      for (let i = 0; ; i++) {
        const q = new URLSearchParams({
          courseWorkStates: "PUBLISHED", // no teacher-only drafts or other students' work
          pageSize: String(PAGE_SIZE),
          fields: "nextPageToken,courseWork(id,title,description,state,alternateLink,dueDate,dueTime)",
        });
        if (workToken) q.set("pageToken", workToken);
        const page = pageItems<ClassroomCourseWork>(await get(`${API}/courses/${encodeURIComponent(course.id)}/courseWork?${q}`), "courseWork");
        for (const work of page.items) {
          if (!record(work) || (work.description !== undefined && typeof work.description !== "string")) {
            throw new CalendarInputError("Google Classroom returned unreadable coursework. Existing assignments were kept.", 502);
          }
          items.push({ ...work, courseId: course.id, description: cleanDescription(work.description ?? "") });
        }
        if (!page.next) break;
        if (i + 1 >= CLASSROOM_MAX_PAGES) {
          throw new CalendarInputError("Google returned too many Classroom coursework pages to import safely. Existing assignments were kept.", 502);
        }
        workToken = page.next;
      }
      return items;
    }));
    for (const items of batches) courseWork.push(...items);
  }
  const feed: ClassroomFeed = {
    source: "classroom", accountId: row.accountId, checkedAt: now, complete: true,
    courses: allCourses, courseWork,
  };
  if (!isClassroomFeed(feed)) {
    throw new CalendarInputError("Google Classroom returned incomplete coursework. Existing assignments were kept.", 502);
  }
  // A different device may disconnect or change accounts during the requests.
  // Do not send that old account's snapshot back after its connection is gone.
  const current = await store.getClassroom(row.accountId);
  if (!current) throw new CalendarInputError("No Classroom account connected.", 409);
  if (current.accountId !== row.accountId || current.refreshToken !== row.refreshToken || current.connectedAt !== row.connectedAt) {
    throw new CalendarInputError("The Classroom account changed while checking. Existing reminders were kept; check again.", 502);
  }
  return feed;
}
